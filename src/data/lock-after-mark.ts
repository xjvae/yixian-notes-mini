// 「输完口令标记私密之后，要不要立刻把这层锁回去」——设置键与跨窗同步。
//
// 三档（2026-10-12 作者拍的，与"自动上锁"那组同一种控件）：
//  · never 不锁：输完口令保持解锁；
//  · now   立即锁：补做完标记就直接 private_lock，不再问；
//  · ask   每次问我（默认）：标记补做完后，页脚那颗锁钮变成 5 秒的确认态，点它才锁。
//
// 缺键与脏值一律回到 ask：这条锁不住内容也伤不到内容，但"悄悄不锁"和"悄悄锁上"
// 都会让人以为按了另一个意思的钮，所以宁可当场问一句。
//
// 只在**真的走过口令窗**那条路上生效（锁着点"标记私密"→ 输口令 → 补做）。
// 已经解锁时点标记，他没输过密码，就不该被问"要不要立即锁定"。

import { useSyncExternalStore } from "react";
import { listen } from "@/platform/bridge";
import { getSetting, settingsSet } from "@/platform/commands";
import { DB_CHANGED } from "@/platform/contracts";
import type { DbChangedEvent } from "@/platform/contracts";
import { logger } from "@/platform/logger";

const SCOPE = "lock-after-mark";
export const LOCK_AFTER_MARK_KEY = "private.lock_after_mark";

export type LockAfterMark = "never" | "now" | "ask";

/** 三档读法：脏值/缺键回到"每次问我" */
export function lockAfterMarkFrom(stored: string | null): LockAfterMark {
  return stored === "never" || stored === "now" ? stored : "ask";
}

let current: LockAfterMark = "ask";
let version = 0;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 挂载前调用一次（幂等）。之后靠 `db:changed{kind:"setting"}` 跟着别的窗同步 */
export async function initLockAfterMark(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    current = lockAfterMarkFrom(await getSetting(LOCK_AFTER_MARK_KEY));
  } catch (error) {
    logger.caught(SCOPE, "读锁档失败，按每次问我", error);
    current = "ask";
  }
  emit();
  await listen<DbChangedEvent>(DB_CHANGED, (payload) => {
    if (payload.kind !== "setting") return;
    void getSetting(LOCK_AFTER_MARK_KEY)
      .then((stored) => {
        const next = lockAfterMarkFrom(stored);
        if (next === current) return;
        current = next;
        emit();
      })
      .catch((error: unknown) => logger.caught(SCOPE, "跨窗同步锁档失败", error));
  });
}

export function setLockAfterMark(mode: LockAfterMark): void {
  if (mode === current) return;
  current = mode;
  emit();
  void settingsSet(LOCK_AFTER_MARK_KEY, mode).catch((error: unknown) =>
    logger.caught(SCOPE, "锁档落库失败（本次只在本窗生效）", error),
  );
}

/** 当前档位（非 hook 场合：标记补做完那一刻要读它） */
export function lockAfterMark(): LockAfterMark {
  return current;
}

/** 当前档位。version 作原语快照，理由同 auto-size-default */
export function useLockAfterMark(): LockAfterMark {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return current;
}
