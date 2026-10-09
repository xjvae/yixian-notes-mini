// settings — 设置窗（单例）。url 与 vite 入口 settings.html 对应（跨语言契约）。

use tauri::{AppHandle, Manager};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::frames;

pub const SETTINGS_LABEL: &str = "settings";
const SETTINGS_ENTRY: &str = "settings.html";
const SETTINGS_SIZE: (f64, f64) = (560.0, 480.0);
const SETTINGS_MIN: (f64, f64) = (480.0, 420.0);

pub async fn open(app: &AppHandle) -> AppResult<()> {
    // 记住过就按那份出生（位置与尺寸都在建之前定），避免"先闪一下再跳到位"
    let (position, size) = frames::placement_or(app, SETTINGS_LABEL, SETTINGS_SIZE);
    let spec = WindowSpec {
        label: SETTINGS_LABEL.into(),
        url: SETTINGS_ENTRY.into(),
        title: "设置".into(),
        size,
        position,
        min_size: Some(SETTINGS_MIN),
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

/// 关闭 = 隐藏（与回收站/搜索同口径：窗内无状态要销毁，留着记住摆位）
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(SETTINGS_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "设置窗没有打开"))?
        .hide()
        .map_err(|e| AppError::new("WINDOW_HIDE", e.to_string()))
}
