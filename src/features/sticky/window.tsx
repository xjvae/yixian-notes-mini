// 便签浮窗 — 一张便签一扇 OS 窗口。
//
// 装配职责：读实体、把四类内容体与字段面板接上、收起/恢复/删除/置顶、
// 几何与在途写的收口。内容体只管渲染与回调，不碰 store。
//
// 行为口径（继承旧实现的事故教训）：
//  · 关窗/卸载前必须 flush：store 的去抖窗口里可能压着最后一笔编辑；
//  · 收起走 resizeKeepingPosition（62px 栏不是展开尺寸，几何合流在收起期被抑制）；
//  · 删除先 flush 再软删再关窗——软删可从回收站恢复，但最后一笔输入丢了就真丢了。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  ChevronDown,
  History,
  ListChecks,
  PanelLeftClose,
  TextIcon,
  Trash2,
} from "lucide-react";
import { StickyLeading, WindowChrome } from "@/ui/window-chrome";
import { themeOf, THEME_KEYS } from "@/data/theme";
import { displayTitle, noteTypeLabel, NOTE_TYPE_ORDER } from "@/data/note-types";
import { conversionPatch } from "@/data/note-convert";
import { describeDue } from "@/data/due";
import { BODY_MAX, shouldShowCount } from "@/data/limit";
import { normalizeTagInput, tagInk } from "@/data/tags";
import { useNow } from "@/features/sticky/use-now";
import { TodoBody } from "@/features/sticky/todo-body";
import { TimelineBody } from "@/features/sticky/timeline-body";
import { ReminderFields } from "@/features/sticky/reminder-fields";
import {
  BAR_HEIGHT,
  BAR_MAX_WIDTH,
  STICKY_DEFAULT_SIZE,
  STICKY_MIN_SIZE,
} from "@/features/sticky/window-statics";
import { useDockSnap } from "@/window/use-dock-snap";
import { useNote, useWriteFailures } from "@/store/hooks";
import { flushNow, removeNote, updateNote } from "@/store/notes-store";
import { closeFloatingSticky } from "@/platform/commands";
import { currentWindow, resizeKeepingPosition } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { getStickyId } from "@/window/identity";
import { useWindowGeometry } from "@/window/geometry";
import type { StickyContentType } from "@/platform/contracts";

const SCOPE = "sticky";
/** 收起栏上显示的标题上限：再长就截断，条高度是死的 */
const BAR_TITLE_MAX = 18;

const TYPE_ICONS: Record<StickyContentType, typeof TextIcon> = {
  text: TextIcon,
  todo: ListChecks,
  reminder: AlarmClock,
  timeline: History,
};

export function StickyWindow() {
  const id = getStickyId();
  const note = useNote(id);
  const failures = useWriteFailures();
  const now = useNow();

  /** 收起形态只认本地开关：展开尺寸记在行里，收起栏的高度不该写回去 */
  const [minimized, setMinimized] = useState(() => note?.collapsed ?? false);
  const minimizedRef = useRef(minimized);
  useEffect(() => {
    minimizedRef.current = minimized;
  }, [minimized]);

  // 几何合流持久化：moved/resized 静默 180ms 才写；收起与贴边期间抑制
  // （贴边的细丝/滑出位都不是用户的展开几何，记下它们就是毁掉恢复尺寸）
  const commitGeometry = useCallback(
    (
      patch: Partial<{
        x: number | null;
        y: number | null;
        width: number | null;
        height: number | null;
      }>,
    ) => {
      if (id === null) return;
      updateNote(id, patch);
    },
    [id],
  );

  /** 贴边吸附：判定在 dock-model（纯函数），这里只接交互。无条件调用（Hooks 纪律） */
  const dock = useDockSnap({ id: id ?? "", note, minimized });

  useWindowGeometry(
    commitGeometry,
    () => minimizedRef.current || dock.suppressGeometry,
    STICKY_MIN_SIZE,
  );

  const flush = useCallback(() => {
    void flushNow();
  }, []);

  // 关窗/卸载前冲刷在途写
  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      void flushNow();
    };
  }, [flush]);

  const handleTogglePin = useCallback(() => {
    if (id === null || note === null) return;
    const next = !note.pinned;
    updateNote(id, { pinned: next });
    void currentWindow()
      .setAlwaysOnTop(next)
      .catch((error: unknown) => logger.caught(SCOPE, "切换置顶失败", error));
  }, [id, note]);

  const handleClose = useCallback(() => {
    if (id === null) return;
    void (async () => {
      await flushNow();
      await closeFloatingSticky(id);
    })();
  }, [id]);

  const handleMinimize = useCallback(() => {
    if (id === null || note === null || minimized) return;
    if (dock.docked) return; // 贴边态本身就是收纳形态，不叠收起
    setMinimized(true);
    minimizedRef.current = true; // 程序性改尺寸必须立刻被几何合流看见
    const width = Math.min(note.width ?? STICKY_DEFAULT_SIZE.width, BAR_MAX_WIDTH);
    void resizeKeepingPosition(width, BAR_HEIGHT).catch((error: unknown) =>
      logger.caught(SCOPE, "收起失败", error),
    );
    updateNote(id, { collapsed: true });
  }, [id, note, minimized, dock.docked]);

  const handleExpand = useCallback(() => {
    if (id === null || note === null || !minimized) return;
    const width = Math.max(
      STICKY_MIN_SIZE.width,
      note.width ?? STICKY_DEFAULT_SIZE.width,
    );
    const height = Math.max(
      STICKY_MIN_SIZE.height,
      note.height ?? STICKY_DEFAULT_SIZE.height,
    );
    void resizeKeepingPosition(width, height)
      .then(() => {
        setMinimized(false);
        minimizedRef.current = false;
      })
      .catch((error: unknown) => logger.caught(SCOPE, "恢复失败", error));
    updateNote(id, { collapsed: false });
  }, [id, note, minimized]);

  const handleDelete = useCallback(() => {
    if (id === null) return;
    void (async () => {
      try {
        await flushNow();
        await removeNote(id);
        await flushNow();
      } catch (error) {
        logger.caught(SCOPE, "删除前落盘失败，仍继续关窗", error);
      }
      await closeFloatingSticky(id);
    })();
  }, [id]);

  if (id === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-red-50 text-sm text-red-700">
        这扇窗口缺少便签 id（应由 Rust 注入）
      </div>
    );
  }
  if (note === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-100 text-sm text-neutral-500">
        便签不存在，可能已被删除
      </div>
    );
  }

  const theme = themeOf(note.theme);
  const due = describeDue(note.dueAt, note.doneAt, now);
  const showDueBadge =
    note.contentType === "reminder" && due.state !== "none" && due.state !== "done";
  const dueUrgent = due.state === "overdue" || due.state === "today";

  const switchType = (to: StickyContentType): void => {
    updateNote(id, conversionPatch(note, to));
  };

  const addTag = (raw: string): void => {
    const name = normalizeTagInput(raw, note.tags);
    if (name !== null) updateNote(id, { tags: [...note.tags, name] });
  };

  const barTitle = displayTitle(note.title, note.private);
  const barBadges = showDueBadge ? (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
      style={{
        backgroundColor: dueUrgent ? theme.accent : "rgba(0,0,0,0.06)",
        color: dueUrgent ? "#fff" : theme.ink,
      }}
    >
      {due.text}
    </span>
  ) : null;

  return (
    <WindowChrome
      background={theme.paper}
      accent={theme.accent}
      collapsed={minimized}
      title={
        barTitle.length > BAR_TITLE_MAX
          ? `${barTitle.slice(0, BAR_TITLE_MAX)}…`
          : barTitle
      }
      badges={barBadges}
      leading={<StickyLeading accent={theme.accent} />}
      pinned={note.pinned}
      onTogglePin={handleTogglePin}
      onExpand={handleExpand}
      onClose={handleClose}
      onBodyClick={dock.docked && !dock.revealed ? () => dock.toggleReveal() : undefined}
      bodyClickLabel="滑出便签"
    >
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

        {/* 页脚：标签 + 字数 + 动作 */}
        <div className="flex shrink-0 items-center gap-1">
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
          {dock.docked && dock.revealed && (
            <button
              type="button"
              aria-label="收回贴边"
              title="收回贴边（拖离边缘可解除贴边）"
              onClick={() => dock.toggleReveal()}
              className="rounded p-1 transition-colors hover:bg-black/10"
              style={{ color: theme.accent }}
            >
              <PanelLeftClose size={14} aria-hidden />
            </button>
          )}
          {!dock.docked && (
            <button
              type="button"
              aria-label="收起为标题栏"
              title="收起"
              onClick={handleMinimize}
              className="rounded p-1 transition-colors hover:bg-black/10"
              style={{ color: theme.accent }}
            >
              <ChevronDown size={14} aria-hidden />
            </button>
          )}
          <button
            type="button"
            aria-label="删除便签"
            title="删除（可在回收站恢复）"
            onClick={handleDelete}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: theme.accent }}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>
    </WindowChrome>
  );
}
