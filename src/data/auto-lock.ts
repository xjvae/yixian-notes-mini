// 自动上锁的档位与读法 — 设置窗那一排按钮、启动时的缺省都从这一处取。
//
// 默认档与上限是**跨语言的同一个数**：Rust 那侧是 `autolock.rs` 的 `DEFAULT_MINUTES` 与
// `minutes_from` 里的 `0..=1440`，两边各写一份迟早分叉（分叉的形状是"设置上写着 5 分钟，
// 实际按别的数锁"）。对照测试在 `mirrored-constants.test.ts`。

export const AUTO_LOCK_KEY = "private.auto_lock_min";

/** 缺键与脏值回到这一档 */
export const AUTO_LOCK_DEFAULT_MIN = 5;

/** 合法上限（分钟）。超出就回默认档：脏值不许把锁悄悄关掉，也不许把它拧成一天以上 */
export const AUTO_LOCK_MAX_MIN = 1440;

export const AUTO_LOCK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "不锁" },
  { value: 1, label: "1 分钟" },
  { value: AUTO_LOCK_DEFAULT_MIN, label: `${AUTO_LOCK_DEFAULT_MIN} 分钟` },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
];

/** 缺键与脏值回到默认档——与 Rust `minutes_from` 同一条口径 */
export function autoLockMinutes(stored: string | null): number {
  const parsed = Number.parseInt(stored ?? "", 10);
  return parsed >= 0 && parsed <= AUTO_LOCK_MAX_MIN ? parsed : AUTO_LOCK_DEFAULT_MIN;
}
