// 托盘 — 新建便签、搜索、回收站、设置、开机启动、收起全部、恢复全部、退出。
// 托盘在数据层之后构建：菜单处理器要用 app.try_state::<Db>() 拿库。
//
// 菜单 id 就是热键表里的动作 id（`hide-all` / `show-all` 等，见 `hotkeys.rs`）：
// 一个动作用两个名字迟早分叉成"设置里那一行按了没反应"。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::data::private::PrivateVault;
use crate::db::pool::Db;
use crate::windows::{float, search, settings, trash, unlock};

/// 托盘那一格的人话名字。**UIA 那边就靠这个名字认我们**（`icon_rect`），
/// 所以它同时是显示文案和匹配串 —— 改这里要记得引导第十步那条跟着改
const TRAY_TOOLTIP: &str = "一闲笔记 mini";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let new_i = MenuItem::with_id(app, "new-sticky", "新建便签", true, None::<&str>)?;
    let search_i = MenuItem::with_id(app, "search", "搜索", true, None::<&str>)?;
    let trash_i = MenuItem::with_id(app, "trash", "回收站", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    // 开机启动：勾 = 注册表那条 Run 键在（判据在 `autostart.rs`，库里没这一份）。
    // 这一项用勾选菜单项而不是普通项 + 文字前缀：✅ 是系统画的，点了就地翻转，
    // 不用自己拼"勾/没勾"两套文案，也不会出现两套文案与真实状态各说各的。
    // 读不到状态按"没勾"建菜单——托盘是用户唯一的退出路，不能因一条状态读不出来就建不起来。
    let autostart_on = match crate::autostart::is_enabled(app) {
        Ok(enabled) => enabled,
        Err(e) => {
            crate::support::log::warn("tray", &format!("开机启动状态读不出，按没开建菜单：{e}"));
            false
        }
    };
    let autostart_i = CheckMenuItem::with_id(
        app,
        crate::autostart::MENU_ID,
        "开机启动",
        true,
        autostart_on,
        None::<&str>,
    )?;
    // 一键收起 / 恢复：两条都常驻可用（"没东西可恢复"就是一条 0 扇的日志，不灰掉——
    // 灰掉的那一条要跟着状态改，而状态在 Rust 这边，改菜单比让它一直可点更贵）
    let hide_i = MenuItem::with_id(app, "hide-all", "收起全部便签", true, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show-all", "恢复全部便签", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &new_i,
            &search_i,
            &trash_i,
            &settings_i,
            &autostart_i,
            &hide_i,
            &show_i,
            &sep,
            &quit_i,
        ],
    )?;
    // 设置窗改完开关要刷这一项的勾：菜单只在这里建一次，句柄不存下来就再也够不着它
    app.manage(crate::autostart::TrayToggle(autostart_i.clone()));

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("打包图标缺失").clone())
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new-sticky" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(db) = app.try_state::<Db>() else {
                        crate::support::log::warn("tray", "主库不可用，无法新建便签");
                        return;
                    };
                    let db = db.inner().clone();
                    if let Err(e) = float::create_sticky(&app, db).await {
                        crate::support::log::error("tray", &format!("新建便签失败：{e}"));
                    }
                });
            }
            "search" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = search::open(&app).await {
                        crate::support::log::warn("tray", &format!("打开搜索失败：{e}"));
                    }
                });
            }
            "trash" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = trash::open(&app).await {
                        crate::support::log::warn("tray", &format!("打开回收站失败：{e}"));
                    }
                });
            }
            "settings" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = settings::open(&app).await {
                        crate::support::log::warn("tray", &format!("打开设置失败：{e}"));
                    }
                });
            }
            crate::autostart::MENU_ID => {
                // 翻转它，并且按**注册表里真的变成什么**来画勾：设不进去（被安全软件拦）
                // 就维持原样，不许出现"勾上了但下次开机没启动"那种界面骗人的状态。
                //
                // 这条挪出回调，跟同文件里其它真要干活的条目一个办法（hide_all 是例外：
                // 它只下一次 ShowWindow）。菜单回调占着主线程的模态菜单循环，而 set_checked
                // 内部要往主线程排一次队（tauri 的 run_on_main_thread 没有"已在主线程就地跑"
                // 的短路）——这次排队在模态循环里到底什么时候被派发没实测过，不去赌它。
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::autostart::toggle(&app) {
                        crate::support::log::warn("tray", &format!("开机启动切换失败：{e}"));
                    }
                });
            }
            "lock" => {
                // 无论配没配过口令都开口令窗：没配过的人看到「设置私密密码」表单——
                // "锁了没反应"与"根本没锁"在界面上必须分得开。
                use tauri::Emitter;
                let vault = app.state::<PrivateVault>().inner().clone();
                crate::data::private::lock(&vault);
                let _ = app.emit("store:private-changed", "tray");
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = unlock::open(&app).await {
                        crate::support::log::warn("tray", &format!("开口令窗失败：{e}"));
                    }
                });
            }
            "hide-all" => {
                crate::windows::hide_all::hide_all(app);
            }
            "show-all" => {
                crate::windows::hide_all::show_all(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// 托盘里我们那一格的屏幕矩形（**物理**像素）。引导第十步据此把气泡贴到它头上。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 问一次"我们那格在哪儿"。**问不到不叫失败**：图标被收进溢出面板、这台机器的托盘
/// 不是 `Shell_TrayWnd` 那一套（ARM Win11、被第三方替换的 shell）、UIA 起不来，都问不到——
/// 调用方（气泡）退回"屏幕右下角"那一档摆法，正文也照那一档说。
///
/// 为什么只能走 UIA：托盘图标是 `Shell_NotifyIcon` 注册的，**没有句柄**，Win32 这一侧
/// 拿不到它的矩形；Win11 的托盘也不再是 `ToolbarWindow32`（`TB_GETITEMRECT` 那条老路彻底没了）。
/// UIA 那边它是一枚 `NotifyItemIcon` 按钮，`Name` 就是我们设的 tooltip，矩形现成
///（本机实测：32×48 一排，y 落在任务栏那条 1392..1440 上）。
pub fn icon_rect() -> Option<TrayRect> {
    // COM 要在**自己的线程**里起套间：借 Tauri 运行时的线程会把套间模式留在那条线上，
    // 而这个构建是 panic=abort —— 一次误用不是"这一步没摆好"，是整个应用没了
    std::thread::spawn(|| tray_rect_here(TRAY_TOOLTIP))
        .join()
        .unwrap_or(None)
}

fn tray_rect_here(needle: &str) -> Option<TrayRect> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::CUIAutomation;
    // SAFETY: 单线程内先 init 后 uninit，中间只读 UIA 的数据；COM 对象都在
    // `read_tray_rect` 返回时（也就是 uninit 之前）析构完
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() {
        crate::support::log::warn("tray", &format!("UIA 起不来（COM 初始化 {hr:?}），托盘位置问不到"));
        return None;
    }
    let out = read_tray_rect(needle, || {
        why("CoCreateInstance", unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        })
    });
    unsafe { CoUninitialize() };
    out
}

/// 每一问都留一行为什么没问到。退回"屏幕右下角那一档"本身可以接受，**静悄悄**退回不行：
/// 作者只会说"气泡没跟着托盘"，没有这一行就只能猜是 UIA 挂了、图标没建好、还是名字不匹配。
fn why<T>(stage: &str, r: windows::core::Result<T>) -> Option<T> {
    r.map_err(|e| crate::support::log::warn("tray", &format!("UIA {stage} 没成：{e}")))
        .ok()
}

/// 分得开是因为要测：`CoCreateInstance` 那一句在别的机器上不一定有（没 Explorer、
/// 提权环境），把"给我一个 IUIAutomation"抽成入参，剩下的走位就能喂一个拿不到的实例。
fn read_tray_rect<F>(needle: &str, make: F) -> Option<TrayRect>
where
    F: FnOnce() -> Option<windows::Win32::UI::Accessibility::IUIAutomation>,
{
    let auto = make()?;
    find_icon_rect(&auto, needle)
}

fn find_icon_rect(
    auto: &windows::Win32::UI::Accessibility::IUIAutomation,
    needle: &str,
) -> Option<TrayRect> {
    use windows::Win32::UI::Accessibility::TreeScope_Descendants;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    // 任务栏那一扇是现成的（`win_hook.rs` 认前台时也认它）。**类名在第一位**——
    // 写成 `FindWindowW(None, w!("Shell_TrayWnd"))` 是拿它当标题找，永远找不到
    let tray = why("FindWindowW", unsafe {
        FindWindowW(windows::core::w!("Shell_TrayWnd"), None)
    })?;
    if tray.is_invalid() {
        crate::support::log::warn("tray", "没有 Shell_TrayWnd 这扇（这台机器的托盘不是那一套）");
        return None;
    }
    let root = why("ElementFromHandle", unsafe {
        auto.ElementFromHandle(tray)
    })?;
    let cond = why("CreateTrueCondition", unsafe {
        auto.CreateTrueCondition()
    })?;
    // 整棵子树一次问完（本机 43 个元素；只在引导第十步问一次）
    let items = why("FindAll", unsafe { root.FindAll(TreeScope_Descendants, &cond) })?;
    let count = why("Length", unsafe { items.Length() })?;
    // 认**两种**命中：`AutomationId = "NotifyItemIcon"` 且名字带我们的 tooltip 才算托盘那一格；
    // 只名字对得上的先记着当备胎。为什么要分：任务栏上"程序按钮"那一格的名字也含我们的标题
    //（本机实测 `Qoder CN` 两条都有，程序按钮在 1325、托盘格在 1906），只比名字就会把气泡
    // 摆到任务栏中间去。备胎留着的理由是个别的 Windows 版本那格 automationId 不一定同名
    let mut name_only: Option<TrayRect> = None;
    for i in 0..count {
        let Ok(el) = (unsafe { items.GetElement(i) }) else {
            continue;
        };
        // 名字里带上我们的 tooltip 才算我们那格：UIA 那侧有的条目会多一个前导空格，
        // 所以是 contains 而不是相等
        let Ok(raw) = (unsafe { el.CurrentName() }) else {
            continue;
        };
        if !raw.to_string().contains(needle) {
            continue;
        }
        let is_tray_cell = unsafe { el.CurrentAutomationId() }
            .map(|id| id.to_string() == "NotifyItemIcon")
            .unwrap_or(false);
        let Some(rect) = rect_of(&el) else {
            continue;
        };
        if is_tray_cell {
            crate::support::log::info(
                "tray",
                &format!("托盘那一格：({},{}) {}x{} 物理", rect.x, rect.y, rect.width, rect.height),
            );
            return Some(rect);
        }
        name_only = Some(rect);
    }
    if let Some(rect) = name_only {
        crate::support::log::info(
            "tray",
            &format!("没认出 NotifyItemIcon，退用名字对上的那一格：({},{})", rect.x, rect.y),
        );
        return Some(rect);
    }
    crate::support::log::info("tray", "任务栏里没有我们那一格（图标可能还没建好或被收起来了）");
    None
}

/// 元素的外框 → 我们的矩形。空矩形（被折叠/收进溢出面板）当没找到：
/// 别把气泡摆到 (0,0) 那种鬼地方
fn rect_of(
    el: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<TrayRect> {
    let r = unsafe { el.CurrentBoundingRectangle() }.ok()?;
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    if w <= 0 || h <= 0 {
        crate::support::log::info("tray", "那一格的矩形是空的（可能被收进溢出面板了）");
        return None;
    }
    Some(TrayRect { x: r.left, y: r.top, width: w, height: h })
}

#[cfg(test)]
mod tests {
    /// 只喂一个假对象：拿不到 `IUIAutomation` 时那条退路必须走通（不能 panic、也不能瞎给个矩形）。
    /// 真的那一路要 Explorer + 我们自己在跑才有托盘图标，本机靠日志那一行核对，不在单测里赌环境。
    #[test]
    fn 起不来UIA就回None() {
        let out = super::read_tray_rect("一闲笔记 mini", || None);
        assert!(out.is_none());
    }

    /// 真走一遍 UIA。**`#[ignore]`**：要有活的 Explorer、且那枚图标在明面上（没被收进
    /// 溢出面板）才量得到，不该挂在每次 `cargo test` 上。
    ///
    /// 认的是**别人家**的一枚图标（`Qoder CN`），这样这条不用先把本应用跑起来 ——
    /// 而起 COM、找 `Shell_TrayWnd`、遍历子树、按名字取矩形这一整条路是真的走过了一次。
    /// 本机当时的参照：(1906,1392) 32×48（任务栏就占 1392..1440 那一条）。
    #[test]
    #[ignore = "要活托盘：Explorer 在跑且那枚图标没被收进溢出面板"]
    fn 真机UIA走一遍() {
        let got = super
            ::tray_rect_here("Qoder CN")
            .expect("问不到：那枚图标被收进溢出面板了？");
        eprintln!(
            "UIA 问到 Qoder CN 那一格：({},{}) {}x{}",
            got.x, got.y, got.width, got.height
        );
        assert!(got.width > 0 && got.height > 0, "矩形不该是空的");
        assert!(got.y > 0, "任务栏在屏幕下缘，y 应该是个正数");
    }
}
