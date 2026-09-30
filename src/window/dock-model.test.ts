// 贴边几何判定契约。工作区取 1200×800（原点 100,100，模拟任务栏占掉的偏移）。

import { describe, expect, it } from "vitest";
import {
  edgeGap,
  nearestEdge,
  revealedRect,
  sliverRect,
  SLIVER,
  STAGGER,
} from "@/window/dock-model";

const AREA = { x: 100, y: 100, width: 1200, height: 800 };
const EXPANDED = { width: 320, height: 300 };

describe("nearestEdge", () => {
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
  it("左边：贴工作区左缘，厚度 20，slot 沿边错开 26", () => {
    const first = sliverRect("left", AREA, EXPANDED, 0);
    expect(first).toEqual({ x: 100, y: 100, width: SLIVER, height: 300 });
    const second = sliverRect("left", AREA, EXPANDED, 1);
    expect(second.y).toBe(100 + STAGGER);
    expect(second.width).toBe(SLIVER);
  });

  it("右边：右缘内收一个厚度", () => {
    const rect = sliverRect("right", AREA, EXPANDED, 0);
    expect(rect.x).toBe(100 + 1200 - SLIVER);
    expect(rect.width).toBe(SLIVER);
  });

  it("上/下边：厚度方向是高度，沿边错开的是 x", () => {
    const top = sliverRect("top", AREA, EXPANDED, 0);
    expect(top.y).toBe(100);
    expect(top.height).toBe(SLIVER);
    const bottom = sliverRect("bottom", AREA, EXPANDED, 2);
    expect(bottom.y).toBe(100 + 800 - SLIVER);
    expect(bottom.x).toBe(100 + STAGGER * 2);
  });

  it("沿边超出工作区被裁住", () => {
    const tall = { width: 320, height: 5000 };
    const rect = sliverRect("left", AREA, tall, 0);
    expect(rect.height).toBe(800);
  });
});

describe("revealedRect", () => {
  it("展开态完全落在工作区内且贴边", () => {
    const left = revealedRect("left", AREA, EXPANDED, 0);
    expect(left.x).toBe(100);
    expect(left.width).toBe(320);
    const right = revealedRect("right", AREA, EXPANDED, 0);
    expect(right.x + right.width).toBe(100 + 1200);
    const bottom = revealedRect("bottom", AREA, EXPANDED, 0);
    expect(bottom.y + bottom.height).toBe(100 + 800);
  });

  it("展开尺寸大于工作区被裁住", () => {
    const huge = { width: 4000, height: 4000 };
    const rect = revealedRect("left", AREA, huge, 0);
    expect(rect.width).toBe(1200);
    expect(rect.height).toBe(800);
  });
});

describe("edgeGap", () => {
  it("给出矩形该边到工作区边缘的余量", () => {
    expect(edgeGap({ x: 130, y: 0, width: 100, height: 100 }, "left", AREA)).toBe(30);
    expect(edgeGap({ x: 1200, y: 0, width: 100, height: 100 }, "right", AREA)).toBe(0);
  });
});
