// trash — 回收站窗（单例）。url 与 vite 入口 trash.html 对应（跨语言契约）。

use tauri::{AppHandle, Manager};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};

pub const TRASH_LABEL: &str = "trash";
const TRASH_ENTRY: &str = "trash.html";
const TRASH_SIZE: (f64, f64) = (440.0, 560.0);
const TRASH_MIN: (f64, f64) = (360.0, 420.0);

pub async fn open(app: &AppHandle) -> AppResult<()> {
    let spec = WindowSpec {
        label: TRASH_LABEL.into(),
        url: TRASH_ENTRY.into(),
        title: "回收站".into(),
        size: TRASH_SIZE,
        min_size: Some(TRASH_MIN),
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        focused: true,
        init_script: None,
    };
    build_window(app, spec).await.map(|_| ())
}

/// 关闭 = 隐藏：窗里没有要销毁的状态，留着窗还能记住下次的位置（window_state 随 M4）
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(TRASH_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "回收站没有打开"))?
        .hide()
        .map_err(|e| AppError::new("WINDOW_HIDE", e.to_string()))
}
