// 窗的固定几何 — 便签与叠窗那四个数，**唯一的出处**。住 data/ 这一层是因为
// `window/auto-size.ts` 与预览台都要用，不该反向伸进 features。
//
// 这四个数同时是 Rust 侧 `windows/float.rs` 的 DEFAULT_SIZE / MIN_SIZE / BAR_HEIGHT /
// BAR_MAX_WIDTH。两边各写一份迟早分叉，所以有一条对照测试钉着：
// `src/data/mirrored-constants.test.ts`。

export const STICKY_MIN_SIZE = { width: 220, height: 200 };
export const STICKY_DEFAULT_SIZE = { width: 320, height: 300 };
/** 收起成标题栏形态的固定高度与最大宽度 */
export const BAR_HEIGHT = 62;
export const BAR_MAX_WIDTH = 360;
