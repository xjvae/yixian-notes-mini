// 历史版本命令 — 列出某张便签的历史，与一键回滚到某一版。
// 表与"只存内容"这套口径的理由在 0009_revisions.sql；冷却与保留量在 query/revision.rs。

use tauri::{State, WebviewWindow};

use crate::db::models::{StickyInput, StickyRow};
use crate::db::pool::Db;
use crate::db::query::{revision, sticky};
use crate::support::error::{AppError, AppResult};

use super::entity::emit_changed;
use super::run_db;

#[tauri::command]
pub async fn sticky_revisions(
    db: State<'_, Db>,
    id: String,
) -> AppResult<Vec<revision::RevisionMeta>> {
    let db = db.inner().clone();
    run_db(db, move |db| {
        let conn = db.lock();
        revision::list(&conn, &id)
    })
    .await
}

/// 回滚到第 `seq` 版。**只换内容**：摆位、尺寸、置顶、贴边、收起、归组全部跟着
/// 当前走——历史管的是"这张写了什么"，不是"这扇窗怎么摆"。
/// 换之前先把当前内容强记一版（`force`，绕过冷却），所以回滚本身也能被回滚。
#[tauri::command]
pub async fn sticky_revert(
    win: WebviewWindow,
    db: State<'_, Db>,
    id: String,
    seq: i64,
) -> AppResult<StickyRow> {
    let db = db.inner().clone();
    let id_for_db = id.clone();
    let row = run_db(db, move |db| {
        // 先读当前行（`sticky::get` 自己拿锁、自己放），再进锁里取那一版并记当前
        let base = sticky::get(db, &id_for_db)?
            .ok_or_else(|| AppError::new("STICKY_MISSING", "这张便签不存在或已被删除"))?;
        let content = {
            let conn = db.lock();
            let found = revision::load(&conn, &id_for_db, seq)?
                .ok_or_else(|| AppError::new("REVISION_MISSING", format!("没有第 {seq} 版")))?;
            revision::record(&conn, &id_for_db, sticky::now_ms(), true)?;
            found
        };
        sticky::upsert(
            db,
            StickyInput {
                id: base.id,
                title: content.title,
                body: content.body,
                content_type: content.content_type,
                // 三个 JSON 字段是原样存的，这里重新解析成输入形状
                items: serde_json::from_str(&content.items_json).map_err(json_error)?,
                timeline: serde_json::from_str(&content.timeline_json).map_err(json_error)?,
                tags: serde_json::from_str(&content.tags_json).map_err(json_error)?,
                theme: content.theme,
                icon: content.icon,
                due_at: content.due_at,
                done_at: content.done_at,
                repeat: content.repeat,
                // 以下全部沿用当前行：回滚搬不动窗，也不改归组与私密标记
                pinned: base.pinned,
                floating: base.floating,
                collapsed: base.collapsed,
                is_private: base.is_private,
                group_id: base.group_id,
                x: base.x,
                y: base.y,
                width: base.width,
                height: base.height,
                deleted: base.deleted,
                docked: base.docked,
                dock_edge: base.dock_edge,
                auto_size: base.auto_size,
            },
        )
    })
    .await?;
    emit_changed(&win, "sticky");
    Ok(row)
}

fn json_error(e: serde_json::Error) -> AppError {
    AppError::new("REVISION", format!("那一版的内容读不出：{e}"))
}
