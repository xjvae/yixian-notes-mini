// 提醒卡窗 — 到点那条提醒**自己画的一张卡**，蹲在主屏工作区右下角，12 秒自己走。
// 为什么不等系统通知：那条链不在我们手里——直跑的 exe 没有 AppUserModelID（插件按目录末尾判），
// notify-rust 退回兜底常量、toast 以"Windows PowerShell"的名义走，而 Windows 认 AUMID 靠开始菜单
// 快捷方式，没装就没有。所以卡永远画，系统通知只在装出来的包才发（`reminders.rs::looks_installed`）。
// 透明、置顶、不进任务栏、**不抢焦点**；一叠只留一张卡：label 固定，第二条来了广播 `reminder:show`
// 换内容，不 destroy+重建（那要撞 `factory` 的 CreatingRegistry 占位）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::support::error::AppResult;
use crate::support::log;
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const CARD_LABEL: &str = "reminder-card";
/// 换内容的事件名（前端 contracts.ts 有同名常量镜像）
pub const CARD_EVENT: &str = "reminder:show";

/// 卡的尺寸与离工作区右下角的间距（逻辑像素）。宽度跟着便签走；高度放标题 + 一句说明 +
/// 底下那一排（「稍后再响」与「去看这张便签」并排），再高就露出空一片（看着像"半张没写完的便签"）。
const CARD_SIZE: (f64, f64) = (320.0, 104.0);
const MARGIN: f64 = 16.0;
/// 自己不招人地待多久：够读完两行字，又不至于赖在屏幕上
const DISMISS_MS: u64 = 12_000;
/// 画完第一帧的余量 + 到点没来喊的兜底（同便签窗那条纪律）
const REVEAL_TIMEOUT_MS: u64 = 2000;

/// 第几张卡。每条提醒涨一格，只有**还是当前那一格**的定时器才有权收窗——
/// 中途又来一条时，旧定时器不许把新那张收掉。
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// 卡上要写的东西。`title`/`text` 由调用方按私密口径先洗过一遍（私密的换成中性文案），
/// 这一层不再判私密：判两处就会判出两个结果。全 owned `String`：建窗是 async 而调用点是
/// 提醒那条常驻线程，负载得能跟着任务搬过去。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub title: String,
    pub text: String,
    pub sticky_id: String,
    pub group_id: Option<String>,
    /// 那张便签自己的纸色键（`themes` 里那个）。卡跟着它画：提醒该像是从那叠纸上撕下来
    /// 的一张，不是一个系统对话框——而颜色只有前端那张表知道，所以传键不传十六进制。
    pub theme: String,
}

/// 弹出一张卡（或把已经在那儿的那张换成这条）。不阻塞调用线程：建窗交给运行时，
/// 这条循环下一轮该扫还是扫它的（提醒线程睡 30 秒那一觉不该被建窗的往返占掉）。
pub fn show(app: &AppHandle, card: Card) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    match app.get_webview_window(CARD_LABEL) {
        Some(_) => {
            let _ = app.emit(CARD_EVENT, &card);
            log::info(
                "reminder",
                &format!("{}：换成新卡片（已有一张在屏上）", card.sticky_id),
            );
        }
        None => {
            log::info(
                "reminder",
                &format!("{}：卡上屏（右下角一扇，12 秒后自己走）", card.sticky_id),
            );
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = build(&app, &card, generation).await {
                    log::warn(
                        "reminder",
                        &format!("{}：卡窗建不出来：{e}", card.sticky_id),
                    );
                }
            });
        }
    }
    schedule_dismiss(app.clone(), generation);
}

/// 立刻收掉（点卡、点×、以及 `reminder_open` 那条路）。
/// 涨一格是为了让还在睡的定时器别再去动窗——那扇窗这会儿可能已经是**下一条**的了。
pub fn dismiss(app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(CARD_LABEL)
        && let Err(e) = window.destroy()
    {
        log::warn("reminder", &format!("卡窗销毁失败：{e}"));
    }
}

async fn build(app: &AppHandle, card: &Card, generation: u64) -> AppResult<()> {
    // 注入 JS 对象字面量而不是 JSON（字符串由 Debug 转义，JS 认这套）。`Option` 得自己写成
    // `null`——直接用 `{:?}` 会漏出 `Some("g1")` 那种 JS 看不懂的东西。
    let group = match &card.group_id {
        Some(gid) => format!("{gid:?}"),
        None => "null".to_string(),
    };
    let spec = WindowSpec {
        label: CARD_LABEL.into(),
        // 与便签同一个入口：卡不需要新的 html，main.tsx 认出 __REMINDER__ 就画卡
        url: "index.html".into(),
        title: "提醒".into(),
        size: CARD_SIZE,
        position: placement(),
        min_size: None,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focused: false,
        visible: false,
        reveal_timeout_ms: Some(REVEAL_TIMEOUT_MS),
        // 复用路径走不到（有窗就换内容），留着与别窗同一形状
        show_on_reuse: false,
        init_script: Some(format!(
            "window.__REMINDER__ = {{ title: {:?}, text: {:?}, stickyId: {:?}, groupId: {group}, theme: {:?} }};",
            card.title, card.text, card.sticky_id, card.theme
        )),
    };
    build_window(app, spec).await?;
    // 建窗往返期间又来了一条（或用户已把卡点掉）：只有那一格能动窗，我这张出生就过时了
    if GENERATION.load(Ordering::SeqCst) != generation
        && let Some(window) = app.get_webview_window(CARD_LABEL)
    {
        let _ = window.destroy();
    }
    Ok(())
}

/// 主屏工作区右下角（任务栏那一条不算地方）。取 (0,0) 那块屏＝主屏（`monitor::refresh`
/// 按 Win32 惯例把原点排最前）。量不到返回 None 交系统摆位，**不许**瞎猜坐标——猜歪了就是
/// "卡跑到看不见的屏上"。
fn placement() -> Option<(f64, f64)> {
    let work = monitor::at((0, 0))?;
    let scale = monitor::at_physical(0, 0)?.scale;
    let (w, h) = (CARD_SIZE.0 * scale, CARD_SIZE.1 * scale);
    let edge = (
        work.x + work.width - w as i64 - (MARGIN * scale) as i64,
        work.y + work.height - h as i64 - (MARGIN * scale) as i64,
    );
    let (x, y) = work.clamp_block(edge, w as i64, h as i64);
    Some((x as f64 / scale, y as f64 / scale))
}

fn schedule_dismiss(app: AppHandle, generation: u64) {
    // 自己的线程而不是 async_runtime：这条睡 12 秒，别占 worker（与 `reminders::spawn` 同一条理由）
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(DISMISS_MS));
        if GENERATION.load(Ordering::SeqCst) != generation {
            return; // 已经有更新的一张，收窗归它自己的定时器
        }
        if let Some(window) = app.get_webview_window(CARD_LABEL) {
            let _ = window.destroy();
        }
    });
}
