// 类型转换 — 切换便签类型时字段一律保留（due_at、items、timeline 都跟着走，
// 切回来什么都在）；唯一一处内容搬运：文本 → 清单时若还没有条目，把正文按行
// 种成条目草稿，正文原样保留。

import type { StickyContentType, StickyNote } from "@/platform/contracts";
import { genItemId } from "@/data/entities";

export function conversionPatch(
  note: Pick<StickyNote, "contentType" | "body" | "items">,
  to: StickyContentType,
): Partial<Pick<StickyNote, "contentType" | "items">> {
  if (note.contentType === to) return {};
  const patch: Partial<Pick<StickyNote, "contentType" | "items">> = {
    contentType: to,
  };
  if (to === "todo" && note.items.length === 0 && note.body.trim() !== "") {
    patch.items = note.body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => ({ id: genItemId(), text: line, done: false }));
  }
  return patch;
}
