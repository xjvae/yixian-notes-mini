// 提醒到期分档 — 没有系统通知、没有调度器，这个角标就是用户唯一的信号来源。
// 按**所在日历天**分档（不是按 24 小时差），当天已过点要说「（已过点）」，
// 否则用户会在晚上 10 点读到「今天 18:00」并以为还在排队。
//
// 全部纯函数；`now` 永远显式传入——别把"跑测试的时分"变成隐式输入。

import type { ReminderRepeat } from "@/platform/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DueView {
  state: "none" | "done" | "overdue" | "today" | "tomorrow" | "soon" | "later";
  text: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function timeText(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相差几个日历天（b - a）。逐日走，跨 DST 边界不会漂出一小时 */
export function calendarDaysBetween(a: Date, b: Date): number {
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

export function describeDue(
  dueAt: number | null,
  doneAt: number | null,
  now: number,
): DueView {
  if (dueAt === null) return { state: "none", text: "" };
  if (doneAt !== null) return { state: "done", text: "已完成" };
  const due = new Date(dueAt);
  const nowDate = new Date(now);
  const days = calendarDaysBetween(nowDate, due);
  if (days < 0) {
    const n = -days;
    return { state: "overdue", text: `逾期 ${n} 天` };
  }
  if (days === 0) {
    const passed = dueAt < now;
    return {
      state: "today",
      text: `今天 ${timeText(dueAt)}${passed ? "（已过点）" : ""}`,
    };
  }
  if (days === 1) return { state: "tomorrow", text: `明天 ${timeText(dueAt)}` };
  if (days <= 7) return { state: "soon", text: `${days} 天后` };
  return {
    state: "later",
    text: `${due.getMonth() + 1}月${due.getDate()}日 ${timeText(dueAt)}`,
  };
}

/**
 * 重复提醒的下一个到期点：保持"日历天 + 墙上时刻"，天数按日历推进。
 * 勾选完成时调用（repeat=none 的完成没有"下一次"）。
 * 夏令时跳过某一时刻的极端情形由 Date 归一化到有效时刻，不自己造轮。
 */
export function nextOccurrence(dueAt: number, repeat: ReminderRepeat): number | null {
  if (repeat === "none") return null;
  const due = new Date(dueAt);
  const step = repeat === "daily" ? 1 : 7;
  const next = new Date(
    due.getFullYear(),
    due.getMonth(),
    due.getDate() + step,
    due.getHours(),
    due.getMinutes(),
  );
  return next.getTime();
}

/** epoch ms → datetime-local 输入值（本地时区） */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 输入值 → epoch ms；空串/非法返回 null */
export function fromLocalInputValue(value: string): number | null {
  if (value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
