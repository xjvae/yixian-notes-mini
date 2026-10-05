// 预览台的窗内侧 — 装替身桥（platform/bridge 的 DevBridge）。
//
// 一扇 iframe = 一扇窗：label、注入的 __STICKY_ID__/__STICKY_GROUP_ID__、初始几何，
// 全部由宿主（entries/preview.tsx）经查询串交进来，本页自己不猜。
// RPC 走 postMessage 到宿主父帧；事件（db:changed）与合成的 moved/resized 由宿主推回来。
//
// 只实现 app 真用到的那几个 Window 方法（见 bridge.ts 顶注与 grep 面）：
// 没实现的方法一碰就抛，预览台不装出一副"什么都验过"的样子。

import { installDevBridge, type DevBridge } from "@/platform/bridge";

interface WireRequest {
  t: "ipc";
  id: number;
  cmd: string;
  args: Record<string, unknown> | undefined;
  label: string;
}
interface WireWindowOp {
  t: "winop";
  op: "resize" | "frame" | "focus";
  label: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

type GeometryHandler = (
  payload: { width: number; height: number } | { x: number; y: number },
) => void;

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** 宿主给的初始几何与身份；不在预览上下文里就返回 null */
export function readPreviewContext(): {
  label: string;
  rect: { x: number; y: number; width: number; height: number };
} | null {
  const search = params();
  if (!search.has("preview")) return null;
  const label = search.get("label");
  if (label === null) return null;
  const stickyId = search.get("stickyId");
  const groupId = search.get("groupId");
  const focus = search.get("focus");
  // 注入全局与 Rust 的 initialization_script 同形（float.rs 的跨语言契约）
  if (stickyId !== null) {
    window.__STICKY_ID__ = stickyId;
    delete window.__STICKY_GROUP_ID__;
  }
  if (groupId !== null) {
    window.__STICKY_GROUP_ID__ = groupId;
    delete window.__STICKY_ID__;
    if (focus !== null) window.__STICKY_FOCUS_ID__ = focus;
  }
  return {
    label,
    rect: {
      x: Number(search.get("x") ?? 0),
      y: Number(search.get("y") ?? 0),
      width: Number(search.get("w") ?? 320),
      height: Number(search.get("h") ?? 300),
    },
  };
}

export function installPreviewBridge(): void {
  const context = readPreviewContext();
  if (context === null) return;

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const movedHandlers = new Set<GeometryHandler>();
  const resizedHandlers = new Set<GeometryHandler>();
  let rect = { ...context.rect };
  let seq = 0;

  const toParent = (message: WireRequest | WireWindowOp): void => {
    window.parent.postMessage(message, window.location.origin);
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as
      | {
          t: "reply";
          id: number;
          ok: boolean;
          result?: unknown;
          error?: { code: string; message: string };
        }
      | { t: "event"; event: string; payload: unknown }
      | { t: "geom"; x?: number; y?: number; width?: number; height?: number };
    if (!data || typeof data !== "object") return;
    if (data.t === "reply") {
      const entry = pending.get(data.id);
      if (entry === undefined) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      // Rust 的 AppError 到前端是 {code,message} 的裸对象（不是 Error），这里同形
      else entry.reject(data.error ?? { code: "PREVIEW", message: "预览台命令失败" });
    }
    if (data.t === "event") {
      for (const handler of eventHandlers.get(data.event) ?? []) handler(data.payload);
    }
    if (data.t === "geom") {
      if (data.x !== undefined && data.y !== undefined) {
        rect = { ...rect, x: data.x, y: data.y };
        for (const handler of movedHandlers) handler({ x: data.x, y: data.y });
      }
      if (data.width !== undefined && data.height !== undefined) {
        rect = { ...rect, width: data.width, height: data.height };
        for (const handler of resizedHandlers)
          handler({ width: data.width, height: data.height });
      }
    }
  });

  const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = (seq += 1);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      toParent({ t: "ipc", id, cmd, args, label: context.label });
      // 宿主不在（页面被单独打开）时别把 Promise 挂死
      window.setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`预览台没回应命令 ${cmd}（宿主页还在吗）`));
        }
      }, 4000);
    });

  /** 替身窗对象：只给 app 用到的那几个方法，其余抛出明示 */
  const fakeWindow = {
    label: context.label,
    scaleFactor: (): Promise<number> => Promise.resolve(1),
    outerPosition: (): Promise<{ x: number; y: number }> =>
      Promise.resolve({ x: rect.x, y: rect.y }),
    innerSize: (): Promise<{ width: number; height: number }> =>
      Promise.resolve({ width: rect.width, height: rect.height }),
    setSize: (size: { width: number; height: number }): Promise<void> => {
      toParent({
        t: "winop",
        op: "resize",
        label: context.label,
        width: size.width,
        height: size.height,
      });
      return Promise.resolve();
    },
    setPosition: (position: { x: number; y: number }): Promise<void> => {
      toParent({
        t: "winop",
        op: "frame",
        label: context.label,
        x: position.x,
        y: position.y,
      });
      return Promise.resolve();
    },
    // 预览台没有真实层级：记下就算（置顶是否真生效归 M5 真机清单）
    setAlwaysOnTop: (): Promise<void> => Promise.resolve(),
    onMoved: (
      handler: (event: { payload: { x: number; y: number } }) => void,
    ): Promise<() => void> => {
      const wrapped: GeometryHandler = (payload) =>
        handler({ payload: payload as { x: number; y: number } });
      movedHandlers.add(wrapped);
      return Promise.resolve(() => {
        movedHandlers.delete(wrapped);
      });
    },
    onResized: (
      handler: (event: { payload: { width: number; height: number } }) => void,
    ): Promise<() => void> => {
      const wrapped: GeometryHandler = (payload) =>
        handler({ payload: payload as { width: number; height: number } });
      resizedHandlers.add(wrapped);
      return Promise.resolve(() => {
        resizedHandlers.delete(wrapped);
      });
    },
    setFocus: (): Promise<void> => {
      toParent({ t: "winop", op: "focus", label: context.label });
      return Promise.resolve();
    },
  };

  const bridge: DevBridge = {
    label: context.label,
    invoke,
    window: fakeWindow as unknown as DevBridge["window"],
    listen: <T>(event: string, handler: (payload: T) => void): Promise<() => void> => {
      const set = eventHandlers.get(event) ?? new Set();
      const wrapped = handler as (payload: unknown) => void;
      set.add(wrapped);
      eventHandlers.set(event, set);
      return Promise.resolve(() => {
        set.delete(wrapped);
      });
    },
    resizeKeepingPosition: (width: number, height: number): Promise<void> => {
      toParent({ t: "winop", op: "resize", label: context.label, width, height });
      return Promise.resolve();
    },
    setWindowFrame: (
      x: number,
      y: number,
      width: number,
      height: number,
    ): Promise<void> => {
      toParent({ t: "winop", op: "frame", label: context.label, x, y, width, height });
      return Promise.resolve();
    },
  };
  installDevBridge(bridge);
}
