// WindowChrome — 所有窗口共用的外壳骨架：拖动条 + 把手 + 内容槽。
// 从第一天就只有这一份标题条实现（旧架构五扇窗各写一份的债不再发生）。
//
// 纪律：
//  · 拖动区只认 data-tauri-drag-region；把可点按钮放进拖动条时，按钮自己**不带**该属性，
//    否则 mousedown 先触发拖动。
//  · 视觉定制（便签纸面纹理、私密遮罩等）走 children 与插槽，不改这份骨架。
//  · collapsed=true 时只渲染条：窗体本身已是 62px 高，内容槽不参与布局。

import type { ReactNode } from "react";
import { ChevronUp, Pin, PinOff, X } from "lucide-react";

export interface WindowChromeProps {
  /** 窗口底色（便签 = 纸色；面板窗 = 面板底色） */
  background: string;
  /** 拖动条/把手强调色 */
  accent: string;
  /** 条上文字（收起态显示；展开态由内容自己呈现标题） */
  title?: string;
  leading?: ReactNode;
  /** 收起态的徽标槽（到期角标等） */
  badges?: ReactNode;
  collapsed?: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  /** 仅收起态出现 */
  onExpand?: () => void;
  onClose: () => void;
  /** 整窗点击（贴边细丝的"点一下滑出"）。给了就必须给 bodyClickLabel */
  onBodyClick?: () => void;
  bodyClickLabel?: string;
  children: ReactNode;
}

function iconButton(
  label: string,
  onClick: () => void,
  accent: string,
  node: ReactNode,
): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md p-1.5 transition-colors hover:bg-black/10"
      style={{ color: accent }}
    >
      {node}
    </button>
  );
}

export function WindowChrome({
  background,
  accent,
  title,
  leading,
  badges,
  collapsed = false,
  pinned,
  onTogglePin,
  onExpand,
  onClose,
  onBodyClick,
  bodyClickLabel,
  children,
}: WindowChromeProps) {
  return (
    <div
      className="relative flex h-screen w-screen select-none flex-col overflow-hidden rounded-lg border border-black/10 shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
      style={{ backgroundColor: background }}
    >
      <div
        data-tauri-drag-region
        className="z-10 flex h-9 shrink-0 items-center gap-1.5 px-2"
        style={{ borderBottom: `1px solid ${accent}22` }}
      >
        {leading}
        {collapsed ? (
          <>
            <span
              className="min-w-0 flex-1 truncate text-xs font-semibold"
              style={{ color: accent }}
              data-tauri-drag-region
            >
              {title?.trim() === "" ? "未命名便签" : title}
            </span>
            {badges}
            {onExpand &&
              iconButton("展开", onExpand, accent, <ChevronUp size={14} aria-hidden />)}
          </>
        ) : (
          <div className="flex-1" data-tauri-drag-region />
        )}
        {iconButton(
          pinned ? "取消置顶" : "置顶",
          onTogglePin,
          accent,
          pinned ? <Pin size={14} aria-hidden /> : <PinOff size={14} aria-hidden />,
        )}
        {iconButton("关闭", onClose, accent, <X size={14} aria-hidden />)}
      </div>
      {!collapsed && <div className="min-h-0 flex-1">{children}</div>}
      {onBodyClick && (
        <button
          type="button"
          aria-label={bodyClickLabel ?? ""}
          onClick={onBodyClick}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      )}
    </div>
  );
}

/** 便签窗的 leading 槽：左缘色脊。类型标记随 M1 视图细化补齐 */
export function StickyLeading({ accent }: { accent: string }) {
  return <span className="h-4 w-1 rounded-full" style={{ backgroundColor: accent }} />;
}
