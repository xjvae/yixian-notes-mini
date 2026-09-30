import { describe, expect, it } from "vitest";
import { normalizeTagInput, tagInk } from "@/data/tags";

describe("tagInk", () => {
  it("同一标签永远同色", () => {
    expect(tagInk("工作")).toEqual(tagInk("工作"));
  });

  it("名字有区分度（4 个常见名不全落同色）", () => {
    const inks = ["工作", "生活", "学习", "体检"].map((name) => tagInk(name).background);
    expect(new Set(inks).size).toBeGreaterThan(1);
  });
});

describe("normalizeTagInput", () => {
  const existing = ["工作", "生活"];

  it("去空白、拒空、拒重复", () => {
    expect(normalizeTagInput("  学习  ", existing)).toBe("学习");
    expect(normalizeTagInput("   ", existing)).toBeNull();
    expect(normalizeTagInput("工作", existing)).toBeNull();
  });

  it("限长限量", () => {
    expect(normalizeTagInput("字".repeat(21), existing)).toBeNull();
    expect(normalizeTagInput("新", existing)).toBe("新");
    const full = ["一", "二", "三", "四", "五", "六", "七", "八"];
    expect(normalizeTagInput("九", full)).toBeNull();
  });
});
