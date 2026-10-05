// 星环入口。不 hydrate 主数据：环上四个节点都只是"拉起别的窗"，本页不读库。

import { RingMenu } from "@/features/ring/window";
import { boot } from "@/entries/boot";

void boot({
  label: "星环",
  hydrate: false,
  render: () => <RingMenu />,
});
