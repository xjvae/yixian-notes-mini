// unlock — 口令窗（单例，常置顶）。
// 三相位由前端按 private_status 自行分岔：没配置 = 设置表单；配置了未解锁 = 解锁；
// 忘记密码 = 重置（清空私密内容，UI 层把这句话说清楚）。
// 「立即锁定」之后**总是**开这扇窗：没配过口令的人看到的是设置表单——
// "锁了没反应"与"根本没锁"在界面上必须分得开。

use tauri::{AppHandle, Manager};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};

pub const UNLOCK_LABEL: &str = "unlock";
const UNLOCK_ENTRY: &str = "unlock.html";
const UNLOCK_SIZE: (f64, f64) = (420.0, 470.0);

pub async fn open(app: &AppHandle) -> AppResult<()> {
    let spec = WindowSpec {
        label: UNLOCK_LABEL.into(),
        url: UNLOCK_ENTRY.into(),
        title: "一闲笔记 · 私密密码".into(),
        size: UNLOCK_SIZE,
        min_size: Some((360.0, 400.0)),
        transparent: false,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        visible: true,
        show_on_reuse: true,
        init_script: None,
    };
    build_window(app, spec).await.map(|_| ())
}

/// 完成（解锁/设置/重置成功，或用户取消）：这扇窗是一次性的，用 destroy
/// （close 依赖前端监听器往返，会留僵尸窗）。
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(UNLOCK_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "口令窗没有打开"))?
        .destroy()
        .map_err(|e| AppError::new("WINDOW_CLOSE", e.to_string()))
}
