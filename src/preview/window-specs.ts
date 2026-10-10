// 预览台的窗型规格 — 与 Rust 侧 windows/*.rs 的常量一一对应，改一边要同步另一边：
//   float.rs   DEFAULT_SIZE 320×300 / MIN_SIZE 220×200 / BAR_HEIGHT 62 / BAR_MAX_WIDTH 360
//   search.rs  480×420（min 380×340）· trash.rs 440×560（min 360×420）
//   settings.rs 560×480（min 480×420）· unlock.rs 420×470 · guide.rs 320×168（无边框气泡）
//   ring.rs    RING_SIZE 360×360（正方形，ring.rs 里有一条自 assert 钉着）
// url 与 vite.config.ts 的 rollupOptions.input 同表（跨语言契约那条纪律在这里同样成立）。

export type FrameKind =
  "sticky" | "stack" | "search" | "trash" | "settings" | "unlock" | "ring" | "guide";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameSpec {
  label: string;
  kind: FrameKind;
  /** 承载的实体 id：便签 id / 组 id；面板窗为 null */
  entityId: string | null;
  entry: string;
  /** 开窗时定形的 iframe src：之后改几何只动 DOM，不重载（重载 = 窗内状态全丢） */
  src: string;
  rect: Rect;
  min: { width: number; height: number };
  title: string;
  /**
   * 隐藏但活着（iframe 不卸载，窗内状态与 WebView 实例都在）。
   * 与 Rust 的 close = hide 同口径的那几扇才用得上：search·trash·settings·ring。
   */
  hidden: boolean;
}

/** Rust 侧 close 语义是 hide 的窗（秒开那条路要保住实例）；其余一律 destroy */
export const HIDE_ON_CLOSE: readonly FrameKind[] = [
  "search",
  "trash",
  "settings",
  "ring",
];

export const BAR_HEIGHT = 62;
export const BAR_MAX_WIDTH = 360;

const SIZE: Record<
  FrameKind,
  {
    size: { width: number; height: number };
    min: { width: number; height: number };
    entry: string;
    title: string;
  }
> = {
  sticky: {
    size: { width: 320, height: 300 },
    min: { width: 220, height: 200 },
    entry: "index.html",
    title: "一闲便签",
  },
  stack: {
    size: { width: 320, height: 300 },
    min: { width: 220, height: 200 },
    entry: "index.html",
    title: "一叠便签",
  },
  search: {
    size: { width: 480, height: 420 },
    min: { width: 380, height: 340 },
    entry: "search.html",
    title: "搜索",
  },
  trash: {
    size: { width: 440, height: 560 },
    min: { width: 360, height: 420 },
    entry: "trash.html",
    title: "回收站",
  },
  settings: {
    size: { width: 560, height: 480 },
    min: { width: 480, height: 420 },
    entry: "settings.html",
    title: "设置",
  },
  unlock: {
    size: { width: 420, height: 470 },
    min: { width: 0, height: 0 },
    entry: "unlock.html",
    title: "口令",
  },
  ring: {
    // 与 ring.rs 的 RING_SIZE 同值（360×360）。真机每次开在光标处，预览台摆在画布左上
    size: { width: 360, height: 360 },
    min: { width: 0, height: 0 },
    entry: "ring.html",
    title: "星环",
  },
  guide: {
    // 与 guide.rs 的 BUBBLE_SIZE 同值（320×168 逻辑像素）。教程是一扇无边框透明小气泡，
    // 关 = 销毁（不在 HIDE_ON_CLOSE 里）：下次开都从第一步起
    size: { width: 320, height: 168 },
    min: { width: 0, height: 0 },
    entry: "guide.html",
    title: "引导",
  },
};

export const PANEL_LABELS: readonly { kind: FrameKind; label: string }[] = [
  { kind: "search", label: "search" },
  { kind: "trash", label: "trash" },
  { kind: "settings", label: "settings" },
  { kind: "unlock", label: "unlock" },
  { kind: "ring", label: "ring" },
  { kind: "guide", label: "guide" },
];

export const FLOAT_PREFIX = "sticky-";
export const GROUP_PREFIX = "stickygrp-";

export function specOf(kind: FrameKind): (typeof SIZE)[FrameKind] {
  return SIZE[kind];
}

/** 与 float.rs 的 cascade_position 同口径：按已开浮窗数错开，一眼看出是新开的 */
export function cascadePosition(openFloats: number): { x: number; y: number } {
  return { x: 80 + openFloats * 26, y: 90 + openFloats * 26 };
}
