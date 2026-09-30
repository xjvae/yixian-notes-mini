// lib — 应用装配。
//
// 模块地图：
//   support  ：错误类型（AppError）/ 时钟 / 文件日志
//   db       ：SQLite 主库（pool / migrate / models / query）——唯一主存
//   commands ：前端 invoke 的入口（db 引导与设置 / entity 便签与回收站 /
//              search 检索 / window 窗口域与贴边与工作区）
//   windows  ：窗口构建（factory 声明式规格 + 防重复注册 / float 浮窗 /
//              dock 贴边槽位 / search·trash·settings 面板窗）
//   hotkeys  ：全局快捷键（逐条注册、逐条容忍失败、改键落库）
//   tray     ：系统托盘
//
// 装配顺序：状态先 manage（命令与托盘都拿它）→ 数据层（开库 → 迁移 → 清算 →
// 开机恢复）→ 托盘 → 快捷键。库打不开时不 manage：数据命令统一失败，
// 托盘的「退出」仍然可用——应用必须留一条用户能自己退出去的路。
//
// 钩子（WH_MOUSE_LL 长按右键唤星环）随 M4 落地，落地时同样遵守：
// 兄弟实例活着时绝不重复注册。

mod commands;
mod db;
mod hotkeys;
mod support;
mod tray;
mod windows;

use tauri::Manager;

use crate::db::pool::Db;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // 二次启动：骨架期无事可做；星环落地后在这里唤起它
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(windows::factory::CreatingRegistry::default())
        .manage(windows::dock::DockLayout::default())
        .manage(hotkeys::HotkeyRegistry::default())
        .on_window_event(|window, event| {
            // 销毁清账：贴边注册表不清，槽位号会越涨越大
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                if let Some(id) = label.strip_prefix(windows::float::FLOAT_PREFIX) {
                    window.state::<windows::dock::DockLayout>().remove(id);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = handle.path().app_data_dir()?;
            // 日志落盘排在所有事之前：真机报障时能还原现场的只有这份文件
            support::log::init(&dir);
            support::log::info("app", "应用启动");
            match db::Db::open(&dir) {
                Ok(database) => {
                    match db::migrate::run(&database) {
                        Ok(report) if report.is_noop() => {}
                        Ok(report) => {
                            support::log::info("db", &format!("schema v{} → v{}", report.from, report.to));
                        }
                        Err(e) => support::log::error("db", &format!("迁移失败，SQLite 侧不可用：{e}")),
                    }
                    // 回收站到期清算（30 天）。清不动只是晚一轮，数据仍在库里，不许带崩启动
                    match db::query::trash::purge_expired(
                        &database,
                        db::query::trash::TRASH_RETENTION_DAYS,
                        db::query::sticky::now_ms(),
                    ) {
                        Ok(0) => {}
                        Ok(n) => support::log::info("db", &format!("回收站到期清算 {n} 条")),
                        Err(e) => support::log::warn("db", &format!("回收站清算没跑成：{e}")),
                    }
                    // 开机恢复桌面便签：floating=1 且未删的逐张拉回。
                    // 「开机恢复」设置项默认开，显式写 "0" 才算关（三态口径）。
                    let restore_on_boot =
                        match db::query::settings::get(&database, "restore_on_boot") {
                            Ok(value) => value.as_deref() != Some("0"),
                            Err(_) => true,
                        };
                    if restore_on_boot {
                        match db::query::sticky::list(&database, false) {
                            Ok(rows) => {
                                for row in rows.into_iter().filter(|row| row.floating) {
                                    let handle = handle.clone();
                                    let database = database.clone();
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) =
                                            windows::float::open_sticky(&handle, &database, &row.id).await
                                        {
                                            support::log::warn(
                                                "restore",
                                                &format!("开机恢复便签 {} 失败：{e}", row.id),
                                            );
                                        }
                                    });
                                }
                            }
                            Err(e) => support::log::warn("restore", &format!("开机恢复读库失败：{e}")),
                        }
                    }
                    app.manage(database);
                }
                Err(e) => support::log::error("db", &format!("主库打不开，数据命令将全部拒绝：{e}")),
            }
            tray::build(&handle)?;
            // 快捷键最后注册：插件的托管状态要先就位；逐条容忍失败。
            // 覆盖表从已管理的库读（读不到就按默认表全量注册）。
            let overrides = app
                .try_state::<Db>()
                .and_then(|db| {
                    db::query::settings::get(db.inner(), hotkeys::HOTKEYS_SETTING_KEY)
                        .ok()
                        .flatten()
                })
                .map(|value| hotkeys::bindings_override_from(Some(value.as_str())))
                .unwrap_or_default();
            hotkeys::register_all(&handle, &overrides);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // generate_handler 依赖命令宏生成的隐藏项与函数同模块：
            // 这里必须写完整模块路径，不能经由 mod.rs 转发
            commands::db::get_bootstrap,
            commands::db::settings_get,
            commands::db::settings_set,
            commands::db::data_backup,
            commands::entity::sticky_list,
            commands::entity::sticky_upsert,
            commands::entity::sticky_delete,
            commands::entity::trash_restore,
            commands::search::search_query,
            commands::window::create_floating_sticky,
            commands::window::open_floating_sticky,
            commands::window::close_floating_sticky,
            commands::window::open_trash_window,
            commands::window::close_trash_window,
            commands::window::open_search_window,
            commands::window::close_search_window,
            commands::window::open_settings_window,
            commands::window::close_settings_window,
            commands::window::float_dock_register,
            commands::window::float_dock_unregister,
            commands::window::monitor_work_area,
            commands::hotkey::app_set_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
