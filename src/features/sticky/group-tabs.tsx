// 侧边色块签视图 — 右缘一条签列：一张一块 24×24 方色签（块上是类型图标，私密给锁），点哪块翻哪张；
// 正文仍是那张大纸（与分页同一份 NoteContent）。块是死尺寸、从上往下堆、装不下变可滚——
// 不量也不等分（测量在叠窗 resize 后会不更新，签按旧高度排，预览台可复现）。
// 名字不排进列（26px 直排标题是一堵墙）：悬停/聚焦时在正文左下角浮「第 n/N · 标题」。
// 当前块往正文侧探出 4px 说"是这一张"；tablist 那套：↑/↓ 环形、Home/End、roving tabindex、
// 当前块滚进视野（只动容器自己的 scrollTop，不用 scrollIntoView——它会挪走整扇窗）。
// 色块签 memo 化：签只认"有谁/在哪张/什么主题"，没变的靠 memo 跳过重渲（键盘处理走 latest-ref 保稳）。

import { createElement, memo, useCallback, useEffect, useRef, useState } from "react";
import { NoteContent } from "@/features/sticky/note-content";
import { chipIconOf } from "@/features/sticky/note-icons";
import { GroupMenu } from "@/features/sticky/group-menu";
import { displayName, type StackViewProps } from "@/features/sticky/stack-view";
import { isMasked, usePrivateState } from "@/data/private-state";
import { themeColors } from "@/data/theme";
import { useScheme, type ResolvedScheme } from "@/data/scheme";
import {
  neighborId,
  TAB_CHIP,
  TAB_CHIP_GAP,
  TAB_CHIP_PROTRUDE,
  TAB_WIDTH,
} from "@/window/stack-model";
import type { StickyNote } from "@/platform/contracts";

/** 方签的圆角 */
const CHIP_RADIUS = 8;

const TabChip = memo(function TabChip({
  member,
  resolved,
  masked,
  isCurrent,
  index,
  total,
  onPick,
  onKeyDown,
  onPeek,
  onUnpeek,
  registerRef,
}: {
  member: StickyNote;
  resolved: ResolvedScheme;
  masked: boolean;
  isCurrent: boolean;
  index: number;
  total: number;
  onPick: (id: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onPeek: (id: string) => void;
  onUnpeek: (id: string) => void;
  registerRef: (id: string, node: HTMLButtonElement | null) => void;
}) {
  const theme = themeColors(member.theme, resolved);
  const name = displayName(member);
  // createElement 而非 <Icon/>：chipIconOf 是"查表返回既有组件"的函数，
  // 大写变量接它的返回值会被 react-hooks/static-components 误判成渲染期造组件
  const icon = chipIconOf(member, masked);
  return (
    <button
      ref={(node) => {
        registerRef(member.id, node);
      }}
      type="button"
      role="tab"
      aria-selected={isCurrent}
      aria-label={`第 ${index + 1} 张，共 ${total} 张：${name}`}
      title={`${name}（点一下翻到这张；↑↓ 换张）`}
      tabIndex={isCurrent ? 0 : -1}
      onClick={() => onPick(member.id)}
      onKeyDown={onKeyDown}
      onPointerEnter={() => onPeek(member.id)}
      onPointerLeave={() => onUnpeek(member.id)}
      onFocus={() => onPeek(member.id)}
      onBlur={() => onUnpeek(member.id)}
      className="flex shrink-0 cursor-pointer items-center justify-center border-0 transition-[width,filter] hover:brightness-110"
      style={{
        width: isCurrent ? TAB_CHIP + TAB_CHIP_PROTRUDE : TAB_CHIP,
        height: TAB_CHIP,
        borderRadius: CHIP_RADIUS,
        backgroundColor: isCurrent ? theme.accent : `${theme.accent}2E`,
        color: isCurrent ? theme.paper : theme.accent,
        boxShadow: isCurrent ? `0 2px 8px ${theme.accent}55` : "none",
      }}
    >
      {createElement(icon, { size: 13, "aria-hidden": true })}
    </button>
  );
});

export function GroupTabs({ members, currentId, onPick, onDelete }: StackViewProps) {
  const { resolved } = useScheme();
  const priv = usePrivateState();
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>());
  /** 悬停/聚焦到哪一块（浮名字用）；null = 没有 */
  const [peekId, setPeekId] = useState<string | null>(null);
  const shown = members.find((member) => member.id === currentId) ?? members[0];
  const peek = members.find((member) => member.id === peekId) ?? null;

  // latest-ref：键盘换张要读"最新的一叠与当前张"，但处理函数本身必须稳定，
  // 否则 memo 住的色块签每次敲字都会拿到新回调而全体重渲（codebase 惯用法，见 note-content/geometry）
  const latest = useRef({ members, shownId: shown?.id ?? null });
  useEffect(() => {
    latest.current = { members, shownId: shown?.id ?? null };
  });

  /** 当前块滚进视野（只在签列这一格里滚；不需要滚时这几个赋值就是不动的空操作） */
  useEffect(() => {
    const list = listRef.current;
    const tab = shown === undefined ? null : (tabRefs.current.get(shown.id) ?? null);
    if (list === null || tab === null) return;
    const top = tab.offsetTop;
    const bottom = top + tab.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [shown]);

  const go = useCallback(
    (id: string | null): void => {
      if (id === null) return;
      onPick(id);
      tabRefs.current.get(id)?.focus();
    },
    [onPick],
  );

  /* 键盘处理挂在块上而不是 tablist 容器上：容器带 onKeyDown 会被 a11y 规则要求自己
   * 可聚焦，而 roving tabindex 下焦点永远落在某一块上，挂这儿够用 */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      const { members: current, shownId } = latest.current;
      if (shownId === null) return;
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step !== undefined) {
        event.preventDefault();
        go(neighborId(current, shownId, step));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        go(current[0]?.id ?? null);
      } else if (event.key === "End") {
        event.preventDefault();
        go(current[current.length - 1]?.id ?? null);
      }
    },
    [go],
  );

  const handlePeek = useCallback((id: string): void => {
    setPeekId(id);
  }, []);
  const handleUnpeek = useCallback((id: string): void => {
    setPeekId((prev) => (prev === id ? null : prev));
  }, []);
  const registerRef = useCallback((id: string, node: HTMLButtonElement | null): void => {
    tabRefs.current.set(id, node);
  }, []);

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {shown !== undefined && (
        <>
          <div className="min-w-0 flex-1 overflow-hidden">
            <NoteContent
              id={shown.id}
              note={shown}
              leadingActions={<GroupMenu id={shown.id} groupId={shown.groupId} />}
              onDelete={onDelete}
            />
          </div>
          <div
            ref={listRef}
            role="tablist"
            aria-label="这一叠的便签"
            aria-orientation="vertical"
            className="flex shrink-0 flex-col items-end overflow-x-hidden overflow-y-auto"
            style={{ width: TAB_WIDTH, gap: TAB_CHIP_GAP, padding: "6px 2px" }}
          >
            {members.map((member, index) => (
              <TabChip
                key={member.id}
                member={member}
                resolved={resolved}
                masked={isMasked(member, priv)}
                isCurrent={member.id === shown.id}
                index={index}
                total={members.length}
                onPick={onPick}
                onKeyDown={onKeyDown}
                onPeek={handlePeek}
                onUnpeek={handleUnpeek}
                registerRef={registerRef}
              />
            ))}
          </div>
          {peek !== null && (
            /* 名字浮在正文左下角，不塞进签列：列只管"有哪几张、在哪张" */
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-2 left-2 z-20 max-w-[72%] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold shadow-[0_6px_16px_rgba(0,0,0,0.22)]"
              style={{
                backgroundColor: themeColors(peek.theme, resolved).accent,
                color: themeColors(peek.theme, resolved).paper,
              }}
            >
              第 {members.indexOf(peek) + 1}/{members.length} · {displayName(peek)}
            </span>
          )}
        </>
      )}
    </div>
  );
}
