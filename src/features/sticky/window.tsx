// 便签浮窗 — 一张便签一扇 OS 窗口。
//
// 这一层只管**窗口级**的事：身份、几何、收起/贴边、置顶、关窗前冲刷；
// 内容渲染全部在 NoteContent（单窗与叠窗共用，谁也不许抄一份）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Layers, PanelLeftClose } from "lucide-react";
import { StickyLeading, WindowChrome } from "@/ui/window-chrome";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { displayTitle } from "@/data/note-types";
import { TITLE_MAX } from "@/data/limit";
import { describeDue } from "@/data/due";
import type { DockEdge } from "@/platform/contracts";
import { NoteContent } from "@/features/sticky/note-content";
import { GroupMenu } from "@/features/sticky/group-menu";
import { useNow } from "@/features/sticky/use-now";
import {
  BAR_HEIGHT,
  BAR_MAX_WIDTH,
  STICKY_DEFAULT_SIZE,
  STICKY_MIN_SIZE,
} from "@/features/sticky/window-statics";
import { type DockTarget, useDockSnap } from "@/window/use-dock-snap";
import { useAutoSize } from "@/window/use-auto-size";
import { DockSliver } from "@/window/dock-sliver";
import { useDragToGroup } from "@/window/drag-to-group";
import { useNote } from "@/store/hooks";
import { useAutoSizeDefault } from "@/data/auto-size-default";
import { flushNow, updateNote } from "@/store/notes-store";
import { closeFloatingSticky } from "@/platform/commands";
import {
  currentWindow,
  resizeKeepingPosition,
  setWindowMinSize,
} from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { getStickyId } from "@/window/identity";
import { useWindowGeometry } from "@/window/geometry";
import { useStickyPing } from "@/window/use-sticky-ping";

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

  /**
   * 贴边要读写的那一份。单窗就是这张便签自己那行；展开档的尺寸在这里就把默认值带好
   * （`use-dock-snap` 不再猜），落库走 `updateNote`。
   */
  const dockTarget = useMemo<DockTarget | null>(
    () =>
      id === null || note === null
        ? null
        : {
            id,
            docked: note.docked,
            dockEdge: note.dockEdge,
            x: note.x,
            y: note.y,
            width: note.width ?? STICKY_DEFAULT_SIZE.width,
            height: note.height ?? STICKY_DEFAULT_SIZE.height,
            write: (docked: boolean, dockEdge: DockEdge | null) =>
              updateNote(id, { docked, dockEdge }),
          },
    [id, note],
  );

  /** 贴边吸附：判定在 dock-model（纯函数），这里只接交互。无条件调用（Hooks 纪律） */
  const dock = useDockSnap({ target: dockTarget, minimized });

  /**
   * 提醒卡点开来时的那一圈纸边。**贴着的这一张要先滑出来**：细丝那 20×20 里壳体压根
   * 没渲染，圈画在哪儿都看不见（作者第二次报"点了没反应"问的就是这种）。
   */
  const flash = useStickyPing(
    () => (id === null ? [] : [id]),
    () => {
      if (dock.docked && !dock.revealed) dock.toggleReveal();
    },
  );

  /**
   * 拖拽进组：把这扇窗拖到另一扇/另一叠上松手。收起态与贴边态关掉——
   * 那两种形态下的 moved 都不是"用户把窗往别人身上挪"。无条件调用（Hooks 纪律）。
   */
  const merge = useDragToGroup(id ?? "", !minimized && !dock.docked && !dock.revealed);

  /**
   * 自动长高的生效值：这张表过态就听自己的，没表过态听全局。
   * 收起态与贴边态一律关：那两档的尺寸是死的（62 栏 / 20 细丝），跟着内容走就成了打架。
   * 遮罩态不用判：那时 NoteContent 整面换锁，压根没有正文那一格可量。
   */
  const autoDefault = useAutoSizeDefault();
  const autoEnabled =
    !minimized && !dock.docked && !dock.revealed && (note?.autoSize ?? autoDefault);
  const autoOnRef = useRef(false);
  useEffect(() => {
    autoOnRef.current = autoEnabled;
  }, [autoEnabled]);

  const getBodySlot = useCallback(
    () => document.querySelector<HTMLElement>("[data-body-slot]"),
    [],
  );

  /** 手拉窗边 = 这张要固定：记下拉到的尺寸，并把三态拨到"强制固定" */
  const handleManualResize = useCallback(
    (size: { width: number; height: number }) => {
      if (id === null) return;
      updateNote(id, {
        autoSize: false,
        width: Math.round(size.width),
        height: Math.round(size.height),
      });
    },
    [id],
  );

  useAutoSize({
    note,
    enabled: autoEnabled,
    getSlot: getBodySlot,
    onManualResize: handleManualResize,
  });

  /**
   * 关掉自动的这一刻回到行里那个固定值。不补这一写，"固定值还能继续用"就只是说说：
   * 窗还停在自动算出来的尺寸上，得重开一扇才对得上。
   * 只在"刚才开着、现在关了"那一瞬做（首帧不动，不然刚开出来的窗被自己搬一次）。
   */
  const wasAuto = useRef(false);
  useEffect(() => {
    const turningOff = wasAuto.current && !autoEnabled;
    wasAuto.current = autoEnabled;
    if (!turningOff || minimized || id === null) return;
    const width = note?.width ?? STICKY_DEFAULT_SIZE.width;
    const height = note?.height ?? STICKY_DEFAULT_SIZE.height;
    void resizeKeepingPosition(width, height).catch((error: unknown) =>
      logger.caught(SCOPE, "回到固定尺寸失败", error),
    );
  }, [autoEnabled, minimized, note?.width, note?.height, id]);

  useWindowGeometry(
    commitGeometry,
    // 自动期间不把手拉尺寸写回行里：那个"固定值"是关掉自动要回去的地方，覆盖一次就没了
    () => minimizedRef.current || dock.suppressGeometry || autoOnRef.current,
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

  /**
   * 原生最小尺寸跟着**这一档**走：展开 = 220×200（"手拉不能把便签缩到捏不住"这条），
   * 收起或贴边 = 不限。留着 220×200 的话，那条 62 高的栏会被系统当场撑回 200——
   * 收起与贴边要的是"这一档该多大就多大"，不是那张正文的下限。
   * 贴边动画途中的两次写归 `use-dock-snap`（它要"补间前撤、落地后再还"），这里只保证
   * 静止时规则对得上，包括开机恢复回来的那条栏。
   */
  useEffect(() => {
    if (dock.docked) return;
    void setWindowMinSize(minimized ? null : STICKY_MIN_SIZE).catch((error: unknown) =>
      logger.caught(SCOPE, "同步原生最小尺寸失败", error),
    );
  }, [minimized, dock.docked]);

  const handleMinimize = useCallback(() => {
    if (id === null || note === null || minimized) return;
    if (dock.docked) return; // 贴边态本身就是收纳形态，不叠收起
    setMinimized(true);
    minimizedRef.current = true; // 程序性改尺寸必须立刻被几何合流看见
    const width = Math.min(note.width ?? STICKY_DEFAULT_SIZE.width, BAR_MAX_WIDTH);
    void (async () => {
      // 顺序要紧：下限还挂着 200 就先去缩，缩到 62 那一下会被系统夹回 200 高
      try {
        await setWindowMinSize(null);
      } catch (error: unknown) {
        logger.caught(SCOPE, "收起前撤下限失败（栏可能被撑回 200）", error);
      }
      await resizeKeepingPosition(width, BAR_HEIGHT).catch((error: unknown) =>
        logger.caught(SCOPE, "收起失败", error),
      );
    })();
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

  // 贴边未滑出：整扇窗只有 20×20。把壳体（标题条三颗按钮 + 正文 + 页脚）塞进这 400
  // 平方像素里，得到的是一团谁也捏不住的纸屑——所以这一支整支接管，只留纸色小签
  // 与内侧那道强调色刻痕。点小签、Tab、Enter、空格都把它滑出来。
  if (dock.docked && !dock.revealed) {
    return (
      <DockSliver
        edge={note.dockEdge}
        background={theme.paper}
        accent={theme.accent}
        onReveal={dock.toggleReveal}
      />
    );
  }

  return (
    <>
      <WindowChrome
        background={theme.paper}
        accent={theme.accent}
        ink={theme.ink}
        collapsed={minimized}
        flash={flash}
        titleValue={note.title}
        titleMaxLength={TITLE_MAX}
        onRename={(next) => updateNote(id, { title: next })}
        title={
          barTitle.length > BAR_TITLE_MAX
            ? `${barTitle.slice(0, BAR_TITLE_MAX)}…`
            : barTitle
        }
        badges={barBadges}
        leading={<StickyLeading accent={theme.accent} />}
        trailing={
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
            {!dock.docked && !minimized && (
              /* 窗级动作归标题条右侧那一槽（规则与为什么不放页脚，见 `WindowChrome` 的
                 trailing 那条）；收起态不给它——那条栏上已经有「展开」，并排两颗同类钮是骗人 */
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
        pinned={note.pinned}
        onTogglePin={handleTogglePin}
        onExpand={handleExpand}
        onClose={handleClose}
      >
        <NoteContent
          id={id}
          note={note}
          onCollapse={handleMinimize}
          leadingActions={<GroupMenu id={id} groupId={note.groupId} />}
          onDelete={handleDelete}
        />
      </WindowChrome>
      {/*
        拖拽进组的当场反馈：只有悬在别人身上那一小段才出现，居中一条反色胶囊说清
        松手会并进谁——纸色底 + 细描边那版在纸面上几乎没有对比度，看着像贴歪的贴纸，
        所以字走反色（强调色底、纸色字）。整窗描环试过，作者不要：拖着的这张纸
        不该因为"快并进去了"就换一张脸。pointer-events-none：不许抢走这一下拖动。
      */}
      {merge.candidate !== null && (
        <div
          role="status"
          className="merge-hint pointer-events-none fixed inset-0 z-40 flex items-center justify-center px-3"
        >
          <span
            className="flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold shadow-[0_8px_20px_rgba(0,0,0,0.26)]"
            style={{ backgroundColor: theme.accent, color: theme.paper }}
          >
            <Layers size={12} aria-hidden className="shrink-0" />
            <span className="truncate">松手并入「{merge.candidate.name}」</span>
          </span>
        </div>
      )}
    </>
  );
}

async function removeNoteAndFlush(id: string): Promise<void> {
  const { removeNote } = await import("@/store/notes-store");
  await removeNote(id);
  await flushNow();
}
