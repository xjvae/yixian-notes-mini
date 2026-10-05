// frames — 面板窗（搜索/回收站/设置）的位置尺寸记忆。
//
// 拖动/缩放事件是连发的，一事件一写等于拿 SQLite 当记事本：合流 600ms——
// 静默这么久才落一笔，pending 去重保证拖动期间至多一个落笔任务在飞。
// 恢复走物理像素原样放回（量出来什么样放回去就是什么样，同屏不漂）。

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::db::pool::Db;
use crate::db::query::window_state;

/// 固定单例面板（叠窗 stickygrp-* 按前缀动态判定，见 `is_tracked`）
const PANEL_LABELS: &[&str] = &[
    crate::windows::search::SEARCH_LABEL,
    crate::windows::trash::TRASH_LABEL,
    crate::windows::settings::SETTINGS_LABEL,
];

const MERGE_MS: u64 = 600;

/// pending 去重表：label 在表中 = 已有一个落笔任务在飞
#[derive(Default)]
pub struct PanelFrames(Mutex<HashMap<String, ()>>);

/// 参与记忆的窗 label（解锁窗是一次性的，不记；叠窗 stickygrp-* 与面板一样记；
/// 星环 ring **不记**——它每次开在光标处，记住上次的摆位就没了"手在哪环在哪"的意义）
pub fn is_tracked(label: &str) -> bool {
    PANEL_LABELS.contains(&label) || label.starts_with(crate::windows::float::GROUP_PREFIX)
}

pub fn track(app: &AppHandle, label: &str) {
    if !is_tracked(label) {
        return;
    }
    {
        let state = app.state::<PanelFrames>();
        let mut map = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if map.contains_key(label) {
            return; // 已有任务在飞，它落笔时自然拿到最新几何
        }
        map.insert(label.to_string(), ());
    }
    let app = app.clone();
    let label = label.to_string();
    // 独立线程做延迟落笔：600ms 阻塞一个小线程，比为此接 tokio 的定时器干净
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(MERGE_MS));
        {
            let state = app.state::<PanelFrames>();
            state
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&label);
        }
        let Some(window) = app.get_webview_window(&label) else {
            return;
        };
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            return;
        };
        let Some(db) = app.try_state::<Db>() else {
            return;
        };
        let _ = window_state::set(
            db.inner(),
            &label,
            position.x as i64,
            position.y as i64,
            size.width as i64,
            size.height as i64,
        );
    });
}

/// 开窗后把记住的位置尺寸原样放回（物理像素往返，同屏精确）。
/// 尺寸非法（<=0）按没记过算。
pub fn apply_saved(window: &WebviewWindow) {
    let Some(db) = window.app_handle().try_state::<Db>() else {
        return;
    };
    let Ok(Some((x, y, width, height))) = window_state::get(db.inner(), window.label()) else {
        return;
    };
    if width <= 0 || height <= 0 {
        return;
    }
    let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
}
