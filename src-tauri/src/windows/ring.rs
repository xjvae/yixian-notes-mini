// ring — 星环（radial menu，单例）。4 节点：新建便签/搜索/回收站/设置。
//
// 两条与别的窗不一样的口径：
//  · **每次开在唤起点**，不记几何（frames::is_tracked 不认它）——星环的意义就是
//    "手在哪就在哪展开"，记住上次的摆位等于把它变成一个普通面板窗。
//  · **关 = 隐藏**（与搜索/回收站同口径）：星环要秒开，销毁再建一扇 WebView
//    的代价直接落在"按下快捷键到看见环"这段时间上。
//
// 生命周期与钩子（input 模块）的配合（三条都是旧项目真机定稿）：
//  · 引导期走完 → 钩子发 Charging（带按下点）→ `show_charging`：设鼠标穿透 →
//    广播 `ring:charging` → 摆位 → show，**不抢焦点**。窗在这里才第一次露脸；
//  · 松手到阈值 → 钩子发 Open（按下点快照）→ `reveal`：摆位 → 取消穿透 →
//    show → 公告盘矩形 → 广播 `ring:open`，前端把弧下台、盘重放入场；
//  · 公告矩形（`input::ring_shown`）是"盘外左键=收环"的判据。充电态**刻意不公告**：
//    弧不是盘，公告了就会把手正按在那 360×360 里的这段时间判成一堆盘外点击；
//  · close 路径（隐藏）必须 `input::ring_hidden()` 清账。
//
// prewarm：启动即建一扇隐藏的星环窗。不预热的话，第一次长按的充电弧会撞上
// WebView 冷启动（约 1s），弧没画完盘就出来了。url 与 vite 入口 ring.html 对应。
// 反过来说：**预热窗没建好时充电弧干脆不亮**（见 show_charging）——为一条进度
// 反馈去冷启动一扇 webview，恰恰会制造这功能想消掉的那种闪。

use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::input;
use crate::support::error::{AppError, AppResult};
use crate::support::log;
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const RING_LABEL: &str = "ring";
const RING_ENTRY: &str = "ring.html";
/// 环的画布是正方形：360 _logical_，SVG viewBox 300、unit 缩放。
/// 前端 features/ring/window.tsx 的 SIZE=300 与 useUnit 分母 360 与这里是一对，
/// 改一边要同时改另外两边。
const RING_SIZE: f64 = 360.0;
/// 贴屏边时留的缝（**逻辑**像素）：物理那条按这块屏的缩放换算（`place_at`）
const EDGE_MARGIN_LOGICAL: f64 = 4.0;

fn spec() -> WindowSpec {
    WindowSpec {
        label: RING_LABEL.into(),
        url: RING_ENTRY.into(),
        title: "星环".into(),
        size: (RING_SIZE, RING_SIZE),
        // 星环每次都开在唤起处（`place_at`），出生位置无所谓——它建出来就是隐藏的
        position: None,
        min_size: None,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        visible: false,
        // 星环由 open 路径显式 show，不需要这条兜底（它本来就常驻隐藏）
        reveal_timeout_ms: None,
        show_on_reuse: false,
        init_script: None,
    }
}

/// 建（或复用）星环窗但不显示。prewarm 与 Charging 路径共用。
async fn build_hidden(app: &AppHandle) -> AppResult<tauri::WebviewWindow> {
    let window = build_window(app, spec()).await?;
    // 系统阴影那件已经在建窗处统一做了（factory.rs：透明窗一律关），这里只剩星环自己那条：
    // 也必须是"不可拉伸"的：无框但 `resizable=true` 时 tao 仍留着 WS_THICKFRAME，
    // 那是**一圈看不见的伸缩边框**——我们摆的是外框左上角（中心=按下点），
    // 看得见的内容却被推进去好几个像素（缩放越高越多），症状正是
    // "盘没落在右键那一下的点上"。星环的尺寸由 360 逻辑定死，本来也不给用户拉。
    let _ = window.set_resizable(false);
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
    reveal(app, cursor.0 as i32, cursor.1 as i32).await
}

/// 钩子路径：在**按下点**（物理像素）显示。松手位置≈按下位置，但用按下点
/// 而不是再取一次光标——语义上"在按住的地方出盘"。
pub async fn open_at(app: &AppHandle, x: i32, y: i32) -> AppResult<()> {
    reveal(app, x, y).await
}

/// 充电进度弧：引导期走完时在按下点**把这扇窗亮起来**。
///
/// 同步函数，刻意不进 async——这条路对时间的要求是"定时器一响就露脸"，
/// 排一次 async 执行就是在用户已经松手之后才补上那条反馈。
///
/// 四步的顺序是刻意的，改了就会闪盘：
///  1. 设鼠标穿透——充电态这 360×360 若不吃透，短按注入的那一下右键会被自己的
///     窗吃掉，右键就废了；
///  2. 摆位（隐藏状态下摆，露出来的第一帧就在正确位置）；
///  3. 广播 `ring:charging`（带着**此刻真正生效**的阈值，弧要按它扫满一圈）；
///  4. 最后才 show——事件先落，前端已经切到"只画锚点与弧"那棵树，
///     露出来的第一帧就不会是上一轮残留的盘。
///
/// 刻意**不** `set_focus`：这条路径每次长按都会走一遍，右键一下就把用户正在打字的
/// 应用的焦点抢走，是比"没有反馈"严重得多的问题。出盘那条路（`reveal`）照旧要焦点。
/// 刻意**不**公告盘矩形：理由见文件头。
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
///
/// 广播必须留在这里而不是让调用方各发一次：前端靠这条重放入场动画
/// （预热窗常驻隐藏，React 树不重挂载，不重放就是"啪一下直接出现"）。
/// 钩子路径、Alt+Space、托盘、单实例唤起都走这一条，才不会漏。
async fn reveal(app: &AppHandle, x: i32, y: i32) -> AppResult<()> {
    use tauri::Emitter;
    let window = match app.get_webview_window(RING_LABEL) {
        Some(existing) => existing,
        None => build_hidden(app).await?,
    };
    let (left, top, size_phys) = place_at(&window, x as i64, y as i64)?;
    // 充电态把窗设成了鼠标穿透，绽开成盘就必须还回去：盘是要接左键的。
    // 每次开都在这里显式写一遍，不依赖"上一次一定收干净过"。
    let _ = window.set_ignore_cursor_events(false);
    // 先叫开场窗收，再亮盘：两个都是 topmost，叠放次序由显示先后定——反过来的话
    // 开机头一次长按出来的盘可能被那块还没收的画压住
    crate::splash::dismiss(crate::splash::Reason::Revealed);
    let _ = window.show();
    let _ = window.set_focus();
    // 公告矩形给钩子判"盘外左键=收环"（读侧是原子量，回调不许查窗口）。
    // 问窗自己要**实际外框**，不用 scale 反算：跨 DPI 那一下 `scale_factor()`
    // 可能还停在上一块屏，而 outer_position/outer_size 给的就是真相——
    // 钩子那边拿来比较的也正是屏幕真相，两边同一份事实才不会点格子被误判成盘外。
    let announced = match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(size)) if size.width > 0 && size.height > 0 => {
            input::ring_shown(pos.x, pos.y, size.width as i32, size.height as i32);
            (pos.x, pos.y, size.width as i32, size.height as i32)
        }
        // 读不到就退回算出来的那份：有近似矩形，好过"未公告 = 一律算盘内"
        // 那样谁都收不掉环（那条兜底方向是刻意的，但只该在真没矩形时用）
        _ => {
            input::ring_shown(left, top, size_phys, size_phys);
            (left, top, size_phys, size_phys)
        }
    };
    // 一行几何现场（发布版没控制台，能还原"位置不准"的只有这份文件）：
    // 按下点、命中的屏有几块、要摆的框、窗实际落在的框。两套数不一致就是 DPI/搬窗时序
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
///
/// 缩放取的是**按下点那块屏**的，不是窗自己的：星环每次都被搬走，窗上那份
/// `scale_factor()` 是**上一次落点那块屏**的（系统的 DPI 变化要过消息循环才送到），
/// 拿它算边长就等于把盘心摆在偏 `360×(新缩放-旧缩放)/2` 的地方——混 DPI 双屏上
/// 这就是"位置不准"的形状（100%↔150% 之间偏 90px）。
///
/// 夹取用的是那块屏的**整块**矩形（留 4 逻辑像素边），不是工作区：贴着屏幕底部
/// 长按时，夹工作区会把盘往上顶起一整个任务栏的高度，而盘心还自称在光标上。
/// 工作区那份留给贴边细丝（任务栏底下不留东西是对的，盘不是）。
///
/// 屏表是采样线程刷好的缓存（`windows::monitor`）；缓存还没建立（启动头一两秒）
/// 或点落在所有屏之外时**以按下点为中心不夹取**——绝不借别的屏兜底，
/// 那正是"星环自己跳回主屏"。
///
/// 最后还有一次**回读校准**（`correct_to_press_point`），所以"返回的左上角"是请求值，
/// 屏幕上真实的框以回读为准。
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

/// 回读校准：我请求的框 ≠ 屏幕上真实的框时，再摆一次，把**看得见的内容中心**压回
/// 按下点。用户判断"准不准"看的是后者，而差额来源不止一处：无框但可拉伸时那圈
/// 看不见的伸缩边框、DPI 迁移途中、系统给透明窗加的边——每一种都是"盘偏几个像素"。
/// 贴屏边那一下的偏移是**故意**让开的（半个盘出界 = 两个节点点不到），
/// 补完会越界就不补。已经对准（±1px）就直接不动窗：不给每次开盘多添一次重绘。
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
