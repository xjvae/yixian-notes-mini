// 搜索入口。不 hydrate 主数据：搜索按查询取数。

import { SearchWindow } from "@/features/search/window";
import { boot } from "@/entries/boot";

void boot({
  label: "搜索",
  hydrate: false,
  render: () => <SearchWindow />,
});
