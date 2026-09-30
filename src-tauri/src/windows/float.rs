// float — 便签浮窗的规格与开窗路径。一便签一窗（label = sticky-<id>）。
// `__STICKY_ID__` 注入脚本是跨语言契约：前端 identity.ts 读它，别处不得另造来源。

use tauri::{AppHandle, Manager};

use crate::db::models::StickyInput;
use crate::db::pool::Db;
use crate::db::query::sticky;
use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};

pub const FLOAT_PREFIX: &str = "sticky-";
const MAIN_ENTRY: &str = "index.html";
const DEFAULT_SIZE: (f64, f64) = (320.0, 300.0);
const MIN_SIZE: (f64, f64) = (220.0, 200.0);

pub fn label_for(id: &str) -> String {
    format!("{FLOAT_PREFIX}{id}")
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
    let position = match (row.x, row.y) {
        (Some(x), Some(y)) => (x as f64, y as f64),
        _ => cascade_position(app),
    };
    let size = (
        row.width.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.0),
        row.height.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.1),
    );
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
        init_script: Some(format!("window.__STICKY_ID__ = {:?};", id)),
    };
    let window = build_window(app, spec).await?;
    let _ = window.set_position(tauri::LogicalPosition::new(position.0, position.1));
    Ok(())
}

/// 关闭并销毁一扇便签窗。窗不存在不算错（调用方往往只是"让它别再显示"）
pub async fn close_sticky(app: &AppHandle, id: &str) -> AppResult<()> {
    if let Some(window) = app.get_webview_window(&label_for(id)) {
        window
            .destroy()
            .map_err(|e| AppError::new("WINDOW_CLOSE", e.to_string()))?;
    }
    Ok(())
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
    }
}
