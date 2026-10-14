// ring — 星环（radial menu，单例，label 固定 `ring`）。4 节点：新建便签/搜索/回收站/设置。
// 两条与别的窗不一样的口径：每次开在唤起点、不记几何（frames::is_tracked 不认它）；
// 关 = 隐藏——秒开，销毁再建一扇 WebView 的代价直接落在"按下快捷键到看见环"上。
// prewarm：启动即建一扇隐藏的窗；预热窗没建好时充电弧干脆不亮（show_charging）——
// 为一条反馈去冷启动 webview（约 1s）恰恰会制造这功能想消掉的那种闪。
// 充电/出盘都走钩子（input 模块）：Charging→show_charging（穿透、摆位、show，不抢焦点、
// 刻意不公告盘矩形），Open→reveal（取消穿透、抢焦点、公告矩形）；close 必须 ring_hidden() 清账。

use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::input;
use crate::support::error::{AppError, AppResult};
use crate::support::log;
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const RING_LABEL: &str = "ring";
const RING_ENTRY: &str = "ring.html";
/// 环的画布是正方形：360 _logical_。前端 features/ring/window.tsx 的 SIZE=300、
/// useUnit 分母 360 与这里是一对，改一边要同时改另外两边。
const RING_SIZE: f64 = 360.0;
/// 贴屏边时留的缝（**逻辑**像素）：物理那条按这块屏的缩放换算（`place_at`）
const EDGE_MARGIN_LOGICAL: f64 = 4.0;

fn spec() -> WindowSpec {
    WindowSpec {
        label: RING_LABEL.into(),
        url: RING_ENTRY.into(),
        title: "星环".into(),
        size: (RING_SIZE, RING_SIZE),
        // 每次都开在唤起处（`place_at`），出生位置无所谓——建出来就是隐藏的
        position: None,
        min_size: None,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        visible: false,
        // open 路径显式 show，不需要这条兜底（它本来就常驻隐藏）
        reveal_timeout_ms: None,
        show_on_reuse: false,
        init_script: None,
    }
}

/// 建（或复用）星环窗但不显示。prewarm 与 Charging 路径共用。
async fn build_hidden(app: &AppHandle) -> AppResult<tauri::WebviewWindow> {
    let window = build_window(app, spec()).await?;
    // 必须不可拉伸：无框但 resizable=true 时 tao 仍留着 WS_THICKFRAME——一圈看不见的
    // 伸缩边框。摆的是外框左上角，看得见的内容被推进去好几个像素（症状：盘没落在按下点）
    let _ = window.set_resizable(false);
    let _ = window.hide();
    Ok(window)
}

/// 启动预热：先建出来藏着，第一次长按才有即时的充电弧（不预热会撞约 1s 的 WebView 冷启动）
pub async fn prewarm(app: &AppHandle) -> AppResult<()> {
    build_hidden(app).await.map(|_| ())
}

/// 快捷键/托盘唤起：以当前光标为中心，显示整盘
pub async fn open(app: &AppHandle) -> AppResult<()> {
    let cursor = monitor::cursor().unwrap_or((120, 120));
    reveal(app, cursor.0 as i32, cursor.1 as i32).await
}

/// 钩子路径：在**按下点**（物理像素）显示——语义是"在按住的地方出盘"，不再取一次光标。
pub async fn open_at(app: &AppHandle, x: i32, y: i32) -> AppResult<()> {
    reveal(app, x, y).await
}

/// 充电进度弧：引导期走完时在按下点**把这扇窗亮起来**。同步、刻意不进 async——
/// 这条路要"定时器一响就露脸"，排一次 async 就是在用户松手之后才补上反馈。
/// 四步顺序（穿透→摆位→广播→show）刻意，改了会闪盘：穿透不还回去短按注入的右键会被自己吃掉；
/// 隐藏状态下摆位、事件先落，露出的第一帧才是正确位置上的弧而不是上一轮残留的盘。
/// 广播带**此刻真正生效**的阈值，弧按它扫满一圈。
/// 刻意不 set_focus（长按一下抢走用户打字的焦点比没反馈严重得多）、刻意不公告盘矩形（见文件头）。
pub fn show_charging(app: &AppHandle, x: i32, y: i32, hold_ms: u32) -> AppResult<()> {
    use tauri::Emitter;
    // 预热窗不在就**不亮**（宁可不给反馈，也不为一条反馈冷启动一扇 webview）
    let Some(window) = app.get_webview_window(RING_LABEL) else {
        return Ok(());
    };
    let _ = window.set_ignore_cursor_events(true);
    place_at(&window, x as i64, y as i64)?;
    let _ = app.emit("ring:charging", hold_ms);
    // 弧也是"星环露脸"：同样先叫开场窗收，理由见 `reveal`
    crate::splash::dismiss(crate::splash::Reason::Revealed);
    let _ = window.show();
    Ok(())
}

/// 出盘的唯一一条路：摆位 → 取消穿透 → show → 抢焦点 → 公告矩形 → 广播 `ring:open`。
/// 广播必须留在这里而不是让调用方各发一次：预热窗常驻隐藏、React 树不重挂载，前端全靠这条
/// 重放入场动画；钩子、Alt+Space、托盘、单实例都走这一条才不会漏。
async fn reveal(app: &AppHandle, x: i32, y: i32) -> AppResult<()> {
    use tauri::Emitter;
    let window = match app.get_webview_window(RING_LABEL) {
        Some(existing) => existing,
        None => build_hidden(app).await?,
    };
    let (left, top, size_phys) = place_at(&window, x as i64, y as i64)?;
    // 充电态设的穿透必须还回去（盘要接左键）；每次开都显式写一遍，不依赖"上次一定收干净过"
    let _ = window.set_ignore_cursor_events(false);
    // 先收开场窗再亮盘：两个都是 topmost，叠放次序由显示先后定，反了盘会被那块画压住
    crate::splash::dismiss(crate::splash::Reason::Revealed);
    let _ = window.show();
    let _ = window.set_focus();
    // 公告矩形给钩子判"盘外左键=收环"（读侧是原子量，回调不许查窗口）。
    // 问窗要**实际外框**不用 scale 反算：跨 DPI 时 scale_factor() 可能还停在上一块屏，
    // 钩子拿来比较的正是屏幕真相，两边同一份事实才不会把点格子误判成盘外。
    let announced = match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(size)) if size.width > 0 && size.height > 0 => {
            input::ring_shown(pos.x, pos.y, size.width as i32, size.height as i32);
            (pos.x, pos.y, size.width as i32, size.height as i32)
        }
        // 读不到退回算出来的那份：未公告 = 一律算盘内，谁都收不掉环
        _ => {
            input::ring_shown(left, top, size_phys, size_phys);
            (left, top, size_phys, size_phys)
        }
    };
    // 一行几何现场：发布版没控制台，"位置不准"只能靠这份日志还原（算得 vs 实际）
    log::info(
        "ring",
        &format!(
            "开盘：按下 ({x},{y})·屏 {} 块·算得 ({},{},{},{})·实际 ({},{},{},{})",
            monitor::count(),
            left,
            top,
            size_phys,
            size_phys,
            announced.0,
            announced.1,
            announced.2,
            announced.3
        ),
    );
    let _ = app.emit("ring:open", ());
    Ok(())
}

/// 关 = 隐藏：星环没有状态要销毁，留着下次直接显示。
/// 必须清盘驻留账：否则钩子会把之后每一次盘外左键都当"收环"。
pub async fn close(app: &AppHandle) -> AppResult<()> {
    app.get_webview_window(RING_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "星环没有打开"))?
        .hide()
        .map_err(|e| AppError::new("WINDOW_HIDE", e.to_string()))?;
    input::ring_hidden();
    Ok(())
}

/// 把环的中心摆到按下点（物理像素）**并落位**，返回左上角与边长（物理像素）。
/// 缩放取**按下点那块屏**的，不是窗自己的——星环每次都被搬走，窗上那份还是上一次落点的屏，
/// 拿它算边长就把盘心偏掉 `360×(新缩放-旧缩放)/2`（混 DPI 双屏上"位置不准"的形状）。
/// 夹取用那块屏的**整块**矩形（留边），不是工作区：贴屏幕底部夹工作区会把盘顶起一个任务栏高。
/// 屏表缓存没建立或点落在所有屏之外时以按下点为中心**不夹取**——绝不借别的屏兜底，那正是"星环跳回主屏"。
/// 返回的是请求值，最后一次回读校准（`correct_to_press_point`）后屏幕上真实的框以回读为准。
fn place_at(window: &tauri::WebviewWindow, x: i64, y: i64) -> AppResult<(i32, i32, i32)> {
    let screen = monitor::at_physical(x, y);
    let scale = match &screen {
        Some(found) => found.scale,
        None => window
            .scale_factor()
            .map_err(|e| AppError::new("WINDOW_SCALE", e.to_string()))?
            .max(0.01),
    };
    let side = (RING_SIZE * scale) as i64;
    let margin = (EDGE_MARGIN_LOGICAL * scale) as i64;
    let (left, top) = match screen {
        Some(found) => found.place_centered(x, y, side, margin),
        None => (x - side / 2, y - side / 2),
    };
    let _ = window.set_position(PhysicalPosition::new(left as i32, top as i32));
    correct_to_press_point(window, x, y, screen);
    Ok((left as i32, top as i32, side as i32))
}

/// 回读校准：请求的框 ≠ 屏幕上真实的框时再摆一次，把**看得见的内容中心**压回按下点
/// （差额来源：那圈看不见的伸缩边框、DPI 迁移途中、系统给透明窗加的边——都是"盘偏几个像素"）。
/// 贴屏边那一下的偏移是**故意**让开的，补完会越界就不补；已对准（±1px）不动窗，不多添一次重绘。
fn correct_to_press_point(
    window: &tauri::WebviewWindow,
    x: i64,
    y: i64,
    screen: Option<monitor::Screen>,
) {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return; // 读不到就当第一次摆的是对的：手上没有比请求更可信的事实
    };
    let (width, height) = (size.width as i64, size.height as i64);
    let (dx, dy) = (
        x - (pos.x as i64 + width / 2),
        y - (pos.y as i64 + height / 2),
    );
    if dx.abs() <= 1 && dy.abs() <= 1 {
        return;
    }
    let (left, top) = (pos.x as i64 + dx, pos.y as i64 + dy);
    let stays_inside = match screen {
        Some(found) => {
            let margin = (EDGE_MARGIN_LOGICAL * found.scale) as i64;
            left >= found.left + margin
                && left + width <= found.left + found.width - margin
                && top >= found.top + margin
                && top + height <= found.top + found.height - margin
        }
        None => true,
    };
    if stays_inside {
        let _ = window.set_position(PhysicalPosition::new(left as i32, top as i32));
    }
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
