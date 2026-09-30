// 便签窗的固定几何常量 — window.tsx 与 use-dock-snap 共用，别处不许再抄一份。

export const STICKY_MIN_SIZE = { width: 220, height: 200 };
export const STICKY_DEFAULT_SIZE = { width: 320, height: 300 };
/** 收起成标题栏形态的固定高度与最大宽度（Rust 开窗路径用同一套数值） */
export const BAR_HEIGHT = 62;
export const BAR_MAX_WIDTH = 360;
