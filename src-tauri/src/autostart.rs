// 开机启动 — 状态就住在 Windows 的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 里，
// 库里不再存一份：两处各存一份早晚分叉（这边勾着，那边那条已被人在任务管理器里关掉）。
// 键不在 = 没开，这正是要求的默认值——不用加设置项，也不用迁移。
//
// 两个入口共用这一份实现（`tray.rs` 的勾选项 + 设置窗的复选框）：
//  · 改完直接刷托盘那一项的勾（在 Rust 侧 set_checked，不绕前端）；
//  · 再广播 `EVENT`，开着设置窗的人跟着重读（反方向由命令本身负责刷托盘）。
//
// 为什么改完要**重读一遍**、不直接信 enable/disable 的返回：注册表是别人也能改的共享状态。
// 手动删过那条键的人点"取消勾选"，`disable()` 会因为"没这个值"报错——可想要的结果（键不在）
// 明明已经达成。所以成不成只看重读，不看那一声返回。

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::support::error::{AppError, AppResult};
use crate::support::log;

/// 托盘勾选项的 id：`tray.rs` 建菜单与这里同步共用（一个动作用两个名字迟早分叉）
pub const MENU_ID: &str = "autostart";
/// 前端事件名（与 `contracts.ts` 的 `AUTOSTART_CHANGED` 同值）
pub const EVENT: &str = "app:autostart-changed";

/// 托盘那一项的句柄。菜单在启动时建一次，之后的勾与不勾要靠它落回界面。
/// 没有这条托管状态（托盘没建起来）时同步一律走 `try_state`，不许 panic。
pub struct TrayToggle(pub tauri::menu::CheckMenuItem<tauri::Wry>);

/// 现在开没开（读注册表）。
pub fn is_enabled(app: &AppHandle) -> AppResult<bool> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| AppError::new("AUTOSTART", format!("读开机启动状态失败：{e}")))
}

/// 设定开关，返回**实际生效**的状态；没改成要求的样子就报错（不返回"大概成了"）。
pub fn set_enabled(app: &AppHandle, want: bool) -> AppResult<bool> {
    {
        let manager = app.autolaunch();
        // 这两条的返回先放下：成不成由下面的重读判定
        if want {
            let _ = manager.enable();
        } else {
            let _ = manager.disable();
        }
    }
    let now = is_enabled(app)?;
    if now != want {
        log::error(
            "autostart",
            &format!("设成 {want} 之后重读是 {now}——注册表没写进去"),
        );
        return Err(AppError::new(
            "AUTOSTART",
            if want {
                "开机启动没打开：注册表那条 Run 键写不进去（可能被安全软件拦了）"
            } else {
                "开机启动没关掉：注册表那条 Run 键删不掉"
            },
        ));
    }
    sync_tray(app, now);
    let _ = app.emit(EVENT, now);
    log::info("autostart", &format!("开机启动 = {now}"));
    Ok(now)
}

/// 翻一次（托盘那一条走这里）。
pub fn toggle(app: &AppHandle) -> AppResult<bool> {
    set_enabled(app, !is_enabled(app)?)
}

/// 把要显示的勾刷到托盘那一项上。
pub fn sync_tray(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayToggle>()
        && let Err(e) = state.0.set_checked(enabled)
    {
        log::warn("autostart", &format!("托盘的勾没刷上：{e}"));
    }
}
