// guide — 引导气泡（单例，常置顶，一次性）。十二步分步教程，前端在 `features/guide/`。
//
// 形状是一扇 320×168 的**无边框透明小窗**，与提醒卡同一类东西（`windows/card.rs`）：
// `factory` 对所有窗都下了 `decorations(false)`，透明窗再统一关掉系统阴影——透明窗把
// 窗矩形以外全裁掉，外阴影等于没画，所以卡片四周留了内边距、边靠描边。
//
// 三条口径：
//  · **不遮罩**：Tauri 的点击穿透是整窗开关（`set_ignore_cursor_events` 没有区域粒度），
//    盖一层暗就点不动底下那张真便签——引导期间要能跟着做，所以宁可不遮。
//  · **隐藏建 + 等前端喊 reveal**：这一扇是透明窗，出生就可见会先亮一块 WebView2 默认白；
//    2000ms 到点无条件 show，"看不见比闪一下白严重"那条纪律在这儿一样成立。
//  · **出生位置在这里定**（工作区正中）：第一步就讲"按住右键出盘"，盘出现在屏幕中间，
//    气泡落在那儿最贴。摆位交给前端就是"先闪在系统给的位置再跳走"——那条老症状。
//    之后每搬一次都是他点了「下一步」，跳是预期内的。
//
// 关 = 销毁（下次开都从第一步起）。销账 `guide.seen` 在 `commands/window.rs` 那条命令里做。

use tauri::{AppHandle, Manager};

use crate::support::error::{AppError, AppResult};
use crate::support::log;
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const GUIDE_LABEL: &str = "guide";
/// 看过引导没有。缺键（或值不是 "1"）= 没看过 → 下次启动自动再演一次
pub const GUIDE_SEEN_KEY: &str = "guide.seen";
/// 引导自己建的那张**虚拟演示便签**的 id。讲到便签的那六步（换类 / 长高 / 贴边 / 并叠 /
/// 提醒 / 私密）在桌面上一张都没有时靠它指着，走完（或跳过）由 `close_guide_window` 销毁。
/// 记在库里而不是只在窗里：应用被直接关掉时那条 close 没跑到，下次开引导照这个 id 先清。
pub const GUIDE_DEMO_NOTE_KEY: &str = "guide.demo_note";
const GUIDE_ENTRY: &str = "guide.html";
/// 与前端 `features/guide/window.tsx` 的 BUBBLE 同值（**逻辑**像素），改一边要改另一边。
/// 这是**出生高，也是下限**：三行文案在 168 里装不下，前端量完实测高会调 `setWindowFrame`
/// 把这扇窗往下长——透明窗把窗矩形以外全裁走，不涨就会被裁掉最后一行和「知道了」那颗钮。
const BUBBLE_SIZE: (f64, f64) = (320.0, 168.0);
/// 等 reveal 的兜底时长，与便签窗、提醒卡同值
const REVEAL_TIMEOUT_MS: u64 = 2000;

/// 出生摆在工作区正中（物理算完再换回逻辑，与 `card.rs::placement` 同一条路）。
/// 屏表缓存还没刷出来（启动头一两秒）就给 None，交回系统摆——比拿一块别的屏兜底好。
fn placement() -> Option<(f64, f64)> {
    let work = monitor::at((0, 0))?;
    let scale = monitor::at_physical(0, 0)?.scale;
    let (w, h) = (BUBBLE_SIZE.0 * scale, BUBBLE_SIZE.1 * scale);
    let (x, y) = work.clamp_block(
        (
            work.x + (work.width - w as i64) / 2,
            work.y + (work.height - h as i64) / 2,
        ),
        w as i64,
        h as i64,
    );
    Some((x as f64 / scale, y as f64 / scale))
}

pub async fn open(app: &AppHandle) -> AppResult<()> {
    let spec = WindowSpec {
        label: GUIDE_LABEL.into(),
        url: GUIDE_ENTRY.into(),
        title: "引导".into(),
        size: BUBBLE_SIZE,
        position: placement(),
        // 尺寸由这一步的文案定死，不给拉：拉大了就是卡片周围一圈看不见的空白
        min_size: None,
        transparent: true,
        // 置顶：它讲的正是桌面上那些浮窗，被压住的气泡没法指东西
        always_on_top: true,
        skip_taskbar: true,
        // 拿焦点：气泡上的三颗钮与 ←/→/Esc 都要能用键盘走
        focused: true,
        visible: false,
        reveal_timeout_ms: Some(REVEAL_TIMEOUT_MS),
        // 第二次点「重看引导」走复用：直接 show + 拿焦点（位置由前端按第一步重摆）
        show_on_reuse: true,
        init_script: None,
    };
    let window = build_window(app, spec).await?;
    // **必须不可拉伸**：无框但 `resizable=true` 时 tao 仍留着 WS_THICKFRAME，那是一圈
    // 看不见的伸缩边框——我们摆的是外框左上角，看得见的那张卡片却被推进去好几个像素，
    // 缩放越高越多。症状就是"气泡位置不对"。星环那条老账（`ring.rs::build_hidden`），
    // 气泡的尺寸由 BUBBLE_SIZE 定死，本来也不给用户拉。
    let _ = window.set_resizable(false);
    if let (Ok(scale), Some(area)) = (window.scale_factor(), monitor::at((0, 0))) {
        // 摆位结果要落日志：真机上"位置不对"这件事，没有这份数就只能猜是缩放、工作区
        // 还是那圈边框（`set_resizable` 的成败同理——之前都是 `let _ =` 吞掉的）
        log::info(
            "guide",
            &format!(
                "气泡出生：缩放 {scale:.2}·工作区 ({},{},{},{})·窗内区 {:?}",
                area.x, area.y, area.width, area.height, window.inner_size().ok().map(|s| (s.width, s.height)),
            ),
        );
    }
    Ok(())
}

/// 关掉这扇窗。销账由调用方（那条命令）负责，这里只管窗。
pub async fn close(app: &AppHandle) -> AppResult<()> {
    // 闸门无论如何要放下：气泡停在讲环那两步被关掉时，前端那条 release 不一定赶得上，
    // 而闸门一直立着 = 真环从此点盘外收不掉——那是比"引导没关干净"严重得多的副作用
    crate::input::set_guide_holds_ring(false);
    app.get_webview_window(GUIDE_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "引导窗没有打开"))?
        .destroy()
        .map_err(|e| AppError::new("WINDOW_CLOSE", e.to_string()))
}

/// 星环那一边的留缝（逻辑像素），与前端 `window.tsx` 的 GAP 同值
const RING_GAP_LOGICAL: f64 = 14.0;
/// 星环的见方（逻辑像素），与 `ring.rs` 的 RING_SIZE 同值
const RING_SIDE_LOGICAL: f64 = 360.0;

/// 讲星环那几步（第二、三步）：报回**屏幕上那只环的真实中心**（逻辑像素），气泡据此摆过去。
///
/// 为什么不自己开环：作者报的两条都出在这儿。① "第二步闪星环盘"——气泡在盘外，
/// 点它推进 = 盘外左键 = 钩子按平时的规矩把环收了；② "第三步不在星环上"——那一步讲的是
/// 环上那一格，环是我们叫出来的还是他真按出来的，位置根本两回事。
/// 所以顺序反过来了：**第一步等他真按住右键**（前端听 `ring:open` 自动推进），
/// 到第二、三步时环就是他刚开出来的那一只，我们只读它的矩形。
///
/// 读不到环（他从第三步用「上一步」倒着走、或环已经被收掉）才兜底自己开一只。
/// 期间把 `GUIDE_HOLDS_RING` 立起来：盘外左键不收环，盘内那一下照常收。
pub async fn show_ring(app: &AppHandle) -> AppResult<RingSpot> {
    crate::input::set_guide_holds_ring(true);
    if let Some(spot) = ring_spot(app) {
        log::info(
            "guide",
            &format!("星环那一步：用他真开出来的环，中心 ({:.0},{:.0}) 逻辑", spot.cx, spot.cy),
        );
        return Ok(spot);
    }
    // 兜底：屏幕上没有环，就按"环 + 缝 + 气泡"成对居中的位置开一只
    let area = monitor::at((0, 0))
        .ok_or_else(|| AppError::new("GUIDE_NO_MONITOR", "拿不到工作区，星环这一步摆不出位置"))?;
    let scale = monitor::at_physical(0, 0)
        .map(|screen| screen.scale.max(0.01))
        .unwrap_or(1.0);
    let ring_phys = RING_SIDE_LOGICAL * scale;
    let pair_phys = ring_phys + (RING_GAP_LOGICAL + BUBBLE_SIZE.0) * scale;
    let left = area.x + ((area.width - pair_phys as i64) / 2).max(0);
    let cx = left + (ring_phys / 2.0) as i64;
    let cy = area.y + (area.height - ring_phys as i64) / 2;
    crate::windows::ring::open_at(app, cx as i32, cy as i32).await?;
    if let Some(window) = app.get_webview_window(GUIDE_LABEL) {
        // `ring::reveal` 会 set_focus（那是给"用户主动唤环"定的：环要吃键盘）。
        // 引导里主角是气泡，焦点不夺回来，气泡上的键盘就走不通
        let _ = window.set_focus();
    }
    log::info(
        "guide",
        &format!("星环那一步：屏上没有环，兜底开一只，中心 ({cx},{cy}) 物理·缩放 {scale:.2}"),
    );
    Ok(RingSpot {
        cx: cx as f64 / scale,
        cy: cy as f64 / scale,
        half: RING_SIDE_LOGICAL / 2.0,
    })
}

/// 离开讲环的那几步：闸门放下，环还开着就收掉——它是被引导叫出来的，不该留在桌上。
pub async fn release_ring(app: &AppHandle) {
    crate::input::set_guide_holds_ring(false);
    if ring_spot(app).is_some() {
        if let Err(e) = crate::windows::ring::close(app).await {
            log::warn("guide", &format!("收环没成：{e}"));
        }
    }
}

/// 屏幕上那只环的真实中心与半径（逻辑像素）。窗不在、或藏着（关=隐藏那条）都算没有。
fn ring_spot(app: &AppHandle) -> Option<RingSpot> {
    let window = app.get_webview_window(crate::windows::ring::RING_LABEL)?;
    if !window.is_visible().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?.max(0.01);
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(RingSpot {
        cx: (pos.x as f64 + size.width as f64 / 2.0) / scale,
        cy: (pos.y as f64 + size.height as f64 / 2.0) / scale,
        half: (size.width as f64 / 2.0) / scale,
    })
}

/// 环的中心与半径（逻辑像素）。前端拿它算气泡落点，不再自己猜。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RingSpot {
    pub cx: f64,
    pub cy: f64,
    pub half: f64,
}
