// 侧边色块签视图 — 正文还是一张大纸（可编辑，与分页那张是同一份 NoteContent），
// 右缘一条签列：一张一块**方色签**，块上是这一张的类型图标（私密的给锁），点哪块翻哪张。
//
// 名字不排进列里。26px 宽里直排标题是一堵墙（上一版就这样，作者看了说"重新设计"），
// 所以悬停或键盘聚焦到某块上时，在正文左下角浮一条「第 n/N · 标题」——列只管
// "有哪几张、现在在哪张"，认名字这件事交给一条完整的横排字。
//
// 这一档**既不量也不等分**：块是死的尺寸（24×24）、从上往下堆、装不下由浏览器把这条变成
// 可滚。第一版在这里算过 `tabRows(count, area)`，那次测量在叠窗 resize 后会不更新
// （ResizeObserver / resize 可以不回调），签便按旧高度排：既裁一截又因为 overflow 是
// hidden 而滚不动——预览台上把叠窗从高 300 改到 70 就复现了。定尺寸没有这种漂移面。
//
// 当前那块往正文那侧多探出 4px（28 宽 vs 24），"是这一张"靠这个错位说，不靠一整块深色
// 压在纸边上。按 tablist 那套办：↑/↓ 环形换张（与翻页同一条心智：一叠没有头尾）、
// Home/End 到首末、roving tabindex、当前块滚进视野——滚只动这一条容器自己的 scrollTop，
// 不用 `scrollIntoView`（它会往上找可滚祖先，body 是 overflow:hidden 也照样被它挪走整扇窗）。

import { useCallback, useEffect, useRef, useState } from "react";
import { NoteContent } from "@/features/sticky/note-content";
import { chipIconOf } from "@/features/sticky/note-icons";
import { GroupMenu } from "@/features/sticky/group-menu";
import { displayName, type StackViewProps } from "@/features/sticky/stack-view";
import { isMasked, usePrivateState } from "@/data/private-state";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import {
  neighborId,
  TAB_CHIP,
  TAB_CHIP_GAP,
  TAB_CHIP_PROTRUDE,
  TAB_WIDTH,
} from "@/window/stack-model";

/** 方签的圆角 */
const CHIP_RADIUS = 8;

export function GroupTabs({ members, currentId, onPick, onDelete }: StackViewProps) {
  const { resolved } = useScheme();
  const priv = usePrivateState();
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>());
  /** 悬停/聚焦到哪一块（浮名字用）；null = 没有 */
  const [peekId, setPeekId] = useState<string | null>(null);
  const shown = members.find((member) => member.id === currentId) ?? members[0];
  const peek = members.find((member) => member.id === peekId) ?? null;

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
      if (shown === undefined) return;
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step !== undefined) {
        event.preventDefault();
        go(neighborId(members, shown.id, step));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        go(members[0]?.id ?? null);
      } else if (event.key === "End") {
        event.preventDefault();
        go(members[members.length - 1]?.id ?? null);
      }
    },
    [go, members, shown],
  );

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
            {members.map((member, index) => {
              const theme = themeColors(member.theme, resolved);
              const isCurrent = member.id === shown.id;
              const name = displayName(member);
              const Icon = chipIconOf(member, isMasked(member, priv));
              return (
                <button
                  key={member.id}
                  ref={(node) => {
                    tabRefs.current.set(member.id, node);
                  }}
                  type="button"
                  role="tab"
                  aria-selected={isCurrent}
                  aria-label={`第 ${index + 1} 张，共 ${members.length} 张：${name}`}
                  title={`${name}（点一下翻到这张；↑↓ 换张）`}
                  tabIndex={isCurrent ? 0 : -1}
                  onClick={() => onPick(member.id)}
                  onKeyDown={onKeyDown}
                  onPointerEnter={() => setPeekId(member.id)}
                  onPointerLeave={() =>
                    setPeekId((prev) => (prev === member.id ? null : prev))
                  }
                  onFocus={() => setPeekId(member.id)}
                  onBlur={() => setPeekId((prev) => (prev === member.id ? null : prev))}
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
                  <Icon size={13} aria-hidden />
                </button>
              );
            })}
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
