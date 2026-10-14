// 口令窗入口。不 hydrate 主数据；相位由 private_status + 这一次的意图分岔
// （设置 / 揭开那一张 / 只验身份 / 已经收回去 / 重置）。

import { UnlockWindow } from "@/features/unlock/window";
import { boot } from "@/entries/boot";

void boot({
  label: "口令窗",
  hydrate: false,
  render: () => <UnlockWindow />,
});
