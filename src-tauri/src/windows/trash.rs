// trash — 回收站窗（单例）。url 与 vite 入口 trash.html 对应（跨语言契约）。

use tauri::{AppHandle, Manager};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::frames;

pub const TRASH_LABEL: &str = "trash";
const TRASH_ENTRY: &str = "trash.html";
const TRASH_SIZE: (f64, f64) = (440.0, 560.0);
const TRASH_MIN: (f64, f64) = (360.0, 420.0);

pub async fn open(app: &AppHandle) -> AppResult<()> {
    // 记住过就按那份出生（位置与尺寸都在建之前定），避免"先闪一下再跳到位"
    let (position, size) = frames::placement_or(app, TRASH_LABEL, TRASH_SIZE);
    let spec = WindowSpec {
        label: TRASH_LABEL.into(),
        url: TRASH_ENTRY.into(),
        title: "回收站".into(),
        size,
        position,
        min_size: Some(TRASH_MIN),
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

/// 关闭 = 隐藏：窗里没有要销毁的状态，留着窗还能记住下次的位置
/// （摆位由 `frames::track` 落进 `window_state`，销毁反而要把窗口实例重建一遍）
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(TRASH_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "回收站没有打开"))?
        .hide()
        .map_err(|e| AppError::new("WINDOW_HIDE", e.to_string()))
}
