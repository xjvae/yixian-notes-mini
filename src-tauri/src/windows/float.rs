// float — 便签浮窗的规格与开窗路径。一便签一窗（label = sticky-<id>）。
// `__STICKY_ID__` 注入脚本是跨语言契约：前端 identity.ts 读它，别处不得另造来源。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::models::StickyInput;
use crate::db::pool::Db;
use crate::db::query::{group, sticky};
use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::frames;

pub const FLOAT_PREFIX: &str = "sticky-";
pub const GROUP_PREFIX: &str = "stickygrp-";
const MAIN_ENTRY: &str = "index.html";
const DEFAULT_SIZE: (f64, f64) = (320.0, 300.0);
const MIN_SIZE: (f64, f64) = (220.0, 200.0);
/// 收起成标题栏形态的固定高度与最大宽度（前端收起按钮走同一套常量口径）
const BAR_HEIGHT: f64 = 62.0;
const BAR_MAX_WIDTH: f64 = 360.0;

pub fn label_for(id: &str) -> String {
    format!("{FLOAT_PREFIX}{id}")
}

pub fn group_label_for(gid: &str) -> String {
    format!("{GROUP_PREFIX}{gid}")
}

/// 新建默认便签并开窗，返回新 id（托盘与命令共用这一条路径）
pub async fn create_sticky(app: &AppHandle, db: Db) -> AppResult<String> {
    let id = gen_id();
    sticky::upsert(&db, default_input(&id))?;
    open_sticky(app, &db, &id).await?;
    Ok(id)
}

/// 打开（或聚焦已存在的）一扇便签窗。几何取行里存的值，没摆过位就级联落点。
pub async fn open_sticky(app: &AppHandle, db: &Db, id: &str) -> AppResult<()> {
    let label = label_for(id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let row = sticky::get(db, id)?
        .ok_or_else(|| AppError::new("STICKY_MISSING", format!("便签 {id} 不存在")))?;
    // 组员住叠窗（一叠一窗），不再单开一扇：搜索点结果、回收站恢复都走这条路，
    // 否则同一张便签会在单窗和叠窗里各显形一次。
    // 指向已删组的悬空成员按散着算——组行没了就当没组（见 query/group.rs 头部）。
    if let Some(gid) = row.group_id.as_deref()
        && group::exists(db, gid)?
    {
        // 带着"要看哪一张"进去：点结果/恢复点的就是这一张
        return open_group_stack(app, db, gid, Some(id)).await;
    }
    let position = match (row.x, row.y) {
        (Some(x), Some(y)) => (x as f64, y as f64),
        _ => cascade_position(app),
    };
    // 收起态的行记的仍是展开尺寸：开机恢复时按收起形态开窗
    let size = if row.collapsed {
        (
            row.width
                .map(|v| v as f64)
                .unwrap_or(DEFAULT_SIZE.0)
                .min(BAR_MAX_WIDTH),
            BAR_HEIGHT,
        )
    } else {
        (
            row.width.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.0),
            row.height.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.1),
        )
    };
    let spec = WindowSpec {
        label,
        url: MAIN_ENTRY.into(),
        title: "一闲便签".into(),
        size,
        min_size: Some(MIN_SIZE),
        transparent: true,
        always_on_top: row.pinned,
        skip_taskbar: true,
        focused: true,
        visible: true,
        show_on_reuse: true,
        init_script: Some(format!("window.__STICKY_ID__ = {:?};", id)),
    };
    let window = build_window(app, spec).await?;
    let _ = window.set_position(tauri::LogicalPosition::new(position.0, position.1));
    Ok(())
}

/// 关闭并销毁一扇便签窗。窗不存在不算错（调用方往往只是"让它别再显示"）
pub async fn close_sticky(app: &AppHandle, id: &str) -> AppResult<()> {
    destroy_window(app, &label_for(id)).await
}

/// 关闭并销毁一扇叠窗。叠窗的 label 整串由 `group_label_for` 定形，
/// 绝不能借道 `close_sticky`——那会再套一层 FLOAT_PREFIX，destroy 找不到窗，静默 no-op。
pub async fn close_stack(app: &AppHandle, gid: &str) -> AppResult<()> {
    destroy_window(app, &group_label_for(gid)).await
}

async fn destroy_window(app: &AppHandle, label: &str) -> AppResult<()> {
    if let Some(window) = app.get_webview_window(label) {
        window
            .destroy()
            .map_err(|e| AppError::new("WINDOW_CLOSE", e.to_string()))?;
    }
    Ok(())
}

/// 叠窗要落在哪一张：搜索点的是组员、刚移进来的那一张、回收站恢复的那一张。
/// 冷开走 init_script 的 `__STICKY_FOCUS_ID__`，窗已经在了走 `sticky:reveal` 事件——
/// 一条信息两条路，缺了后者就是"点了第一张却看到别的张"。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StickyReveal<'a> {
    pub group_id: &'a str,
    pub sticky_id: &'a str,
}

/// 叠窗翻到指定那张的事件名（前端 contracts.ts 有同名常量镜像）
pub const REVEAL_EVENT: &str = "sticky:reveal";

/// 打开（或聚焦）一扇叠窗：一叠一扇，窗内翻页，成员由前端按 group_id 捞。
/// 注入 `__STICKY_GROUP_ID__`（与 `__STICKY_ID__` 互斥，二者是"这扇窗是谁"的唯一出处）。
pub async fn open_group_stack(
    app: &AppHandle,
    db: &Db,
    gid: &str,
    focus: Option<&str>,
) -> AppResult<()> {
    let label = group_label_for(gid);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        if let Some(sid) = focus {
            // 广播给所有窗，叠窗自己按 groupId 认领（与 db:changed 同一口径）
            let _ = app.emit(
                REVEAL_EVENT,
                StickyReveal {
                    group_id: gid,
                    sticky_id: sid,
                },
            );
        }
        return Ok(());
    }
    // 首次落点：groups 行记过就用（旧库导入带进来的摆位），没记过走级联。
    // 用户此后拖动/缩放的记忆落在 window_state（frames::is_tracked 认 stickygrp-*），
    // 由下面的 apply_saved 原样放回——groups 行不再是几何的活住址，只当出生点。
    let (group_w, group_h) = group_frame(db, gid)?;
    let position = group_position(app, db, gid);
    let init_script = match focus {
        Some(sid) => format!(
            "window.__STICKY_GROUP_ID__ = {:?}; window.__STICKY_FOCUS_ID__ = {:?};",
            gid, sid
        ),
        None => format!("window.__STICKY_GROUP_ID__ = {:?};", gid),
    };
    let spec = WindowSpec {
        label,
        url: MAIN_ENTRY.into(),
        title: "一叠便签".into(),
        size: (group_w, group_h),
        min_size: Some(MIN_SIZE),
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        visible: true,
        show_on_reuse: true,
        init_script: Some(init_script),
    };
    let window = build_window(app, spec).await?;
    let _ = window.set_position(tauri::LogicalPosition::new(position.0, position.1));
    frames::apply_saved(&window);
    Ok(())
}

/// 叠窗尺寸：组行记过就用，没记过用默认
fn group_frame(db: &Db, gid: &str) -> AppResult<(f64, f64)> {
    let row = crate::db::query::group::get(db, gid)?
        .ok_or_else(|| AppError::new("GROUP_MISSING", format!("组合 {gid} 不存在")))?;
    Ok((
        row.width.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.0),
        row.height.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.1),
    ))
}

/// 叠窗位置：组行记过就用，没记过按已有浮窗数级联
fn group_position(app: &AppHandle, db: &Db, gid: &str) -> (f64, f64) {
    if let Ok(Some(row)) = crate::db::query::group::get(db, gid)
        && let (Some(x), Some(y)) = (row.x, row.y)
    {
        return (x as f64, y as f64);
    }
    cascade_position(app)
}

/// 没摆过位的便签按开窗数级联落点，一眼能看出是新开的
fn cascade_position(app: &AppHandle) -> (f64, f64) {
    let count = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(FLOAT_PREFIX))
        .count() as f64;
    (80.0 + count * 26.0, 90.0 + count * 26.0)
}

fn gen_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("s{:x}{:x}", sticky::now_ms(), seq)
}

fn default_input(id: &str) -> StickyInput {
    StickyInput {
        id: id.to_string(),
        title: String::new(),
        body: String::new(),
        content_type: "text".into(),
        items: Vec::new(),
        timeline: Vec::new(),
        tags: Vec::new(),
        theme: "yellow".into(),
        pinned: true,
        floating: true,
        collapsed: false,
        is_private: false,
        group_id: None,
        x: None,
        y: None,
        width: None,
        height: None,
        due_at: None,
        done_at: None,
        repeat: "none".into(),
        deleted: false,
        docked: false,
        dock_edge: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一叠一窗与一签一窗靠 label 前缀分流（on_window_event 的贴边清账也按前缀认）。
    /// 前缀一旦互相包含，销毁与清账都会静默走错分支——这里钉住互不重叠。
    #[test]
    fn 两种窗label前缀互不重叠() {
        assert!(!GROUP_PREFIX.starts_with(FLOAT_PREFIX));
        assert!(group_label_for("g1").starts_with(GROUP_PREFIX));
        assert!(!group_label_for("g1").starts_with(FLOAT_PREFIX));
        assert!(!label_for("s1").starts_with(GROUP_PREFIX));
    }
}
