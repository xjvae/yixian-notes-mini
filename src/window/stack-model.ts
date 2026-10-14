// 叠窗 — 纯函数层：给定一叠便签与"当前在看哪一张"，算该显示哪张、相邻是谁、手风琴每行多高。
// 不碰窗口 API，接线在 features/sticky/group-stack.tsx。两条口径：成员顺序沿用 sticky_list 的
// updated_at DESC（store 原序），编辑会把那张挪到最前，所以当前张认 id 不认下标（认下标敲字串张）；
// 翻页环形（末张下一张回首张，一叠没有头尾），各档呈现共用同一条环形序与同一个 currentId，切档不迁移数据。
// 曾经的三档几何（层叠卡片/扇形/网格）2026-10-08 删除，想加回来口径记在 ROADMAP M3。

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

/** currentId 在这一叠里的序（0 起）。找不到 → null，供"第 n/N 张"与切片/手风琴用 */
export function positionOf(
  members: readonly StickyNote[],
  currentId: string,
): number | null {
  const at = members.findIndex((note) => note.id === currentId);
  return at === -1 ? null : at;
}

/** 内容区尺寸：视图量出来交给这里算行高（见 use-content-box.ts） */
export interface Size {
  width: number;
  height: number;
}

// —— 侧边色块签（tabs）——
//
// 正文一张（可编辑），右缘一条签列：一块方色签 + 图标，名字悬停浮出。没有任何算术：块死尺寸、
// 从上往下堆、装不下变可滚。前两版的教训：量行高 resize 后会过期（RO/resize 可以不回调，签按旧高排、
// overflow hidden 滚不动），CSS 等分 + 26px 直排标题是一堵墙。定尺寸既不量也不等分，没有漂移面。

/** 签列占这么宽（左右内缩 + 一块方签，当前那块再多探出 4px） */
export const TAB_WIDTH = 30;
/** 一块方签的边长 */
export const TAB_CHIP = 24;
/** 当前那块往正文那侧多探出这么多（"翻的是这张"靠这个错位说，不靠整块深色压边） */
export const TAB_CHIP_PROTRUDE = 4;
/** 块与块之间的缝 */
export const TAB_CHIP_GAP = 6;

// —— 手风琴（accordion）——
//
// 一列到底：收起的每张一条 24px 的标题行，展开那张吃掉剩余高度。
// 展开有下限（120）：十几张时若把展开压到 24px 高，正文就没了——那种时候让整列滚，
// 而不是把正在编辑的那张压扁。

export const ACCORDION_ROW = 24;
export const ACCORDION_OPEN_MIN = 120;

export interface AccordionRow {
  index: number;
  y: number;
  height: number;
  open: boolean;
}

export function accordionRows(
  count: number,
  openIndex: number,
  area: Size,
): { rows: AccordionRow[]; scroll: boolean } {
  if (count <= 0) return { rows: [], scroll: false };
  const open = Math.max(ACCORDION_OPEN_MIN, area.height - (count - 1) * ACCORDION_ROW);
  let y = 0;
  const rows = Array.from({ length: count }, (_, index) => {
    const height = index === openIndex ? open : ACCORDION_ROW;
    const row: AccordionRow = { index, y, height, open: index === openIndex };
    y += height;
    return row;
  });
  return { rows, scroll: y > area.height };
}
