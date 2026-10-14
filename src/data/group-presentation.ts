// 叠窗的呈现方式 — 分页翻 / 侧边色块签 / 手风琴，模块级状态 + 订阅。默认 pages（能一眼退回熟悉的那套）。
// 三档共用同一份成员序与同一个 currentId（见 window/stack-model.ts），切档不动数据。
// 已删的三档（层叠卡片/扇形/网格，2026-10-08）：库里还写着这三个值时白名单认不出，自动回落 pages。
// 跨窗同步照 scheme.ts 同一条路：改档窗落库，别的窗收 `db:changed{kind:"setting"}` 重读；本窗读内存份，切档立刻生效。

import { useSyncExternalStore } from "react";
import { listen } from "@/platform/bridge";
import { getSetting, settingsSet } from "@/platform/commands";
import { DB_CHANGED } from "@/platform/contracts";
import type { DbChangedEvent } from "@/platform/contracts";
import { logger } from "@/platform/logger";

const SCOPE = "group-view";
const SETTING_KEY = "group.presentation";

/** 白名单就是档位表本身：设置窗的选项、库里的取值、这里的判定共用一份 */
export const GROUP_PRESENTATIONS = ["pages", "tabs", "accordion"] as const;

export type GroupPresentation = (typeof GROUP_PRESENTATIONS)[number];

let current: GroupPresentation = "pages";
let version = 0;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function isPresentation(value: string | null): value is GroupPresentation {
  return value !== null && (GROUP_PRESENTATIONS as readonly string[]).includes(value);
}

function changeTo(next: GroupPresentation, persist: boolean): void {
  if (next === current) return;
  current = next;
  emit();
  if (persist) {
    void settingsSet(SETTING_KEY, next).catch((error: unknown) =>
      logger.caught(SCOPE, "叠窗呈现方式落库失败（本次只在本窗生效）", error),
    );
  }
}

/** 挂载前调用：读库 → 挂跨窗订阅。幂等。 */
export async function initGroupPresentation(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const stored = await getSetting(SETTING_KEY);
    if (isPresentation(stored)) current = stored;
  } catch (error) {
    logger.caught(SCOPE, "读叠窗呈现方式失败，按分页", error);
  }
  emit();
  await listen<DbChangedEvent>(DB_CHANGED, (payload) => {
    if (payload.kind !== "setting") return;
    void getSetting(SETTING_KEY)
      .then((stored) => changeTo(isPresentation(stored) ? stored : "pages", false))
      .catch((error: unknown) => logger.caught(SCOPE, "跨窗同步叠窗呈现方式失败", error));
  });
}

export function changeGroupPresentation(next: GroupPresentation): void {
  changeTo(next, true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前档。version 作原语快照（对象字面量会触发重渲染循环） */
export function useGroupPresentation(): GroupPresentation {
  useSyncExternalStore(subscribe, () => version);
  return current;
}
