// 命令包装 — 每条后端命令一个具名函数。视图层不允许出现裸字符串 invoke，
// 参数形状由 contracts.ts 的类型保证。

import type {
  Bootstrap,
  SearchHit,
  StickyInput,
  StickyNote,
  WorkArea,
} from "@/platform/contracts";
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

/** 打开/聚焦回收站窗 */
export function openTrashWindow(): Promise<void> {
  return invoke<void>("open_trash_window");
}

/** 隐藏回收站窗（close = hide：窗内无状态要销毁） */
export function closeTrashWindow(): Promise<void> {
  return invoke<void>("close_trash_window");
}

/** 回收站「恢复」：清删除时钟 + 回桌面 + 当场拉起浮窗 */
export function trashRestore(id: string): Promise<boolean> {
  return invoke<boolean>("trash_restore", { id });
}

/** 子串检索（标题命中优先；私密/已删不进结果） */
export function searchQuery(query: string): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_query", { query });
}

/** 打开/聚焦一扇已有便签的浮窗（搜索点结果用） */
export function openFloatingSticky(id: string): Promise<void> {
  return invoke<void>("open_floating_sticky", { id });
}

/** 打开/聚焦搜索窗 */
export function openSearchWindow(): Promise<void> {
  return invoke<void>("open_search_window");
}

/** 隐藏搜索窗 */
export function closeSearchWindow(): Promise<void> {
  return invoke<void>("close_search_window");
}

/** 写设置项（"0" = 显式关） */
export function settingsSet(key: string, value: string): Promise<void> {
  return invoke<void>("settings_set", { key, value });
}

// —— 贴边 ——

/** 注册贴边槽位，返回同侧序号（细丝错开用） */
export function floatDockRegister(id: string, edge: string): Promise<number> {
  return invoke<number>("float_dock_register", { id, edge });
}

/** 解除贴边注册 */
export function floatDockUnregister(id: string): Promise<void> {
  return invoke<void>("float_dock_unregister", { id });
}

/** 当前显示器工作区（物理像素） */
export function monitorWorkArea(): Promise<WorkArea> {
  return invoke<WorkArea>("monitor_work_area");
}
