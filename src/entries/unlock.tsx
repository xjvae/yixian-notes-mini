// 口令窗入口。不 hydrate 主数据；相位由 private_status 分岔（设置/解锁/重置）。

import { UnlockWindow } from "@/features/unlock/window";
import { boot } from "@/entries/boot";

void boot({
  label: "口令窗",
  hydrate: false,
  render: () => <UnlockWindow />,
});
