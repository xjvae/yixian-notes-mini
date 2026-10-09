// 校验 — 库里读出来的行在进 store 前过一遍归一化：形状不对的字段就地修，
// 修不了的行整体丢弃并留一条 warn。原则：绝不让一条坏数据换来一个白窗口。

import type { StickyItem, StickyNote, TimelineEntry } from "@/platform/contracts";
import { isDockEdge } from "@/platform/contracts";
import { isStickyContentType } from "@/data/entities";
import { themeOf, THEME_KEYS } from "@/data/theme";
import { logger } from "@/platform/logger";

const SCOPE = "validate";

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 三态布尔（`autoSize` 那种"没表过态"的列）：只有真/假算表过态，1/0 也认
 * （库里那列是 INTEGER，手改过或从别的形状来都会给数字）。
 * 其余一律 null = 跟全局走——脏值不许被猜成 true 或 false，那等于替用户改了这张的模式。
 */
function asTriBool(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
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

function normalizeTimeline(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): TimelineEntry[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const entry = raw as Partial<TimelineEntry>;
    if (typeof entry.id !== "string" || typeof entry.text !== "string") return [];
    return [
      {
        id: entry.id,
        at: asIntOrNull(entry.at) ?? 0,
        text: entry.text,
      },
    ];
  });
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
    timeline: normalizeTimeline(row.timeline),
    tags: normalizeTags(row.tags),
    theme,
    // 图标只在这里管形状（长度、类型），**认不认这个 key 由渲染那边兜底**：
    // 校验层不引 lucide，认不出的 key 在签上自动回落成类型图标，画不出空白
    icon:
      typeof row.icon === "string" && row.icon.length > 0 && row.icon.length <= 32
        ? row.icon
        : null,
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
    docked: asBool(row.docked, false),
    dockEdge: isDockEdge(row.dockEdge) ? row.dockEdge : null,
    autoSize: asTriBool(row.autoSize),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
}
