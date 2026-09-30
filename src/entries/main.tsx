// 便签窗入口（index.html）。一个 WebView 一扇窗：是哪一张由 Rust 注入的
// `__STICKY_ID__` 决定（factory.rs 拼的初始化脚本）。叠窗（一叠一窗）随 M3 加入，
// 届时这里按 `__STICKY_GROUP_ID__` 分岔。

import { StickyWindow } from "@/features/sticky/window";
import { boot } from "@/entries/boot";

void boot({
  label: "便签",
  render: () => <StickyWindow />,
});
