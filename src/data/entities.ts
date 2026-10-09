// 实体工厂 — StickyNote 的类型住在 platform/contracts.ts（线上形状 = 运行时形状，
// 见那份文件的头注释）；这里只有与存储无关的构造与 id 工具。

import type { StickyContentType, StickyItem, StickyNote } from "@/platform/contracts";
import { THEME_KEYS } from "@/data/theme";

let idCounter = 0;

/** 便签/条目 id：毫秒时间戳 + 进程内序号，一进程内唯一 */
export function genId(prefix = "s"): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function genItemId(): string {
  return genId("i");
}

/** 归整条目 id：长度对齐 items（老数据兼容口径，新数据总是一一对应） */
export function alignItemIds(items: string[], ids?: string[]): StickyItem[] {
  return items.map((text, index) => ({
    id: ids?.[index] ?? genItemId(),
    text,
    done: false,
  }));
}

/** 新便签默认形态。开窗路径（Rust）与前端共用同一套默认值口径 */
export function createDefaultSticky(id: string, now: number): StickyNote {
  return {
    id,
    title: "",
    body: "",
    contentType: "text",
    items: [],
    timeline: [],
    tags: [],
    theme: THEME_KEYS[0],
    icon: null,
    pinned: true,
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
    // 新签不表太态：跟着全局那个开关走（默认关，所以新建的签照旧是手拉的固定尺寸）
    autoSize: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function isStickyContentType(value: unknown): value is StickyContentType {
  return (
    value === "text" || value === "todo" || value === "reminder" || value === "timeline"
  );
}
