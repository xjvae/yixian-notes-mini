// 提醒调度 — 常驻循环：扫到点的提醒 → 发系统通知 + 把那张便签拉到屏上（**不抢焦点**）。
//
// 作者拍的口径：只弹一次（改到期时间会自动重新生效）、过期超过 24 小时不补、
// 通知之外还要把窗拉到屏上但不抢焦点（星环那条老理由：右键一下就把用户正在打字的
// 应用的焦点抢走，比没有反馈严重得多）。
//
// 三条实现上的讲究：
//  1. **循环而不是 setTimeout**：前端那份在隐藏窗里会被 WebView2 节流甚至暂停，
//     "到点不响"就是这么来的（判据与发生点算法在 `db::query::reminder`）；
//  2. **通知发完才写 reminded_at**：先写后发，一旦发的那步崩了，这条提醒就永远哑了，
//     而用户完全看不出为什么；
//  3. **私密便签不带上标题**：toast 会出现在锁屏与通知中心，把私密标题写进去等于
//     绕过整个私密集合。所以私密的那条只说"有一条提醒到点了"。

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::pool::Db;
use crate::db::query::{reminder, sticky::now_ms};
use crate::support::log;
use crate::windows::{card, float, hide_all};

/// 扫描间隔。30s 是拍的：提醒本身的粒度是分钟，30 秒内补上就看不出迟到，
/// 而再密就是让常驻循环空转（每轮都要过一次 SQLite）。
const SCAN_EVERY: Duration = Duration::from_secs(30);

/// 起循环。**必须在 `app.manage(database)` 之后调用**，否则这里拿不到 `Db`。
///
/// 走一条**自己的线程**而不是 `tauri::async_runtime::spawn`：这条循环每轮要睡 30 秒，
/// 放在异步运行时里等于把一个 worker 整段堵死（本工程别的路径——开窗、清算、
/// 钩子事件——都在同一个运行时上跑，为一条定时器占掉一格不值）。
/// `AppHandle` 是 Send + Sync，窗操作与通知本来就是往事件循环投递消息，线程无关。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SCAN_EVERY);
        let Some(db) = app.try_state::<Db>() else {
            // 主库打不开时应用照常起（走的是明确错误界面），这时没账可扫
            continue;
        };
        match reminder::pending(&db, now_ms()) {
            Ok(due) => {
                for item in due {
                    fire(&app, &db, &item);
                }
            }
            Err(e) => log::warn("reminder", &format!("扫描到期提醒失败，下一轮再试：{e}")),
        }
    });
}

/// 一条到期提醒的全部动作。任何一步都不许带崩循环：通知发不出去、窗找不到、
/// 标记写失败，都只记一条日志，下一轮还会试（没标 reminded_at 就还没弹过）。
fn fire(app: &AppHandle, db: &Db, item: &reminder::Due) {
    // 标题：私密的换成中性文案，不让它出现在锁屏上
    let title = if item.private {
        "一闲笔记 · 私密提醒".to_string()
    } else if item.title.trim().is_empty() {
        "未命名便签".to_string()
    } else {
        item.title.clone()
    };
    let body = if item.private {
        "有一条提醒到点了（内容要解锁才看得到）".to_string()
    } else {
        "这条提醒到点了 · 勾掉或改时间就不再提醒".to_string()
    };

    // 系统通知只在**装出来的包**才发。判据抄插件自己那一条（desktop.rs 里
    // exe 目录以 `target\debug|release` 结尾就不写 AppUserModelID）：
    // 那种情况下 notify-rust 退回它自己的兜底常量 `POWERSHELL_APP_ID`，toast 会以
    // "Windows PowerShell" 的名义出现——比不弹更让人莫名其妙。而 Windows 认 AUMID
    // 靠的是开始菜单里那条快捷方式，没装过就没有（这台机器三处都查不到安装痕迹）。
    // 卡的可见性不依赖这件事：下面那张卡两种跑法都画。
    if looks_installed() {
        match app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
        {
            // 注意：这条 Ok 只说明"交给系统了"。插件里 `show()` 的结果是被丢掉的，
            // 所以它**不能**当"用户看到了"的证据——真机上到底有没有出 toast，
            // 只能看屏幕。这也是为什么再画一张自己的卡不是可选项。
            Ok(()) => log::info("reminder", &format!("{}：已发系统通知（不保证可见）", item.id)),
            Err(e) => log::warn("reminder", &format!("{}：系统通知发不出去：{e}", item.id)),
        }
    } else {
        log::info(
            "reminder",
            &format!("{}：直跑的那版不发系统通知（没有 AppUserModelID，会以 PowerShell 名义出），只画卡", item.id),
        );
    }

    // 自己画的卡：屏幕右下角，12 秒自己走，点一下就跳到那张便签。
    // 这一步是整个功能"看得见"的唯一保证，所以它不许被上面那条路的成败影响。
    card::show(
        app,
        card::Card {
            title,
            text: body,
            sticky_id: item.id.clone(),
            group_id: item.group_id.clone(),
            theme: item.theme.clone(),
        },
    );

    // 拉到屏上：只动**窗已经在的**那一张（floating 的便签），且**不 set_focus**。
    // 一张被关掉的便签为了响铃凭空开出来，比不弹更让人意外——那条留给通知本身。
    //
    // 组员的那一扇不是 `sticky-<id>` 而是 `stickygrp-<gid>`（一叠一窗）：按单窗 label 找
    // 必然找不到，于是每条组里的提醒都会被记成"窗还没开"。找到叠窗还不够，还得把它
    // **翻到这一张**——不然拉出来的是一叠里的别的张，用户看到的还是"提醒没弹"。
    // 翻法与点搜索结果同一条路（REVEAL_EVENT，前端按 groupId 认领）。
    //
    // **托盘刚按过"收起全部便签"时这一步整段跳过**：那张卡照画，点卡仍然会开那一扇。
    // 不然这条"一键隐藏"就成了"只安静三十秒"——到点自己又把窗摆回桌面。
    if item.floating && hide_all::is_hidden_all(app) {
        log::info(
            "reminder",
            &format!("{}：全部便签正收着，不往屏上拉（卡照画）", item.id),
        );
    } else if item.floating {
        let label = match item.group_id.as_deref() {
            Some(gid) => float::group_label_for(gid),
            None => float::label_for(&item.id),
        };
        match app.get_webview_window(&label) {
            Some(window) => {
                if let Err(e) = window.show() {
                    log::warn("reminder", &format!("{}：把便签拉到屏上失败：{e}", item.id));
                }
                if let Some(gid) = item.group_id.as_deref() {
                    let _ = app.emit(
                        float::REVEAL_EVENT,
                        float::StickyReveal {
                            group_id: gid,
                            sticky_id: &item.id,
                        },
                    );
                }
            }
            None => log::info("reminder", &format!("{}：窗还没开，只发通知", item.id)),
        }
    }

    if let Err(e) = reminder::mark(db, &item.id, item.occurrence) {
        log::warn("reminder", &format!("{}：记弹过失败（下一轮会再弹一次）：{e}", item.id));
    }
}

/// 是不是"装出来的那一份"。判据是**开发产物目录树**取反：`…/target/debug…`（含
/// `cargo test` 那层的 `target/debug/deps`）里的都算直跑的开发版。
///
/// 为什么和通知插件那条判据不完全抄一样：插件只看目录**末尾**是不是
/// `target\debug|release`，于是 `cargo test` 的 exe（在 `target/debug/deps`）在它眼里
/// 反倒像"装好的"。这里宁可严一点：只有明确装出去的包才发系统通知。
fn looks_installed() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        // 问不到自己是谁，就按"不是装出来的"处理：少发一条系统通知不丢人，
        // 以别人的名义发一条才丢人
        return false;
    };
    let dir = exe
        .parent()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    !dev_output_dir(&dir)
}

/// 纯函数那一半：路径（已转小写、分隔符不分正反斜杠）是不是开发产物那棵树。
fn dev_output_dir(dir: &str) -> bool {
    let unified = dir.replace('\\', "/");
    unified.contains("/target/debug") || unified.contains("/target/release")
}

#[cfg(test)]
mod tests {
    use super::dev_output_dir;

    /// 这条判据决定"发不发系统通知"，判错的形状是那条 toast 以别人的名义弹出来。
    /// 正反斜杠都测：Windows 上两种写法都会出现，而 `to_lowercase` 之前是原样字符串。
    #[test]
    fn 开发产物目录认得全_装出去的认不出() {
        assert!(dev_output_dir(r"e:\zcode\yixian-notes-mini\src-tauri\target\release"));
        assert!(dev_output_dir(r"e:\zcode\yixian-notes-mini\src-tauri\target\release\deps"));
        assert!(dev_output_dir("/home/x/proj/src-tauri/target/debug"));
        assert!(!dev_output_dir(r"c:\users\admin\appdata\local\programs\yixiannotesmini"));
        assert!(!dev_output_dir(r"e:\tools\yixian\yixian-notes-mini.exe"), "路径里压根没有 target");
    }
}
