// 窗口身份 — "这扇窗是谁"的唯一出处是 Rust 注入的初始化脚本（float.rs）。
// 注入全局名 `__STICKY_ID__` / `__STICKY_GROUP_ID__` 互斥，是跨语言契约（platform/contracts.ts）。

declare global {
  interface Window {
    __STICKY_ID__?: string;
    __STICKY_GROUP_ID__?: string;
    __STICKY_FOCUS_ID__?: string;
  }
}

function injected(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 本窗承载的便签 id。null = 不是单窗（叠窗，或打开方式不对） */
export function getStickyId(): string | null {
  return injected(window.__STICKY_ID__);
}

/** 本窗承载的组 id。null = 不是叠窗 */
export function getGroupId(): string | null {
  return injected(window.__STICKY_GROUP_ID__);
}

/** 叠窗开局该落在哪一张（冷开时 Rust 随组 id 一起注入）。null = 用默认首张 */
export function getStickyFocusId(): string | null {
  return injected(window.__STICKY_FOCUS_ID__);
}
