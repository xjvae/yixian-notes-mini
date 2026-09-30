// 校验 — 库里读出来的行在进 store 前过一遍归一化：形状不对的字段就地修，
// 修不了的行整体丢弃并留一条 warn。原则：绝不让一条坏数据换来一个白窗口。

import type { StickyItem, StickyNote } from "@/platform/contracts";
import { isStickyContentType } from "@/data/entities";
import { themeOf, THEME_KEYS } from "@/data/theme";
import { logger } from "@/platform/logger";

const SCOPE = "validate";

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function normalizeItems(value: unknown): StickyItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): StickyItem[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const item = raw as Partial<StickyItem>;
    if (typeof item.id !== "string" || typeof item.text !== "string") return [];
    return [
      {
        id: item.id,
        text: item.text,
        done: asBool(item.done, false),
      },
    ];
  });
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string");
}

/**
 * 归一化一行。返回 null 表示这行坏到没法用（调用方跳过它，不要写回去——
 * 写回去会把这个判定变成"每次读都改一次库"）。
 */
export function normalizeSticky(row: StickyNote): StickyNote | null {
  if (typeof row.id !== "string" || row.id === "") {
    logger.warn(SCOPE, `丢弃无 id 的便签行：${JSON.stringify(row).slice(0, 80)}`);
    return null;
  }
  if (!isStickyContentType(row.contentType)) {
    logger.warn(SCOPE, `便签 ${row.id} 的 content_type 不认识，按 text 处理`);
  }
  const theme = THEME_KEYS.includes(row.theme) ? row.theme : themeOf("").key;
  return {
    ...row,
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    contentType: isStickyContentType(row.contentType) ? row.contentType : "text",
    items: normalizeItems(row.items),
    tags: normalizeTags(row.tags),
    theme,
    pinned: asBool(row.pinned, true),
    floating: asBool(row.floating, true),
    collapsed: asBool(row.collapsed, false),
    private: asBool(row.private, false),
    groupId: typeof row.groupId === "string" ? row.groupId : null,
    x: asIntOrNull(row.x),
    y: asIntOrNull(row.y),
    width: asIntOrNull(row.width),
    height: asIntOrNull(row.height),
    dueAt: asIntOrNull(row.dueAt),
    doneAt: asIntOrNull(row.doneAt),
    repeat: row.repeat === "daily" || row.repeat === "weekly" ? row.repeat : "none",
    deleted: asBool(row.deleted, false),
    deletedAt: asIntOrNull(row.deletedAt),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
}
