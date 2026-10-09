// 叠窗 — 一叠一扇：同一组的几张便签共用一扇窗，在窗里翻着看。
//
// 内容渲染仍是 NoteContent 那一份：归组菜单照传（叠窗里也得能把手里这张移出去，
// 否则「移进」是个单向门）。窗级动作（收起 / 贴边那颗「收回」）不从这里走——它们和
// 单窗一样住标题条右侧（`WindowChrome` 的 trailing 槽），作者要的就是"两张纸同一个位置"。
// 翻页控件走拖动条的 leading 槽。
//
// 几何不在这里管：Rust 的 frames::track 认 stickygrp-* 前缀，拖动合流 600ms 落
// window_state，开窗时 apply_saved 原样放回。这里若再写一遍就是两个住址。
// 唯一的例外是"展开尺寸"：收起期间 window_state 记的就是那条栏，恢复要的数
// 只能另存一份到组行（见 handleCollapse）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers,
  PanelLeftClose,
  Pencil,
} from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { GROUP_NAME_MAX } from "@/data/limit";
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
import { useNote, useNotes, useStoreStatus } from "@/store/hooks";
import { flushNow, removeNote } from "@/store/notes-store";
import {
  closeGroupStack,
  groupList,
  groupRename,
  groupSetCollapsed,
  groupSetDock,
} from "@/platform/commands";
import {
  currentWindow,
  currentWindowSize,
  listen,
  resizeKeepingPosition,
  setWindowMinSize,
} from "@/platform/bridge";
import { describeError } from "@/platform/errors";
import { logger } from "@/platform/logger";
import { STICKY_REVEAL } from "@/platform/contracts";
import type { StickyGroup, StickyRevealEvent } from "@/platform/contracts";
import {
  getGroupId,
  getStackCollapsedAtBirth,
  getStickyFocusId,
} from "@/window/identity";
import { useStickyPing } from "@/window/use-sticky-ping";
import { type DockTarget, useDockSnap } from "@/window/use-dock-snap";
import { DockSliver } from "@/window/dock-sliver";
import type { DockEdge } from "@/platform/contracts";
import { activeId, membersOf, neighborId, positionOf } from "@/window/stack-model";
import { GroupTabs } from "@/features/sticky/group-tabs";
import { GroupAccordion } from "@/features/sticky/group-accordion";
import { displayName } from "@/features/sticky/stack-view";
import { useGroupPresentation, type GroupPresentation } from "@/data/group-presentation";

const SCOPE = "stack";

/**
 * 每档怎么抽张，写在标题条上而不是让人猜：分页有箭头，色块签与手风琴各给一句。
 * 加了新档忘了在这里登记，标题条就少一句说明（不会画错，只是不说）。
 */
const MODE_HINT: Partial<Record<GroupPresentation, string>> = {
  tabs: "点右侧色块翻张",
  accordion: "点标题行就地展开",
};

export function GroupStackWindow() {
  const gid = getGroupId();
  const notes = useNotes();
  const { resolved } = useScheme();
  const { ready } = useStoreStatus();
  /** 分页翻 / 侧边色块签 / 手风琴。开关在设置窗，切档立刻重排这一扇，不用重开 */
  const presentation = useGroupPresentation();
  const [currentId, setCurrentId] = useState<string | null>(() => getStickyFocusId());
  const [group, setGroup] = useState<StickyGroup | null>(null);
  /** 置顶是这扇窗的当场状态：groups 行没有 pinned 列，重开按开窗规格回到置顶 */
  const [pinned, setPinned] = useState(true);
  /**
   * 收起成标题栏那一档。**出生就读注入的全局**（identity.ts），不等 `group_list` 回来：
   * 那一趟往返之前窗已经按 62 高亮了，首帧画一张正文再改形状就是"打开时抖一下"。
   * 会话内的开合归这里，落库的读法走 `groups.collapsed`（同 `pinned` 那条分工）。
   */
  const [collapsed, setCollapsed] = useState(getStackCollapsedAtBirth);
  /**
   * 收起前那一刻量到的展开尺寸。组行是跨会话的那一份，这一份是**当场**的那一份：
   * 刚收完就点展开，`group_list` 还没回来，读行会读到上一次的值（或 null 落到默认尺寸）。
   */
  const [expanded, setExpanded] = useState<{ width: number; height: number } | null>(
    null,
  );
  /** 收起栏上的到期角标按时钟分档（与单窗同一条），渲染期不许直接取 Date.now() */
  const now = useNow();
  /**
   * 改组合名。名字今天只在"拖两张到一起"那一刻抄第一张的标题，之后没有任何改的地方
   * （作者报的这条）。草稿取 `group.name` 原文，输入框硬顶 `GROUP_NAME_MAX`；
   * 空串/超长的最终口径在 Rust（`group::normalize_name`），所以提交完是**重读一遍**
   * 拿回来的那份，不在这里再算一遍第二个真相。
   */
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) nameInput.current?.focus();
  }, [renaming]);

  const commitName = useCallback((): void => {
    if (gid === null) return;
    setRenaming(false);
    void groupRename(gid, draft)
      .then(() => groupList())
      .then((rows) => setGroup(rows.find((row) => row.id === gid) ?? null))
      .catch((error: unknown) => {
        // 改失败要当场说：不然是"按了没反应"，而这正是最难自己发现的那类
        setNameError(`名字没改掉：${describeError(error)}`);
        logger.caught(SCOPE, "改组合名失败", error);
      });
  }, [gid, draft]);

  const members = useMemo(
    () => (gid === null ? [] : membersOf(notes, gid)),
    [notes, gid],
  );
  /**
   * 贴边那一档。判定与动画全在 `use-dock-snap`（与单窗同一份），这里给的是**组行**那一份
   * target：展开尺寸取 `groups.width/height`（收起时被刷新过），落库走 `group_set_dock`。
   * `group` 是异步到的 → 到之前按自由窗处理，到了且记着 docked 就补一次开机恢复。
   */
  const dockTarget = useMemo<DockTarget | null>(
    () =>
      gid === null || group === null
        ? null
        : {
            id: gid,
            docked: group.docked,
            dockEdge: group.dockEdge,
            x: group.x,
            y: group.y,
            width: group.width ?? STICKY_DEFAULT_SIZE.width,
            height: group.height ?? STICKY_DEFAULT_SIZE.height,
            write: (docked: boolean, edge: DockEdge | null) => {
              // **本地先翻**：`dock.docked` 读的就是这一份 state，不翻它的话细丝已经
              // 摆出去了、壳体还挂着（单窗那边 `updateNote` 走 store 回流，天然有这一拍）
              setGroup((prev) =>
                prev === null ? prev : { ...prev, docked, dockEdge: edge },
              );
              void groupSetDock(gid, docked, edge).catch((error: unknown) =>
                logger.caught(SCOPE, "记贴边状态失败", error),
              );
            },
          },
    [gid, group],
  );
  const dock = useDockSnap({ target: dockTarget, minimized: collapsed });

  /**
   * 提醒卡点开来时的那一圈纸边：这一叠里**有**那张就算，不用它正好是当前哪一张。
   * 贴着的那一叠先滑出来再闪（细丝里壳体没渲染，光闪看不见）。
   */
  const flash = useStickyPing(
    () => members.map((member) => member.id),
    () => {
      if (dock.docked && !dock.revealed) dock.toggleReveal();
    },
  );
  const shownId = activeId(members, currentId);
  const shown = useNote(shownId);
  const at = shownId === null ? null : positionOf(members, shownId);

  useEffect(() => {
    if (gid === null) return;
    void groupList()
      .then((rows) => setGroup(rows.find((row) => row.id === gid) ?? null))
      .catch((error: unknown) => logger.caught(SCOPE, "取组合清单失败", error));
  }, [gid]);

  // 窗已经在了又被点到（搜索点结果 / 别处的窗归组）：由事件把这一扇翻过去
  useEffect(() => {
    if (gid === null) return;
    let unbind: (() => void) | null = null;
    let cancelled = false;
    void listen<StickyRevealEvent>(STICKY_REVEAL, (payload) => {
      if (payload.groupId === gid) setCurrentId(payload.stickyId);
    })
      .then((off) => {
        if (cancelled) off();
        else unbind = off;
      })
      .catch((error: unknown) => logger.caught(SCOPE, "订阅叠窗落点失败", error));
    return () => {
      cancelled = true;
      unbind?.();
    };
  }, [gid]);

  // 关窗前把在途写落盘：叠窗销毁是 Rust 侧 destroy，没有第二次机会
  useEffect(() => {
    const flush = (): void => {
      void flushNow();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      void flushNow();
    };
  }, []);

  // 这一叠翻空了（成员被删空或全被移走）就自己退场：空叠没有可显示的东西
  useEffect(() => {
    if (gid === null || !ready || members.length > 0) return;
    void closeGroupStack(gid).catch((error: unknown) =>
      logger.caught(SCOPE, "空叠退场失败", error),
    );
  }, [gid, ready, members.length]);

  const turn = useCallback(
    (step: number): void => {
      if (shownId === null) return;
      setCurrentId(neighborId(members, shownId, step));
    },
    [members, shownId],
  );

  const handleTogglePin = useCallback((): void => {
    const next = !pinned;
    setPinned(next);
    void currentWindow()
      .setAlwaysOnTop(next)
      .catch((error: unknown) => logger.caught(SCOPE, "切换置顶失败", error));
  }, [pinned]);

  /**
   * 原生最小尺寸跟着**这一档**走（与单窗那条 effect 同一条规则）：展开 = 220×200，
   * 收起 = 不限。留着 220×200，那条 62 高的栏会被系统当场撑回 200。
   * 出生时 Rust 已按 `groups.collapsed` 给过对的那一份，这里只管会话内切换与开机恢复
   * 后的一致性（同档重贴一次是空操作）。
   */
  useEffect(() => {
    void setWindowMinSize(collapsed ? null : STICKY_MIN_SIZE).catch((error: unknown) =>
      logger.caught(SCOPE, "同步原生最小尺寸失败", error),
    );
  }, [collapsed]);

  /**
   * 收起这一叠。三步的顺序不能换（单窗 handleMinimize 那条坑一模一样）：
   *  1. 先撤原生下限——挂着 220×200 去缩，62 高的栏会被撑回 200；
   *  2. 量**还没缩时**的尺寸，再缩到那条栏（量晚了量到的就是栏）；
   *  3. 把展开尺寸报给 `group_set_collapsed`（为什么要报它，文件头那条讲过）。
   */
  const handleCollapse = useCallback((): void => {
    if (gid === null || collapsed) return;
    setCollapsed(true);
    void (async () => {
      try {
        await setWindowMinSize(null);
      } catch (error: unknown) {
        logger.caught(SCOPE, "收起前撤下限失败（栏可能被撑回 200）", error);
      }
      const size = await currentWindowSize();
      setExpanded(size);
      await resizeKeepingPosition(Math.min(size.width, BAR_MAX_WIDTH), BAR_HEIGHT);
      await groupSetCollapsed(gid, true, size);
    })().catch((error: unknown) => logger.caught(SCOPE, "收起失败", error));
  }, [gid, collapsed]);

  /**
   * 展开回正文那一档。尺寸优先用当场量到的那份，其次组行（跨会话的那一份），
   * 都没有才落默认值；下限等尺寸到位之后再还（见上面那条 effect，它跟着 collapsed 走）。
   */
  const handleExpand = useCallback((): void => {
    if (gid === null || !collapsed) return;
    const width = Math.max(
      STICKY_MIN_SIZE.width,
      expanded?.width ?? group?.width ?? STICKY_DEFAULT_SIZE.width,
    );
    const height = Math.max(
      STICKY_MIN_SIZE.height,
      expanded?.height ?? group?.height ?? STICKY_DEFAULT_SIZE.height,
    );
    void resizeKeepingPosition(width, height)
      .then(() => groupSetCollapsed(gid, false))
      .then(() => {
        setCollapsed(false);
        setExpanded(null);
      })
      .catch((error: unknown) => logger.caught(SCOPE, "展开失败", error));
  }, [gid, collapsed, expanded, group?.width, group?.height]);

  const handleClose = useCallback((): void => {
    if (gid === null) return;
    void (async () => {
      await flushNow();
      await closeGroupStack(gid).catch((error: unknown) =>
        logger.caught(SCOPE, "关叠窗失败", error),
      );
    })();
  }, [gid]);

  const handleDelete = useCallback((): void => {
    if (shownId === null) return;
    void (async () => {
      try {
        await flushNow();
        await removeNote(shownId);
      } catch (error) {
        logger.caught(SCOPE, "删除前落盘失败，仍继续删", error);
      }
    })();
  }, [shownId]);

  if (gid === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-red-50 text-sm text-red-700">
        这扇窗口缺少组合 id（应由 Rust 注入）
      </div>
    );
  }
  if (shown === null || shownId === null) {
    // 空叠：退场效果已经在跑了，这一帧给个不骗人的中间态
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-100 text-sm text-neutral-500">
        这一叠空了
      </div>
    );
  }

  const theme = themeColors(shown.theme, resolved);
  /**
   * 贴着边、还没滑出：整扇窗只有 20×20，把壳体塞进去就是一团捏不住的纸屑 ——
   * 与单窗同一条，整支换成小签。点它滑出（滑出来是**这一档**的样子：收起态就是那条栏）。
   */
  if (dock.docked && !dock.revealed) {
    return (
      <DockSliver
        edge={group?.dockEdge ?? "left"}
        background={theme.paper}
        accent={theme.accent}
        onReveal={dock.toggleReveal}
      />
    );
  }
  const total = members.length;
  /**
   * 收起那一档不翻张：箭头、扇面切片与"怎么抽张"那句说明一起收——正文没画出来，
   * 箭头点了也没东西可看，留着只会在 360 宽的条里把组合名挤没。
   */
  const paging = !collapsed && presentation === "pages";
  /** 只有分页给箭头：色块签与手风琴的抽张动作都在纸面上，不在标题条上 */
  const turning = paging;
  const hint = collapsed || paging ? null : (MODE_HINT[presentation] ?? null);
  /**
   * 收起栏上的到期角标：这一叠里**当前那张**是提醒且没勾掉才给。
   * 为什么要它——收起来的叠窗只剩一条栏，到点的提醒要是只住在通知里，
   * 那条 toast 早就散了，用户回头看不出"这一叠里有事没办"。
   */
  const due = describeDue(shown.dueAt, shown.doneAt, now);
  const dueUrgent = due.state === "overdue" || due.state === "today";
  const barBadges =
    collapsed &&
    shown.contentType === "reminder" &&
    due.state !== "none" &&
    due.state !== "done" ? (
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

  /**
   * 「收起为标题栏」这颗钮，与单窗那颗住在同一个槽（`WindowChrome` 的 trailing，
   * 标题条右侧）。作者要的就是这个统一：两张纸的最小化钮都在右上角。
   */
  const collapseButton = (
    <button
      type="button"
      aria-label="收起为标题栏"
      title="收起"
      onClick={handleCollapse}
      className="rounded p-1 transition-colors hover:bg-black/10"
      style={{ color: theme.accent }}
    >
      <ChevronDown size={14} aria-hidden />
    </button>
  );

  return (
    <WindowChrome
      background={theme.paper}
      accent={theme.accent}
      ink={theme.ink}
      collapsed={collapsed}
      flash={flash}
      badges={barBadges}
      onExpand={handleExpand}
      leading={
        <div className="flex min-w-0 items-center gap-1">
          {turning && (
            <button
              type="button"
              aria-label="上一张"
              title="上一张"
              onClick={() => turn(-1)}
              className="rounded p-1 transition-colors hover:bg-black/10"
              style={{ color: theme.accent }}
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
          )}
          {paging && (
            /* 扇面切片：一张一竖条，当前那张立起来；点条直接跳到那一张 */
            <div
              className="flex items-end gap-0.5"
              role="group"
              aria-label="这一叠的便签"
            >
              {members.map((member, index) => {
                const isCurrent = member.id === shownId;
                const tilt = (index - (at ?? 0)) * 2;
                return (
                  <button
                    key={member.id}
                    type="button"
                    aria-label={`第 ${index + 1} 张，共 ${total} 张`}
                    aria-pressed={isCurrent}
                    title={displayName(member)}
                    onClick={() => setCurrentId(member.id)}
                    className="w-1 rounded-full transition-all"
                    style={{
                      height: isCurrent ? 16 : 9,
                      backgroundColor: themeColors(member.theme, resolved).accent,
                      opacity: isCurrent ? 1 : 0.4,
                      transform: `rotate(${tilt}deg)`,
                    }}
                  />
                );
              })}
            </div>
          )}
          {hint !== null && (
            <span className="text-[10px]" style={{ color: theme.accent }}>
              {hint}
            </span>
          )}
          {turning && (
            <button
              type="button"
              aria-label="下一张"
              title="下一张"
              onClick={() => turn(1)}
              className="rounded p-1 transition-colors hover:bg-black/10"
              style={{ color: theme.accent }}
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          )}
          {!collapsed && (
            <span className="text-[10px] tabular-nums" style={{ color: theme.accent }}>
              {(at ?? 0) + 1}/{total}
            </span>
          )}
          {group !== null &&
            (renaming ? (
              <span className="flex min-w-0 items-center gap-1">
                <input
                  ref={nameInput}
                  aria-label="组合名称"
                  value={draft}
                  maxLength={GROUP_NAME_MAX}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitName();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(false);
                    }
                  }}
                  onBlur={commitName}
                  className="w-32 rounded bg-black/5 px-1 text-xs outline-none"
                  style={{ color: theme.accent }}
                />
                <button
                  type="button"
                  aria-label="组合名定了"
                  // 有 input 在场，点这颗钮会先触发 input 的 blur → commitName 已经跑过了；
                  // 这里再调一次是幂等的（同一个名字写两遍），但省掉"点了没反应"的错觉
                  onClick={commitName}
                  className="rounded p-0.5 transition-colors hover:bg-black/10"
                  style={{ color: theme.accent }}
                >
                  <Check size={11} aria-hidden />
                </button>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-0.5">
                <Layers size={12} aria-hidden className="shrink-0" />
                {/*
                  字号跟着单窗那条栏走（`text-xs` + semibold，作者报"组合最小化标题字太小"——
                  原来 10px 是这条栏里最小的一号字，收起后整条栏就剩它一个标题）。
                  名字自己占一格才截得出省略号：文本直接挂在 flex 容器上是个"匿名 flex item"，
                  `truncate` 里只有 overflow:hidden 对它生效，出来是没有省略号的半截字。
                  上限 168 是给收起那一档留的——整条栏才 360 宽，长名字会把右边三颗钮顶出窗。
                */}
                <span
                  className="max-w-[168px] truncate text-xs font-semibold"
                  style={{ color: theme.accent }}
                  title={`组合：${group.name}`}
                >
                  {group.name}
                </span>
                <button
                  type="button"
                  aria-label="改组合名"
                  title="改组合名（Enter 定、Esc 不算）"
                  onClick={() => {
                    setNameError(null);
                    setDraft(group.name);
                    setRenaming(true);
                  }}
                  className="shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:opacity-100"
                  style={{ color: theme.accent }}
                >
                  <Pencil size={12} aria-hidden />
                </button>
              </span>
            ))}
          {nameError !== null && (
            <span
              role="alert"
              className="min-w-0 truncate text-[10px]"
              style={{ color: "#B91C1C" }}
            >
              {nameError}
            </span>
          )}
        </div>
      }
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
          {!collapsed && collapseButton}
        </>
      }
      pinned={pinned}
      onTogglePin={handleTogglePin}
      onClose={handleClose}
    >
      {(() => {
        /** 三档拿到的东西完全一样（有谁、当前哪张、点谁、删手里这张），所以一份 props */
        const view = {
          members,
          currentId: shownId,
          onPick: setCurrentId,
          onDelete: handleDelete,
        };
        switch (presentation) {
          case "tabs":
            return <GroupTabs {...view} />;
          case "accordion":
            return <GroupAccordion {...view} />;
          case "pages":
            return (
              <NoteContent
                id={shown.id}
                note={shown}
                leadingActions={<GroupMenu id={shown.id} groupId={shown.groupId} />}
                onDelete={handleDelete}
              />
            );
        }
      })()}
    </WindowChrome>
  );
}
