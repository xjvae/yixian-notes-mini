import { describe, expect, it } from "vitest";
import type { StickyNote } from "@/platform/contracts";
import { patchRowText, rowRefFrom, rowRoom, rowText } from "@/features/sticky/row-target";

function note(overrides: Partial<StickyNote> = {}): StickyNote {
  return {
    id: "s1",
    title: "",
    body: "正文",
    contentType: "todo",
    items: [{ id: "i1", text: "买菜  https://a.b", done: false }],
    timeline: [{ id: "t1", at: 1, text: "发生过的事" }],
    tags: [],
    theme: "goose",
    icon: null,
    pinned: false,
    floating: true,
    collapsed: false,
    private: false,
    groupId: null,
    x: null,
    y: null,
    width: null,
    height: null,
    dueAt: null,
    doneAt: null,
    repeat: "none",
    deleted: false,
    deletedAt: null,
    docked: false,
    dockEdge: null,
    autoSize: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("rowRefFrom 认 DOM 上那两个属性", () => {
  it("只认 todo 与 timeline，id 空的算认不出", () => {
    expect(rowRefFrom("todo", "i1")).toEqual({ kind: "todo", id: "i1" });
    expect(rowRefFrom("timeline", "t9")).toEqual({ kind: "timeline", id: "t9" });
    expect(rowRefFrom("note", "i1")).toBeNull();
    expect(rowRefFrom(null, "i1")).toBeNull();
    expect(rowRefFrom("todo", "")).toBeNull();
  });
});

describe("rowText / patchRowText 读写都锁在同一 id 上", () => {
  it("按 id 取那一条自己的文本", () => {
    expect(rowText(note(), { kind: "todo", id: "i1" })).toBe("买菜  https://a.b");
    expect(rowText(note(), { kind: "timeline", id: "t1" })).toBe("发生过的事");
    expect(rowText(note(), { kind: "todo", id: "没有这条" })).toBeNull();
  });

  it("写回只动那一条，别的一条不碰", () => {
    const source = note({
      items: [
        { id: "i1", text: "一", done: false },
        { id: "i2", text: "二", done: true },
      ],
    });
    const patch = patchRowText(source, { kind: "todo", id: "i1" }, "[一](https://a.b)");
    expect(patch?.items).toEqual([
      { id: "i1", text: "[一](https://a.b)", done: false },
      { id: "i2", text: "二", done: true },
    ]);
    // 勾没被抹掉：done 跟着 item 走，patch 只换 text
    expect(patch?.items?.[1]?.done).toBe(true);
  });

  it("目标已经不在了（别的窗刚删了这条）就不写，也不凭空造一条", () => {
    const patch = patchRowText(note(), { kind: "todo", id: "已删" }, "新内容");
    expect(patch).toBeNull();
  });

  it("时间轴走 timeline 那一份，不动 items", () => {
    const patch = patchRowText(note(), { kind: "timeline", id: "t1" }, "改了");
    expect(patch?.timeline).toEqual([{ id: "t1", at: 1, text: "改了" }]);
    expect(patch?.items).toBeUndefined();
  });
});

describe("rowRoom 按条目上限留位", () => {
  it("留 1 个字给引用前那个换行（与条目自己粘图同一条口径）", () => {
    expect(rowRoom("")).toBe(199);
    expect(rowRoom("一二三")).toBe(196);
    // 快满了就是快满了，负数由调用方挡（附件那层按 room 决定存不存）
    expect(rowRoom("字".repeat(200))).toBe(-1);
  });
});
