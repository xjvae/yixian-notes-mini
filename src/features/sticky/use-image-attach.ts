// use-image-attach — 便签贴图的三条路：正文光标处插入、清单/时间轴条目追加、按引用删除。
// 从 note-content.tsx 抽出（原 139-218 行）：attachToBody 与 attachToRow 的
// "预算 → 放不下就逐张回滚刚存的字节" 是逐行重复的，这里收成 rollbackAttachments 一份；
// 组件里只留 UI 状态（编辑态、提示条），存储口径（先存后插、光标从落定那一刻重算、
// 截断不如回滚）都归这一份。todo/timeline 直通条目级的 `images.attach` 也从这里出。

import { useCallback, type RefObject } from "react";
import { forgetMedia } from "@/features/sticky/use-media";
import { useNoteImageAttacher } from "@/features/sticky/use-note-image";
import { withoutMediaRef } from "@/data/body-parse";
import type { RowRef } from "@/features/sticky/row-target";
import { patchRowText, rowRoom, rowText } from "@/features/sticky/row-target";
import { BODY_MAX, ITEM_MAX } from "@/data/limit";
import { mediaDelete } from "@/platform/commands";
import { logger } from "@/platform/logger";
import { getNote, updateNote } from "@/store/notes-store";
import type { StickyNote } from "@/platform/contracts";

const SCOPE = "sticky";

export interface ImageAttachParams {
  id: string;
  /** 渲染那一刻的行（dropImage 的摘除目标按它算，保持原口径） */
  note: StickyNote;
  editingBody: boolean;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
  onMessage: (message: string) => void;
}

export interface ImageAttach {
  attachToBody: (files: File[]) => Promise<void>;
  attachToRow: (row: RowRef, files: File[]) => Promise<void>;
  dropImage: (mediaId: string, row?: RowRef | null) => void;
  /** 条目级粘图口（todo/timeline 的 attach prop）+ busy/message 呈现态 */
  images: ReturnType<typeof useNoteImageAttacher>;
}

export function useImageAttach({
  id,
  note,
  editingBody,
  bodyRef,
  onMessage,
}: ImageAttachParams): ImageAttach {
  const images = useNoteImageAttacher(id);

  /** 内存里此刻那一份（不是渲染闭包里的 `note`）：跨过 await 后还要改这张时用它——await 期间
   *  人还在打字、updateNote 每下换新对象，闭包里那份已成旧快照。 */
  const liveNote = useCallback((): StickyNote | null => getNote(id), [id]);
  const liveBody = useCallback(
    (): string => getNote(id)?.body ?? note.body,
    [id, note.body],
  );

  /** 预算没拦住时的同一条退路：截断会把 `![…](media://m…)` 切成认不出的残句（图永远显不出），
   *  宁可逐张回滚刚存的字节、回一句"放不下"。两个容器（正文/条目）共用，文案按容器分 */
  const rollbackAttachments = useCallback(
    (ids: readonly string[], container: string, overflow: number): void => {
      for (const mediaId of ids) {
        void mediaDelete(mediaId).catch((error: unknown) =>
          logger.caught(SCOPE, `回滚刚存的图失败（${container}放不下）`, error),
        );
      }
      onMessage(`${container}放不下这些图片引用（还差 ${overflow} 个字）`);
    },
    [onMessage],
  );

  /** 存好之后把引用插进正文的光标处（不在编辑态就插到末尾） */
  const attachToBody = useCallback(
    async (files: File[]): Promise<void> => {
      const { refs, ids } = await images.attach(files, {
        room: BODY_MAX - liveBody().length,
        isPrivate: note.private,
      });
      if (refs.length === 0) return;
      // 这一串 await 期间人还在打字、每下换掉内存里那份——光标与正文都必须从**落定那一刻**重算，
      // 拿闭包旧值拼回去会把这几百毫秒打的字整个吃掉
      const body = liveBody();
      const caret = Math.min(
        editingBody ? (bodyRef.current?.selectionStart ?? body.length) : body.length,
        body.length,
      );
      const block = refs.join("\n");
      const head = body.slice(0, caret);
      const tail = body.slice(caret);
      const joined =
        head +
        (head === "" || head.endsWith("\n") ? "" : "\n") +
        block +
        (tail === "" ? "\n" : tail.startsWith("\n") ? "" : "\n") +
        tail;
      if (joined.length > BODY_MAX) {
        rollbackAttachments(ids, "正文", joined.length - BODY_MAX);
        return;
      }
      updateNote(id, { body: joined });
    },
    // liveBody/liveNote 每拍都读内存真相，进依赖的只有会变的 UI 状态与这张的密级
    [images, note.private, editingBody, bodyRef, rollbackAttachments, id, liveBody],
  );

  /** 把图存好追加到某条末尾——与清单/时间轴粘图同口径（room 先算、放不下回滚、空条不垫换行）。 */
  const attachToRow = useCallback(
    async (row: RowRef, files: File[]): Promise<void> => {
      const before = rowText(liveNote() ?? note, row);
      if (before === null) return;
      const { refs, ids } = await images.attach(files, {
        room: rowRoom(before),
        isPrivate: note.private,
      });
      if (refs.length === 0) return;
      // 同 `attachToBody`：这一串 await 期间那一条可能又被改过，追加的对象必须是当下那一份
      const current = rowText(liveNote() ?? note, row);
      if (current === null) return;
      const block = refs.join("\n");
      const next = current === "" ? block : `${current}\n${block}`;
      if (next.length > ITEM_MAX) {
        rollbackAttachments(ids, "这条", next.length - ITEM_MAX);
        return;
      }
      const patch = patchRowText(liveNote() ?? note, row, next);
      if (patch === null) return;
      updateNote(id, patch);
    },
    [images, note, rollbackAttachments, id, liveNote],
  );

  /** 阅读态"删掉这张图"：库里字节与引用一起走。给了 `row` 就摘那一条的文本（同一引用正文/条目
   *  都可能出现，须按目标摘、别按正文一把梭）。 */
  const dropImage = useCallback(
    (mediaId: string, row: RowRef | null = null): void => {
      const target = row === null ? note.body : rowText(note, row);
      if (target === null) return;
      const patch =
        row === null
          ? { body: withoutMediaRef(target, mediaId) }
          : patchRowText(note, row, withoutMediaRef(target, mediaId));
      if (patch === null) return;
      updateNote(id, patch);
      forgetMedia(mediaId);
      void mediaDelete(mediaId).catch((error: unknown) =>
        logger.caught(SCOPE, "删图库里的字节失败（引用已摘）", error),
      );
    },
    [note, id],
  );

  return { attachToBody, attachToRow, dropImage, images };
}
