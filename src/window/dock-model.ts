// 贴边判定 — 纯函数层。给定矩形与工作区算"该不该贴、贴哪边、细丝在哪、展开在哪"，
// 不碰任何窗口 API，全部可单测。接线在 use-dock-snap.ts。
//
// 三条几何口径：
//  · 细丝贴**工作区**边缘（任务栏底下不留东西），不是屏幕边缘；
//  · 同侧多张细丝按槽位错开 26px（细丝 20px + 6px 缝），slot 由 Rust 注册表发放；
//  · 贴边判定有迟滞：吸附 ≤ SNAP_PX，解除要拖出 > DETACH_PX——否则在阈值附近来回闪。

import type { DockEdge } from "@/platform/contracts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 细丝厚度（逻辑像素） */
export const SLIVER = 20;
/** 同侧相邻细丝的错开档距（20px 细丝 + 6px 缝） */
export const STAGGER = 26;
/** 吸附阈值：拖到距工作区边缘这么近就贴 */
export const SNAP_PX = 12;

/** 贴边判定：矩形四边里哪条距工作区边缘 ≤ SNAP_PX。没有 → null（取最近的一条） */
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
 * 细丝的位置尺寸。沿边方向的长度 = 展开尺寸在该方向的值（被工作区与错开档裁掉）；
 * 厚度固定 SLIVER。slot 沿边往下/右错开。
 */
export function sliverRect(
  edge: DockEdge,
  workArea: Rect,
  expanded: { width: number; height: number },
  slot: number,
): Rect {
  const offset = slot * STAGGER;
  switch (edge) {
    case "left":
      return {
        x: workArea.x,
        y: workArea.y + offset,
        width: SLIVER,
        height: Math.min(expanded.height, workArea.height - offset),
      };
    case "right":
      return {
        x: workArea.x + workArea.width - SLIVER,
        y: workArea.y + offset,
        width: SLIVER,
        height: Math.min(expanded.height, workArea.height - offset),
      };
    case "top":
      return {
        x: workArea.x + offset,
        y: workArea.y,
        width: Math.min(expanded.width, workArea.width - offset),
        height: SLIVER,
      };
    case "bottom":
      return {
        x: workArea.x + offset,
        y: workArea.y + workArea.height - SLIVER,
        width: Math.min(expanded.width, workArea.width - offset),
        height: SLIVER,
      };
  }
}

/** 展开态贴回边缘的位置：完全落在工作区内，沿边按槽位错开 */
export function revealedRect(
  edge: DockEdge,
  workArea: Rect,
  expanded: { width: number; height: number },
  slot: number,
): Rect {
  const offset = slot * STAGGER;
  const width = Math.min(expanded.width, workArea.width);
  const height = Math.min(expanded.height, workArea.height - offset);
  switch (edge) {
    case "left":
      return { x: workArea.x, y: workArea.y + offset, width, height };
    case "right":
      return {
        x: workArea.x + workArea.width - width,
        y: workArea.y + offset,
        width,
        height,
      };
    case "top":
      return {
        x: workArea.x + offset,
        y: workArea.y,
        width: Math.min(expanded.width, workArea.width - offset),
        height,
      };
    case "bottom":
      return {
        x: workArea.x + offset,
        y: workArea.y + workArea.height - height,
        width: Math.min(expanded.width, workArea.width - offset),
        height,
      };
  }
}
