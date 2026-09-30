// 托盘 — 新建便签、回收站、退出。锁定/收起全部/暂停劫持随 ROADMAP 加入。
// 托盘在数据层之后构建：菜单处理器要用 app.try_state::<Db>() 拿库。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::db::pool::Db;
use crate::windows::{float, search, trash};

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let new_i = MenuItem::with_id(app, "new-sticky", "新建便签", true, None::<&str>)?;
    let search_i = MenuItem::with_id(app, "search", "搜索", true, None::<&str>)?;
    let trash_i = MenuItem::with_id(app, "trash", "回收站", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&new_i, &search_i, &trash_i, &sep, &quit_i])?;

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
                        eprintln!("主库不可用，无法新建便签");
                        return;
                    };
                    let db = db.inner().clone();
                    if let Err(e) = float::create_sticky(&app, db).await {
                        eprintln!("新建便签失败：{e}");
                    }
                });
            }
            "search" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = search::open(&app).await {
                        eprintln!("打开搜索失败：{e}");
                    }
                });
            }
            "trash" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = trash::open(&app).await {
                        eprintln!("打开回收站失败：{e}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
