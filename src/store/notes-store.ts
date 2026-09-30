// notes-store — 数据核。三条设计决定，每条都是对旧架构一个具体病灶的回答：
//
// 1. **实体粒度写**：updateNote(id, patch) 立即改内存、去抖后按单实体 upsert。
//    没有"整包 JSON + 行基线差集"这一族机制——写哪个实体是调用点自己知道的，
//    不需要拿规范化形状反推。这是把"全仓唯一能真丢数据的路径"整个拆掉。
// 2. **单一跨窗机制**：只听 Rust 的 `db:changed {writer, kind}`。远端合流时，
//    `pending` 里的实体以本地为准（在途编辑不被覆盖），其余以远端为准。
//    没有合成 storage 事件，没有第二套语义。
// 3. **没有模式机**：主库拿不到就是 `error` 状态，界面给明确的错误态；
//    测试/预览注入内存 Backend，不存在"退化成另一套存储语义"这回事。
//
// 次序铁律（继承自旧架构的真机教训）：**先订阅、后读**。订阅到手之后再读，
// 读到的那份不会比此后的任何广播更旧；反过来就在两窗之间留出丢更新的真空。

import type { StickyInput, StickyNote } from "@/platform/contracts";
import { DB_CHANGED } from "@/platform/contracts";
import type { DbChangedEvent } from "@/platform/contracts";
import { currentWindowLabel, listen } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { normalizeSticky } from "@/data/validate";
import type { NotesBackend } from "@/store/backend";

const SCOPE = "store";
const FLUSH_MS = 250;

type Listener = () => void;

let backend: NotesBackend | null = null;
let hydrated = false;
let hydrationError: unknown = null;

/** 全量实体。value 一经发布不再就地修改——更新 = 换新对象 */
const notes = new Map<string, StickyNote>();
/** 在途写实体 id：flush 成功前，远端合流不许覆盖它们 */
const pending = new Set<string>();
/** 上一次 flush 的失败实体 id（重试到成功为止），供 UI 反馈 */
const failed = new Set<string>();

let version = 0;
let listCache: readonly StickyNote[] = [];
const listeners = new Set<Listener>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let changeBound = false;

// —— 订阅面（useSyncExternalStore 用） ——

function emit(): void {
  version += 1;
  listCache = [...notes.values()];
  for (const listener of listeners) listener();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStoreVersion(): number {
  return version;
}

/** 全量快照（引用稳定：只在 emit 时重建） */
export function getNotesSnapshot(): readonly StickyNote[] {
  return listCache;
}

/** 单实体读（引用稳定：该实体未更新时返回同一对象） */
export function getNote(id: string): StickyNote | null {
  return notes.get(id) ?? null;
}

export function isStoreReady(): boolean {
  return hydrated;
}

export function getHydrationError(): unknown {
  return hydrationError;
}

export function getFailedIds(): readonly string[] {
  return [...failed];
}

// —— 装配与启动 ——

export function initStore(implementation: NotesBackend): void {
  backend = implementation;
}

/**
 * 启动加载。**先订阅、后读**（见文件头）。失败不静默：状态落在 error，
 * 由入口渲染明确的错误界面——没有"退化成 localStorage"这条退路。
 */
export async function hydrateStore(): Promise<void> {
  if (!backend) throw new Error("store 未配置 Backend（先 initStore）");
  if (!changeBound) {
    changeBound = true;
    await bindChangeListeners();
  }
  try {
    const rows = await backend.bootstrap();
    notes.clear();
    for (const row of rows) {
      const note = normalizeSticky(row);
      if (note) notes.set(note.id, note);
    }
    pending.clear();
    failed.clear();
    hydrated = true;
    hydrationError = null;
    emit();
  } catch (error) {
    hydrated = false;
    hydrationError = error;
    logger.caught(SCOPE, "首屏加载失败", error);
    emit();
    throw error;
  }
}

async function bindChangeListeners(): Promise<void> {
  try {
    await listen<DbChangedEvent>(DB_CHANGED, (payload) => {
      if (payload.writer === currentWindowLabel()) return;
      if (payload.kind !== "sticky") return;
      void refreshFromRemote();
    });
  } catch (error) {
    // 订阅失败不挡首屏：本窗退化为"读得到但听不到远端"。要留痕——这是真 bug 时唯一的线索
    changeBound = false;
    logger.caught(SCOPE, "跨窗变更订阅失败，本窗口将收不到远端更新", error);
  }
}

/** 远端变了：重拉全量，pending 的实体以本地为准 */
async function refreshFromRemote(): Promise<void> {
  if (!backend) return;
  try {
    const rows = await backend.list(false);
    const localPending = new Map<string, StickyNote>();
    for (const id of pending) {
      const local = notes.get(id);
      if (local) localPending.set(id, local);
    }
    notes.clear();
    for (const row of rows) {
      const note = normalizeSticky(row);
      if (!note) continue;
      const local = localPending.get(note.id);
      notes.set(note.id, local ?? note);
    }
    emit();
  } catch (error) {
    logger.caught(SCOPE, "远端刷新失败，本窗口停在最后一次读到的数据", error);
  }
}

// —— 写 ——

/**
 * 单实体更新：立即改内存（订阅者同步重渲染），并入 pending，去抖落库。
 * 返回 false = 实体不存在或 store 未就绪（调用方不该在未就绪时写字段）。
 */
export function updateNote(
  id: string,
  patch: Partial<Omit<StickyNote, "id" | "createdAt" | "updatedAt">>,
): boolean {
  if (!hydrated || !backend) return false;
  const current = notes.get(id);
  if (!current) return false;
  notes.set(id, { ...current, ...patch });
  pending.add(id);
  failed.delete(id);
  emit();
  scheduleFlush();
  return true;
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_MS);
}

/** 立即落库全部在途写。开新窗前 / 关窗前调用（等它完成再继续） */
export async function flushNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const sink = backend;
  if (!sink || pending.size === 0) return;
  const batch = [...pending];
  pending.clear();
  const results = await Promise.allSettled(
    batch.map(async (id) => {
      const note = notes.get(id);
      if (!note) {
        // 在途期间实体被本地删掉：把删除落成真
        await sink.remove(id, true);
        return;
      }
      const saved = await sink.upsert(toInput(note));
      // 用权威时间戳回填内存（不改其它字段，不触发新一轮写）
      notes.set(id, saved);
    }),
  );
  let hadFailure = false;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      failed.delete(batch[index]);
      return;
    }
    hadFailure = true;
    pending.add(batch[index]);
    failed.add(batch[index]);
  });
  if (hadFailure) {
    logger.warn(
      SCOPE,
      `落库有 ${failed.size} 条失败，改动仍在内存里（下次编辑或下次 flush 重试）`,
    );
  }
  emit();
}

/** 软删除（进回收站）。本地先生效，落库走 pending 通道 */
export async function removeNote(id: string, hard = false): Promise<boolean> {
  if (!hydrated || !backend) return false;
  if (!notes.has(id)) return false;
  if (hard) {
    notes.delete(id);
  } else {
    const note = notes.get(id);
    if (note) {
      notes.set(id, { ...note, deleted: true, deletedAt: Date.now(), floating: false });
    }
  }
  emit();
  try {
    await backend.remove(id, hard);
    failed.delete(id);
  } catch (error) {
    failed.add(id);
    logger.caught(SCOPE, `删除落库失败（id=${id}）`, error);
  }
  emit();
  return true;
}

function toInput(note: StickyNote): StickyInput {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...input
  } = note;
  return input;
}

// —— 测试复位 ——

export function resetStoreForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  backend = null;
  hydrated = false;
  hydrationError = null;
  notes.clear();
  pending.clear();
  failed.clear();
  version = 0;
  listCache = [];
  listeners.clear();
  changeBound = false;
}
