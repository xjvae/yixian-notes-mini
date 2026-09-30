// 私密层包装 — 读合并、写拆分发生在 Backend 这一层，notes-store 对"私密"二字无感知：
//  · 读：私密便签的主库行只有空占位；已解锁时把 private.json 里的真身合并回来；
//  · 写：私密便签落库前把敏感字段抹成占位，真身整份进 privateSave（重加密）；
//  · 未解锁时的私密便签只写占位（不覆盖 private.json 里的真身）；
//  · 私密层未启用时全部直通——"私密"只是个标记，内容照旧明文在主库（与旧实现同口径）。

import type { SealedText, StickyInput, StickyNote } from "@/platform/contracts";
import { privateLoad, privateSave } from "@/platform/commands";
import { isPrivateLayerActive, isPrivateUnlocked } from "@/data/private-state";
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

  async function syncSealed(): Promise<void> {
    if (!isPrivateLayerActive() || !isPrivateUnlocked()) {
      sealed = {};
      return;
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
      if (!input.private || !isPrivateLayerActive()) {
        return inner.upsert(input);
      }
      if (!isPrivateUnlocked()) {
        // 未解锁：手上这本就是占位（视图层不给编辑），照占位写库，不碰 private.json
        return inner.upsert(stripSensitive(input));
      }
      // 先封真身（fresh nonce 整份重加密），再把占位落主库。封失败就不动主库。
      sealed[input.id] = extractSealed(input);
      await saveSealed();
      return inner.upsert(stripSensitive(input));
    },

    async remove(id, hard) {
      // 真删一张私密便签：密封套里的真身一并带走（软删不动，恢复后还在）
      if (hard && isPrivateLayerActive() && isPrivateUnlocked() && id in sealed) {
        delete sealed[id];
        try {
          await saveSealed();
        } catch (error) {
          logger.caught(SCOPE, "清理私密内容失败（行已删，封套内留了孤儿条目）", error);
        }
      }
      return inner.remove(id, hard);
    },
  };
}
