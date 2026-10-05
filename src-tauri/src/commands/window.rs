// 窗口域命令 — 建窗/关窗/贴边注册/工作区。销毁一律用 destroy 而非 close：close 只发
// CloseRequested、依赖前端监听器往返，监听器没注册成功就留僵尸窗（真机实锤）。
// 面板窗例外：close 语义是 hide（窗内无状态要销毁，留着还能记住摆位）。

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};
use crate::windows::{dock::DockLayout, float, monitor, ring, search, settings, trash, unlock};

#[tauri::command]
pub async fn create_floating_sticky(app: AppHandle, db: State<'_, Db>) -> AppResult<String> {
    let db = db.inner().clone();
    float::create_sticky(&app, db).await
}

#[tauri::command]
pub async fn open_floating_sticky(app: AppHandle, db: State<'_, Db>, id: String) -> AppResult<()> {
    let db = db.inner().clone();
    float::open_sticky(&app, &db, &id).await
}

#[tauri::command]
pub async fn close_floating_sticky(app: AppHandle, id: String) -> AppResult<()> {
    float::close_sticky(&app, &id).await
}

#[tauri::command]
pub async fn open_trash_window(app: AppHandle) -> AppResult<()> {
    trash::open(&app).await
}

#[tauri::command]
pub async fn close_trash_window(app: AppHandle) -> AppResult<()> {
    trash::close(&app).await
}

#[tauri::command]
pub async fn open_search_window(app: AppHandle) -> AppResult<()> {
    search::open(&app).await
}

#[tauri::command]
pub async fn close_search_window(app: AppHandle) -> AppResult<()> {
    search::close(&app).await
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> AppResult<()> {
    settings::open(&app).await
}

#[tauri::command]
pub async fn close_settings_window(app: AppHandle) -> AppResult<()> {
    settings::close(&app).await
}

#[tauri::command]
pub async fn open_unlock_window(app: AppHandle) -> AppResult<()> {
    unlock::open(&app).await
}

#[tauri::command]
pub async fn close_unlock_window(app: AppHandle) -> AppResult<()> {
    unlock::close(&app).await
}

#[tauri::command]
pub async fn open_ring_window(app: AppHandle) -> AppResult<()> {
    ring::open(&app).await
}

#[tauri::command]
pub async fn close_ring_window(app: AppHandle) -> AppResult<()> {
    ring::close(&app).await
}

/// 关闭并销毁一扇叠窗（成员清空时由叠窗自己调用退场）
#[tauri::command]
pub async fn close_group_stack(app: AppHandle, gid: String) -> AppResult<()> {
    float::close_stack(&app, &gid).await
}

// —— 贴边 ——

#[tauri::command]
pub async fn float_dock_register(
    layout: State<'_, DockLayout>,
    id: String,
    edge: String,
) -> AppResult<i64> {
    Ok(layout.inner().register(&id, &edge))
}

#[tauri::command]
pub async fn float_dock_unregister(layout: State<'_, DockLayout>, id: String) -> AppResult<()> {
    layout.inner().unregister(&id);
    Ok(())
}

// —— 工作区 ——

/// 当前显示器的工作区（物理像素）。贴边细丝贴的是工作区边缘，不是屏幕边缘——
/// 任务栏底下不留东西。多显示器的"最近屏"按窗口当前位置判定。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkArea {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[tauri::command]
pub async fn monitor_work_area(win: WebviewWindow) -> AppResult<WorkArea> {
    let position = win
        .outer_position()
        .map_err(|e| AppError::new("WINDOW_POS", e.to_string()))?;
    // SAFETY 那份集中在 windows/monitor.rs，这里只搬运结果
    let area = monitor::at((position.x as i64, position.y as i64))
        .ok_or_else(|| AppError::new("MONITOR", "取显示器工作区失败"))?;
    Ok(WorkArea {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
    })
}
