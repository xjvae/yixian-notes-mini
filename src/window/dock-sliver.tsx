// 贴边细丝 — 窗真的只有 SLIVER×SLIVER 那一小块时替代整个 WindowChrome：20px 里塞不下
// 标题条+正文+页脚，只留一条纸色小签（底色沿用本窗纸色，贴边前后不换身份），内侧一道强调色
// 刻痕负责在桌面上找得到它。朝向：外侧直角、内侧圆角+刻痕。尺寸不写死 20px（真实大小由
// `setWindowFrame` 说了算，CSS 再报一遍就是第二个真相），`fixed inset-0` 占满整窗。
// 整块 aria-hidden（空纸片无可读内容；aria-hidden 元素不可聚焦，不踩 aria-hidden-focus），
// 但键盘够得着：Tab/Enter/空格即唤出。

import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DockEdge } from "@/platform/contracts";

/** 唤出键。Tab 是"我要把这扇窗的焦点要过来"的直觉，Enter / 空格是同一个意思的显式表达 */
const REVEAL_KEYS: readonly string[] = ["Tab", "Enter", " "];

interface Side {
  /** 圆角开在哪一侧（外侧不许有角：那是贴着屏幕边的） */
  radius: string;
  /** 刻痕的位置与朝向：竖直边上一条竖的，水平边上一条横的 */
  mark: string;
  /** 内侧那条 1px 分隔（外侧不给描边） */
  shadow: string;
}

const SIDES: Record<DockEdge, Side> = {
  left: {
    radius: "rounded-r-lg",
    mark: "right-[4px] top-1/2 -translate-y-1/2 w-[3px] h-[10px]",
    shadow: "1px 0 0 rgba(20,24,29,0.06)",
  },
  right: {
    radius: "rounded-l-lg",
    mark: "left-[4px] top-1/2 -translate-y-1/2 w-[3px] h-[10px]",
    shadow: "-1px 0 0 rgba(20,24,29,0.06)",
  },
  top: {
    radius: "rounded-b-lg",
    mark: "bottom-[4px] left-1/2 -translate-x-1/2 h-[3px] w-[10px]",
    shadow: "0 1px 0 rgba(20,24,29,0.06)",
  },
  bottom: {
    radius: "rounded-t-lg",
    mark: "top-[4px] left-1/2 -translate-x-1/2 h-[3px] w-[10px]",
    shadow: "0 -1px 0 rgba(20,24,29,0.06)",
  },
};

/** 浮起来的那层投影：小签离桌面一样高，不能比摊开时更"贴地" */
const LIFT = "0 6px 14px rgba(23,26,31,0.16)";

export interface DockSliverProps {
  /** 贴的那条边；尚未定边时只上基础样式（圆角与刻痕都不知道该朝哪边开） */
  edge: DockEdge | null;
  /** 纸色，与本窗同一个来源 */
  background: string;
  /** 强调色：刻痕用它 */
  accent: string;
  /** 唤出（滑出到展开尺寸），正常壳体随之回来 */
  onReveal: () => void;
}

export function DockSliver({ edge, background, accent, onReveal }: DockSliverProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (REVEAL_KEYS.includes(event.key)) onReveal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onReveal]);

  const side: Side | undefined = edge === null ? undefined : SIDES[edge];
  const rootStyle: CSSProperties = {
    backgroundColor: background,
    boxShadow: side === undefined ? LIFT : `${side.shadow}, ${LIFT}`,
  };
  const mark: ReactNode = side ? (
    <span
      className={`absolute rounded-full ${side.mark}`}
      style={{ backgroundColor: accent, opacity: 0.62 }}
    />
  ) : null;

  return (
    <div
      aria-hidden
      onClick={onReveal}
      className={`fixed inset-0 cursor-pointer overflow-hidden ${side?.radius ?? ""}`}
      style={rootStyle}
    >
      {mark}
    </div>
  );
}
