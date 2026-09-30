// 窗口身份 — "这扇窗是谁"的唯一出处是 Rust 注入的初始化脚本（factory.rs）。
// 注入全局名 `__STICKY_ID__` 是跨语言契约（platform/contracts.ts）。

declare global {
  interface Window {
    __STICKY_ID__?: string;
  }
}

/** 本窗承载的便签 id。null = 打开方式不对（不带 id 的 main 入口） */
export function getStickyId(): string | null {
  const id = window.__STICKY_ID__;
  return typeof id === "string" && id !== "" ? id : null;
}
