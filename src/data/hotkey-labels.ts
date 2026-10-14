// 键位的人话名字与写法 — 设置窗与引导教程共用这一份（两处各写一套迟早一个说 Alt+1 一个说 Ctrl+1）。
// 口径跟着 hotkey-section.tsx 走：key === "" 是显式停用不算"没绑上"；bound === false 是注册失败，
// 必须标出来（教一个按下去没反应的键，用户只能当软件坏了）；展示剥 Key/Digit 前缀、Space 写"空格"。

import type { HotkeyBinding } from "@/platform/contracts";

/** 动作 → 人话名字。键是 Rust `hotkeys.rs::DEFAULT_BINDINGS` 里的 action 名 */
export const ACTION_LABELS: Record<string, string> = {
  ring: "唤起星环",
  sticky: "新建便签",
  search: "搜索",
  trash: "回收站",
  settings: "设置",
  "hide-all": "收起全部便签",
  "show-all": "恢复全部便签",
};

/** Accelerator → 展示写法：`Alt+Key1` → `Alt + 1`，`Alt+Space` → `Alt + 空格` */
export function prettyKey(accel: string): string {
  if (accel === "") return "已停用";
  return accel
    .split("+")
    .map((part) =>
      part
        .replace(/^Key/, "")
        .replace(/^Digit/, "")
        .replace(/^Space$/, "空格"),
    )
    .join(" + ");
}

/**
 * 一条绑定的整句写法：`新建便签 Alt + 1`；没绑上就当场说清楚。
 * 引导那一步用它，设置窗的 aria-label 也用它，两处念出来一样。
 */
export function describeBinding(binding: HotkeyBinding): string {
  const label = ACTION_LABELS[binding.action] ?? binding.action;
  const key = prettyKey(binding.key);
  if (binding.key === "") return `${label} 已停用`;
  return binding.bound ? `${label} ${key}` : `${label} ${key}（没绑上）`;
}
