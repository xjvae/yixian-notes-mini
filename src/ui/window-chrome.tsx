// WindowChrome — 所有窗口共用的外壳骨架：拖动条 + 把手 + 内容槽。
//  · 拖动区只认 data-tauri-drag-region；把可点按钮放进拖动条时，按钮自己**不带**该属性，否则 mousedown 先触发拖动。
//  · 视觉定制（便签纸面纹理、私密遮罩等）走 children 与插槽，不改这份骨架。
//  · collapsed=true 时只渲染条：窗体本身已是 62px 高，内容槽不参与布局。

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronUp, Pencil, Pin, PinOff, X } from "lucide-react";

export interface WindowChromeProps {
  /** 窗口底色（便签 = 纸色；面板窗 = 面板底色） */
  background: string;
  /** 拖动条/把手强调色 */
  accent: string;
  /**
   * 纸面墨色，只用来算那一圈描边（`color-mix` 8%）。不传就走面板墨色 `--panel-ink`。
   * 便签必须传：描边要跟着这张纸走，深纸浅纸都得有边但不能是"灰圈"。
   */
  ink?: string;
  /**
   * 条上文字。**收起与展开两支都显示**：展开那句只读（改名仍走正文那一行输入框），收起那句可切编辑框（给 `onRename` 才有那颗钮）。
   * 不给就没有这句（面板窗、叠窗的组名住 `leading` 槽）；18 字截断由调用方做，空标题在这换成"未命名便签"。
   */
  title?: string;
  /**
   * 改标题时的**初值**：必须是那条没被显示层截过的原文。
   * `title` 是给人看的（超 18 字会被截成"…"、空标题会被换成"未命名便签"），
   * 拿它当草稿就等于把省略号写回真标题。没传才退回 `title`。
   */
  titleValue?: string;
  leading?: ReactNode;
  /** 收起态的徽标槽（到期角标等） */
  badges?: ReactNode;
  collapsed?: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  /** 仅收起态出现 */
  onExpand?: () => void;
  /**
   * 贴在右侧按钮组**左边**的窗级动作（「收起为标题栏」与贴边那颗「收回」走这一槽）。
   * 单窗与叠窗同一个位置：窗级动作归标题条，不归正文页脚——叠窗三档里有两档压根
   * 不渲染 NoteContent，页脚那个位置对它不存在，两张纸就别再各住一处了。
   */
  trailing?: ReactNode;
  /**
   * 纸边闪一圈（`sticky:ping`）。"去看这张便签"点下去而那张本来就开着、还在前台时，
   * 摆位与焦点都改变不了任何看得见的东西——这一圈就是那声"在这儿"。
   */
  flash?: boolean;
  /**
   * 给了才在收起态的条上多一颗「改标题」按钮，不给就是只读（面板窗没有标题这回事）。
   * 不能用双击标题做——原因见渲染处那条注释。提交时机：Enter 与失焦；Esc 不算。截断与上限由调用方管。
   */
  onRename?: (next: string) => void;
  /** 标题输入框的硬顶，由调用方从 `TITLE_MAX` 传进来 */
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

  // 离开收起态编辑框就消失（不用 effect 去翻状态：那是 effect 里 setState，规则直接禁止）。
  // 留着的话下次收起会看见一个"不知道自己在不在编辑"的框——预览台实测撞到的
  const editing = renaming && collapsed;

  const titleInput = useRef<HTMLInputElement>(null);
  // 光标要落在框里（与正文编辑态同一套做法——`autoFocus` 属性被 a11y 规则禁掉，
  // 而且它只在挂载那一次生效，这个框是按下「改标题」之后才出现的）
  useEffect(() => {
    if (editing) titleInput.current?.focus();
  }, [editing]);

  const commitRename = (write: (next: string) => void): void => {
    setRenaming(false);
    write(draft);
  };

  /** 草稿取**原文**（titleValue），不是条上那份给人看的截断 */
  const startRename = (): void => {
    setDraft(titleValue ?? title ?? "");
    setRenaming(true);
  };

  /** 条上那句人话的字色：一律走这张纸/这块面板自己的墨色。强调色在浅色档上压小字
   *  实测只有 3.2–4.2:1（AA 要 4.5），而标题、改名框都是 12px 的小字 */
  const titleInk = ink ?? "var(--panel-ink)";

  /** 条上那句标题，收起与展开共用：展开态一张纸在桌面上就靠它认是谁；只读，不抢正文那行输入框的编辑 */
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
        // 闪光那一圈用这扇窗自己的强调色（见 index.css 的 .sticky-ping）
        ["--ping-ink" as string]: accent,
        // 轮廓由这张纸自己的墨色给而不是黑色半透明：黑 10% 压在近白的纸上就是一条灰圈
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
                // 提交走 onBlur 与 Enter 两条：点别处（含那三颗按钮）也算说完
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
                // 编辑框**不带** data-tauri-drag-region：带了就成不了光标落点
                className="min-w-0 flex-1 rounded bg-black/5 px-1 text-xs font-semibold outline-none"
                style={{ color: titleInk }}
              />
            ) : (
              titleSpan
            )}
            {badges}
            {/* 改名必须走**按钮**不能双击标题：那条 span 是 drag region，Windows 上双击会最大化、最大化又被贴边判定当场收走；不带该属性的 BUTTON 不触发拖动 */}
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
