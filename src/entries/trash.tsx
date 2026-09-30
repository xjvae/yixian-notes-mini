// 回收站入口。不 hydrate 主数据（回收站自己按 includeDeleted 取数 + 听广播刷新）。

import { TrashWindow } from "@/features/trash/window";
import { boot } from "@/entries/boot";

void boot({
  label: "回收站",
  hydrate: false,
  render: () => <TrashWindow />,
});
