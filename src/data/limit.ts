// 字数上限 — 只挡写不拦删：到顶后输入被截断会很困惑，这里只负责把"还剩多少"
// 说清楚，由输入框 maxLength 硬顶（超长的最后一个字符进不来）。

export const TITLE_MAX = 40;
export const BODY_MAX = 2000;
export const ITEM_MAX = 100;
export const TAG_MAX = 20;
export const TAG_COUNT_MAX = 8;

/** 达到提示阈值（接近上限）才显示计数器，平时不占视线 */
export function shouldShowCount(length: number, max: number): boolean {
  return length >= Math.max(0, max - 80);
}
