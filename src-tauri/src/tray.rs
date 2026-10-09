// 托盘 — 新建便签、搜索、回收站、设置、收起全部、恢复全部、退出。
// 托盘在数据层之后构建：菜单处理器要用 app.try_state::<Db>() 拿库。
//
// 菜单 id 就是热键表里的动作 id（`hide-all` / `show-all` 等，见 `hotkeys.rs`）：
// 一个动作用两个名字迟早分叉成"设置里那一行按了没反应"。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::data::private::PrivateVault;
use crate::db::pool::Db;
use crate::windows::{float, search, settings, trash, unlock};

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let new_i = MenuItem::with_id(app, "new-sticky", "新建便签", true, None::<&str>)?;
    let search_i = MenuItem::with_id(app, "search", "搜索", true, None::<&str>)?;
    let trash_i = MenuItem::with_id(app, "trash", "回收站", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
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
            &hide_i,
            &show_i,
            &sep,
            &quit_i,
        ],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("打包图标缺失").clone())
        .tooltip("一闲笔记 mini")
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
