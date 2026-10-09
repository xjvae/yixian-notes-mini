// 叠窗各档呈现共用的那份契约 — 两个视图（侧边色块签 / 手风琴）拿到的东西一模一样：
// 这一叠有谁、当前在看哪张、点谁就把哪张变成当前、删手里这张。
//
// 名字也收在这一份里：空标题给「未命名便签」、私密给「私密便签」是
// `displayTitle` 的既有口径（未解锁时真实标题根本不在内存里，占位是隐私边界不是文案），
// 视图自己再写一遍"标题为空就用 xxx"就是第二个真相。

import type { StickyNote } from "@/platform/contracts";
import { displayTitle } from "@/data/note-types";

export interface StackViewProps {
  members: readonly StickyNote[];
  /** 当前在看的那张：色块签里是探出那块、手风琴里是展开那一行 */
  currentId: string;
  onPick: (id: string) => void;
  onDelete: () => void;
}

/** 条/签/行上显示的名字 */
export function displayName(note: StickyNote): string {
  return displayTitle(note.title, note.private);
}

/** 待办那类的完成数（别的类型没有计数可给，就别硬造一个） */
export function todoChip(note: StickyNote): string | null {
  if (note.contentType !== "todo" || note.items.length === 0) return null;
  const done = note.items.filter((item) => item.done).length;
  return `${done}/${note.items.length}`;
}
