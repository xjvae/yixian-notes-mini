// 命中判定的契约 — 拖拽进组只有"自己的 moved 流 + 别窗一份快照"两样东西，
// 谁被压住了全靠前端自己算。算错的代价是把一张纸并进了不该进的那叠，
// 所以钉死这几条：含边界、自己不算、叠窗优先、面积小的优先、平手按 label（可复现）。

import { describe, expect, it } from "vitest";
import type { FloatFrame } from "@/platform/contracts";
import { pickMergeTarget } from "@/window/drag-to-group";

function frame(label: string, over: Partial<FloatFrame> = {}): FloatFrame {
  return {
    label,
    kind: "sticky",
    id: label.replace(/^float-/, ""),
    x: 100,
    y: 100,
    width: 200,
    height: 160,
    ...over,
  };
}

describe("pickMergeTarget 压在谁身上", () => {
  it("没压到任何一扇就是没候选", () => {
    expect(pickMergeTarget("float-me", [frame("float-a")], { x: 40, y: 40 })).toBeNull();
  });

  it("自己那扇不算目标（压在自己标题带上不该并组）", () => {
    expect(
      pickMergeTarget("float-me", [frame("float-me")], { x: 150, y: 150 }),
    ).toBeNull();
  });

  it("矩形边界上的点算命中", () => {
    const frames = [frame("float-a")];
    expect(pickMergeTarget("float-me", frames, { x: 100, y: 100 })?.label).toBe(
      "float-a",
    );
    expect(pickMergeTarget("float-me", frames, { x: 300, y: 260 })?.label).toBe(
      "float-a",
    );
    // 越出一像素就不算
    expect(pickMergeTarget("float-me", frames, { x: 301, y: 260 })).toBeNull();
  });

  it("叠窗优先：一叠是明确的容器，压住叠窗时不挑同一片里的单窗", () => {
    const hit = pickMergeTarget(
      "float-me",
      [frame("float-b"), frame("group-g1", { kind: "stack", id: "g1" })],
      {
        x: 150,
        y: 150,
      },
    );
    expect(hit?.kind).toBe("stack");
  });

  it("同是单窗时压到面积小的那扇（指哪儿是哪儿，不被大窗盖走）", () => {
    const small = frame("float-small", { x: 140, y: 140, width: 40, height: 40 });
    const big = frame("float-big", { x: 100, y: 100, width: 400, height: 400 });
    // 大的排在前面试探定序：排序必须真的生效，与数组顺序无关
    expect(pickMergeTarget("float-me", [big, small], { x: 150, y: 150 })?.label).toBe(
      "float-small",
    );
  });

  it("面积也相同时按 label 定序：同一份输入两次判定给出同一扇", () => {
    const b = frame("float-b");
    const a = frame("float-a");
    expect(pickMergeTarget("float-me", [b, a], { x: 150, y: 150 })?.label).toBe(
      "float-a",
    );
    expect(pickMergeTarget("float-me", [a, b], { x: 150, y: 150 })?.label).toBe(
      "float-a",
    );
  });

  it("负坐标那侧的屏（多显示器）照同一套判定", () => {
    const left = frame("float-left", { x: -800, y: -100, width: 200, height: 160 });
    expect(
      pickMergeTarget("float-me", [left, frame("float-a")], { x: -700, y: 0 })?.label,
    ).toBe("float-left");
  });
});
