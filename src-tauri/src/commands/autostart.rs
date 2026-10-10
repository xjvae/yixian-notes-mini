// 开机启动命令 — 设置窗那一条勾的后端（托盘自己走 `autostart::toggle`，不过 IPC）。
// 两条都返回**实际生效**的状态：写不进去会报错，界面据此退回原样——
// 点下去的样式不是结果，注册表里的才是。

use tauri::AppHandle;

use crate::autostart;
use crate::support::error::AppResult;

/// 现在开没开（读注册表；键不在就是没开）
#[tauri::command]
pub async fn autostart_get(app: AppHandle) -> AppResult<bool> {
    autostart::is_enabled(&app)
}

/// 设定开关。返回实际生效的状态，并把托盘那一项的勾一起刷掉
#[tauri::command]
pub async fn autostart_set(app: AppHandle, enabled: bool) -> AppResult<bool> {
    autostart::set_enabled(&app, enabled)
}
