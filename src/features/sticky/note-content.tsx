// NoteContent — 便签内容渲染的**唯一**实现：类型切换、标题、四类内容体、
// 标签、失败反馈、私密遮罩、页脚动作。单窗与叠窗都渲染它，谁也不许自己抄一份。
//
// 窗级动作（收起/贴边收纳）与宿主相关的按钮经 `windowActions` 槽注入；
// 删除动作经 `onDelete` 由宿主决定（单窗=删并关窗，叠窗=删并翻页）。
// 遮罩态（私密未解锁）也在这里处理：真身不在内存，标题/正文/标签区整体换锁面。

import type { ReactNode } from "react";
import {
  AlarmClock,
  History,
  ListChecks,
  Lock,
  LockOpen,
  TextIcon,
  Trash2,
} from "lucide-react";
import { themeColors, themeOf, THEME_KEYS } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { conversionPatch } from "@/data/note-convert";
import { noteTypeLabel, NOTE_TYPE_ORDER } from "@/data/note-types";
import { describeDue } from "@/data/due";
import { BODY_MAX, shouldShowCount } from "@/data/limit";
import { normalizeTagInput, tagInk } from "@/data/tags";
import { useNow } from "@/features/sticky/use-now";
import { TodoBody } from "@/features/sticky/todo-body";
import { TimelineBody } from "@/features/sticky/timeline-body";
import { ReminderFields } from "@/features/sticky/reminder-fields";
import { usePrivateState } from "@/data/private-state";
import { useWriteFailures } from "@/store/hooks";
import { updateNote } from "@/store/notes-store";
import { openUnlockWindow } from "@/platform/commands";
import { logger } from "@/platform/logger";
import type { StickyContentType, StickyNote } from "@/platform/contracts";

const SCOPE = "sticky";
const TYPE_ICONS: Record<StickyContentType, typeof Lock> = {
  text: TextIcon,
  todo: ListChecks,
  reminder: AlarmClock,
  timeline: History,
};

export interface NoteContentProps {
  id: string;
  note: StickyNote;
  /** 窗级动作槽（单窗：收起/贴边收纳；叠窗：不传，叠窗没有这两种形态） */
  windowActions?: ReactNode;
  /** 页脚最前面的槽：归组菜单。单窗与叠窗都传——叠窗里也得能把手里这张移出去 */
  leadingActions?: ReactNode;
  onDelete: () => void;
}

export function NoteContent({
  id,
  note,
  windowActions,
  leadingActions,
  onDelete,
}: NoteContentProps) {
  const failures = useWriteFailures();
  const now = useNow();
  const { resolved } = useScheme();
  const priv = usePrivateState();

  const theme = themeColors(note.theme, resolved);
  const due = describeDue(note.dueAt, note.doneAt, now);
  const showDueBadge =
    note.contentType === "reminder" && due.state !== "none" && due.state !== "done";
  const dueUrgent = due.state === "overdue" || due.state === "today";
  const masked = note.private && (!priv.active || !priv.unlocked);

  const switchType = (to: StickyContentType): void => {
    updateNote(id, conversionPatch(note, to));
  };

  const addTag = (raw: string): void => {
    const name = normalizeTagInput(raw, note.tags);
    if (name !== null) updateNote(id, { tags: [...note.tags, name] });
  };

  const dueBadge = showDueBadge ? (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        backgroundColor: dueUrgent ? theme.accent : "rgba(0,0,0,0.06)",
        color: dueUrgent ? "#fff" : theme.ink,
      }}
    >
      {due.text}
    </span>
  ) : null;

  if (masked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Lock size={22} aria-hidden style={{ color: theme.accent }} />
        <p className="text-xs font-medium" style={{ color: theme.ink }}>
          已锁定 · 私密便签
        </p>
        <button
          type="button"
          onClick={() =>
            void openUnlockWindow().catch((error: unknown) =>
              logger.caught(SCOPE, "开口令窗失败", error),
            )
          }
          className="rounded-md px-4 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ backgroundColor: theme.accent, color: theme.paper }}
        >
          解锁
        </button>
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            aria-label="删除便签"
            title="删除（可在回收站恢复）"
            onClick={onDelete}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent }}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1.5 p-3">
      {/* 类型切换 + 六色 */}
      <div
        className="flex shrink-0 items-center gap-0.5"
        role="group"
        aria-label="便签类型"
      >
        {NOTE_TYPE_ORDER.map((type) => {
          const Icon = TYPE_ICONS[type];
          const active = note.contentType === type;
          return (
            <button
              key={type}
              type="button"
              aria-label={`转为${noteTypeLabel(type)}`}
              aria-pressed={active}
              title={`转为${noteTypeLabel(type)}`}
              onClick={() => switchType(type)}
              className="rounded p-1 transition-colors"
              style={{
                color: active ? theme.accent : theme.ink,
                backgroundColor: active ? "rgba(0,0,0,0.07)" : "transparent",
                opacity: active ? 1 : 0.45,
              }}
            >
              <Icon size={14} aria-hidden />
            </button>
          );
        })}
        <div className="flex-1" />
        {dueBadge}
        <div role="group" aria-label="便签颜色" className="flex items-center gap-1">
          {THEME_KEYS.map((key) => {
            const dot = themeOf(key);
            const active = key === note.theme;
            return (
              <button
                key={key}
                type="button"
                aria-label={`换成${dot.name}`}
                aria-pressed={active}
                title={dot.name}
                onClick={() => updateNote(id, { theme: key })}
                className="h-3.5 w-3.5 rounded-full border transition-transform hover:scale-110"
                style={{
                  backgroundColor: dot.paper,
                  borderColor: active ? dot.accent : "rgba(0,0,0,0.15)",
                  boxShadow: active ? `0 0 0 2px ${dot.accent}55` : "none",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* 标题 */}
      <input
        aria-label="便签标题"
        value={note.title}
        maxLength={40}
        placeholder="标题"
        onChange={(event) => updateNote(id, { title: event.target.value })}
        className="shrink-0 bg-transparent text-sm font-semibold"
        style={{ color: theme.ink }}
      />

      {/* 内容体 */}
      {note.contentType === "todo" ? (
        <TodoBody
          items={note.items}
          ink={theme.ink}
          accent={theme.accent}
          onChange={(items) => updateNote(id, { items })}
        />
      ) : note.contentType === "timeline" ? (
        <TimelineBody
          entries={note.timeline}
          ink={theme.ink}
          accent={theme.accent}
          onChange={(timeline) => updateNote(id, { timeline })}
        />
      ) : (
        <>
          {note.contentType === "reminder" && (
            <ReminderFields
              dueAt={note.dueAt}
              doneAt={note.doneAt}
              repeat={note.repeat}
              ink={theme.ink}
              accent={theme.accent}
              onChange={(patch) => updateNote(id, patch)}
            />
          )}
          <textarea
            aria-label="便签正文"
            value={note.body}
            maxLength={BODY_MAX}
            placeholder="写点什么…"
            onChange={(event) => updateNote(id, { body: event.target.value })}
            className="min-h-0 w-full flex-1 resize-none bg-transparent text-[13px] leading-relaxed"
            style={{ color: theme.ink }}
          />
        </>
      )}

      {/* 写入失败反馈条 */}
      {failures.length > 0 && (
        <div
          role="status"
          className="shrink-0 rounded px-2 py-1 text-[11px]"
          style={{ backgroundColor: "#FEE2E2", color: "#991B1B" }}
        >
          有改动还没写进磁盘，会自动重试
        </div>
      )}

      {/* 页脚：归组槽 + 标签 + 字数 + 窗级动作 + 私密 + 删除 */}
      <div className="flex shrink-0 items-center gap-1">
        {leadingActions}
        {note.tags.map((tag) => {
          const chipInk = tagInk(tag);
          return (
            <span
              key={tag}
              className="flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px]"
              style={{ backgroundColor: chipInk.background, color: chipInk.ink }}
            >
              {tag}
              <button
                type="button"
                aria-label={`摘掉标签「${tag}」`}
                onClick={() =>
                  updateNote(id, { tags: note.tags.filter((name) => name !== tag) })
                }
                className="opacity-40 transition-opacity hover:opacity-100"
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          aria-label="添加标签"
          placeholder="+ 标签"
          maxLength={20}
          className="w-16 rounded-full bg-black/5 px-2 py-0.5 text-[10px] placeholder:text-black/30"
          style={{ color: theme.ink }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              addTag(event.currentTarget.value);
              event.currentTarget.value = "";
            }
          }}
          onBlur={(event) => {
            addTag(event.currentTarget.value);
            event.currentTarget.value = "";
          }}
        />
        <div className="flex-1" />
        {shouldShowCount(note.body.length, BODY_MAX) && (
          <span className="text-[10px] opacity-40" style={{ color: theme.ink }}>
            {note.body.length}/{BODY_MAX}
          </span>
        )}
        {windowActions}
        <button
          type="button"
          aria-label={note.private ? "取消私密" : "标记私密"}
          title={note.private ? "取消私密" : "标记私密"}
          onClick={() => {
            if (note.private && (priv.active ? priv.unlocked : true)) {
              updateNote(id, { private: false });
              return;
            }
            if (!note.private && priv.active && priv.unlocked) {
              updateNote(id, { private: true });
              return;
            }
            void openUnlockWindow().catch((error: unknown) =>
              logger.caught(SCOPE, "开口令窗失败", error),
            );
          }}
          className="rounded p-1 transition-colors hover:bg-black/10"
          style={{ color: theme.accent }}
        >
          {note.private ? (
            <LockOpen size={14} aria-hidden />
          ) : (
            <Lock size={14} aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label="删除便签"
          title="删除（可在回收站恢复）"
          onClick={onDelete}
          className="rounded p-1 transition-colors hover:bg-black/10"
          style={{ color: theme.accent }}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}
