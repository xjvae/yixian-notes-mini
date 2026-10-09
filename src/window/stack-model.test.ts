// 叠窗翻页的行为契约 — 钉的是用户看得见的事：敲字时不串张、翻到末张还能绕回、
// 手里这张没了就落到还剩的第一张、只剩一张时翻页按钮不会跳去别处。

import { describe, expect, it } from "vitest";
import type { StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";
import {
  activeId,
  accordionRows,
  membersOf,
  neighborId,
  positionOf,
  ACCORDION_OPEN_MIN,
  ACCORDION_ROW,
} from "@/window/stack-model";

function note(id: string, overrides: Partial<StickyNote> = {}): StickyNote {
  return { ...createDefaultSticky(id, 1_700_000_000_000), ...overrides };
}

const g1 = [
  note("a", { groupId: "g1" }),
  note("b", { groupId: "g1" }),
  note("c", { groupId: "g1" }),
];

describe("membersOf 这一叠里有谁", () => {
  it("别的组与已删的都不算这叠的成员", () => {
    const all = [
      ...g1,
      note("x", { groupId: "g2" }),
      note("y", { groupId: null }),
      note("z", { groupId: "g1", deleted: true }),
    ];
    expect(membersOf(all, "g1").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("保持列表序（sticky_list 的 updated_at DESC 就是叠里的张序）", () => {
    expect(
      membersOf([note("b", { groupId: "g1" }), note("a", { groupId: "g1" })], "g1").map(
        (m) => m.id,
      ),
    ).toEqual(["b", "a"]);
  });
});

describe("activeId 当前显示哪一张", () => {
  it("认 id 不认下标：列表序变了仍是那一张", () => {
    // 编辑把 c 顶到最前（updated_at DESC 的新序），用户手里还是 c
    expect(activeId([note("c", { groupId: "g1" }), ...g1.slice(0, 2)], "c")).toBe("c");
  });

  it("currentId 没给或已不在这一叠里 → 落到首张", () => {
    expect(activeId(g1, null)).toBe("a");
    expect(activeId(g1, "gone")).toBe("a");
  });

  it("空叠 → null（这一叠没张了，窗该退场）", () => {
    expect(activeId([], "a")).toBeNull();
  });
});

describe("neighborId 翻到相邻那张", () => {
  it("末张的下一张绕回首张，首张的上一张绕到末张", () => {
    expect(neighborId(g1, "c", 1)).toBe("a");
    expect(neighborId(g1, "a", -1)).toBe("c");
    expect(neighborId(g1, "b", 1)).toBe("c");
    expect(neighborId(g1, "b", -1)).toBe("a");
  });

  it("只剩一张时原地不动，不会跳去别处", () => {
    const single = [note("a", { groupId: "g1" })];
    expect(neighborId(single, "a", 1)).toBe("a");
    expect(neighborId(single, "a", -1)).toBe("a");
  });

  it("手里这张刚被移走 → 落在还剩的第一张", () => {
    expect(neighborId(g1.slice(1), "a", 1)).toBe("b");
  });

  it("空叠 → null", () => {
    expect(neighborId([], "a", 1)).toBeNull();
  });
});

describe("positionOf 第几张", () => {
  it("给出 0 起的序；不在这一叠里 → null", () => {
    expect(positionOf(g1, "b")).toBe(1);
    expect(positionOf(g1, "gone")).toBeNull();
  });
});

// 下面这几档的几何用例：AREA 取真机默认叠窗的内容区（叠窗默认 320×300，标题条 36 →
// 内容区 320×264），TINY 取最小窗（220×200 → 164）的内容区。

const AREA = { width: 320, height: 264 };
const TINY = { width: 220, height: 164 };

// 侧签这一档没有几何用例：块是死的尺寸、由 CSS 往下堆，不在纯函数里算行高。
// 理由记在 stack-model.ts 的 tabs 那节与 group-tabs.tsx 的文件头——量出来的行高会在
// 窗 resize 后过期，而过期的结果是既裁一截又滚不动。

describe("accordionRows 手风琴", () => {
  it("展开那张拿剩下的，收起的每人一条", () => {
    const { rows, scroll } = accordionRows(4, 0, AREA);
    expect(scroll).toBe(false);
    expect(rows[0]?.height).toBe(AREA.height - 3 * ACCORDION_ROW);
    expect(rows[0]?.open).toBe(true);
    expect(rows.slice(1).map((row) => row.height)).toEqual([
      ACCORDION_ROW,
      ACCORDION_ROW,
      ACCORDION_ROW,
    ]);
  });

  it("展开的那张可以在任意位置：y 是前面各行高度之和", () => {
    const { rows } = accordionRows(4, 2, AREA);
    expect(rows[2]?.open).toBe(true);
    expect(rows[2]?.y).toBe(2 * ACCORDION_ROW);
    expect(rows[3]?.y).toBe(2 * ACCORDION_ROW + (rows[2]?.height ?? 0));
  });

  it("十几张时展开那张守住下限，整列改滚", () => {
    const { rows, scroll } = accordionRows(10, 9, AREA);
    expect(rows[9]?.height).toBe(ACCORDION_OPEN_MIN);
    expect(scroll).toBe(true);
  });

  it("只剩一张就占满", () => {
    const { rows, scroll } = accordionRows(1, 0, AREA);
    expect(rows[0]?.height).toBe(AREA.height);
    expect(scroll).toBe(false);
  });

  it("最小窗里四张：展开那张还是守住下限（宁可整列滚，也不把正在编辑的压扁）", () => {
    const { rows, scroll } = accordionRows(4, 0, TINY);
    expect(rows[0]?.height).toBe(ACCORDION_OPEN_MIN);
    expect(scroll).toBe(true);
  });
});
