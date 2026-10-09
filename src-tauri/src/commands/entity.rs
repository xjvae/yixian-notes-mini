// 便签实体命令 — 每条写命令完成后广播 `db:changed {writer, kind}`。
// writer 是调用方窗口 label：前端 store 据此跳过自己写入的回灌。

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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

/// 改组合名。建组时名字是抄第一张便签标题的，之后一直没有改的地方（作者要的这条），
/// 口径与建组同一条（`group::normalize_name`：trim / 空→未命名组合 / 40 字符）。
#[tauri::command]
pub async fn group_rename(db: State<'_, Db>, gid: String, name: String) -> AppResult<()> {
    let db = db.inner().clone();
    run_db(db, move |db| group::rename(db, &gid, &name)).await
}

/// 收起/恢复一叠。收起时前端把**当前展开尺寸**一起报来（那是"恢复成多大"的唯一凭据），
/// 恢复时不报（None = 只翻状态，尺寸还留在行里）。
#[tauri::command]
pub async fn group_set_collapsed(
    db: State<'_, Db>,
    gid: String,
    collapsed: bool,
    expand_w: Option<f64>,
    expand_h: Option<f64>,
) -> AppResult<()> {
    let db = db.inner().clone();
    run_db(db, move |db| {
        let expand = match (expand_w, expand_h) {
            (Some(w), Some(h)) => Some((w.round() as i64, h.round() as i64)),
            _ => None,
        };
        group::set_collapsed(db, &gid, collapsed, expand)
    })
    .await
}

/// 贴边 / 解除贴边（一叠）。判定与动画在前端，这条只落状态——与单窗那两列同分工。
#[tauri::command]
pub async fn group_set_dock(
    db: State<'_, Db>,
    gid: String,
    docked: bool,
    edge: Option<String>,
) -> AppResult<()> {
    let db = db.inner().clone();
    run_db(db, move |db| {
        group::set_dock(db, &gid, docked, edge.as_deref())
    })
    .await
}

/// 拖拽进组：把 `source` 那张拖到 `target` 那张上松手。
///
/// target 已在某一叠里就进那一叠；还散着就地立一叠收两张（组名与被压住的摆位抄
/// target，见 `group::merge_into`）。所以**这条是本工程唯一的建组入口**——菜单里的
/// "移进"仍然只列已有组：一叠至少要两张才立得住，而"拖到另一张上"天然满足这点。
/// 新组 id 在 Rust 这边生成，不让前端传（传进来的能撞车也能伪造）。
///
/// 刻意用 AppHandle 而不是 WebviewWindow：发起方往往就是要被销毁的那一扇，
/// 拿它的句柄去发事件等于踩在自己正在拆的窗上。
#[tauri::command]
pub async fn sticky_merge_into(
    app: AppHandle,
    db: State<'_, Db>,
    source_id: String,
    target_id: String,
) -> AppResult<String> {
    let db = db.inner().clone();
    let new_group_id = float::gen_group_id();
    let source_for_db = source_id.clone();
    let target_for_db = target_id;
    let merged = run_db(db.clone(), move |db| {
        let merged = group::merge_into(db, &source_for_db, &target_for_db, &new_group_id)?;
        group::prune_empty(db)?;
        Ok(merged)
    })
    .await?;
    let payload = serde_json::json!({ "writer": "merge", "kind": "sticky" });
    // 广播失败（窗正在销毁等）不阻断写路径：别的窗最多晚一轮刷新
    let _ = app.emit("db:changed", payload);
    // 被拖走的那张就地退场（它现在是叠里的一张），叠窗当场拉起并落在它这一张上——
    // 不聚焦到刚进来的那张，用户就看不出"并进去了"
    float::close_sticky(&app, &source_id).await?;
    float::open_group_stack(&app, &db, &merged.group_id, Some(&source_id)).await?;
    Ok(merged.group_id)
}

fn emit_changed(win: &WebviewWindow, kind: &str) {
    let payload = serde_json::json!({ "writer": win.label(), "kind": kind });
    // 广播失败（窗正在销毁等）不阻断写路径：别的窗最多晚一轮刷新
    let _ = win.app_handle().emit("db:changed", payload);
}
