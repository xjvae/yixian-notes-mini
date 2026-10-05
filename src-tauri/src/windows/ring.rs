// ring — 星环（radial menu，单例）。4 节点：新建便签/搜索/回收站/设置。
//
// 两条与别的窗不一样的口径：
//  · **每次开在光标处**，不记几何（frames::is_tracked 不认它）——星环的意义就是
//    "手在哪就在哪展开"，记住上次的摆位等于把它变成一个普通面板窗。
//    光标位置是物理像素，窗的尺寸与半径按缩放系数换算过去，两套单位不许混着用。
//  · **关 = 隐藏**（与搜索/回收站同口径）：星环要秒开，销毁再建一扇 WebView
//    的代价直接落在"按下快捷键到看见环"这段时间上。
//
// url 与 vite 入口 ring.html 对应（跨语言契约）。长按右键唤出（WH_MOUSE_LL）随 M4
// 的另一半落地时，走的也是这条 open()——钩子只负责"何时唤"，不负责"唤什么"。

use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const RING_LABEL: &str = "ring";
const RING_ENTRY: &str = "ring.html";
/// 环的画布是正方形：420 _logical_ 够放半径 130 的四节点 + 中心提示。
/// 前端 features/ring/window.tsx 里的 CENTER/RADIUS 与这里是一对，改一边要改另一边
const RING_SIZE: f64 = 420.0;

pub async fn open(app: &AppHandle) -> AppResult<()> {
    // 快捷键/托盘唤起：以当前光标为中心
    let cursor = cursor_position().unwrap_or((120, 120));
    open_at(app, cursor.0 as i32, cursor.1 as i32).await
}

/// 钩子路径：在**按下点**（物理像素）唤起。松手位置≈按下位置，但用按下点
/// 而不是再取一次光标——中间这一瞬手可能已经挪走，语义上"在按住的地方出盘"。
pub async fn open_at(app: &AppHandle, x: i32, y: i32) -> AppResult<()> {
    let spec = WindowSpec {
        label: RING_LABEL.into(),
        url: RING_ENTRY.into(),
        title: "星环".into(),
        size: (RING_SIZE, RING_SIZE),
        min_size: None,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        init_script: None,
    };
    let window = build_window(app, spec).await?;
    // 已存在的窗（秒开那条路）也要重新落回唤起点
    place_at(&window, x as i64, y as i64)?;
    Ok(())
}

/// 关 = 隐藏：星环没有状态要销毁，留着下次直接显示
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(RING_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "星环没有打开"))?
        .hide()
        .map_err(|e| AppError::new("WINDOW_HIDE", e.to_string()))
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
