// 私密层包装 — 读合并、写拆分发生在 Backend 这一层，notes-store 对"私密"二字无感知：
//  · 读：私密便签的主库行只有空占位；已解锁时把 private.json 里的真身合并回来；
//  · 写：私密便签落库前把敏感字段抹成占位，真身整份进 privateSave（重加密）；
//  · 未解锁时的私密便签只写占位（不覆盖 private.json 里的真身）；
//  · 私密层未启用时全部直通——"私密"只是个标记，内容照旧明文在主库（与旧实现同口径）。
//
// 这一层的形状判据一律取 privateStatus()（Rust 权威），不读 private-state 的缓存位：
// 缓存是界面遮罩的依据，晚了半拍就会把私密内容按"直通"写进主库。

import type {
  PrivateStatus,
  RevisionMeta,
  SealedContent,
  SealedRevision,
  SealedText,
  StickyInput,
  StickyNote,
} from "@/platform/contracts";
import { privateLoad, privateSave, privateStatus } from "@/platform/commands";
import { logger } from "@/platform/logger";
import type { NotesBackend } from "@/store/backend";

const SCOPE = "private-backend";

/**
 * 私密历史的三个阈值与 Rust `db/query/revision.rs` 同值（那边管明文表，这里管封套）：
 * 同一张 60 秒最多一档、每张留最新 50 条、留 7 天。改一边要同步另一边。
 */
const REVISION_COALESCE_MS = 60_000;
const REVISION_KEEP = 50;
const REVISION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const REVISION_PREVIEW_CHARS = 60;

function contentOf(entry: SealedText): SealedContent {
  return {
    title: entry.title,
    body: entry.body,
    contentType: entry.contentType,
    items: entry.items,
    timeline: entry.timeline,
    tags: entry.tags,
  };
}

/**
 * 把"被换掉之前那一份"追加进 revisions。判据与 Rust 的 `record` 同一条：
 * 没变不占格、冷却内不占格、两头夹保留量。`force` 只给回滚用。
 */
function pushRevision(
  previous: SealedContent | undefined,
  revisions: SealedRevision[] | undefined,
  now: number,
  force: boolean,
): SealedRevision[] {
  const list = revisions ?? [];
  // 新建的那张没有"之前"，没什么可留
  if (previous === undefined) return list;
  const newest = list[list.length - 1];
  if (newest !== undefined) {
    if (JSON.stringify(newest.content) === JSON.stringify(previous)) return list;
    if (!force && now - newest.createdAt < REVISION_COALESCE_MS) return list;
  }
  const next = [
    ...list,
    { seq: (newest?.seq ?? 0) + 1, createdAt: now, content: previous },
  ];
  const cutoff = now - REVISION_KEEP_MS;
  return next.filter((row) => row.createdAt >= cutoff).slice(-REVISION_KEEP);
}

/** 列表里那一行的摘要。四类便签的正文不在同一个字段，跟着类型分岔（同 Rust） */
function previewOf(content: SealedContent): string {
  const source =
    content.contentType === "todo"
      ? (content.items[0]?.text ?? "")
      : content.contentType === "timeline"
        ? (content.timeline[0]?.text ?? "")
        : content.body;
  const flat = source.replace(/\n/g, " ").trim();
  return flat.length <= REVISION_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, REVISION_PREVIEW_CHARS)}…`;
}

async function readMap(): Promise<Record<string, SealedText>> {
  const parsed: unknown = JSON.parse(await privateLoad());
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, SealedText>)
    : {};
}

const BLANK = {
  title: "",
  body: "",
  items: [] as StickyInput["items"],
  timeline: [] as StickyInput["timeline"],
  tags: [] as string[],
};

function stripSensitive(input: StickyInput): StickyInput {
  return input.private ? { ...input, ...BLANK } : input;
}

function extractSealed(input: StickyInput): SealedContent {
  return {
    title: input.title,
    body: input.body,
    contentType: input.contentType,
    items: input.items,
    timeline: input.timeline,
    tags: input.tags,
  };
}

function mergeSealed(note: StickyNote, sealed: Record<string, SealedText>): StickyNote {
  const entry = sealed[note.id];
  if (entry === undefined) return note;
  return {
    ...note,
    title: entry.title,
    body: entry.body,
    items: entry.items,
    timeline: entry.timeline,
    tags: entry.tags,
  };
}

export function withPrivateLayer(inner: NotesBackend): NotesBackend {
  let sealed: Record<string, SealedText> = {};

  /**
   * 把 `sealed` 摆到与**权威状态**一致，并把这个状态返回给调用方。
   *
   * 这里不读 private-state 的缓存位：缓存是界面遮罩的依据，不该决定落盘形状。
   * 刚配完口令的那一窗，缓存还可能停在"未配置"，此时按直通写下去就是明文进主库；
   * 反过来，若 `sealed` 还没跟着当前状态装载过就整份 privateSave 重写，
   * 封套里别人的真身会被抹掉——两个方向都是丢数据，所以一次取权威、一次装到位。
   * 取不到状态就抛：宁可这条写失败留在 pending 里重试，也不猜一个形状写下去。
   */
  async function syncSealed(): Promise<PrivateStatus> {
    const status = await privateStatus();
    if (!status.configured || !status.unlocked) {
      sealed = {};
      return status;
    }
    try {
      const parsed: unknown = JSON.parse(await privateLoad());
      sealed =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, SealedText>)
          : {};
    } catch (error) {
      logger.caught(SCOPE, "私密内容读不出，私密便签按锁定态显示", error);
      sealed = {};
    }
    return status;
  }

  async function saveSealed(): Promise<void> {
    await privateSave(JSON.stringify(sealed));
  }

  return {
    async bootstrap() {
      const status = await syncSealed();
      const rows = await inner.bootstrap();
      // 收割孤儿：封套里有、stickies 表里连一行都没有（回收站里也没有）的那些条目。
      // 硬删曾经绕过本包装层（回收站直接打 IPC），那阵漏下的真身就在这一次被清掉。
      // 只在解锁态做：锁着读不到内容，也就无从判断谁是真的没了。
      if (status.configured && status.unlocked && Object.keys(sealed).length > 0) {
        const alive = new Set((await inner.list(true)).map((row) => row.id));
        const orphans = Object.keys(sealed).filter((id) => !alive.has(id));
        if (orphans.length > 0) {
          for (const id of orphans) delete sealed[id];
          try {
            await saveSealed();
            logger.info(SCOPE, `清掉 ${orphans.length} 条没有对应便签的私密内容`);
          } catch (error) {
            logger.caught(SCOPE, "收割孤儿条目失败（下次启动再试）", error);
          }
        }
      }
      return rows.map((row) => (row.private ? mergeSealed(row, sealed) : row));
    },

    async list(includeDeleted) {
      await syncSealed();
      const rows = await inner.list(includeDeleted);
      return rows.map((row) => (row.private ? mergeSealed(row, sealed) : row));
    },

    async upsert(input) {
      if (!input.private) {
        return inner.upsert(input);
      }
      const status = await syncSealed();
      if (!status.configured) {
        // 私密层没启用："私密"只是个标记，内容照旧明文在主库（与旧实现同口径）
        return inner.upsert(input);
      }
      if (!status.unlocked) {
        // 未解锁：手上这本就是占位（视图层不给编辑），照占位写库，不碰封套
        return inner.upsert(stripSensitive(input));
      }
      // 先封真身（fresh nonce 整份重加密），再把占位落主库。封失败就不动主库。
      // 覆盖之前把**旧真身**记成一版：私密便签不进明文历史表（那张表谁都看得见），
      // 它的版本只能跟着封套走，于是"看历史"和"看便签"共用同一道口令门
      const previous = sealed[input.id];
      sealed[input.id] = {
        ...extractSealed(input),
        revisions: pushRevision(
          previous === undefined ? undefined : contentOf(previous),
          previous?.revisions,
          Date.now(),
          false,
        ),
      };
      await saveSealed();
      // 返回值要合并回真身：主库那份是占位，而 notes-store.flushNow 拿返回值**整份**
      // 换掉内存里的实体（它只要 Rust 盖的 updatedAt）。不合并就是每次落库把这张的
      // 标题和正文从内存里抹掉，下一次落库再把抹掉的空占位封回套里——真内容没了。
      return mergeSealed(await inner.upsert(stripSensitive(input)), sealed);
    },

    async remove(id, hard) {
      // 先删行、再清套：反过来万一中间断在一半，留下的是"行已经没了意义、真身也拿不回来"
      // 的空壳，比留一条孤儿条目糟得多。（软删不动封套——从回收站恢复后内容还得在。）
      await inner.remove(id, hard);
      if (hard) {
        const status = await syncSealed();
        if (status.configured && status.unlocked && id in sealed) {
          delete sealed[id];
          try {
            await saveSealed();
          } catch (error) {
            logger.caught(SCOPE, "清理私密内容失败（行已删，封套内留了孤儿条目）", error);
          }
        }
      }
    },
  };
}

/**
 * 私密便签的历史版本（从封套里读，新的在前）。
 *
 * 锁着会由 `privateLoad` 抛 `PRIVATE_LOCKED` —— 这正是作者要的"必须输入密码才能查看"
 * 落的地方：私密的版本与私密的正文共用同一道门，没有第二条能绕过它的读路径。
 */
export async function sealedRevisions(id: string): Promise<RevisionMeta[]> {
  const list = (await readMap())[id]?.revisions ?? [];
  return [...list].reverse().map((row) => ({
    seq: row.seq,
    createdAt: row.createdAt,
    title: row.content.title,
    contentType: row.content.contentType,
    preview: previewOf(row.content),
  }));
}

/**
 * 回到封套里的某一版：把那一版的内容写进条目（`revisions` 原样留着），并把**回滚前**
 * 这份强记成一版（`force` 绕过冷却——刚打的字立刻回滚，不记就没有回头路）。
 *
 * 只重写封套：主库那一行对私密便签永远是空占位，没有内容可换。调用方拿到返回值后用
 * `updateNote` 把内容落进视图，那一次 flush 会因为"内容没变"而不再多记一版。
 */
export async function sealedRevert(id: string, seq: number): Promise<SealedContent> {
  const map = await readMap();
  const entry = map[id];
  const target = entry?.revisions?.find((row) => row.seq === seq);
  if (entry === undefined || target === undefined) {
    throw new Error(`私密便签没有第 ${seq} 版`);
  }
  map[id] = {
    ...target.content,
    revisions: pushRevision(contentOf(entry), entry.revisions, Date.now(), true),
  };
  await privateSave(JSON.stringify(map));
  return target.content;
}

/**
 * 批量摘掉封套里的条目（连它们那一串版本）。回收站"一键清空"那一条路用它——
 * 那是 Rust 侧的整批 DELETE，不经过本文件的包装层，不在这里动手就没人动手。
 *
 * 调用时机：**行删完之后**。锁着会由 `privateLoad` 抛 `PRIVATE_LOCKED`，原样抛给
 * 调用方：走到这里说明口令门已经过了，状态却对不上，不该静默放过。
 */
export async function dropSealed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const map = await readMap();
  const hit = ids.filter((id) => id in map);
  if (hit.length === 0) return;
  for (const id of hit) delete map[id];
  await privateSave(JSON.stringify(map));
}
