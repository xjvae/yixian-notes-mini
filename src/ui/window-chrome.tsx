// WindowChrome — 所有窗口共用的外壳骨架：拖动条 + 右侧把手 + 内容槽。
// 从第一天就只有这一份标题条实现（旧架构五扇窗各写一份的债不再发生）。
//
// 纪律：
//  · 拖动区只认 data-tauri-drag-region；把可点按钮放进拖动条时，按钮自己**不带**该属性，
//    否则 mousedown 先触发拖动（旧架构用真机换来的教训）。
//  · 视觉定制（便签纸面纹理、私密遮罩等）走 children 与插槽，不改这份骨架。

import type { ReactNode } from "react";
import { Pin, PinOff, X } from "lucide-react";

export interface WindowChromeProps {
  /** 窗口底色（便签 = 纸色；面板窗 = 面板底色） */
  background: string;
  /** 拖动条/把手强调色 */
  accent: string;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  /** 拖动条最左侧的槽位（类型标记、标题芯片等） */
  leading?: ReactNode;
  children: ReactNode;
}

export function WindowChrome({
  background,
  accent,
  pinned,
  onTogglePin,
  onClose,
  leading,
  children,
}: WindowChromeProps) {
  return (
    <div
      className="flex h-screen w-screen select-none flex-col overflow-hidden rounded-lg border border-black/10 shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
      style={{ backgroundColor: background }}
    >
      <div
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-1 px-2"
        style={{ borderBottom: `1px solid ${accent}22` }}
      >
        {leading}
        <div className="flex-1" data-tauri-drag-region />
        <button
          type="button"
          aria-label={pinned ? "取消置顶" : "置顶"}
          title={pinned ? "取消置顶" : "置顶"}
          onClick={onTogglePin}
          className="rounded-md p-1.5 transition-colors hover:bg-black/10"
          style={{ color: accent }}
        >
          {pinned ? <Pin size={14} aria-hidden /> : <PinOff size={14} aria-hidden />}
        </button>
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
          className="rounded-md p-1.5 transition-colors hover:bg-black/10"
          style={{ color: accent }}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** 便签窗的 leading 槽：左缘色脊。类型标记/标签芯片随 M1 补齐 */
export function StickyLeading({ accent }: { accent: string }) {
  return <span className="h-4 w-1 rounded-full" style={{ backgroundColor: accent }} />;
}
