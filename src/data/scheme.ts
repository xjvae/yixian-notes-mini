// 主题三档 — 浅色 / 深色 / 跟随系统。模块级状态 + useSyncExternalStore 订阅。
//
// 两条设计决定：
//  · **注入必须发生在模块加载期之前可用**：结论落 `<html data-theme>`，CSS 的深色
//    层按这个属性命中。initScheme 在 boot 挂载前 await——晚了就先闪一帧浅色。
//  · 持久化走主库 settings（本架构没有 localStorage），跨窗同步借 `db:changed
//    {kind:"setting"}` 广播：设置窗改了档，其它窗重读并即时换色。
//
// 便签的纸色/强调色走内联样式，CSS 盖不住——成对的深色值住在 theme.ts（themeColors）。

import { useSyncExternalStore } from "react";
import { listen } from "@/platform/bridge";
import { getSetting, settingsSet } from "@/platform/commands";
import { DB_CHANGED } from "@/platform/contracts";
import type { DbChangedEvent } from "@/platform/contracts";
import { logger } from "@/platform/logger";

const SCOPE = "scheme";
const SETTING_KEY = "scheme";

export type SchemeSetting = "light" | "dark" | "system";
export type ResolvedScheme = "light" | "dark";

let setting: SchemeSetting = "system";
let resolved: ResolvedScheme = "light";
let version = 0;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function resolveFrom(setting: SchemeSetting): ResolvedScheme {
  if (setting !== "system") return setting;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(): void {
  document.documentElement.dataset.theme = resolved;
}

function changeTo(next: SchemeSetting, persist: boolean): void {
  if (next === setting) {
    apply();
    return;
  }
  setting = next;
  resolved = resolveFrom(next);
  apply();
  emit();
  if (persist) {
    void settingsSet(SETTING_KEY, next).catch((error: unknown) =>
      logger.caught(SCOPE, "主题设置落库失败（本次只在本窗生效）", error),
    );
  }
}

function isSchemeSetting(value: string | null): value is SchemeSetting {
  return value === "light" || value === "dark" || value === "system";
}

/** 挂载前调用：读库 → 应用 → 挂订阅（系统档跟随 + 跨窗广播）。幂等。 */
export async function initScheme(): Promise<void> {
  if (initialized) {
    apply();
    return;
  }
  initialized = true;
  try {
    const stored = await getSetting(SETTING_KEY);
    if (isSchemeSetting(stored)) setting = stored;
  } catch (error) {
    logger.caught(SCOPE, "读主题设置失败，按跟随系统", error);
  }
  resolved = resolveFrom(setting);
  apply();
  emit();

  // 系统档跟随系统切换
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (setting !== "system") return;
    resolved = resolveFrom("system");
    apply();
    emit();
  });

  // 跨窗同步：别的窗改了档，本窗重读
  await listen<DbChangedEvent>(DB_CHANGED, (payload) => {
    if (payload.kind !== "setting") return;
    void getSetting(SETTING_KEY)
      .then((stored) => {
        changeTo(isSchemeSetting(stored) ? stored : "system", false);
      })
      .catch((error: unknown) => logger.caught(SCOPE, "跨窗同步主题失败", error));
  });
}

export function changeScheme(next: SchemeSetting): void {
  changeTo(next, true);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

/** 读当前档与解析结果。version 作原语快照（对象字面量会触发重渲染循环） */
export function useScheme(): { setting: SchemeSetting; resolved: ResolvedScheme } {
  useSyncExternalStore(subscribe, getVersion);
  return { setting, resolved };
}
