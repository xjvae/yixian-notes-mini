// 窗口身份 — "这扇窗是谁"的唯一出处是 Rust 注入的初始化脚本（float.rs / card.rs）。
// 注入全局名 `__STICKY_ID__` / `__STICKY_GROUP_ID__` / `__REMINDER__` 互斥，是跨语言契约
// （platform/contracts.ts）。

import type { ReminderCardPayload } from "@/platform/contracts";

declare global {
  interface Window {
    __STICKY_ID__?: string;
    __STICKY_GROUP_ID__?: string;
    __STICKY_FOCUS_ID__?: string;
    __STICKY_COLLAPSED__?: boolean;
    __REMINDER__?: ReminderCardPayload;
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

/**
 * 叠窗开出来就是收起的吗。**只读一次**（挂载时）：窗的出生尺寸由 Rust 按组行定，
 * 前端要等 `group_list` 回来才知道那一档，首帧就会在 62 高的条里画一整张正文。
 * 之后的开合归这扇窗自己的状态（与 `pinned` 同一口径）。
 */
export function getStackCollapsedAtBirth(): boolean {
  return window.__STICKY_COLLAPSED__ === true;
}

/**
 * 这扇窗是提醒卡吗（`windows/card.rs` 注入的那一份）。null = 不是卡。
 * 只认注入的字段形状，不猜：缺 title/stickyId 就当没有，免得把半份 payload 画成一张卡。
 */
export function getReminderCard(): ReminderCardPayload | null {
  const injected = window.__REMINDER__;
  if (
    injected === undefined ||
    typeof injected.title !== "string" ||
    typeof injected.stickyId !== "string"
  ) {
    return null;
  }
  return {
    title: injected.title,
    text: typeof injected.text === "string" ? injected.text : "",
    stickyId: injected.stickyId,
    groupId: typeof injected.groupId === "string" ? injected.groupId : null,
    // 认不到就留空串：`themeColors` 自己会回落到默认那张纸，这里不另抄一份默认值
    theme: typeof injected.theme === "string" ? injected.theme : "",
  };
}
