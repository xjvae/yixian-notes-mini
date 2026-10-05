// 叠窗翻页 — 纯函数层。给定一叠便签与"当前在看哪一张"，算该显示哪张、相邻那张是谁。
// 不碰任何窗口 API，全部可单测。接线在 features/sticky/group-stack.tsx。
//
// 两条口径：
//  · 成员顺序沿用 sticky_list 的 updated_at DESC（store 里的原序）。编辑会把那一张挪到
//    最前，所以当前张认 **id** 不认下标——认下标会在敲字的过程中串张。
//  · 翻页是环形的：末张的下一张回到首张。一叠东西本来就没有头尾。

import type { StickyNote } from "@/platform/contracts";

/** 某一叠的成员：属于该组且未删，保持传入顺序（= 列表序） */
export function membersOf(
  notes: readonly StickyNote[],
  groupId: string,
): readonly StickyNote[] {
  return notes.filter((note) => note.groupId === groupId && !note.deleted);
}

/** 当前该显示哪一张：currentId 还在这一叠里就用它，否则退回首张；空叠 → null */
export function activeId(
  members: readonly StickyNote[],
  currentId: string | null,
): string | null {
  if (currentId !== null && members.some((note) => note.id === currentId)) {
    return currentId;
  }
  return members[0]?.id ?? null;
}

/**
 * 相对 currentId 前进 step 张（step 可为负）后的那张 id，环形。
 * 只有一张 = 原地；currentId 已不在这一叠里 = 落到首张。
 */
export function neighborId(
  members: readonly StickyNote[],
  currentId: string,
  step: number,
): string | null {
  const count = members.length;
  if (count === 0) return null;
  const at = members.findIndex((note) => note.id === currentId);
  if (at === -1) return members[0]?.id ?? null;
  if (count === 1) return currentId;
  const offset = ((step % count) + count) % count;
  return members[(at + offset) % count]?.id ?? null;
}

/** currentId 在这一叠里的序（0 起）。找不到 → null，供"第 n/N 张"与扇面切片用 */
export function positionOf(
  members: readonly StickyNote[],
  currentId: string,
): number | null {
  const at = members.findIndex((note) => note.id === currentId);
  return at === -1 ? null : at;
}
