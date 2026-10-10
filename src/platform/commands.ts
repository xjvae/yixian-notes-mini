// 命令包装 — 每条后端命令一个具名函数。视图层不允许出现裸字符串 invoke，
// 参数形状由 contracts.ts 的类型保证。

import type {
  Bootstrap,
  DockEdge,
  FloatFrame,
  HookStatus,
  HotkeyBinding,
  MediaBytes,
  MediaMeta,
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

/**
 * 改组合名。建组时名字抄的是第一张便签的标题，之后只有这一条路能改。
 * 空串/超长的口径在 Rust 那边（`group::normalize_name`），这里不重复判——
 * 两处各判一份，早晚判出不一样来。
 */
export function groupRename(gid: string, name: string): Promise<void> {
  return invoke<void>("group_rename", { gid, name });
}

/**
 * 收起 / 恢复一叠（叠窗那条 62 高的标题栏）。
 * 收起时把**当前展开尺寸**报上去（`groups.width/height` 是"恢复成多大"的凭据——
 * 窗自身的记忆在 window_state 里，收起期间它记的就是那条栏）；恢复时不用报。
 */
export function groupSetCollapsed(
  gid: string,
  collapsed: boolean,
  expand?: { width: number; height: number },
): Promise<void> {
  return invoke<void>("group_set_collapsed", {
    gid,
    collapsed,
    expandW: expand?.width ?? null,
    expandH: expand?.height ?? null,
  });
}

/**
 * 贴边 / 解除贴边（一叠）。判定与动画在前端，这条只落状态——与单窗那两列同分工。
 * `edge` 给 null 就是"没贴"；Rust 那边只认 left/right/top/bottom，认不出一律按没贴算。
 */
export function groupSetDock(
  gid: string,
  docked: boolean,
  edge: DockEdge | null,
): Promise<void> {
  return invoke<void>("group_set_dock", { gid, docked, edge });
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

/**
 * 开机启动：开没开。事实来源是 Windows 注册表的 Run 键（键不在 = 没开，也就是默认值）。
 * 与「开机自动恢复桌面上的便签」是两条：那条管启动了之后摆不摆回便签，这条管启不启动应用。
 */
export function autostartGet(): Promise<boolean> {
  return invoke<boolean>("autostart_get");
}

/**
 * 设定开机启动，返回**实际生效**的状态（写不进去会抛错——被安全软件拦住的机器上，
 * 界面必须退回原样并把原因说出来，不能画一个不成立的勾）。
 * 成功后 Rust 侧同时刷托盘那一项的勾，并发 `AUTOSTART_CHANGED`。
 */
export function autostartSet(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("autostart_set", { enabled });
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

/**
 * 便签窗"内容画完了"那一声：Rust 那边据此把这扇窗亮出来（建的时候是隐藏的，
 * 为的是不让他先看见 WebView2 那块默认白）。真机侧另有 2s 兜底，喊不响也会显示。
 *
 * `focus: false` = 只亮出来、不抢焦点。提醒卡走这一支：一条到点的提醒不该把用户
 * 正在打字的应用的焦点抢走（星环那条老理由）。默认拿焦点，别处不用改。
 */
export function floatReveal(focus = true): Promise<void> {
  return invoke<void>("float_reveal", { focus });
}

/** 点提醒卡：收卡 + 把那张便签拉到屏上（组员由 Rust 并进叠窗并翻到那一张） */
export function reminderOpen(id: string): Promise<void> {
  return invoke<void>("reminder_open", { id });
}

/** 提醒卡上的 ×：只收卡 */
export function reminderDismiss(): Promise<void> {
  return invoke<void>("reminder_dismiss");
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

// —— 引导教程窗 ——

/** 打开引导教程（十二步，分步点下一步） */
export function openGuideWindow(): Promise<void> {
  return invoke<void>("open_guide_window");
}

/**
 * 讲星环那几步：报回**屏幕上那只环的真实中心**（逻辑像素 + 半径）。
 * 气泡据此摆到它右边；屏上没有环时 Rust 才兜底开一只。
 */
export function guideShowRing(): Promise<{ cx: number; cy: number; half: number }> {
  return invoke<{ cx: number; cy: number; half: number }>("guide_show_ring");
}

/** 离开讲环的那几步：闸门放下、环还开着就收掉 */
export function guideReleaseRing(): Promise<void> {
  return invoke<void>("guide_release_ring");
}

/**
 * 托盘里我们那一格的矩形（**物理**像素），问不到就是 null。
 * 图标是 `Shell_NotifyIcon` 注册的、没有句柄，Win32 拿不到它的矩形——Rust 那侧走
 * UI Automation 问 Explorer（`tray.rs::icon_rect`）。
 */
export function trayRect(): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  return invoke<{ x: number; y: number; width: number; height: number } | null>(
    "tray_rect",
  );
}

/**
 * 让 Rust **凑够** `want` 张虚拟演示便签（已有的不动，缺几张补几张），返回最后那张的窗 label。
 * 1 张给讲单张的那几步，2 张给并叠那一步（桌上没有第二张时它自己会变一张出来，正文有明说）。
 * 走完或跳过引导时由 `close_guide_window` 顺手销毁、不进回收站。
 */
export function guideDemoNote(want: number): Promise<string> {
  return invoke<string>("guide_demo_note", { want });
}

/**
 * 关掉引导教程（关 = 销毁：下次开都从第一步起）。
 * 销账 `guide.seen=1` 由这条命令在 Rust 侧顺手做掉——窗上有 × 与 Esc 两条关法，
 * 写在窗内就得两处各写一遍。
 */
export function closeGuideWindow(): Promise<void> {
  return invoke<void>("close_guide_window");
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

// —— 图片（media 表，见 migrations/0005_media.sql）——

/**
 * 存一张图，返回它的 id（正文里那句 `media://<id>` 就是凭据）。
 * `private` 传的是**这张便签此刻私不私密**——要不要真加密由服务端按"私密层配没配置"定，
 * 与正文那条直通口径一字不差。
 */
export function mediaSave(input: {
  noteId: string;
  mime: string;
  dataBase64: string;
  width: number;
  height: number;
  private: boolean;
}): Promise<MediaMeta> {
  return invoke<MediaMeta>("media_save", { input });
}

/** 取一张图的字节。null = 库里没这行（图删了，或引用来自旧库）；密文没解锁会抛错 */
export function mediaGet(id: string): Promise<MediaBytes | null> {
  return invoke<MediaBytes | null>("media_get", { id });
}

/** 删一张图（正文里去掉那句引用时配套）。true = 真删了一行 */
export function mediaDelete(id: string): Promise<boolean> {
  return invoke<boolean>("media_delete", { id });
}

/** 便签的私密标记翻了：名下每张图重过一遍密文。返回改了几行 */
export function mediaSetPrivate(noteId: string, isPrivate: boolean): Promise<number> {
  return invoke<number>("media_set_private", { noteId, private: isPrivate });
}

/** 右键劫持运行态 */
export function hookStatus(): Promise<HookStatus> {
  return invoke<HookStatus>("hook_status");
}

/** 改劫持配置（四项独立可选，只动传来的项） */
export function hookSetConfig(patch: {
  paused?: boolean;
  holdMs?: number;
  charging?: boolean;
  whitelist?: string[];
}): Promise<void> {
  return invoke<void>("hook_set_config", patch);
}

/**
 * 桌面上开着的浮窗矩形（物理像素）。拖拽进组的命中判定用：一次给全，
 * 拖起时取一份快照就够——这一趟里别的窗不会自己跑。
 */
export function floatFrames(): Promise<FloatFrame[]> {
  return invoke<FloatFrame[]>("float_frames");
}

/**
 * 拖拽进组：把 sourceId 拖到 targetId 上松手。target 散着就地立一叠（组名与摆位抄它），
 * 已在某一叠里就进那一叠。成功返回并入的那一叠 id；源窗随之销毁。
 */
export function stickyMergeInto(sourceId: string, targetId: string): Promise<string> {
  return invoke<string>("sticky_merge_into", { sourceId, targetId });
}
