// useMedia — 按 id 把图取成能直接进 `<img src>` 的 data: URL，模块级缓存：
// 同一张图会在单窗/叠窗/导出里各出现一次，每张都问库就是几 MB 字节走两趟 IPC。
// 没揭开时解不开（PRIVATE_LOCKED），那次结果既不进缓存也不留负结果——否则揭开后那一屏还挂着"看不见"。
// 另记一笔 fromSealed（取回那刻有张开着的 id）：那些是解出来的字节，收回时只清这批，公开那批跟着清是白跑 IPC。
// data: 而非 blob:：CSP 两个都放行（tauri.conf.json），data: 少一层 createObjectURL 与释放时机。

import { useEffect, useState } from "react";
import { mediaGet } from "@/platform/commands";
import { hasRevealed, registerPrivateScrub } from "@/data/private-state";
import { isAppError } from "@/platform/errors";

export type MediaState = "loading" | "ok" | "missing" | "locked" | "error";

export interface MediaResult {
  state: MediaState;
  url: string | null;
  message: string | null;
}

const urls = new Map<string, string>();
const pending = new Map<string, Promise<MediaResult>>();
const fromSealed = new Set<string>();

/** 有张被收回那一刻由 private-state 回调（注册在下面）。清完这一屏先回空白，
 *  下次 loadMedia 问过库再落回来——那时没开着就是 locked 态，跟遮罩一起"看不见" */
export function evictDecryptedMedia(): void {
  for (const id of fromSealed) urls.delete(id);
  fromSealed.clear();
}

// 模块加载时就登记：谁持有缓存谁负责清，不必每个入口都记得调用（漏一处就是留着泄露面）
registerPrivateScrub(evictDecryptedMedia);

export function loadMedia(id: string): Promise<MediaResult> {
  const cached = urls.get(id);
  if (cached !== undefined)
    return Promise.resolve({ state: "ok", url: cached, message: null });
  const inflight = pending.get(id);
  if (inflight !== undefined) return inflight;

  // 出发时"有没有张开着"决定这份字节该不该留在缓存里：收回在请求途中落下来的，
  // 这一屏可以用，但不能落进模块级缓存（那一格没人再清了）
  const startedOpen = hasRevealed();
  const task = mediaGet(id)
    .then((bytes): MediaResult => {
      if (bytes === null) return { state: "missing", url: null, message: null };
      const url = `data:${bytes.mime};base64,${bytes.dataBase64}`;
      if (startedOpen && !hasRevealed()) {
        return { state: "ok", url, message: null };
      }
      urls.set(id, url);
      // 认的是"取回来那一刻"而不是"这行加密过没有"（命令不回收缩标记）：
      // 锁着还能拿到的字节必然是公开的，多记一个 id 只是多清一次，少记才是泄露
      if (startedOpen) fromSealed.add(id);
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
  fromSealed.delete(id);
}

export function useMedia(id: string): MediaResult {
  // null = 还没问过库；不在 effect 里同步 setState（白多一次渲染），渲染期把"没结果"表达成 loading 就够
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
