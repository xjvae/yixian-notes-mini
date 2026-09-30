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

/**
 * 列表/收起栏能显示的标题。空标题给「未命名便签」；私密便签给「私密便签」——
 * 这个占位是隐私边界的一部分（未解锁时真实标题根本不在内存里），不是文案润色。
 */
export function displayTitle(title: string, isPrivate: boolean): string {
  return title.trim() !== "" ? title : isPrivate ? "私密便签" : "未命名便签";
}
