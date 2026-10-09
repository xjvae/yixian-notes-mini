// 叠窗 — 纯函数层。给定一叠便签与"当前在看哪一张"，算该显示哪张、相邻那张是谁、
// 手风琴每行多高。不碰任何窗口 API，全部可单测。接线在 features/sticky/group-stack.tsx。
//
// 两条口径：
//  · 成员顺序沿用 sticky_list 的 updated_at DESC（store 里的原序）。编辑会把那一张挪到
//    最前，所以当前张认 **id** 不认下标——认下标会在敲字的过程中串张。
//  · 翻页是环形的：末张的下一张回到首张。一叠东西本来就没有头尾。
//    其余各档呈现（group.presentation：侧签 / 手风琴）用的是同一条环形序与同一个
//    currentId，所以任意两档之间切换不迁移任何数据。
//
// 这里曾经还有三档的几何（层叠卡片 / 扇形 / 网格缩略格），作者 2026-10-08 说"删除"，
// 连同视图与用例一起撤了。想再加回来时，那三档的算法口径记在 ROADMAP M3。

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
// 正文只有一张（跟分页一样可编辑），右缘多一条签列：一张一块**方色签**，块上是这一张的
// 图标，名字不排进列里（悬停/聚焦时在正文左下角浮出来）。
//
// 这一档**没有任何算术**：块是死的尺寸、从上往下堆、装不下由浏览器把这条变成可滚。
// 前两版都不是这样——第一版在这里算过 `tabRows(count, area)`（量出来的行高一 resize 就
// 过期：RO/resize 可以不回调，于是签按旧高度排，既裁一截又因为 overflow 是 hidden 而
// 滚不动，预览台把窗从高 300 改到 70 就复现）；第二版改成 CSS 等分 + 26px 直排标题，
// 直排字本身就是一堵墙，作者看了说"重新设计"。定尺寸的块既不量也不等分，没有漂移面。

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
