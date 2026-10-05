// input — 全局"长按右键唤星环"的手势链：状态机（纯）→ 低级钩子（接线）→ 星环。
//
// 本模块对外只暴露配置与生命周期；判定逻辑在 state.rs（纯，可穷举单测），
// 白名单口径在 allowlist.rs（纯），Win32 机器房在 win_hook.rs。
//
// 配置语义：
//  · `hold_ms`：长按阈值，落库（`ring.trigger.hold_ms`），跨启动生效；
//  · `paused`：暂停劫持是"直到下次启动"的临时开关，**刻意不落库**——落库会让
//    用户以为右键坏了（重启都救不回来），重启即恢复是刻意的；
//  · 白名单：落库（`hook.whitelist`），跨启动生效。

pub mod allowlist;
mod state;
mod win_hook;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::RwLock;

/// 长按阈值默认值（毫秒）
pub const DEFAULT_HOLD_MS: u32 = 450;
pub const MIN_HOLD_MS: u32 = 150;
pub const MAX_HOLD_MS: u32 = 2000;

static HOLD_MS: AtomicU32 = AtomicU32::new(DEFAULT_HOLD_MS);
static PAUSED: AtomicBool = AtomicBool::new(false);
static WHITELIST: RwLock<Vec<String>> = RwLock::new(Vec::new());

pub fn spawn(app: tauri::AppHandle) {
    win_hook::spawn(app);
}

pub fn shutdown() {
    win_hook::shutdown();
}

pub fn hold_ms() -> u32 {
    HOLD_MS.load(Ordering::Relaxed)
}

pub fn set_hold_ms(ms: u32) {
    HOLD_MS.store(ms.clamp(MIN_HOLD_MS, MAX_HOLD_MS), Ordering::Relaxed);
}

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::Relaxed)
}

pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

/// 写白名单：过 allowlist::parse_list 归一（基名/去重/截断），采样线程下一轮生效
pub fn set_whitelist(raws: &[String]) {
    let list = allowlist::parse_list(raws);
    if let Ok(mut guard) = WHITELIST.write() {
        *guard = list;
    }
}

pub fn whitelist() -> Vec<String> {
    WHITELIST.read().map(|guard| guard.clone()).unwrap_or_default()
}

/// 最近采样到的前台进程基名（设置界面的「上一个前台程序」）
pub fn foreground_name() -> Option<String> {
    win_hook::foreground_name()
}

/// 星环盘驻留状态的唯一账本（钩子回调据此判定"盘外左键=收环"）。
/// 消费线程在盘亮起时置位；`windows/ring.rs` 的 close 路径清账。
pub fn set_ring_open(open: bool) {
    win_hook::set_ring_open(open);
}
