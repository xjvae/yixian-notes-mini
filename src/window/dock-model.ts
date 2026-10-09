// 贴边判定 — 纯函数层。给定矩形与工作区算"该不该贴、贴哪边、细丝在哪、展开在哪"，
// 不碰任何窗口 API，全部可单测。接线在 use-dock-snap.ts。
//
// 数值是上一产品线的**实测值**，不是拍脑袋：32px 以内人眼就认为"我已经放到边上了"
// （12px 太苛刻，多数时候等于没这功能）；20px 再窄就捏不住；26 = 20 细丝 + 6 缝，
// 相邻两条既分得开又仍然贴着同一条边。
//
// 三条几何口径：
//  · 一切以**工作区**（已排除任务栏）为界，不是屏幕边缘。用整屏算贴边，Windows
//    底部那条任务栏就会把细丝盖住（真机踩过）；
//  · 细丝是 **SLIVER×SLIVER 的小方块**，不是"整条边的一根签"：贴边的目的是把这张纸
//    收起来只留一个能捏住的头，留一条 300px 高的签等于什么都没收；沿边按槽位错开，
//    并整体内缩 20px 起排（贴在屏幕角上等于消失——那儿是 Win11 圆角 + 任务栏热区）；
//  · 滑出态用**展开尺寸原样**推到那条边上再夹回工作区。滑出**不**按槽位错开：
//    错开是细丝之间避让用的，一张摊开的纸不必躲另一张摊开的纸。

import type { DockEdge } from "@/platform/contracts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 尺寸是否有效（NaN/0/负数一律不算，否则后面全是 NaN 矩形） */
function validSize(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function clamp(value: number, min: number, max: number): number {
  // min > max（窗比工作区还大）时以 min 为准：宁可溢出，也不要 NaN/反转
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/** 细丝厚度与宽度：贴边后窗收缩成 SLIVER×SLIVER 的小方块，保证还捏得住 */
export const SLIVER = 20;
/** 同边 ≥2 条时的错开间距（沿边方向，20px 细丝 + 6px 缝） */
export const STAGGER = 26;
/**
 * 沿边起点内缩。第一条细丝必须离屏幕角这么远，否则它就"消失"在角落里
 * （角上是 Windows 的圆角 + 任务栏热区，20px 宽的一条根本点不到）。
 */
export const CORNER_INSET = SLIVER;
/** 吸附阈值：拖到距工作区边缘这么近就贴（旧实现实测 32） */
export const SNAP_PX = 32;
/** 迟到事件的位置容差：与"自己刚写进去的位置"差这么几像素以内一律当回声 */
export const LATE_EVENT_TOLERANCE_PX = 2;

/** 沿边方向：left/right 是竖直边（沿 y 排），top/bottom 沿 x 排 */
export function isVerticalEdge(edge: DockEdge): boolean {
  return edge === "left" || edge === "right";
}

/** 把矩形整体钳进工作区（尺寸不变；比工作区还大时贴左上角） */
export function clampRectToBounds(rect: Rect, workArea: Rect): Rect {
  if (!validSize(rect)) return rect;
  return {
    ...rect,
    x: clamp(rect.x, workArea.x, workArea.x + workArea.width - rect.width),
    y: clamp(rect.y, workArea.y, workArea.y + workArea.height - rect.height),
  };
}

/** 第 slot 号细丝沿边方向的起点（槽位由 Rust 注册表发放；非法值一律当第 0 条） */
export function dockSlotOffset(slot: number, stagger = STAGGER): number {
  const safe = Math.max(0, Number.isFinite(slot) ? Math.floor(slot) : 0);
  return CORNER_INSET + safe * stagger;
}

/** 贴边判定：矩形四边里哪条距工作区边缘 ≤ SNAP_PX。都不够近 → null */
export function nearestEdge(
  rect: Rect,
  workArea: Rect,
): { edge: DockEdge; gap: number } | null {
  const candidates: ReadonlyArray<[DockEdge, number]> = [
    ["left", rect.x - workArea.x],
    ["top", rect.y - workArea.y],
    ["right", workArea.x + workArea.width - (rect.x + rect.width)],
    ["bottom", workArea.y + workArea.height - (rect.y + rect.height)],
  ];
  let best: { edge: DockEdge; gap: number } | null = null;
  for (const [edge, gap] of candidates) {
    if (gap <= SNAP_PX && (best === null || gap < best.gap)) {
      best = { edge, gap };
    }
  }
  return best;
}

/** 某条边离工作区边缘有多远（>0 = 已拖离；用于解除判定） */
export function edgeGap(rect: Rect, edge: DockEdge, workArea: Rect): number {
  switch (edge) {
    case "left":
      return rect.x - workArea.x;
    case "top":
      return rect.y - workArea.y;
    case "right":
      return workArea.x + workArea.width - (rect.x + rect.width);
    case "bottom":
      return workArea.y + workArea.height - (rect.y + rect.height);
  }
}

/**
 * 贴边后的细丝：`SLIVER × SLIVER` 的小方块，沿边按槽位错开，整块保证在工作区内。
 * 槽位再多也不能排出屏去——超出可用长度就夹到最后一条位置（宁可两条重叠一格，
 * 也不要一条看不见：看不见的细丝等于那张便签丢了）。
 */
export function sliverRect(edge: DockEdge, workArea: Rect, slot = 0): Rect {
  const maxAlong = Math.max(
    0,
    (isVerticalEdge(edge) ? workArea.height : workArea.width) - SLIVER,
  );
  const offset = Math.min(dockSlotOffset(slot), maxAlong);
  const base =
    edge === "left"
      ? { x: workArea.x, y: workArea.y + offset }
      : edge === "right"
        ? { x: workArea.x + workArea.width - SLIVER, y: workArea.y + offset }
        : edge === "top"
          ? { x: workArea.x + offset, y: workArea.y }
          : { x: workArea.x + offset, y: workArea.y + workArea.height - SLIVER };
  return clampRectToBounds({ ...base, width: SLIVER, height: SLIVER }, workArea);
}

/**
 * 滑出后的矩形：展开尺寸**原样**，只是整体推到那条边上并钳回工作区。
 * 跨边那一轴保留展开几何自己的坐标——滑出去哪儿取决于这张纸原来摆哪儿，
 * 而不是它挤在第几号槽里。
 */
export function revealedRect(edge: DockEdge, workArea: Rect, expanded: Rect): Rect {
  const size = {
    width: validSize(expanded) ? expanded.width : SLIVER,
    height: validSize(expanded) ? expanded.height : SLIVER,
  };
  const aligned: Rect =
    edge === "left"
      ? { x: workArea.x, y: expanded.y, ...size }
      : edge === "right"
        ? { x: workArea.x + workArea.width - size.width, y: expanded.y, ...size }
        : edge === "top"
          ? { x: expanded.x, y: workArea.y, ...size }
          : { x: expanded.x, y: workArea.y + workArea.height - size.height, ...size };
  return clampRectToBounds(aligned, workArea);
}
