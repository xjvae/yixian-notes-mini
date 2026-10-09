// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseBodySpans } from "@/data/body-parse";
import { selectionRange } from "@/features/sticky/selection-range";

/**
 * 按 rich-text 的画法搭一棵小 DOM：纯文本那几段带 data-start/data-end，
 * 链接是 `<a>`、代码是 `<code>`、图是 `<img>`——都不带区间。
 * 这样测的是"选区落回正文"这件事，而不是去验渲染层长什么样。
 */
function renderBody(body: string): HTMLDivElement {
  const root = document.createElement("div");
  root.dataset.bodyContent = "";
  for (const span of parseBodySpans(body)) {
    const seg = span.segment;
    const tag =
      seg.kind === "image"
        ? "img"
        : seg.kind === "link"
          ? "a"
          : seg.kind === "code"
            ? "code"
            : "span";
    const node = document.createElement(tag);
    if (seg.kind === "text") {
      node.dataset.start = String(span.start);
      node.dataset.end = String(span.end);
      node.textContent = seg.text;
    } else if (seg.kind === "link") {
      node.textContent = seg.text;
    } else if (seg.kind === "code") {
      node.textContent = seg.code;
    }
    root.append(node);
  }
  return root;
}

/** 浏览器那边的 Selection 不好造，这里包一层 jsdom 的 Range：语义一样 */
function fakeSelection(range: Range): Selection {
  return {
    rangeCount: 1,
    isCollapsed: range.collapsed,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection;
}

function select(fromNode: Node, from: number, toNode: Node, to: number): Range {
  const range = document.createRange();
  range.setStart(fromNode, from);
  range.setEnd(toNode, to);
  return range;
}

const BODY = "先看 https://a.b 再看 `npm i` 结束";

describe("selectionRange 把选区落回正文", () => {
  it("纯文本里选几个字：区间就是那几个字在正文里的位置", () => {
    const root = renderBody(BODY);
    const first = root.firstElementChild as HTMLElement;
    const text = first.firstChild as Text;
    const range = select(text, 0, text, 2);
    expect(
      selectionRange(fakeSelection(range), root, BODY, parseBodySpans(BODY)),
    ).toEqual({
      start: 0,
      end: 2,
    });
  });

  it("选中一整段纯文本（从中间到末尾）也算得出来", () => {
    const body = "开头 尾巴";
    const root = renderBody(body);
    const spans = parseBodySpans(body);
    const last = spans[spans.length - 1];
    const holder = [...root.children].at(-1) as HTMLElement;
    const text = holder.firstChild as Text;
    const range = select(text, 0, text, text.length);
    expect(selectionRange(fakeSelection(range), root, body, spans)).toEqual({
      start: last.start,
      end: last.end,
    });
  });

  it("选跨到链接上：截出来带 []() 那几个语法字，和眼睛看到的不一样 → 整段放弃", () => {
    const root = renderBody(BODY);
    const text = (root.firstElementChild as HTMLElement).firstChild as Text;
    const link = root.querySelector("a") as HTMLElement;
    const linkText = link.firstChild as Text;
    const range = select(text, 3, linkText, 3);
    expect(
      selectionRange(fakeSelection(range), root, BODY, parseBodySpans(BODY)),
    ).toBeNull();
  });

  it("选在代码上：那段没有区间，不做修改", () => {
    const root = renderBody(BODY);
    const code = root.querySelector("code") as HTMLElement;
    const inner = code.firstChild as Text;
    const range = select(inner, 0, inner, 3);
    expect(
      selectionRange(fakeSelection(range), root, BODY, parseBodySpans(BODY)),
    ).toBeNull();
  });

  it("两端落在元素上（不是文本节点）时 offset 是孩子序号，不是字数 → 放弃", () => {
    const root = renderBody("就这些字");
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(root, 1);
    expect(
      selectionRange(fakeSelection(range), root, "就这些字", parseBodySpans("就这些字")),
    ).toBeNull();
  });

  it("选的东西不在正文那一格里（清单条目也是文本节点，但没有这层的区间）→ 放弃", () => {
    const root = renderBody("正文");
    const outside = document.createElement("span");
    outside.textContent = "条目里的字";
    document.body.append(outside);
    const text = outside.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    expect(
      selectionRange(fakeSelection(range), root, "正文", parseBodySpans("正文")),
    ).toBeNull();
    outside.remove();
  });

  it("空选区与 null 选区都不给区间", () => {
    const root = renderBody(BODY);
    const spans = parseBodySpans(BODY);
    const text = (root.firstElementChild as HTMLElement).firstChild as Text;
    const collapsed = select(text, 1, text, 1);
    expect(selectionRange(fakeSelection(collapsed), root, BODY, spans)).toBeNull();
    expect(selectionRange(null, root, BODY, spans)).toBeNull();
    expect(selectionRange(fakeSelection(collapsed), null, BODY, spans)).toBeNull();
  });
});
