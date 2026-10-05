// 叠窗 — 一叠一扇：同一组的几张便签共用一扇窗，在窗里翻着看。
//
// 内容渲染仍是 NoteContent 那一份：归组菜单照传（叠窗里也得能把手里这张移出去，
// 否则「移进」是个单向门），收起/贴边收纳那组窗级动作不传——叠窗没有这两种形态。
// 翻页控件走拖动条的 leading 槽。
//
// 几何不在这里管：Rust 的 frames::track 认 stickygrp-* 前缀，拖动合流 600ms 落
// window_state，开窗时 apply_saved 原样放回。这里若再写一遍就是两个住址。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Layers } from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { NoteContent } from "@/features/sticky/note-content";
import { GroupMenu } from "@/features/sticky/group-menu";
import { useNote, useNotes, useStoreStatus } from "@/store/hooks";
import { flushNow, removeNote } from "@/store/notes-store";
import { closeGroupStack, groupList } from "@/platform/commands";
import { currentWindow, listen } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { STICKY_REVEAL } from "@/platform/contracts";
import type { StickyGroup, StickyRevealEvent } from "@/platform/contracts";
import { getGroupId, getStickyFocusId } from "@/window/identity";
import { activeId, membersOf, neighborId, positionOf } from "@/window/stack-model";

const SCOPE = "stack";

export function GroupStackWindow() {
  const gid = getGroupId();
  const notes = useNotes();
  const { resolved } = useScheme();
  const { ready } = useStoreStatus();
  const [currentId, setCurrentId] = useState<string | null>(() => getStickyFocusId());
  const [group, setGroup] = useState<StickyGroup | null>(null);
  /** 置顶是这扇窗的当场状态：groups 行没有 pinned 列，重开按开窗规格回到置顶 */
  const [pinned, setPinned] = useState(true);

  const members = useMemo(
    () => (gid === null ? [] : membersOf(notes, gid)),
    [notes, gid],
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
  const total = members.length;

  return (
    <WindowChrome
      background={theme.paper}
      accent={theme.accent}
      leading={
        <div className="flex items-center gap-1">
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
          {/* 扇面切片：一张一竖条，当前那张立起来；点条直接跳到那一张 */}
          <div className="flex items-end gap-0.5" role="group" aria-label="这一叠的便签">
            {members.map((member, index) => {
              const isCurrent = member.id === shownId;
              const tilt = (index - (at ?? 0)) * 2;
              return (
                <button
                  key={member.id}
                  type="button"
                  aria-label={`第 ${index + 1} 张，共 ${total} 张`}
                  aria-pressed={isCurrent}
                  title={member.title.trim() === "" ? "未命名便签" : member.title}
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
          <span className="text-[10px] tabular-nums" style={{ color: theme.accent }}>
            {(at ?? 0) + 1}/{total}
          </span>
          {group !== null && (
            <span
              className="flex items-center gap-0.5 text-[10px]"
              style={{ color: theme.accent }}
            >
              <Layers size={11} aria-hidden />
              {group.name}
            </span>
          )}
        </div>
      }
      pinned={pinned}
      onTogglePin={handleTogglePin}
      onClose={handleClose}
    >
      <NoteContent
        id={shown.id}
        note={shown}
        leadingActions={<GroupMenu id={shown.id} groupId={shown.groupId} />}
        onDelete={handleDelete}
      />
    </WindowChrome>
  );
}
