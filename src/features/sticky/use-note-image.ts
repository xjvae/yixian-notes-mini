// 把外来的图存进这张便签名下 — 正文、清单条目、时间轴条目共用这一个口。
//
// 只做"压好 + 存库 + 回引用"，**不碰任何文本**：往哪儿插、还剩多少字可写，是宿主
// 自己的事（正文与条目的上限差 25 倍，见 data/limit.ts）。反过来把插入也搬进来，就得在这里
// 再抄一份"目标文本长什么样"，那就是第二个真相。
//
// `room` 是调用方给的"还能放多少字符"。按**累计**长度算，一次粘三张时第二张不能按
// "第一张还没进来"的旧长度算。放不下的那张**根本不存**，而不是存完再发现没地方写——
// 那样库里就躺着一张没人引用的图。

import { useCallback, useState } from "react";
import { mediaSave } from "@/platform/commands";
import { describeError } from "@/platform/errors";
import { MEDIA_REF_BUDGET, mediaRef } from "@/data/body-parse";
import { isAcceptedMime, prepareImage } from "@/data/image-input";

export interface AttachResult {
  /** 成功存下的那几张的引用，按传入文件顺序 */
  refs: string[];
  /** 与 `refs` 一一对应的图库 id：调用方要是发现插不下，拿它们把刚存的删回去 */
  ids: string[];
  /** 要显示给用户的一句话（null = 没有） */
  message: string | null;
}

export interface NoteImageAttacher {
  /** 正在压图（一次可能几张，别逐张闪提示） */
  busy: boolean;
  message: string | null;
  clearMessage: () => void;
  attach: (
    files: File[],
    options: { room: number; isPrivate: boolean },
  ) => Promise<AttachResult>;
}

export function useNoteImageAttacher(noteId: string): NoteImageAttacher {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const attach = useCallback(
    async (
      files: File[],
      { room, isPrivate }: { room: number; isPrivate: boolean },
    ): Promise<AttachResult> => {
      const images = files.filter((file) => isAcceptedMime(file.type));
      if (images.length === 0) {
        const text = "拖进来的不是 png / jpeg / gif / webp / bmp，不收";
        setMessage(text);
        return { refs: [], ids: [], message: text };
      }
      setBusy(true);
      setMessage(null);
      const refs: string[] = [];
      const ids: string[] = [];
      let note: string | null = null;
      let used = 0;
      for (const file of images) {
        if (used + MEDIA_REF_BUDGET > room) {
          note = `这里只剩 ${Math.max(0, room - used)} 个字，放不下更多图片引用`;
          break;
        }
        try {
          const prepared = await prepareImage(file);
          const meta = await mediaSave({
            noteId,
            mime: prepared.mime,
            dataBase64: prepared.dataBase64,
            width: prepared.width,
            height: prepared.height,
            private: isPrivate,
          });
          const ref = mediaRef(meta.id, file.name);
          refs.push(ref);
          ids.push(meta.id);
          used += ref.length + 2;
        } catch (error) {
          note = describeError(error);
        }
      }
      setBusy(false);
      setMessage(note);
      return { refs, ids, message: note };
    },
    [noteId],
  );

  const clearMessage = useCallback((): void => {
    setMessage(null);
  }, []);

  return { busy, message, clearMessage, attach };
}
