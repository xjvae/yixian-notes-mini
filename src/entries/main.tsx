// 便签窗入口（index.html）。一个 WebView 一扇窗：单窗、叠窗、还是那张提醒卡，
// 由 Rust 注入的初始化脚本决定（float.rs 与 card.rs）——`__STICKY_ID__` 是一张便签
// 一扇窗，`__STICKY_GROUP_ID__` 是一叠便签一扇窗，`__REMINDER__` 是到点提醒那张卡。
// 三个互斥，这里只认注入，不自己猜。
//
// 叠窗/单窗那一步的判定放在 render 里而不是模块顶层：预览台（dev）的替身桥是在 boot()
// 里装的，顶层读全局会读在它之前——真机上没这个次序问题，但那样就等于同一份代码两种时序。
// 卡这一支可以在顶层读：那张窗只有真 Tauri 会建（预览台压根没有卡窗），
// 而它要不要 hydrate/抢焦点必须在 boot() 之前就定下来。

import { GroupStackWindow } from "@/features/sticky/group-stack";
import { StickyWindow } from "@/features/sticky/window";
import { ReminderCard } from "@/window/reminder-card";
import { boot } from "@/entries/boot";
import { getGroupId, getReminderCard } from "@/window/identity";

const card = getReminderCard();

void boot({
  label: card === null ? "便签" : "提醒",
  // 卡不读主数据：要写的字已经在注入那一份里了。少一趟 hydrate，也少一处
  // 能把私密内容画到一张不锁的卡上的机会
  hydrate: card === null,
  // Rust 那边建的是隐藏窗（float.rs / card.rs），画完第一帧才亮 —— 见 boot.tsx 的 RevealWhenCommitted
  reveal: true,
  // 卡不抢焦点：一条到点的提醒不该把用户正在打字的应用的光标抢走（星环那条老理由）
  revealFocus: card === null,
  render: () =>
    card !== null ? (
      <ReminderCard initial={card} />
    ) : getGroupId() === null ? (
      <StickyWindow />
    ) : (
      <GroupStackWindow />
    ),
});
