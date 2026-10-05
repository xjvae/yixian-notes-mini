// 便签实体命令 — 每条写命令完成后广播 `db:changed {writer, kind}`。
// writer 是调用方窗口 label：前端 store 据此跳过自己写入的回灌。

use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::db::models::{StickyInput, StickyRow};
use crate::db::pool::Db;
use crate::db::query::{group, sticky, trash};
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
    let id_for_db = id.clone();
    // 删的是组里最后一张时，组行必须跟着没（软删也算）——空组自动清不只归组那一条路
    let changed = run_db(db.clone(), move |db| {
        let changed = sticky::delete(db, &id_for_db, hard)?;
        group::prune_empty(db)?;
        Ok(changed)
    })
    .await?;
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

/// 归组/移出（降级口径：只能移进**已有**组）。
/// 归组 = 该便签收进叠窗，单窗就地销毁；移出 = 弹回桌面单窗。
#[tauri::command]
pub async fn sticky_set_group(
    win: WebviewWindow,
    db: State<'_, Db>,
    id: String,
    group_id: Option<String>,
) -> AppResult<bool> {
    let db = db.inner().clone();
    let id_for_db = id.clone();
    let group_for_db = group_id.clone();
    let changed = run_db(db.clone(), move |db| {
        let changed = group::set_member(db, &id_for_db, group_for_db.as_deref())?;
        group::prune_empty(db)?;
        Ok(changed)
    })
    .await?;
    if changed {
        emit_changed(&win, "sticky");
        let app = win.app_handle().clone();
        match group_id.as_deref() {
            // 归组：单窗就地销毁，叠窗当场拉起——晚一步便是签就没人给它显形了
            Some(gid) => {
                float::close_sticky(&app, &id).await?;
                // 归组后叠窗要落在刚移进去的那一张，否则"移进去了"看不出来
                float::open_group_stack(&app, &db, gid, Some(&id)).await?;
            }
            None => {
                float::open_sticky(&app, &db, &id).await?;
            }
        }
    }
    Ok(changed)
}

/// 组合清单（归组菜单用）。
#[tauri::command]
pub async fn group_list(db: State<'_, Db>) -> AppResult<Vec<crate::db::models::GroupRow>> {
    let db = db.inner().clone();
    run_db(db, group::list).await
}

fn emit_changed(win: &WebviewWindow, kind: &str) {
    let payload = serde_json::json!({ "writer": win.label(), "kind": kind });
    // 广播失败（窗正在销毁等）不阻断写路径：别的窗最多晚一轮刷新
    let _ = win.app_handle().emit("db:changed", payload);
}
