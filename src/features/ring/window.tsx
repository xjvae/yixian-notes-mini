// RingWindow — 星环：中心一格 + 四节点（正北/正东/正南/正西）。
//
// 四条收场，一条都不能少：环是"顺手唤起"的东西，收不掉就成了拦路的窗。
//  · 点节点：先把环收起再做事——动作拉起来的窗不该被环压着；
//  · 点环外空白：收起；
//  · Esc：收起；
//  · 窗失焦：收起（用户去点别处了，环就该让路）。
//
// 键盘走 Tab + Enter（原生焦点顺序按节点数组），不做方向键环绕选择：四个节点用不着。
// 透明底由 index.css 兜（body 默认 transparent），本页不许铺任何不透明底色。

import { useCallback, useEffect } from "react";
import { Search, Settings, StickyNotePlus, Trash2 } from "lucide-react";
import {
  closeRingWindow,
  createFloatingSticky,
  openSearchWindow,
  openSettingsWindow,
  openTrashWindow,
} from "@/platform/commands";
import { logger } from "@/platform/logger";

/** 节点数与窗尺寸是一对：窗 420、半径 130、中心 210（改这里要同时改 Rust 的 RING_SIZE） */
const CENTER = 210;
const RADIUS = 130;

interface RingNode {
  id: string;
  label: string;
  icon: typeof Search;
  /** 自正北起顺时针的方位角（度） */
  angle: number;
  run: () => Promise<unknown>;
}

const NODES: readonly RingNode[] = [
  {
    id: "sticky",
    label: "新建便签",
    icon: StickyNotePlus,
    angle: 0,
    run: createFloatingSticky,
  },
  { id: "search", label: "搜索", icon: Search, angle: 90, run: openSearchWindow },
  { id: "trash", label: "回收站", icon: Trash2, angle: 180, run: openTrashWindow },
  { id: "settings", label: "设置", icon: Settings, angle: 270, run: openSettingsWindow },
];

function nodePosition(angle: number): { left: number; top: number } {
  const rad = (angle * Math.PI) / 180;
  return {
    left: CENTER + RADIUS * Math.sin(rad),
    top: CENTER - RADIUS * Math.cos(rad),
  };
}

export function RingWindow() {
  const dismiss = useCallback((): void => {
    void closeRingWindow().catch((error: unknown) =>
      logger.caught("ring", "收起星环失败", error),
    );
  }, []);

  const pick = useCallback(
    (node: RingNode): void => {
      // 先收起再动作：两条都是命令，不等彼此——动作慢也不该让环杵在那儿
      dismiss();
      void node
        .run()
        .catch((error: unknown) => logger.caught("ring", `${node.label}失败`, error));
    },
    [dismiss],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    const onBlur = (): void => dismiss();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [dismiss]);

  return (
    <div
      className="relative h-screen w-screen"
      role="menu"
      aria-label="星环"
      // 点环外的空白就是"不要了"。节点自己 stopPropagation，不会误收
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      {/* 环轨：纯装饰，不接事件 */}
      <div
        aria-hidden
        className="absolute rounded-full border border-dashed"
        style={{
          left: CENTER - RADIUS,
          top: CENTER - RADIUS,
          width: RADIUS * 2,
          height: RADIUS * 2,
          borderColor: "var(--panel-border)",
        }}
      />
      {/* 中心格：点它也等于收起 */}
      <button
        type="button"
        aria-label="收起星环"
        onClick={dismiss}
        className="absolute flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[11px] transition-colors"
        style={{
          left: CENTER,
          top: CENTER,
          backgroundColor: "var(--panel-card)",
          borderColor: "var(--panel-border)",
          color: "var(--panel-muted)",
        }}
      >
        一闲
      </button>

      {NODES.map((node) => {
        const Icon = node.icon;
        const { left, top } = nodePosition(node.angle);
        return (
          <button
            key={node.id}
            type="button"
            role="menuitem"
            aria-label={node.label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => pick(node)}
            className="absolute flex h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-full border shadow-[0_6px_18px_rgba(0,0,0,0.16)] transition-transform hover:scale-105 focus-visible:scale-105"
            style={{
              left,
              top,
              backgroundColor: "var(--panel-card)",
              borderColor: "var(--panel-border)",
              color: "var(--panel-ink)",
            }}
          >
            <Icon size={20} aria-hidden />
            <span className="text-[10px] leading-none">{node.label}</span>
          </button>
        );
      })}
    </div>
  );
}
