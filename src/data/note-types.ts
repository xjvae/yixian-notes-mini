// 便签四类的元数据。图标在 feature 层配（lucide），这里只放与存储/展示无关的口径。

import type { StickyContentType } from "@/platform/contracts";

export const NOTE_TYPE_ORDER: readonly StickyContentType[] = [
  "text",
  "todo",
  "reminder",
  "timeline",
];

export function noteTypeLabel(type: StickyContentType): string {
  switch (type) {
    case "text":
      return "文本";
    case "todo":
      return "清单";
    case "reminder":
      return "提醒";
    case "timeline":
      return "时间轴";
  }
}
