import { describe, expect, it } from "vitest";
import { conversionPatch } from "@/data/note-convert";
import { createDefaultSticky } from "@/data/entities";

function note(overrides: { body?: string; items?: never[] } = {}) {
  return {
    ...createDefaultSticky("s1", 1_700_000_000_000),
    contentType: "text" as const,
    ...overrides,
  };
}

describe("conversionPatch", () => {
  it("文本 → 清单：正文按行种成条目草稿，正文原样保留", () => {
    const patch = conversionPatch(note({ body: "买牛奶\n\n寄快递" }), "todo");
    expect(patch.contentType).toBe("todo");
    expect(patch.items?.map((item) => item.text)).toEqual(["买牛奶", "寄快递"]);
    expect(patch.items?.[0].done).toBe(false);
  });

  it("已有条目时不重复种", () => {
    const existing = [{ id: "i1", text: "已有", done: false }];
    const patch = conversionPatch(
      { contentType: "text", body: "正文", items: existing },
      "todo",
    );
    expect(patch.items).toBeUndefined();
    expect(patch.contentType).toBe("todo");
  });

  it("同类型不动", () => {
    expect(conversionPatch(note(), "text")).toEqual({});
  });

  it("清单 → 文本：只改类型，条目跟着走（切回来还在）", () => {
    const patch = conversionPatch(
      { contentType: "todo", body: "", items: [{ id: "i1", text: "x", done: false }] },
      "text",
    );
    expect(patch).toEqual({ contentType: "text" });
  });
});
