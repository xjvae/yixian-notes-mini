// 右键菜单的"目标"抽象：正文/清单条目/时间轴记录各是一块文本。链接包进哪句、图从哪句摘掉、
// 还剩几个字是同一套算法，只是存回位置不同（body / items[i].text / timeline[i].text）——
// 收拢这层，note-content 只有一条"读目标文本 → 算 → 写回"的路径，不为每种类型各抄一份
// （抄一份就是漏一份，上一轮"清单/时间轴没吃识别"正是这么来的）。
// RowRef 用 id 不用下标：条目能增删重排，下标在右键之后、写回之前就可能变。

import type { StickyNote } from "@/platform/contracts";
import { ITEM_MAX } from "@/data/limit";

export type RowRef = { kind: "todo"; id: string } | { kind: "timeline"; id: string };

/** DOM 上那两个属性读进来认不认。认不出（值不是这两类、或 id 空）一律 null */
export function rowRefFrom(kind: string | null, id: string | null): RowRef | null {
  if (id === null || id === "") return null;
  if (kind === "todo" || kind === "timeline") return { kind, id };
  return null;
}

/** 这条目标现在写着什么。找不到（刚被删掉）就是 null，调用方据此什么都不做 */
export function rowText(note: StickyNote, row: RowRef): string | null {
  if (row.kind === "todo") {
    const item = note.items.find((entry) => entry.id === row.id);
    return item === undefined ? null : item.text;
  }
  const entry = note.timeline.find((item) => item.id === row.id);
  return entry === undefined ? null : entry.text;
}

/**
 * 写回目标要落的那个 patch。上限按条目算（`ITEM_MAX`）：条目比正文短得多，
 * 一句图引用就占 ~28 个字，正文那 5000 的余量在这儿是不存在的。
 * 目标已经没了（别的窗刚删了这条）返回 null —— 宁可不写，也不能凭空造一条。
 */
export function patchRowText(
  note: StickyNote,
  row: RowRef,
  next: string,
): Partial<StickyNote> | null {
  if (rowText(note, row) === null) return null;
  return row.kind === "todo"
    ? {
        items: note.items.map((item) =>
          item.id === row.id ? { ...item, text: next } : item,
        ),
      }
    : {
        timeline: note.timeline.map((entry) =>
          entry.id === row.id ? { ...entry, text: next } : entry,
        ),
      };
}

/** 条目还能塞几个字（留 1 个字给引用前面那个换行，见 todo-body 同一条口径） */
export function rowRoom(text: string): number {
  return ITEM_MAX - text.length - 1;
}
