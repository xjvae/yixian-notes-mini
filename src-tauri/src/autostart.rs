// 开机启动 — 状态住 `HKCU\...\Run`，库里不存（两处各存一份早晚分叉）；键不在 = 没开，即默认值。
// 两个入口共用（tray 勾选项 + 设置窗复选框）：改完 Rust 侧直接刷托盘勾，再广播 `EVENT` 让设置窗重读。
// 改完必须重读而非信返回值：注册表是共享状态，手动删过键的人点"取消勾选"时 disable() 会报
// "没这个值"的错，可想要的结果（键不在）已达成——成不成就看重读。

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
