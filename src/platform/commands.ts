// 命令包装 — 每条后端命令一个具名函数。视图层不允许出现裸字符串 invoke，
// 参数形状由 contracts.ts 的类型保证。

import type { Bootstrap, StickyInput, StickyNote } from "@/platform/contracts";
import { invoke } from "@/platform/bridge";

/** 首屏引导：一次拿齐挂载前需要的数据 */
export function getBootstrap(): Promise<Bootstrap> {
  return invoke<Bootstrap>("get_bootstrap");
}

/** 便签全量（includeDeleted=true 供回收站） */
export function stickyList(includeDeleted: boolean): Promise<StickyNote[]> {
  return invoke<StickyNote[]>("sticky_list", { includeDeleted });
}

/** 单实体落库。返回 Rust 盖完时间戳的那一行 */
export function stickyUpsert(input: StickyInput): Promise<StickyNote> {
  return invoke<StickyNote>("sticky_upsert", { input });
}

/** 删除：hard=false 软删（进回收站），hard=true 真删 */
export function stickyDelete(id: string, hard: boolean): Promise<void> {
  return invoke<void>("sticky_delete", { id, hard });
}

/** 新建默认便签并开窗，返回新 id（托盘 / 星环共用） */
export function createFloatingSticky(): Promise<string> {
  return invoke<string>("create_floating_sticky");
}

/** 关闭并销毁一扇便签窗（销毁在 Rust 侧做：close 依赖前端监听器往返，会留僵尸窗） */
export function closeFloatingSticky(id: string): Promise<void> {
  return invoke<void>("close_floating_sticky", { id });
}
