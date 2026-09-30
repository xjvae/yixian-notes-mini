// 便签实体命令 — 每条写命令完成后广播 `db:changed {writer, kind}`。
// writer 是调用方窗口 label：前端 store 据此跳过自己写入的回灌。

use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::db::models::{StickyInput, StickyRow};
use crate::db::pool::Db;
use crate::db::query::{sticky, trash};
use crate::support::error::AppResult;
use crate::windows::float;

use super::run_db;

#[tauri::command]
pub async fn sticky_list(db: State<'_, Db>, include_deleted: bool) -> AppResult<Vec<StickyRow>> {
    let db = db.inner().clone();
    run_db(db, move |db| sticky::list(db, include_deleted)).await
}

#[tauri::command]
pub async fn sticky_upsert(
    win: WebviewWindow,
    db: State<'_, Db>,
    input: StickyInput,
) -> AppResult<StickyRow> {
    let db = db.inner().clone();
    let row = run_db(db, move |db| sticky::upsert(db, input)).await?;
    emit_changed(&win, "sticky");
    Ok(row)
}

#[tauri::command]
pub async fn sticky_delete(
    win: WebviewWindow,
    db: State<'_, Db>,
    id: String,
    hard: bool,
) -> AppResult<bool> {
    let db = db.inner().clone();
    let changed = run_db(db, move |db| sticky::delete(db, &id, hard)).await?;
    emit_changed(&win, "sticky");
    Ok(changed)
}

/// 回收站「恢复」：清删除时钟 + 回桌面 + 当场拉起浮窗。
#[tauri::command]
pub async fn trash_restore(
    win: WebviewWindow,
    db: State<'_, Db>,
    id: String,
) -> AppResult<bool> {
    let db = db.inner().clone();
    let id_for_restore = id.clone();
    let restored = run_db(db.clone(), move |db| trash::restore(db, &id_for_restore)).await?;
    if restored {
        emit_changed(&win, "sticky");
        float::open_sticky(win.app_handle(), &db, &id).await?;
    }
    Ok(restored)
}

fn emit_changed(win: &WebviewWindow, kind: &str) {
    let payload = serde_json::json!({ "writer": win.label(), "kind": kind });
    // 广播失败（窗正在销毁等）不阻断写路径：别的窗最多晚一轮刷新
    let _ = win.app_handle().emit("db:changed", payload);
}
