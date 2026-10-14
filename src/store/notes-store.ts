// notes-store — 数据核。三条设计决定：① 实体粒度写（updateNote 立即改内存、去抖后按单实体 upsert）
// ② 唯一跨窗机制（只听 Rust `db:changed {writer,kind}`，带 `note` 的就只合那一张；远端合流时
//    pending 里的实体以本地为准）③ 没有模式机（主库拿不到就 `error` 态，不"退化成另一套存储语义"）。
// 次序铁律：**先订阅、后读**——订阅到手再读，否则两窗之间留出丢更新的真空。

import type { StickyInput, StickyNote } from "@/platform/contracts";
import { DB_CHANGED } from "@/platform/contracts";
import type { DbChangedEvent } from "@/platform/contracts";
import { currentWindowLabel, listen } from "@/platform/bridge";
import { isAppError } from "@/platform/errors";
import { logger } from "@/platform/logger";
import { normalizeSticky } from "@/data/validate";
import type { NotesBackend } from "@/store/backend";

const SCOPE = "store";
const FLUSH_MS = 250;
/** 落库失败后退避重试的上限：再往上就不如等下一次真实编辑 */
const RETRY_CAP_MS = 10_000;

/** 那一发失败是"等这一张被揭开"而不是"等重试" */
function waitsForUnlock(reason: unknown): boolean {
  return isAppError(reason) && reason.code === "PRIVATE_LOCKED";
}

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
let failedCache: readonly string[] = [];
const listeners = new Set<Listener>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 下一次重试的间隔（0 = 还没有退避过）。成功落完一批就归零 */
let retryDelayMs = 0;
let changeBound = false;

// —— 订阅面（useSyncExternalStore 用） ——

function emit(): void {
  version += 1;
  listCache = [...notes.values()];
  failedCache = [...failed];
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

let lastTitleKey = "";
let lastTitles: ReadonlyMap<string, string> = new Map();

/** "id → 标题" 的快照，**只在标题真的变了时才换引用**。
 *  `getNotesSnapshot()` 每次 emit 都是新数组，按它订阅的读者会被别人敲一个字就带着整扇窗重渲；
 *  只要名字的读者（拖拽进组的悬停胶囊）走这一格。键里带 id：删掉一张也算变 */
export function getTitlesSnapshot(): ReadonlyMap<string, string> {
  const key = listCache.map((row) => `${row.id}\u0000${row.title}`).join("\u0001");
  if (key === lastTitleKey) return lastTitles;
  lastTitleKey = key;
  lastTitles = new Map(listCache.map((row) => [row.id, row.title]));
  return lastTitles;
}

/** 每叠一份的成员快照缓存：key 是 groupId，值只在"这一叠的成员进出或成员对象换代"时才换引用 */
const membersCache = new Map<string, readonly StickyNote[]>();

/** 某一叠的成员快照（保持列表序，= updated_at DESC，见 stack-model 口径）。
 *  与全量 `getNotesSnapshot()` 的差别在引用稳定性：**别的**叠里敲一个字，这一叠的快照引用不动，
 *  叠窗就不会被别人的编辑带着重渲。本叠成员更新（对象换代）当然要换引用——正文要跟着画 */
export function getMembersSnapshot(groupId: string): readonly StickyNote[] {
  const fresh: StickyNote[] = [];
  for (const row of listCache) {
    if (row.groupId === groupId && !row.deleted) fresh.push(row);
  }
  const cached = membersCache.get(groupId);
  if (
    cached !== undefined &&
    cached.length === fresh.length &&
    cached.every((row, index) => row === fresh[index])
  ) {
    return cached;
  }
  membersCache.set(groupId, fresh);
  return fresh;
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

/** 引用稳定的失败清单快照（反馈条订阅用） */
export function getFailedSnapshot(): readonly string[] {
  return failedCache;
}

export function initStore(implementation: NotesBackend): void {
  backend = implementation;
}

/** 启动加载：先订阅后读（见文件头），失败不静默（落 error 态）。 */
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
      // 带实体就只合那一张。整库重拉在打字那条路上是每敲一下、每扇别的窗各来一发 IPC
      if (payload.note !== undefined) {
        mergeRemoteNote(payload.note);
        return;
      }
      void refreshFromRemote();
    });
  } catch (error) {
    // 订阅失败不挡首屏：本窗退化为"读得到但听不到远端"。要留痕——这是真 bug 时唯一的线索
    changeBound = false;
    logger.caught(SCOPE, "跨窗变更订阅失败，本窗口将收不到远端更新", error);
  }
}

/** 单实体合并。在途的那张以本地为准（口径同 `refreshFromRemote`：刚敲的字不许被远端盖掉） */
function mergeRemoteNote(row: StickyNote): void {
  const note = normalizeSticky(row);
  if (note === null || pending.has(note.id)) return;
  notes.set(note.id, note);
  emit();
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

/** 主动重拉（私密层解锁/锁定后由 boot 触发）：后端包装层按新私密状态重并，这里只重读一遍。 */
export async function refreshStore(): Promise<void> {
  if (!hydrated) return;
  await refreshFromRemote();
}

/** 单实体更新：立即改内存并入 pending 去抖落库；返回 false=不存在或未就绪（未就绪别写字段）。 */
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

function scheduleFlush(delayMs = FLUSH_MS): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, delayMs);
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
  // 这里**不**清空 pending：提前清空会留窗口——请求已上路、内存还是旧的，此时远端 `db:changed` 到，刚敲的字会被远端盖掉
  const results = await Promise.allSettled(
    batch.map(async (id) => {
      const note = notes.get(id);
      if (!note) {
        // 在途期间实体被本地删掉：把删除落成真
        await sink.remove(id, true);
        pending.delete(id);
        return;
      }
      const saved = await sink.upsert(toInput(note));
      // 回填分两种，分界是"内存里这份还是不是发出时那份"（updateNote 每次换新对象，引用相等=没再改过）：
      //  · 没改过→整行换后端权威那份（后端会绕过 store 直改字段如 sticky_set_group 的 SQLite 直 UPDATE，整行换才拉得回）；
      //    又改过→只补后端那三个时钟、留新字、**继续在途**（摘出 pending 等于丢掉这一笔）
      const live = notes.get(id);
      if (live === undefined || live === note) {
        notes.set(id, saved);
        pending.delete(id);
      } else {
        notes.set(id, {
          ...live,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
          deletedAt: saved.deletedAt,
        });
      }
    }),
  );
  let hadFailure = false;
  let allWaitingForUnlock = true;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      failed.delete(batch[index]);
      return;
    }
    hadFailure = true;
    pending.add(batch[index]);
    failed.add(batch[index]);
    if (!waitsForUnlock(result.reason)) allWaitingForUnlock = false;
  });
  if (hadFailure) {
    logger.warn(
      SCOPE,
      `落库有 ${failed.size} 条失败，改动仍在内存里（自动退避重试；锁着的那条等解锁补做）`,
    );
  }
  emit();
  scheduleRetry(allWaitingForUnlock && hadFailure);
}

/** 失败后自己把下一次排上：退避 250ms→×4→封顶（不设上限就是拿坏库每 250ms 撞一次 IPC）。
 *  唯一不重试的是"私密层锁着"那一发——解锁前不可能成功、重试只是空转；解锁时 boot 会补做一次 flushNow。 */
function scheduleRetry(onlyWaitingOnLock: boolean): void {
  if (pending.size === 0) {
    retryDelayMs = 0;
    return;
  }
  if (onlyWaitingOnLock) return;
  retryDelayMs = retryDelayMs === 0 ? FLUSH_MS : Math.min(retryDelayMs * 4, RETRY_CAP_MS);
  scheduleFlush(retryDelayMs);
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
  failedCache = [];
  lastTitleKey = "";
  lastTitles = new Map();
  listeners.clear();
  changeBound = false;
}
