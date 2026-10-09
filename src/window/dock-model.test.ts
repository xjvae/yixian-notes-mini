// 贴边几何判定契约。工作区取 1200×800（原点 100,100，模拟任务栏占掉的偏移）。

import { describe, expect, it } from "vitest";
import {
  clampRectToBounds,
  CORNER_INSET,
  dockSlotOffset,
  edgeGap,
  isVerticalEdge,
  nearestEdge,
  revealedRect,
  sliverRect,
  SLIVER,
  SNAP_PX,
  STAGGER,
} from "@/window/dock-model";

const AREA = { x: 100, y: 100, width: 1200, height: 800 };
const EXPANDED = { x: 400, y: 260, width: 320, height: 300 };

describe("nearestEdge", () => {
  it("阈值放宽到 32px：差 30px 也该贴（旧版 12px 时多数时候贴不上）", () => {
    expect(SNAP_PX).toBe(32);
    expect(nearestEdge({ x: 130, y: 300, width: 300, height: 200 }, AREA)?.edge).toBe(
      "left",
    );
    expect(nearestEdge({ x: 130, y: 300, width: 300, height: 200 }, AREA)?.gap).toBe(30);
  });

  it("四边在阈值内都能命中", () => {
    expect(nearestEdge({ x: 108, y: 300, width: 300, height: 200 }, AREA)?.edge).toBe(
      "left",
    );
    expect(nearestEdge({ x: 400, y: 106, width: 300, height: 200 }, AREA)?.edge).toBe(
      "top",
    );
    expect(nearestEdge({ x: 1292, y: 300, width: 300, height: 200 }, AREA)?.edge).toBe(
      "right",
    );
    expect(nearestEdge({ x: 400, y: 892, width: 300, height: 200 }, AREA)?.edge).toBe(
      "bottom",
    );
  });

  it("超出阈值返回 null；多条候选取最近", () => {
    expect(nearestEdge({ x: 400, y: 300, width: 300, height: 200 }, AREA)).toBeNull();
    // 左差 11px、上差 2px → 命中上
    const hit = nearestEdge({ x: 111, y: 102, width: 300, height: 200 }, AREA);
    expect(hit?.edge).toBe("top");
    expect(hit?.gap).toBe(2);
  });
});

describe("sliverRect", () => {
  it("细丝是 20×20 的小方块，不是整条边的一根签", () => {
    const first = sliverRect("left", AREA, 0);
    expect(first).toEqual({
      x: 100,
      y: 100 + CORNER_INSET,
      width: SLIVER,
      height: SLIVER,
    });
    // 收起的目的就是"只留一个捏得住的头"；沿边方向的长度必须也是 20
    expect(first.height).toBe(SLIVER);
  });

  it("第一条不贴屏幕角：整体内缩 20px 起排，往后每条错开 26px", () => {
    expect(sliverRect("left", AREA, 0).y).toBe(100 + CORNER_INSET);
    expect(sliverRect("left", AREA, 1).y).toBe(100 + CORNER_INSET + STAGGER);
    expect(sliverRect("left", AREA, 3).y).toBe(100 + CORNER_INSET + STAGGER * 3);
  });

  it("右边：右缘内收一个厚度；下边：下缘内收一个厚度", () => {
    const right = sliverRect("right", AREA, 0);
    expect(right.x).toBe(100 + 1200 - SLIVER);
    expect(right.width).toBe(SLIVER);
    const bottom = sliverRect("bottom", AREA, 0);
    expect(bottom.y).toBe(100 + 800 - SLIVER);
    expect(bottom.height).toBe(SLIVER);
  });

  it("上/下边沿边方向是 x（竖直边才是 y）", () => {
    const top = sliverRect("top", AREA, 2);
    expect(top.y).toBe(100);
    expect(top.x).toBe(100 + CORNER_INSET + STAGGER * 2);
    expect(isVerticalEdge("top")).toBe(false);
    expect(isVerticalEdge("right")).toBe(true);
  });

  it("槽位再多也不许排出屏去：夹到沿边最后一个可用位置", () => {
    const last = 100 + 800 - SLIVER;
    expect(sliverRect("left", AREA, 999).y).toBe(last);
    expect(sliverRect("right", AREA, 999).y).toBe(last);
    expect(sliverRect("top", AREA, 999).x).toBe(100 + 1200 - SLIVER);
  });

  it("非法槽位当第 0 条（NaN/负数都不许把细丝甩出屏）", () => {
    expect(dockSlotOffset(Number.NaN)).toBe(CORNER_INSET);
    expect(dockSlotOffset(-5)).toBe(CORNER_INSET);
    expect(dockSlotOffset(1.7)).toBe(CORNER_INSET + STAGGER);
  });
});

describe("revealedRect", () => {
  it("展开尺寸原样，只把跨边那一轴推到边上", () => {
    const left = revealedRect("left", AREA, EXPANDED);
    expect(left.x).toBe(100);
    // 滑出去哪儿由这张纸原来的 y 决定，与它挤在第几号槽无关
    expect(left.y).toBe(EXPANDED.y);
    expect(left.width).toBe(320);
    expect(left.height).toBe(300);

    const right = revealedRect("right", AREA, EXPANDED);
    expect(right.x + right.width).toBe(100 + 1200);
    expect(right.y).toBe(EXPANDED.y);

    const bottom = revealedRect("bottom", AREA, EXPANDED);
    expect(bottom.y + bottom.height).toBe(100 + 800);
    expect(bottom.x).toBe(EXPANDED.x);
  });

  it("滑出态绝不按槽位错开：slot 不参与，两条细丝各自滑出都回到自己的位置", () => {
    const a = revealedRect("left", AREA, EXPANDED);
    const b = revealedRect("left", AREA, { ...EXPANDED, y: 500 });
    expect(a.y).toBe(EXPANDED.y);
    expect(b.y).toBe(500);
  });

  it("收起态那条栏（62 高）滑出就是那条栏：不抬到 200，也不越出工作区", () => {
    const BAR = { x: 400, y: 640, width: 318, height: 62 };
    const bottom = revealedRect("bottom", AREA, BAR);
    expect(bottom.height).toBe(62);
    expect(bottom.width).toBe(318);
    expect(bottom.y + bottom.height).toBe(100 + 800);
    // 贴顶那条也一样：栏的高度不该被"展开尺寸的下限"改写
    const top = revealedRect("top", AREA, BAR);
    expect(top.y).toBe(AREA.y);
    expect(top.height).toBe(62);
  });

  it("展开尺寸大于工作区时整块贴左上，不负到看不见", () => {
    const huge = revealedRect("left", AREA, {
      x: 900,
      y: 900,
      width: 4000,
      height: 4000,
    });
    expect(huge.x).toBe(100);
    expect(huge.y).toBe(100);
  });

  it("贴右上角的组合：越界的那一轴被夹回工作区", () => {
    const rect = revealedRect("right", AREA, {
      x: 2000,
      y: 2000,
      width: 320,
      height: 300,
    });
    expect(rect.x).toBe(100 + 1200 - 320);
    expect(rect.y + rect.height).toBeLessThanOrEqual(100 + 800);
  });
});

describe("clampRectToBounds", () => {
  it("整体钳进工作区，尺寸不变", () => {
    expect(clampRectToBounds({ x: 50, y: 50, width: 100, height: 100 }, AREA)).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    });
    expect(clampRectToBounds({ x: 1400, y: 900, width: 100, height: 100 }, AREA)).toEqual(
      {
        x: 1200,
        y: 800,
        width: 100,
        height: 100,
      },
    );
  });

  it("非法尺寸原样返回（NaN/0/负数不进夹取，否则满盘 NaN）", () => {
    const bad = { x: 0, y: 0, width: 0, height: 50 };
    expect(clampRectToBounds(bad, AREA)).toBe(bad);
  });
});

describe("edgeGap", () => {
  it("给出矩形该边到工作区边缘的余量", () => {
    expect(edgeGap({ x: 130, y: 0, width: 100, height: 100 }, "left", AREA)).toBe(30);
    expect(edgeGap({ x: 1200, y: 0, width: 100, height: 100 }, "right", AREA)).toBe(0);
  });
});
