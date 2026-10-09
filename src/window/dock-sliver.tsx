// 贴边细丝的呈现层 — 窗真的只有 SLIVER×SLIVER 那一小块时**替代**整个 WindowChrome。
//
// 为什么是"替代"而不是"缩起来继续用"：20px 见方里塞标题条（三颗 p-1.5 的图标按钮）、
// 正文和页脚，得到的是一个谁也捏不住的纸屑。收起态那条 62px 栏尚且有几百像素宽可用，
// 细丝什么都没有。所以贴边未滑出这一支接管整扇窗：只留一条纸色小签，底色沿用本窗的
// 纸色（贴边前后不能换身份），内侧一道强调色刻痕负责"在桌面上找得到它"。
//
// 尺寸不写死 20px：窗的真实大小由 `setWindowFrame` 说了算，CSS 再报一遍数字就成了
// 第二个真相。`fixed inset-0` 让这块小签恰好占满整窗。
//
// 朝向：贴着屏幕边的**外侧直角**，内侧圆角 + 刻痕。外侧那里没有"边界"，纸片像是从
// 屏幕外长出来的；用户的手和眼都落在内侧这一条上。
//
// 无障碍：整块 aria-hidden——一张没写字的纸片没有可读内容，挂进无障碍树只会让读屏
// 多念一个空节点；而 aria-hidden 盖住的元素本身不可聚焦，也就不踩 axe 的
// aria-hidden-focus。但"不在树里"不等于"键盘够不着"：Tab / Enter / 空格即唤出。

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
