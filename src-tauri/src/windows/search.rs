// search — 搜索窗（单例）。url 与 vite 入口 search.html 对应（跨语言契约）。

use tauri::{AppHandle, Manager};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::frames;

pub const SEARCH_LABEL: &str = "search";
const SEARCH_ENTRY: &str = "search.html";
const SEARCH_SIZE: (f64, f64) = (480.0, 420.0);
const SEARCH_MIN: (f64, f64) = (380.0, 340.0);

pub async fn open(app: &AppHandle) -> AppResult<()> {
    // 记住过就按那份出生（位置与尺寸都在建之前定），避免"先闪一下再跳到位"
    let (position, size) = frames::placement_or(app, SEARCH_LABEL, SEARCH_SIZE);
    let spec = WindowSpec {
        label: SEARCH_LABEL.into(),
        url: SEARCH_ENTRY.into(),
        title: "搜索".into(),
        size,
        position,
        min_size: Some(SEARCH_MIN),
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        focused: true,
        visible: true,
        reveal_timeout_ms: None,
        show_on_reuse: true,
        init_script: None,
    };
    build_window(app, spec).await.map(|window| {
        frames::apply_saved(&window);
    })
}

/// 关闭 = 隐藏（与回收站同口径：窗内无状态要销毁，留着记住摆位）
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(SEARCH_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "搜索窗没有打开"))?
        .hide()
        .map_err(|e| AppError::new("WINDOW_HIDE", e.to_string()))
}
