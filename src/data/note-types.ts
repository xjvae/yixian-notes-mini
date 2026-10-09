// 便签四类的元数据。图标在 feature 层配（lucide），这里只放与存储/展示无关的口径。

import type { StickyContentType, StickyNote } from "@/platform/contracts";

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
 * 「这块文本」到底在哪。四类便签的正文不是一个字段：文本/提醒写在 `body`，
 * 清单在 `items[].text`，时间轴在 `timeline[].text`。所以"复制正文"这类动作
 * 必须按类型取，不然转成清单之后就变成复制一个空字符串（右键菜单就栽过这点）。
 */
export function plainBody(note: StickyNote): string {
  if (note.contentType === "todo") {
    return note.items.map((item) => item.text).join("\n");
  }
  if (note.contentType === "timeline") {
    return note.timeline.map((entry) => entry.text).join("\n");
  }
  return note.body;
}

/** 上面那个动作在菜单上该叫什么（"复制正文"对清单是句假话） */
export function bodyActionLabel(note: StickyNote): string {
  if (note.contentType === "todo") return "复制清单";
  if (note.contentType === "timeline") return "复制时间轴";
  return "复制正文";
}

/**
 * 列表/收起栏能显示的标题。空标题给「未命名便签」；私密便签给「私密便签」——
 * 这个占位是隐私边界的一部分（未解锁时真实标题根本不在内存里），不是文案润色。
 */
export function displayTitle(title: string, isPrivate: boolean): string {
  return title.trim() !== "" ? title : isPrivate ? "私密便签" : "未命名便签";
}
