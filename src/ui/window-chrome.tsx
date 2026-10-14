// WindowChrome — 所有窗口共用的外壳：拖动条 + 把手 + 内容槽。
// 拖动区只认 data-tauri-drag-region（可点按钮不能带该属性，否则先触发拖动）；
// 视觉定制走 children 与插槽；collapsed=true 只渲染条（窗体本身已是 62px 高）。

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronUp, Pencil, Pin, PinOff, X } from "lucide-react";

export interface WindowChromeProps {
  /** 窗口底色（便签 = 纸色；面板窗 = 面板底色） */
  background: string;
  /** 拖动条/把手强调色 */
  accent: string;
  /** 纸面墨色，只用于算描边；不传走 --panel-ink。便签必须传 */
  ink?: string;
  /** 条上标题，收起与展开两态共用；不给就不显示。截断与空标题兜底由调用方管 */
  title?: string;
  /** 改标题的初值：必须是未截断的原文（title 是给人看的截断版） */
  titleValue?: string;
  leading?: ReactNode;
  /** 收起态的徽标槽 */
  badges?: ReactNode;
  collapsed?: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  /** 仅收起态出现 */
  onExpand?: () => void;
  /** 右侧按钮组左边的窗级动作槽（单窗与叠窗同一位置） */
  trailing?: ReactNode;
  /** 纸边闪一圈（sticky:ping），提示"这张在这儿" */
  flash?: boolean;
  /** 给了才在收起态出现「改标题」钮；提交 = Enter 与失焦，Esc 取消 */
  onRename?: (next: string) => void;
  /** 标题输入框硬顶（调用方从 TITLE_MAX 传） */
  titleMaxLength?: number;
  onClose: () => void;
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
  ink,
  title,
  titleValue,
  leading,
  badges,
  collapsed = false,
  pinned,
  onTogglePin,
  onExpand,
  trailing,
  flash = false,
  onRename,
  titleMaxLength,
  onClose,
  children,
}: WindowChromeProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  // 编辑框只存在于收起态，离开收起态自动消失（不用 effect 翻状态）
  const editing = renaming && collapsed;

  const titleInput = useRef<HTMLInputElement>(null);
  // 打开编辑框就把光标落进去（autoFocus 被 a11y 规则禁用，且只在挂载那次生效）
  useEffect(() => {
    if (editing) titleInput.current?.focus();
  }, [editing]);

  const commitRename = (write: (next: string) => void): void => {
    setRenaming(false);
    write(draft);
  };

  /** 草稿取原文（titleValue），不是条上截断后的展示文案 */
  const startRename = (): void => {
    setDraft(titleValue ?? title ?? "");
    setRenaming(true);
  };

  /** 标题字色：用纸/面板墨色——强调色压 12px 小字对比度不达标 */
  const titleInk = ink ?? "var(--panel-ink)";

  const titleSpan = (
    <span
      className="min-w-0 flex-1 truncate text-xs font-semibold"
      style={{ color: titleInk }}
      data-tauri-drag-region
    >
      {title?.trim() === "" ? "未命名便签" : title}
    </span>
  );

  return (
    <div
      className={`relative flex h-screen w-screen select-none flex-col overflow-hidden rounded-lg border border-solid${flash ? " sticky-ping" : ""}`}
      style={{
        backgroundColor: background,
        // 闪光圈用本窗强调色（见 index.css 的 .sticky-ping）
        ["--ping-ink" as string]: accent,
        // 描边用纸墨色 8%：黑色半透明在浅纸上是一条灰圈
        borderColor: `color-mix(in srgb, ${ink ?? "var(--panel-ink)"} 8%, transparent)`,
      }}
    >
      <div
        data-tauri-drag-region
        className="z-10 flex h-9 shrink-0 items-center gap-1.5 px-2"
        style={{ borderBottom: `1px solid ${accent}22` }}
      >
        {leading}
        {collapsed ? (
          <>
            {editing && onRename ? (
              <input
                ref={titleInput}
                aria-label="便签标题"
                value={draft}
                maxLength={titleMaxLength}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename(onRename);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenaming(false);
                  }
                }}
                onBlur={() => commitRename(onRename)}
                // 不能带 data-tauri-drag-region：带了落不了光标
                className="min-w-0 flex-1 rounded bg-black/5 px-1 text-xs font-semibold outline-none"
                style={{ color: titleInk }}
              />
            ) : (
              titleSpan
            )}
            {badges}
            {/* 改名走按钮不走双击：标题是 drag region，Windows 上双击会最大化并被贴边判定收走 */}
            {onRename &&
              !editing &&
              iconButton("改标题", startRename, accent, <Pencil size={14} aria-hidden />)}
            {onExpand &&
              iconButton("展开", onExpand, accent, <ChevronUp size={14} aria-hidden />)}
          </>
        ) : (
          titleSpan
        )}
        {trailing}
        {iconButton(
          pinned ? "取消置顶" : "置顶",
          onTogglePin,
          accent,
          pinned ? <Pin size={14} aria-hidden /> : <PinOff size={14} aria-hidden />,
        )}
        {iconButton("关闭", onClose, accent, <X size={14} aria-hidden />)}
      </div>
      {!collapsed && <div className="min-h-0 flex-1">{children}</div>}
    </div>
  );
}

/** 便签窗的 leading 槽：左缘色脊 */
export function StickyLeading({ accent }: { accent: string }) {
  return <span className="h-4 w-1 rounded-full" style={{ backgroundColor: accent }} />;
}
