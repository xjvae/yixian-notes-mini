// 选区 → 正文区间，右键"把选中变成链接"唯一的位置来源。不能拿渲染字数算（`![名](media://m…)`
// 屏幕上一张图、正文里 28 个字），只能在画的时候把原文区间留在 DOM（data-start/data-end），这里落回那几个数。
// 最硬的判据：把算出的区间截出来与人眼选中的逐字比一遍，选跨了链接会多出 `[]()`，一比不一样就整段放弃——
// 包错位置是要落库的脏数据，宁可菜单项不出现。

import type { BodySpan } from "@/data/body-parse";

/** 选中的字在正文里的原文区间（`[start, end)`） */
export interface SelectionRange {
  start: number;
  end: number;
}

export function selectionRange(
  selection: Selection | null,
  root: HTMLElement | null,
  body: string,
  spans: BodySpan[],
): SelectionRange | null {
  if (selection === null || root === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (selection.isCollapsed || !root.contains(range.commonAncestorContainer)) return null;
  // 两端都必须落在文本节点里：落在元素上时 offset 是"第几个孩子"，不是第几个字
  if (
    range.startContainer.nodeType !== Node.TEXT_NODE ||
    range.endContainer.nodeType !== Node.TEXT_NODE
  ) {
    return null;
  }

  const start = offsetOf(range.startContainer, range.startOffset, root, spans);
  const end = offsetOf(range.endContainer, range.endOffset, root, spans);
  if (start === null || end === null || end <= start) return null;

  const sliced = body.slice(start, end);
  // 比的是 `range.toString()`而不是 `selection.toString()`：语义一样（选中的那几个字），
  // 但 Selection 那一份在**文档没拿到焦点**时给的是空串（预览台实测撞到），Range 不受这个影响
  if (sliced !== range.toString()) return null;
  return { start, end };
}

/**
 * 一个 DOM 位置在正文里的偏移。只认"纯文本那一段"留下的 `data-start`：
 * 链接/代码/图的 holder 根本没有这个属性（它们的区间含着语法字符），走到这儿就是 null。
 * 认完还要回到这次识别结果里核一遍——DOM 上的数和 spans 对不上（HMR 留了旧节点、
 * 或渲染层改了没同步这条）就当认不出来，一个字都不改。
 */
function offsetOf(
  container: Node,
  offset: number,
  root: HTMLElement,
  spans: BodySpan[],
): number | null {
  const holder = container.parentElement?.closest<HTMLElement>("[data-start]");
  if (holder === null || holder === undefined || !root.contains(holder)) return null;
  const base = Number(holder.dataset.start);
  const finish = Number(holder.dataset.end);
  const text = container.textContent ?? "";
  if (!Number.isInteger(base) || !Number.isInteger(finish)) return null;
  // 一个纯文本 span 里就只有这一个文本节点，否则节点内偏移加不出唯一答案
  if (holder.childNodes.length !== 1 || finish - base !== text.length) return null;
  if (offset < 0 || offset > text.length) return null;
  const at = base + offset;
  // 这个起点必须是这次切出来的某一段的起点或段内偏移，由 spans 说了算
  return spans.some((span) => at >= span.start && at <= span.end) ? at : null;
}
