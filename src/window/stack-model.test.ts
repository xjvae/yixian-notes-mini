// 叠窗翻页的行为契约 — 钉的是用户看得见的事：敲字时不串张、翻到末张还能绕回、
// 手里这张没了就落到还剩的第一张、只剩一张时翻页按钮不会跳去别处。

import { describe, expect, it } from "vitest";
import type { StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";
import { activeId, membersOf, neighborId, positionOf } from "@/window/stack-model";

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
