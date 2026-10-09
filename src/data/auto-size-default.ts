// 「随内容自动长高」的全局默认 — 模块级状态 + 订阅，形状照 group-presentation.ts 抄。
//
// 为什么要有"全局默认 + 单张覆盖"两层：这个模式一旦全局开着，就得还能让某一张回到
// 手拉的固定尺寸（便签上 `autoSize` 那一列的三态：null 跟这里走、true/false 是表过态）。
// 只留全局开关，一张不听话的签就得改全局；只留单张，想全开就得一张张点。
//
// 取值口径与 `ring.charging` 那条**反过来**：那边"0 才是关"（默认开着是既有行为），
// 这里"1 才算开"——缺键、脏值、读失败一律按关算。理由：这是一条会改变窗体尺寸行为的
// 新开关，脏值把它悄悄打开，用户看到的是"便签自己乱跳"，那比"没开"难查得多。
//
// 跨窗同步照同一条路：改的窗落库，别的窗收 `db:changed{kind:"setting"}` 重读。

import { useSyncExternalStore } from "react";
import { listen } from "@/platform/bridge";
import { getSetting, settingsSet } from "@/platform/commands";
import { DB_CHANGED } from "@/platform/contracts";
import type { DbChangedEvent } from "@/platform/contracts";
import { logger } from "@/platform/logger";

const SCOPE = "auto-size";
export const AUTO_SIZE_SETTING_KEY = "sticky.auto_size";

let current = false;
let version = 0;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function changeTo(next: boolean, persist: boolean): void {
  if (next === current) return;
  current = next;
  emit();
  if (persist) {
    void settingsSet(AUTO_SIZE_SETTING_KEY, next ? "1" : "0").catch((error: unknown) =>
      logger.caught(SCOPE, "自动尺寸开关落库失败（本次只在本窗生效）", error),
    );
  }
}

/** 挂载前调用：读库 → 挂跨窗订阅。幂等。 */
export async function initAutoSizeDefault(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    current = (await getSetting(AUTO_SIZE_SETTING_KEY)) === "1";
  } catch (error) {
    logger.caught(SCOPE, "读自动尺寸开关失败，按关", error);
    current = false;
  }
  emit();
  await listen<DbChangedEvent>(DB_CHANGED, (payload) => {
    if (payload.kind !== "setting") return;
    void getSetting(AUTO_SIZE_SETTING_KEY)
      .then((stored) => changeTo(stored === "1", false))
      .catch((error: unknown) => logger.caught(SCOPE, "跨窗同步自动尺寸开关失败", error));
  });
}

export function setAutoSizeDefault(on: boolean): void {
  changeTo(on, true);
}

/** 当前全局默认（非 hook 场合用，如 store 里的判定） */
export function autoSizeDefault(): boolean {
  return current;
}

/** 当前全局默认。version 作原语快照，理由同 group-presentation */
export function useAutoSizeDefault(): boolean {
  useSyncExternalStore(subscribe, () => version);
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
