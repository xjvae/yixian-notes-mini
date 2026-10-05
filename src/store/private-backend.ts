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
  SealedText,
  StickyInput,
  StickyNote,
} from "@/platform/contracts";
import { privateLoad, privateSave, privateStatus } from "@/platform/commands";
import { logger } from "@/platform/logger";
import type { NotesBackend } from "@/store/backend";

const SCOPE = "private-backend";

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

function extractSealed(input: StickyInput): SealedText {
  return {
    title: input.title,
    body: input.body,
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
      await syncSealed();
      const rows = await inner.bootstrap();
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
      sealed[input.id] = extractSealed(input);
      await saveSealed();
      return inner.upsert(stripSensitive(input));
    },

    async remove(id, hard) {
      // 真删一张私密便签：密封套里的真身一并带走（软删不动，恢复后还在）
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
      return inner.remove(id, hard);
    },
  };
}
