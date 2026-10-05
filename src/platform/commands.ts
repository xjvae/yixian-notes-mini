// 命令包装 — 每条后端命令一个具名函数。视图层不允许出现裸字符串 invoke，
// 参数形状由 contracts.ts 的类型保证。

import type {
  Bootstrap,
  HookStatus,
  HotkeyBinding,
  PrivateStatus,
  SearchHit,
  StickyGroup,
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

// —— 组合（降级口径：无新建组入口，只能移进已有组）——

/** 归组清单（归组菜单的候选，只含非空组：空组行在写路径上就被清了） */
export function groupList(): Promise<StickyGroup[]> {
  return invoke<StickyGroup[]>("group_list");
}

/** 移进已有组（收进叠窗）/ 移出（弹回桌面单窗）。groupId=null 即移出 */
export function stickySetGroup(id: string, groupId: string | null): Promise<boolean> {
  return invoke<boolean>("sticky_set_group", { id, groupId });
}

/** 关闭并销毁一扇叠窗（叠窗发现成员清空时自己调用退场） */
export function closeGroupStack(gid: string): Promise<void> {
  return invoke<void>("close_group_stack", { gid });
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

/** 打开/聚焦设置窗 */
export function openSettingsWindow(): Promise<void> {
  return invoke<void>("open_settings_window");
}

/** 隐藏设置窗 */
export function closeSettingsWindow(): Promise<void> {
  return invoke<void>("close_settings_window");
}

/** 写设置项（"0" = 显式关）。写完广播 kind:"setting"，scheme 等监听方各自重读 */
export function settingsSet(key: string, value: string): Promise<void> {
  return invoke<void>("settings_set", { key, value });
}

/** 读单个设置项 */
export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("settings_get", { key });
}

/** 立即备份（VACUUM INTO 快照），返回备份文件完整路径 */
export function dataBackup(): Promise<string> {
  return invoke<string>("data_backup");
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

// —— 私密层 ——

export function privateStatus(): Promise<PrivateStatus> {
  return invoke<PrivateStatus>("private_status");
}

/** 首次设置私密密码（成功即进入解锁会话） */
export function privateSetup(password: string): Promise<void> {
  return invoke<void>("private_setup", { password });
}

export function privateUnlock(password: string): Promise<void> {
  return invoke<void>("private_unlock", { password });
}

export function privateLock(): Promise<void> {
  return invoke<void>("private_lock");
}

/** 私密内容整份 JSON map（string → SealedText）。未解锁会拒绝 */
export function privateLoad(): Promise<string> {
  return invoke<string>("private_load");
}

/** 私密内容整份重写（fresh nonce 重加密） */
export function privateSave(data: string): Promise<void> {
  return invoke<void>("private_save", { data });
}

/** 修改密码（需已解锁） */
export function privateRekey(password: string): Promise<void> {
  return invoke<void>("private_rekey", { password });
}

/** 重置（忘记密码的唯一出路）：清空全部私密内容 */
export function privateReset(password: string): Promise<void> {
  return invoke<void>("private_reset", { password });
}

// —— 星环 ——

/** 打开（或显示）星环：单例，每次开在光标处 */
export function openRingWindow(): Promise<void> {
  return invoke<void>("open_ring_window");
}

/** 收起星环（关 = 隐藏，下次秒开） */
export function closeRingWindow(): Promise<void> {
  return invoke<void>("close_ring_window");
}

// —— 口令窗 ——

export function openUnlockWindow(): Promise<void> {
  return invoke<void>("open_unlock_window");
}

export function closeUnlockWindow(): Promise<void> {
  return invoke<void>("close_unlock_window");
}

// —— 快捷键与右键劫持 ——

/** 当前生效的快捷键绑定表（改键 UI 的事实来源）。key 空串 = 显式停用 */
export function hotkeyList(): Promise<HotkeyBinding[]> {
  return invoke<HotkeyBinding[]>("hotkey_list");
}

/** 改一条绑定。key 空串 = 停用；失败（被占用/不合法）抛错且旧键自动还原 */
export function appSetHotkey(action: string, key: string): Promise<void> {
  return invoke<void>("app_set_hotkey", { action, key });
}

/** 右键劫持运行态 */
export function hookStatus(): Promise<HookStatus> {
  return invoke<HookStatus>("hook_status");
}

/** 改劫持配置（三项独立可选，只动传来的项） */
export function hookSetConfig(patch: {
  paused?: boolean;
  holdMs?: number;
  whitelist?: string[];
}): Promise<void> {
  return invoke<void>("hook_set_config", patch);
}
