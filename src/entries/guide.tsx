// 引导窗入口。不 hydrate 主数据：这一窗只讲怎么用，一张签都不读。
// `reveal: true`：它是隐藏建的（`windows/guide.rs`），整树提交后喊 `float_reveal` 才亮。

import { GuideBubble } from "@/features/guide/window";
import { boot } from "@/entries/boot";

void boot({
  label: "引导",
  hydrate: false,
  reveal: true,
  render: () => <GuideBubble />,
});
