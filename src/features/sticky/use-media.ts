// useMedia — 按 id 把库里那张图取成能直接进 `<img src>` 的 data: URL。
//
// 缓存为什么在模块级而不是组件 state：同一张图会在单窗、叠窗当前页、以后可能的
// 导出里各出现一次，每张都问一遍库就是几 MB 字节走两趟 IPC（序列化一次、反序列化一次）。
//
// **只缓存拿到的字节**：锁定态解不开（PRIVATE_LOCKED）不进缓存也不留负结果——
// 否则解锁之后那一屏还挂着"看不见"，用户得再点一下才刷新，那是把一次锁当成了永久状态。
//
// data: 而不是 blob:：CSP 是 `img-src 'self' data: blob:`（tauri.conf.json:21），
// 两个都放行；data: 少一层 createObjectURL 与它的释放时机，字节本来就在内存里。

import { useEffect, useState } from "react";
import { mediaGet } from "@/platform/commands";
import { isAppError } from "@/platform/errors";

export type MediaState = "loading" | "ok" | "missing" | "locked" | "error";

export interface MediaResult {
  state: MediaState;
  url: string | null;
  /** state=error 时给用户看的一句话 */
  message: string | null;
}

const urls = new Map<string, string>();
const pending = new Map<string, Promise<MediaResult>>();

/** 取一张图。命中缓存就是同步完成（返回的 promise 已 resolve） */
export function loadMedia(id: string): Promise<MediaResult> {
  const cached = urls.get(id);
  if (cached !== undefined)
    return Promise.resolve({ state: "ok", url: cached, message: null });
  const inflight = pending.get(id);
  if (inflight !== undefined) return inflight;

  const task = mediaGet(id)
    .then((bytes): MediaResult => {
      if (bytes === null) return { state: "missing", url: null, message: null };
      const url = `data:${bytes.mime};base64,${bytes.dataBase64}`;
      urls.set(id, url);
      return { state: "ok", url, message: null };
    })
    .catch((error: unknown): MediaResult => {
      if (isAppError(error) && error.code === "PRIVATE_LOCKED") {
        return { state: "locked", url: null, message: null };
      }
      return {
        state: "error",
        url: null,
        message: isAppError(error) ? error.message : String(error),
      };
    });
  pending.set(id, task);
  return task.finally(() => {
    pending.delete(id);
  });
}

/** 图被删掉时顺手清缓存：同一个 id 不会被复用（id 带毫秒与序号），但这一屏别留着旧字节 */
export function forgetMedia(id: string): void {
  urls.delete(id);
}

export function useMedia(id: string): MediaResult {
  // null = 还没问过库。不在 effect 里同步 setState（那是白多一次渲染），
  // 渲染期把"还没结果"这件事表达成 loading 就够
  const [result, setResult] = useState<MediaResult | null>(null);

  useEffect(() => {
    if (id === "") return;
    let alive = true;
    void loadMedia(id).then((next) => {
      if (alive) setResult(next);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  if (id === "") return { state: "missing", url: null, message: null };
  return result ?? { state: "loading", url: null, message: null };
}
