// 设置入口。不 hydrate 主数据。

import { SettingsWindow } from "@/features/settings/window";
import { boot } from "@/entries/boot";

void boot({
  label: "设置",
  hydrate: false,
  render: () => <SettingsWindow />,
});
