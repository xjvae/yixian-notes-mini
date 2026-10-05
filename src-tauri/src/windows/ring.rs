// ring — 星环（radial menu，单例）。4 节点：新建便签/搜索/回收站/设置。
//
// 两条与别的窗不一样的口径：
//  · **每次开在唤起点**，不记几何（frames::is_tracked 不认它）——星环的意义就是
//    "手在哪就在哪展开"，记住上次的摆位等于把它变成一个普通面板窗。
//  · **关 = 隐藏**（与搜索/回收站同口径）：星环要秒开，销毁再建一扇 WebView
//    的代价直接落在"按下快捷键到看见环"这段时间上。
//
// 生命周期与钩子（input 模块）的配合：
//  · 长按到阈值 → 钩子发 Charging → 消费线程 open_at（**不显示**，只摆位）+ 广播
//    `ring:charging`，前端画充电弧；窗在这里就提前建好/摆好，松手才不至于闪窗；
//  · 松手 → 钩子发 Up + Open → 消费线程 show + 广播 `ring:open`，前端换整盘；
//  · 盘亮起时 input::set_ring_open(true)：此后盘外左键由钩子转 Dismiss 收环；
//  · close 路径（隐藏）必须 input::set_ring_open(false) 清账。
//
// prewarm：启动即建一扇隐藏的星环窗。不预热的话，第一次长按的充电弧会撞上
// WebView 冷启动（约 1s），弧没画完盘就出来了。url 与 vite 入口 ring.html 对应。

use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::input;
use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const RING_LABEL: &str = "ring";
const RING_ENTRY: &str = "ring.html";
/// 环的画布是正方形：360 _logical_，SVG viewBox 300、unit 缩放。
/// 前端 features/ring/window.tsx 的 SIZE=300 与 useUnit 分母 360 与这里是一对，
/// 改一边要同时改另外两边。
const RING_SIZE: f64 = 360.0;

fn spec() -> WindowSpec {
    WindowSpec {
        label: RING_LABEL.into(),
        url: RING_ENTRY.into(),
        title: "星环".into(),
        size: (RING_SIZE, RING_SIZE),
        min_size: None,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        visible: false,
        show_on_reuse: false,
        init_script: None,
    }
}

/// 建（或复用）星环窗但不显示。prewarm 与 Charging 路径共用。
async fn build_hidden(app: &AppHandle) -> AppResult<tauri::WebviewWindow> {
    let window = build_window(app, spec()).await?;
    let _ = window.hide();
    Ok(window)
}

/// 启动预热：先把 WebView 建出来藏着，第一次长按才有即时的充电弧
pub async fn prewarm(app: &AppHandle) -> AppResult<()> {
    build_hidden(app).await.map(|_| ())
}

/// 快捷键/托盘唤起：以当前光标为中心，显示整盘
pub async fn open(app: &AppHandle) -> AppResult<()> {
    let cursor = cursor_position().unwrap_or((120, 120));
    open_at(app, cursor.0 as i32, cursor.1 as i32).await
}

/// 钩子路径：在**按下点**（物理像素）显示。松手位置≈按下位置，但用按下点
/// 而不是再取一次光标——语义上"在按住的地方出盘"。
/// 调用方负责 input::set_ring_open(true)（消费线程在 Open 分支里做）。
pub async fn open_at(app: &AppHandle, x: i32, y: i32) -> AppResult<()> {
    let window = match app.get_webview_window(RING_LABEL) {
        Some(existing) => existing,
        None => build_hidden(app).await?,
    };
    place_at(&window, x as i64, y as i64)?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// 关 = 隐藏：星环没有状态要销毁，留着下次直接显示。
/// 必须清盘驻留账：否则钩子会把之后每一次盘外左键都当"收环"。
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(RING_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "星环没有打开"))?
        .hide()
        .map_err(|e| AppError::new("WINDOW_HIDE", e.to_string()))?;
    input::set_ring_open(false);
    Ok(())
}

/// 把环的中心摆到指定点（物理像素）。落在屏幕边缘或副屏时把整块环拉回
/// 工作区内：半个环出界 = 两个节点点不到。
fn place_at(window: &tauri::WebviewWindow, x: i64, y: i64) -> AppResult<()> {
    let scale = window
        .scale_factor()
        .map_err(|e| AppError::new("WINDOW_SCALE", e.to_string()))?;
    let size_phys = (RING_SIZE * scale) as i64;
    let half = size_phys / 2;
    let position = match monitor::at((x, y)) {
        Some(area) => area.clamp_block((x - half, y - half), size_phys, size_phys),
        None => (x - half, y - half),
    };
    let _ = window.set_position(PhysicalPosition::new(
        position.0 as i32,
        position.1 as i32,
    ));
    Ok(())
}

/// 当前光标位置（物理像素）。失败返回 None，由调用方退回默认摆位
fn cursor_position() -> Option<(i64, i64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY：GetCursorPos 只往 &mut point 写两个 LONG，无其它输入；
    // 返回值判 BOOL，FALSE 时不读 point 的内容。
    let ok = unsafe { GetCursorPos(&mut point) }.is_ok();
    ok.then_some((point.x as i64, point.y as i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 星环画布是360的正方形() {
        // 前端 useUnit 的分母、SVG viewBox 的换算都建立在这个数上
        assert_eq!(RING_SIZE, 360.0);
    }
}
