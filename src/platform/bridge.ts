// 桥 — 与 Tauri 运行时接触的唯一入口（platform 层之外禁止 import @tauri-apps/*，
// 由 eslint no-restricted-imports 守住，见 eslint.config.js）。
//
// invoke/listen 走动态 import + 记忆化：模块加载零 Tauri 成本，node 单测环境
// 不小心触发也不会崩。窗口 API 是唯一例外：静态 import（对外给同步 currentWindow），
// 因为 label 这类读法散布在渲染期同步路径上，动态化会把整条链路拖进 promise。

import { type Window, getCurrentWindow } from "@tauri-apps/api/window";

/** 我们真正用到的 core 表面（避免 typeof import() 注解，也顺便收窄可依赖面） */
interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

let corePromise: Promise<TauriCore> | null = null;

function tauriCore(): Promise<TauriCore> {
  corePromise ??= import("@tauri-apps/api/core").then((module) => module);
  return corePromise;
}

/** 调用后端命令。命令名是跨语言契约（contracts.ts / lib.rs generate_handler!） */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await tauriCore();
  return core.invoke<T>(cmd, args);
}

/** 订阅后端事件（回调直接拿负载，Event 包装在这一层剥掉）。返回解绑函数 */
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  return tauriListen<T>(event, (event) => handler(event.payload));
}

/** 当前窗口（同步）。渲染期可用 */
export function currentWindow(): Window {
  return getCurrentWindow();
}

/** 当前窗口 label（同步） */
export function currentWindowLabel(): string {
  return getCurrentWindow().label;
}

/**
 * 改内容区尺寸并保持窗口左上角物理位置不动。
 * Windows 的不可见阴影边框会让"改尺寸"顺带挪窗，所以量到的位置要在改完之后原样放回；
 * 位置用物理像素（量出来什么样放回去就是什么样），尺寸用逻辑像素。
 */
export async function resizeKeepingPosition(
  width: number,
  height: number,
): Promise<void> {
  const win = getCurrentWindow();
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  const position = await win.outerPosition();
  await win.setSize(new LogicalSize(width, height));
  await win.setPosition(position);
}
