// 窗口域命令 — 建窗/关窗。销毁一律用 destroy 而非 close：close 只发
// CloseRequested、依赖前端监听器往返，监听器没注册成功就留僵尸窗（真机实锤）。
// 回收站例外：close 语义是 hide（窗内无状态要销毁，留着还能记住摆位）。

use tauri::{AppHandle, State};

use crate::db::pool::Db;
use crate::support::error::AppResult;
use crate::windows::{float, trash};

#[tauri::command]
pub async fn create_floating_sticky(app: AppHandle, db: State<'_, Db>) -> AppResult<String> {
    let db = db.inner().clone();
    float::create_sticky(&app, db).await
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
