// 便签浮窗 — 一张便签一扇 OS 窗口。
//
// 这一层只管**窗口级**的事：身份、几何、收起/贴边、置顶、关窗前冲刷；
// 内容渲染全部在 NoteContent（单窗与叠窗共用，谁也不许抄一份）。

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, PanelLeftClose } from "lucide-react";
import { StickyLeading, WindowChrome } from "@/ui/window-chrome";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { displayTitle } from "@/data/note-types";
import { describeDue } from "@/data/due";
import { NoteContent } from "@/features/sticky/note-content";
import { GroupMenu } from "@/features/sticky/group-menu";
import { useNow } from "@/features/sticky/use-now";
import {
  BAR_HEIGHT,
  BAR_MAX_WIDTH,
  STICKY_DEFAULT_SIZE,
  STICKY_MIN_SIZE,
} from "@/features/sticky/window-statics";
import { useDockSnap } from "@/window/use-dock-snap";
import { useNote } from "@/store/hooks";
import { flushNow, updateNote } from "@/store/notes-store";
import { closeFloatingSticky } from "@/platform/commands";
import { currentWindow, resizeKeepingPosition } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { getStickyId } from "@/window/identity";
import { useWindowGeometry } from "@/window/geometry";

const SCOPE = "sticky";
/** 收起栏上显示的标题上限：再长就截断，条高度是死的 */
const BAR_TITLE_MAX = 18;

export function StickyWindow() {
  const id = getStickyId();
  const note = useNote(id);
  const { resolved } = useScheme();
  /** 收起栏上的提醒角标按时钟分档；时钟走 hook，渲染里不许直接取 Date.now() */
  const now = useNow();

  /** 收起形态只认本地开关：展开尺寸记在行里，收起栏的高度不该写回去 */
  const [minimized, setMinimized] = useState(() => note?.collapsed ?? false);
  const minimizedRef = useRef(minimized);
  useEffect(() => {
    minimizedRef.current = minimized;
  }, [minimized]);

  // 几何合流持久化：moved/resized 静默 180ms 才写；收起与贴边期间抑制
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
        await removeNoteAndFlush(id);
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

  const theme = themeColors(note.theme, resolved);
  const due = describeDue(note.dueAt, note.doneAt, now);
  const showDueBadge =
    note.contentType === "reminder" && due.state !== "none" && due.state !== "done";
  const dueUrgent = due.state === "overdue" || due.state === "today";
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
      <NoteContent
        id={id}
        note={note}
        leadingActions={<GroupMenu id={id} groupId={note.groupId} />}
        windowActions={
          <>
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
          </>
        }
        onDelete={handleDelete}
      />
    </WindowChrome>
  );
}

async function removeNoteAndFlush(id: string): Promise<void> {
  const { removeNote } = await import("@/store/notes-store");
  await removeNote(id);
  await flushNow();
}
