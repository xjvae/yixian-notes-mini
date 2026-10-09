// 私密层状态 — "配没配过 / 解没解锁"这两格事实的 owner（真身在 Rust 内存里，
// 这里的只是订阅面）。便签窗的遮罩、标记私密的引导、托盘锁定都读它。
//
// 跨窗同步：Rust 在每条私密写命令后广播 `store:private-changed`，本模块收到就重读
// 状态并通知订阅者；store 侧由 boot 接了 onPrivateLayerChange → refreshStore，
// 于是"解锁成功"和"锁定"都会让便签内容即时合并/隐去。

import { useSyncExternalStore } from "react";
import { listen } from "@/platform/bridge";
import { privateStatus } from "@/platform/commands";
import { PRIVATE_CHANGED } from "@/platform/contracts";
import type { PrivateStatus, StickyNote } from "@/platform/contracts";
import { logger } from "@/platform/logger";

const SCOPE = "private-state";

export interface PrivateLayerState {
  /** 已设置私密密码 */
  active: boolean;
  /** 当前会话已解锁 */
  unlocked: boolean;
}

let state: PrivateLayerState = { active: false, unlocked: false };
let version = 0;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

async function refetch(): Promise<void> {
  try {
    const status: PrivateStatus = await privateStatus();
    state = { active: status.configured, unlocked: status.unlocked };
    emit();
  } catch (error) {
    logger.caught(SCOPE, "读私密层状态失败", error);
  }
}

/** 挂载前调用一次（幂等）。之后状态变化全靠广播驱动。 */
export async function initPrivateState(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refetch();
  await listen(PRIVATE_CHANGED, () => {
    void refetch();
  });
}

/** 私密层事件后主动重读（解锁窗自己提交成功时用，不等广播往返） */
export async function syncPrivateState(): Promise<void> {
  await refetch();
}

export function getPrivateState(): PrivateLayerState {
  return state;
}

export function isPrivateLayerActive(): boolean {
  return state.active;
}

export function isPrivateUnlocked(): boolean {
  return state.unlocked;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 订阅别名：语义是"私密层状态变了"，boot 拿它接 refreshStore */
export const onPrivateLayerChange = subscribe;

function getVersion(): number {
  return version;
}

export function usePrivateState(): PrivateLayerState {
  useSyncExternalStore(subscribe, getVersion);
  return state;
}

/**
 * 遮罩态的唯一口径：私密 且（没配过 或 没解锁）。真身不在内存里 ——
 * 标题、正文、标签，以及侧签上那个用户自己挑的图标，都算泄露面，所以谁要画遮罩
 * 都问这一处，不许在视图里各写一遍 `private && !unlocked`。
 */
export function isMasked(
  note: Pick<StickyNote, "private">,
  priv: PrivateLayerState,
): boolean {
  return note.private && (!priv.active || !priv.unlocked);
}
