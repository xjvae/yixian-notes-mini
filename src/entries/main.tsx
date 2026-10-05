// 便签窗入口（index.html）。一个 WebView 一扇窗：单窗还是叠窗由 Rust 注入的初始化
// 脚本决定（float.rs）——`__STICKY_ID__` 是一张便签一扇窗，`__STICKY_GROUP_ID__`
// 是一叠便签一扇窗。两个全局互斥，这里只认注入，不自己猜。
//
// 判定放在 render 里而不是模块顶层：预览台（dev）的替身桥是在 boot() 里装的，
// 顶层读全局会读在它之前——真机上没这个次序问题，但那样就等于同一份代码两种时序。

import { GroupStackWindow } from "@/features/sticky/group-stack";
import { StickyWindow } from "@/features/sticky/window";
import { boot } from "@/entries/boot";
import { getGroupId } from "@/window/identity";

void boot({
  label: "便签",
  render: () => (getGroupId() === null ? <StickyWindow /> : <GroupStackWindow />),
});
