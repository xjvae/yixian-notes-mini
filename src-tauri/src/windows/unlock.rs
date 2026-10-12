// unlock — 口令窗（单例，常置顶）。
// 三相位由前端按 private_status 自行分岔：没配置 = 设置表单；配置了未解锁 = 解锁；
// 忘记密码 = 重置（清空私密内容，UI 层把这句话说清楚）。
// 「立即锁定」之后**总是**开这扇窗：没配过口令的人看到的是设置表单——
// "锁了没反应"与"根本没锁"在界面上必须分得开。

use tauri::{AppHandle, Emitter, Manager};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const UNLOCK_LABEL: &str = "unlock";
const UNLOCK_ENTRY: &str = "unlock.html";
const UNLOCK_SIZE: (f64, f64) = (420.0, 470.0);
/// 口令窗"没了"这件事的广播。挂起动作靠它收口：解锁成功是窗自己关的，
/// 放弃也是窗自己关的，两者对挂着的删除动作含义完全相反，所以关掉之后还要再读一次
/// 权威状态才决定执行还是作废。见 `src/window/private-gate.ts`。
pub const DISMISSED_EVENT: &str = "unlock:dismissed";

pub async fn open(app: &AppHandle) -> AppResult<()> {
    let spec = WindowSpec {
        label: UNLOCK_LABEL.into(),
        url: UNLOCK_ENTRY.into(),
        title: "一闲笔记 · 私密密码".into(),
        size: UNLOCK_SIZE,
        // 解锁窗是一次性的、不参与位置记忆（frames::is_tracked 不认它）：那就每次自己
        // 找地方——落在光标所在那块屏的工作区正中。交回系统摆的话，同一台机器上它
        // 每次出现的位置都不一样，而这是一扇要人打字输入的窗。
        position: monitor::spawn_centered(UNLOCK_SIZE, (0.0, 0.0)),
        min_size: Some((360.0, 400.0)),
        transparent: false,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        visible: true,
        reveal_timeout_ms: None,
        show_on_reuse: true,
        init_script: None,
    };
    build_window(app, spec).await.map(|_| ())
}

/// 完成（解锁/设置/重置成功，或用户取消）：这扇窗是一次性的，用 destroy
/// （close 依赖前端监听器往返，会留僵尸窗）。
pub async fn close(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window(UNLOCK_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "口令窗没有打开"))?;
    window
        .destroy()
        .map_err(|e| AppError::new("WINDOW_CLOSE", e.to_string()))?;
    // 先 destroy 再广播：监听方回头查"窗还在不在"时不该看见它
    let _ = app.emit(DISMISSED_EVENT, UNLOCK_LABEL);
    Ok(())
}
