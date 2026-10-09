// RichText 的画法里有一条不属于"看起来"的规则：**凡是它画出来的人话文字，都得能选**。
// 窗体那层是 `select-none`（拖窗不该把整屏字涂蓝），它一路继承进正文与条目，
// 于是"选中文字右键加链接"在真机上根本走不到——拖不出选区。
// 钉在**段根节点**上：外壳少写一次 `select-text` 是看不见的 bug，只有真机能发现。
//
// 这里只断言 class（jsdom 里没有 Tailwind，算不出计算值）；"真的可选中"是上一轮
// 在预览台用 Chrome 量过的：卡片 computed `user-select: none` → 段上 `text`。

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { RichText } from "@/features/sticky/rich-text";

function segmentRoots(body: string): HTMLElement[] {
  const { container } = render(<RichText body={body} ink="#111" accent="#222" />);
  const kids = [...container.children] as HTMLElement[];
  cleanup();
  return kids;
}

describe("RichText 每一段的根节点自己就带 select-text", () => {
  it("纯文本、裸 URL、markdown 链接、行内码、围栏块、远程图芯片", () => {
    const body =
      "先看 改动会去抖 官网 https://a.b/x 与 [文档](https://c.d) 还有 `npm i` 与图 https://e.f/g.png\n```ts\nconst a = 1\n```";
    const kids = segmentRoots(body);
    // 前提：这几类都真画出来了（0 个节点的断言就是空过）
    expect(kids.length).toBeGreaterThanOrEqual(6);
    const missing = kids.filter((el) => !el.classList.contains("select-text"));
    expect(missing.map((el) => `${el.tagName}.${el.className}`)).toEqual([]);
  });

  it("带区间的纯文本段也在这一层（选区落回正文靠的就是它）", () => {
    const kids = segmentRoots("一句普通的话");
    const span = kids[0];
    expect(span.classList.contains("select-text")).toBe(true);
    expect([span.dataset.start, span.dataset.end]).toEqual(["0", "6"]);
  });
});
