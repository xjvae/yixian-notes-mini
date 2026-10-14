// 私密层状态 — "配没配过 + 现在开着哪几张"的订阅面（真身在 Rust 内存里）。遮罩、引导、托盘锁定都读它。
// 逐张模型：没有全局 unlocked 这一格，只有已揭开的 id 列表；同一屏可以两扇窗摊着真身、其余蒙着。
// 跨窗同步：Rust 在每条私密写命令后广播 store:private-changed，收到就重读状态并通知订阅者。

import { useSyncExternalStore } from "react";
import { listen } from "@/platform/bridge";
import { privateStatus } from "@/platform/commands";
import { PRIVATE_CHANGED } from "@/platform/contracts";
import type { PrivateStatus, StickyNote } from "@/platform/contracts";
import { logger } from "@/platform/logger";

const SCOPE = "private-state";

export interface PrivateLayerState {
  active: boolean;
  /** 封套读不出来：不是"没设置"，是"有东西但打不开"，口令窗据此只给重置这一条出路 */
  damaged: boolean;
  revealed: readonly string[];
}

let state: PrivateLayerState = { active: false, damaged: false, revealed: [] };
let version = 0;
let initialized = false;
const listeners = new Set<() => void>();
/** 持有解密字节的模块（如 use-media 的图）在收回时要抹掉自己那份，在这里登记。
 *  不直接 import：这一层在 `features/` 之下，反向依赖会成环 */
const scrubbers = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

async function refetch(): Promise<void> {
  try {
    const status: PrivateStatus = await privateStatus();
    const before = new Set(state.revealed);
    state = {
      active: status.configured,
      damaged: status.damaged,
      revealed: status.revealed,
    };
    // 只在真的有张被收回那一刻擦：广播是无条件发的，拿它当擦除时机会把缓存清得莫名其妙，
    // 漏掉这一次就是留着明文等人取。收回只有 hide_all 一条路，整层字节一起擦就够
    if (state.revealed.length < before.size) for (const scrub of scrubbers) scrub();
    emit();
  } catch (error) {
    logger.caught(SCOPE, "读私密层状态失败", error);
  }
}

export function registerPrivateScrub(scrub: () => void): () => void {
  scrubbers.add(scrub);
  return () => scrubbers.delete(scrub);
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

/** 私密层事件后主动重读（口令窗自己提交成功时用，不等广播往返） */
export async function syncPrivateState(): Promise<void> {
  await refetch();
}

export function getPrivateState(): PrivateLayerState {
  return state;
}

export function isPrivateLayerActive(): boolean {
  return state.active;
}

/** **这一张**开着吗；"有没有任何张开着"是另一格，问 hasRevealed */
export function isRevealed(id: string): boolean {
  return state.revealed.includes(id);
}

/** 有没有任何一张开着。自动上锁那一条时钟与 `flushNow` 的时机问这一格 */
export function hasRevealed(): boolean {
  return state.revealed.length > 0;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 订阅别名：boot 拿它接 refreshStore */
export const onPrivateLayerChange = subscribe;

function getVersion(): number {
  return version;
}

export function usePrivateState(): PrivateLayerState {
  useSyncExternalStore(subscribe, getVersion);
  return state;
}

/** 遮罩态的唯一口径：私密 且（没配过 或 **这一张没揭开**）——标题、正文、标签、侧签图标都是泄露面，
 *  谁要画遮罩都问这一处，不许在视图里各写一遍。没配过也蒙（内容还没被保护过），
 *  界面靠 `active` 把它与"锁着"分开说（引导分岔） */
export function isMasked(
  note: Pick<StickyNote, "id" | "private">,
  priv: PrivateLayerState,
): boolean {
  return note.private && !priv.revealed.includes(note.id);
}
