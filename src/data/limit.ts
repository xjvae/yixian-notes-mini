// 字数上限 — 只挡写不拦删：到顶后输入被截断会很困惑，这里只负责把"还剩多少"
// 说清楚，由输入框 maxLength 硬顶（超长的最后一个字符进不来）。

export const TITLE_MAX = 40;
/**
 * 正文上限。2000 → 5000（作者要的）：库里是 TEXT，SQLite 侧没有实际上限（默认
 * 单值 1e9 字节）。
 * 以前这里的注释写着"唯一的真代价在私密封套——每次落库都把整份 map 重加密重落盘"，
 * 那个前提已经不成立：私密正文现在一张一条进 `private_content`（迁移 0011），
 * 一次落库只重写这一张（5000 字 ≈ 15 KB UTF-8）。历史版本也拆出去了，
 * 所以"张数 × 这个数"不再是要付的量。留下的真实成本是 IPC 上的一份正文，不在加密侧。
 * 5000 字 ≈ 228 行 ≈ 4800px 高，远超自动长高的 900 上限——超出部分正文自己滚。
 */
export const BODY_MAX = 5000;
/** 清单/时间轴单条上限（100 → 200：一条塞一张图的引用约 30 字，留 170 字写字） */
export const ITEM_MAX = 200;
export const TAG_MAX = 20;
export const TAG_COUNT_MAX = 8;
/**
 * 组合名上限，与标题同值。改名那条 Rust 侧 `group::normalize_name` 用的是同一个数——
 * 名字是标签不是正文，超长就截（多打的那几个字丢掉不心疼），不报错让改个名多一次往返。
 */
export const GROUP_NAME_MAX = 40;

/** 达到提示阈值（接近上限）才显示计数器，平时不占视线 */
export function shouldShowCount(length: number, max: number): boolean {
  return length >= Math.max(0, max - 80);
}
