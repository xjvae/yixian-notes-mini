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
  RestoreReport,
  RevisionMeta,
  SearchOutcome,
  Snapshot,
  StickyGroup,
  StickyInput,
  StickyNote,
  UnlockIntent,
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

/** 落库单个实体；Rust 盖完时间戳后返回该行 */
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

/** 关并销毁便签窗（销毁在 Rust 侧做：close 依赖前端监听器往返会留僵尸窗） */
export function closeFloatingSticky(id: string): Promise<void> {
  return invoke<void>("close_floating_sticky", { id });
}

// —— 组合 ——

/** 组清单（只含非空组：空组行在写路径上就被清了） */
export function groupList(): Promise<StickyGroup[]> {
  return invoke<StickyGroup[]>("group_list");
}

/**
 * 改组合名。空串/超长的口径在 Rust 那边（`group::normalize_name`）——
 * 两处各判一份，早晚判出不一样来。
 */
export function groupRename(gid: string, name: string): Promise<void> {
  return invoke<void>("group_rename", { gid, name });
}

/**
 * 收起 / 恢复一叠。收起时报**当前展开尺寸**——`groups.width/height` 是"恢复成多大"的
 * 凭据（窗自身的 window_state 收起期间记的就是那条栏，指望不得）；恢复时不用报。
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
 * 贴边 / 解除贴边（一叠）。这条只落状态，判定与动画在前端。
 * `edge=null` 即"没贴"；认不出的值 Rust 一律按没贴算。
 */
export function groupSetDock(
  gid: string,
  docked: boolean,
  edge: DockEdge | null,
): Promise<void> {
  return invoke<void>("group_set_dock", { gid, docked, edge });
}

/** 移进已有组 / 移出（弹回桌面单窗）。groupId=null 即移出 */
export function stickySetGroup(id: string, groupId: string | null): Promise<boolean> {
  return invoke<boolean>("sticky_set_group", { id, groupId });
}

/** 关闭并销毁一扇叠窗 */
export function closeGroupStack(gid: string): Promise<void> {
  return invoke<void>("close_group_stack", { gid });
}

export function openTrashWindow(): Promise<void> {
  return invoke<void>("open_trash_window");
}

/** 隐藏回收站窗（close = hide：窗内无状态要销毁） */
export function closeTrashWindow(): Promise<void> {
  return invoke<void>("close_trash_window");
}

/** 回收站「恢复」：清删除时钟 + 回桌面 + 拉起浮窗 */
export function trashRestore(id: string): Promise<boolean> {
  return invoke<boolean>("trash_restore", { id });
}

/** 回收站「一键清空」：所有软删行连图真删，返回清掉的条数 */
export function trashClearAll(): Promise<number> {
  return invoke<number>("trash_clear_all");
}

/**
 * 历史版本（新的在前），存被换掉**之前**的内容。私密便签恒空表——该表明文落盘
 * （`migrations/0009_revisions.sql`）。
 */
export function stickyRevisions(id: string): Promise<RevisionMeta[]> {
  return invoke<RevisionMeta[]>("sticky_revisions", { id });
}

/** 回到某一版：只换内容（摆位/置顶/贴边/归组跟着现在走）；现在这份先被存成一版 */
export function stickyRevert(id: string, seq: number): Promise<StickyNote> {
  return invoke<StickyNote>("sticky_revert", { id, seq });
}

/** 子串检索（标题命中优先；私密/已删不进结果） */
export function searchQuery(query: string): Promise<SearchOutcome> {
  return invoke<SearchOutcome>("search_query", { query });
}

/** 打开/聚焦一扇已有便签的浮窗 */
export function openFloatingSticky(id: string): Promise<void> {
  return invoke<void>("open_floating_sticky", { id });
}

export function openSearchWindow(): Promise<void> {
  return invoke<void>("open_search_window");
}

/** 隐藏搜索窗 */
export function closeSearchWindow(): Promise<void> {
  return invoke<void>("close_search_window");
}

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

export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("settings_get", { key });
}

/** 立即备份（VACUUM INTO 快照），返回备份文件完整路径 */
export function dataBackup(): Promise<string> {
  return invoke<string>("data_backup");
}

/** 全部整库快照，新的在前（`backups\` 目录里数出来的） */
export function snapshotList(): Promise<Snapshot[]> {
  return invoke<Snapshot[]>("snapshot_list");
}

/**
 * 整库换回那一刻，**并当场锁上私密层**（内存会话密钥对应的是换掉前的封套）。
 * 恢复前自动存一份，返回值里的 `safetyLabel` 就是它。
 */
export function snapshotRestore(label: string): Promise<RestoreReport> {
  return invoke<RestoreReport>("snapshot_restore", { label });
}

/**
 * 开机启动开没开。事实来源是注册表 Run 键（键不在 = 没开），不是库。
 * 与「开机自动恢复桌面上的便签」是两条：那条管摆不摆回便签，这条管启不启动应用。
 */
export function autostartGet(): Promise<boolean> {
  return invoke<boolean>("autostart_get");
}

/**
 * 设定开机启动，返回**实际生效**的状态；写不进去抛错（被安全软件拦住时界面要退回
 * 原样说原因，不能画不成立的勾）。成功后 Rust 刷托盘勾并发 `AUTOSTART_CHANGED`。
 */
export function autostartSet(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("autostart_set", { enabled });
}

// —— 贴边 ——

/** 注册贴边槽位，返回同侧序号（细丝错开用） */
export function floatDockRegister(id: string, edge: string): Promise<number> {
  return invoke<number>("float_dock_register", { id, edge });
}

export function floatDockUnregister(id: string): Promise<void> {
  return invoke<void>("float_dock_unregister", { id });
}

/** 当前显示器工作区（物理像素） */
export function monitorWorkArea(): Promise<WorkArea> {
  return invoke<WorkArea>("monitor_work_area");
}

/**
 * 报"内容画完了"，Rust 据此把这扇窗亮出来（建时是隐藏的，免看见 WebView2 白闪；
 * 真机另有 2s 兜底）。`focus: false` = 只亮不抢焦点——提醒卡走这支，默认抢。
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

/** 卡上的「稍后再响」：把到期时刻推后 10 分钟、清掉这次的已弹标记，然后收卡（时长在 Rust 那侧） */
export function reminderSnooze(id: string): Promise<void> {
  return invoke<void>("reminder_snooze", { id });
}

// —— 私密层 ——

export function privateStatus(): Promise<PrivateStatus> {
  return invoke<PrivateStatus>("private_status");
}

/** 首次设置私密密码。设完**不等于揭开了哪张**——口令是逐张用的 */
export function privateSetup(password: string): Promise<void> {
  return invoke<void>("private_setup", { password });
}

/** 揭开**那一张**：只把这一张的钥匙放进 Rust 内存，不会顺手解开整层 */
export function privateReveal(noteId: string, password: string): Promise<void> {
  return invoke<void>("private_reveal", { noteId, password });
}

/** 收回全部已揭开的（口令窗「锁上」/ 托盘「立即锁定」/ 自动上锁同一条动作） */
export function privateLock(): Promise<void> {
  return invoke<void>("private_lock");
}

/**
 * 只验口令，**不开任何一张**。删除那道门用它——被删的那张从头到尾没被摊开过。
 */
export function privateVerify(password: string): Promise<void> {
  return invoke<void>("private_verify", { password });
}

/** 「便签窗内刚才有人动了一下」——自动上锁时钟的唯一输入。调用方自己节流，别逐键直连 */
export function privateNoteActivity(): Promise<void> {
  return invoke<void>("private_note_activity");
}

/** 改密码：旧口令验身份，新口令重裹逐张钥匙（内容字节一个都不动） */
export function privateRekey(password: string, newPassword: string): Promise<void> {
  return invoke<void>("private_rekey", { password, newPassword });
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

export function openGuideWindow(): Promise<void> {
  return invoke<void>("open_guide_window");
}

/** 报回**屏幕上那只环的真实中心**（逻辑像素 + 半径）；屏上没有环时 Rust 才兜底开一只 */
export function guideShowRing(): Promise<{ cx: number; cy: number; half: number }> {
  return invoke<{ cx: number; cy: number; half: number }>("guide_show_ring");
}

/** 离开讲环的那几步：闸门放下、环还开着就收掉 */
export function guideReleaseRing(): Promise<void> {
  return invoke<void>("guide_release_ring");
}

/**
 * 托盘那一格的矩形（**物理**像素），问不到为 null。
 * 图标没有句柄、Win32 拿不到矩形——Rust 走 UI Automation 问 Explorer（`tray.rs::icon_rect`）。
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
 * 让 Rust **凑够** `want` 张演示便签（已有的不动），返回最后那张的窗 label。
 * 走完或跳过引导时由 `close_guide_window` 顺手销毁、不进回收站。
 */
export function guideDemoNote(want: number): Promise<string> {
  return invoke<string>("guide_demo_note", { want });
}

/**
 * 关掉引导教程（关 = 销毁：下次从第一步起）。销账 `guide.seen=1` 由 Rust 顺手做——
 * 窗上有 × 与 Esc 两条关法，写在窗内就得两处各写一遍。
 */
export function closeGuideWindow(): Promise<void> {
  return invoke<void>("close_guide_window");
}

// —— 口令窗 ——

/**
 * 口令窗这一次的意图：**为哪张、干什么**。不带 noteId = 从托盘「立即锁定私密便签」开的，
 * 那时不追问哪张，只给立口令 / 改密 / 重置这几条出路。
 */
export function openUnlockWindow(
  noteId?: string,
  purpose?: "reveal" | "delete",
): Promise<void> {
  return invoke<void>("open_unlock_window", {
    noteId: noteId ?? null,
    purpose: purpose ?? null,
  });
}

/** 读这一次的意图（窗挂载时一次；收到 `unlock:intent` 再来一次） */
export function unlockIntent(): Promise<UnlockIntent | null> {
  return invoke<UnlockIntent | null>("unlock_intent");
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
 * `private` = **这张便签此刻私不私密**；要不要真加密由服务端按"私密层配没配置"定。
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

/** 取一张图的字节。null = 库里没这行（图删了或引用来自旧库）；密文没解锁会抛错 */
export function mediaGet(id: string): Promise<MediaBytes | null> {
  return invoke<MediaBytes | null>("media_get", { id });
}

/** 删一张图（正文去掉那句引用时配套）。true = 真删了一行 */
export function mediaDelete(id: string): Promise<boolean> {
  return invoke<boolean>("media_delete", { id });
}

/** 便签私密标记翻了：名下每张图重过一遍密文。返回改了几行 */
export function mediaSetPrivate(noteId: string, isPrivate: boolean): Promise<number> {
  return invoke<number>("media_set_private", { noteId, private: isPrivate });
}

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

/** 把前端一条 warn/error 递进同一份文件日志（`commands/log.rs`，带窗 label）。只该由 logger 调用 */
export function logWrite(
  level: "warn" | "error",
  scope: string,
  message: string,
): Promise<void> {
  return invoke<void>("log_write", { level, scope, message });
}

/**
 * 桌面上开着的浮窗矩形（物理像素）。拖拽进组的命中判定用：拖起时取一次快照就够，
 * 这一趟里别的窗不会自己跑。
 */
export function floatFrames(): Promise<FloatFrame[]> {
  return invoke<FloatFrame[]>("float_frames");
}

/**
 * 拖 sourceId 到 targetId 上松手。target 散着就地立一叠（组名与摆位抄它），
 * 已在某一叠里就进那一叠。返回并入的叠 id；源窗随之销毁。
 */
export function stickyMergeInto(sourceId: string, targetId: string): Promise<string> {
  return invoke<string>("sticky_merge_into", { sourceId, targetId });
}
