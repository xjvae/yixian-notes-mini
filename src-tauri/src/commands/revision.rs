// 历史版本命令 — 列出某张便签的历史，与一键回滚到某一版。
// 表与"只存内容"这套口径的理由在 0009_revisions.sql；冷却与保留量在 query/revision.rs。
//
// 私密便签的那一版住在密文表里（`query/private_note.rs`），而**分岔发生在这一格**：
// 同一条命令，内部按密级走。前端不该再自己判"这张要不要问封套"——判错一次就是
// 一个能绕过口令门的读路径，而 1.2.8 之前那条判断确实住在 `history-panel.tsx` 里。
//
// 私密便签在私密层没启用时**没有历史**：那张明文表谁都读得到，把私密的版本记进去
// 等于拆掉私密层（0010 那次清理清的就是这种漏网），而那时也没有别处可记。

use rusqlite::Connection;
use tauri::{State, WebviewWindow};

use crate::data::private::PrivateVault;
use crate::db::models::{StickyInput, StickyRow};
use crate::db::pool::Db;
use crate::db::query::{private_note, revision, sticky};
use crate::support::error::{AppError, AppResult};

use super::entity::emit_changed;
use super::run_db;

/// 这一张的历史住在哪一张表
enum Shelf {
    /// 明文表（公开便签）
    Plain,
    /// 密文表（要口令才读得出，锁着由 `private_note` 抛 PRIVATE_LOCKED）
    Sealed,
    /// 标着私密，但私密层还没启用：哪张表里都没有它的版本
    Empty,
}

fn shelf(conn: &Connection, vault: &PrivateVault, id: &str) -> AppResult<Shelf> {
    if !sticky::private_flag_conn(conn, id)?.unwrap_or(false) {
        return Ok(Shelf::Plain);
    }
    Ok(if vault.is_configured() {
        Shelf::Sealed
    } else {
        Shelf::Empty
    })
}

#[tauri::command]
pub async fn sticky_revisions(
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    id: String,
) -> AppResult<Vec<revision::RevisionMeta>> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    run_db(db, move |db| {
        let conn = db.lock();
        match shelf(&conn, &vault, &id)? {
            Shelf::Plain => revision::list(&conn, &id),
            Shelf::Sealed => private_note::revision_list(&conn, &vault, &id),
            Shelf::Empty => Ok(Vec::new()),
        }
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
    vault: State<'_, PrivateVault>,
    id: String,
    seq: i64,
) -> AppResult<StickyRow> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    let row = run_db(db, move |db| {
        // 先读当前行：回滚要沿用它的摆位与标记，而那些只住在行上
        // （读的是不合并的那一份——为回滚去解一次密是白解，摆位字段用不着真身）
        let base = sticky::get_raw(db, &id)?
            .ok_or_else(|| AppError::new("STICKY_MISSING", "这张便签不存在或已被删除"))?;
        let which = {
            let conn = db.lock();
            shelf(&conn, &vault, &id)?
        };
        match which {
            Shelf::Empty => Err(AppError::new(
                "REVISION_MISSING",
                "这张便签标着私密，可私密层当时还没启用——那阵子一版都没记",
            )),
            // 私密便签：行上永远是空占位，所以回滚只动密文那一条。
            // 返回**合并过的**那一行，调用方直接换掉内存里的实体，不必再写一次库。
            Shelf::Sealed => {
                {
                    let conn = db.lock();
                    private_note::revert(&conn, &vault, &id, seq, sticky::now_ms())?;
                }
                sticky::get(db, &vault, &id)?
                    .ok_or_else(|| AppError::new("STICKY_MISSING", "回滚完读不回这一张"))
            }
            Shelf::Plain => {
                let content = {
                    let conn = db.lock();
                    let found = revision::load(&conn, &id, seq)?
                        .ok_or_else(|| {
                            AppError::new("REVISION_MISSING", format!("没有第 {seq} 版"))
                        })?;
                    revision::record(&conn, &id, sticky::now_ms(), true, false)?;
                    found
                };
                sticky::upsert(
                    db,
                    &vault,
                    StickyInput {
                        id: base.id,
                        title: content.title,
                        body: content.body,
                        content_type: content.content_type,
                        // 三个 JSON 字段是原样存的，这里重新解析成输入形状
                        items: serde_json::from_str(&content.items_json).map_err(json_error)?,
                        timeline: serde_json::from_str(&content.timeline_json)
                            .map_err(json_error)?,
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
            }
        }
    })
    .await?;
    emit_changed(&win, "sticky");
    Ok(row)
}

fn json_error(e: serde_json::Error) -> AppError {
    AppError::new("REVISION", format!("那一版的内容读不出：{e}"))
}
