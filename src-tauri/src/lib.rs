// lib — 应用装配。
//
// 模块地图：
//   support  ：错误类型（AppError）
//   db       ：SQLite 主库（pool / migrate / models / query）——唯一主存
//   commands ：前端 invoke 的入口（db 引导 / entity 便签 / window 窗口域）
//   windows  ：窗口构建（factory 声明式规格 + 防重复注册 / float 便签浮窗）
//   tray     ：系统托盘
//
// 装配顺序：状态先 manage（命令与托盘都拿它）→ 数据层（开库 → 迁移）→ 托盘。
// 库打不开时不 manage：数据命令会统一失败，托盘的"退出"仍然可用——
// 应用必须留一条用户能自己退出去的路。
//
// 钩子（WH_MOUSE_LL 长按右键唤星环）、全局快捷键、单实例唤起动作随 ROADMAP 落地，
// 落地时同样遵守：兄弟实例活着时绝不重复注册。

mod commands;
mod db;
mod support;
mod tray;
mod windows;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // 二次启动：骨架期无事可做；星环落地后在这里唤起它
        }))
        .manage(windows::factory::CreatingRegistry::default())
        .manage(windows::dock::DockLayout::default())
        .on_window_event(|window, event| {
            // 销毁清账：贴边注册表不清，槽位号会越涨越大
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                if let Some(id) = label.strip_prefix(windows::float::FLOAT_PREFIX) {
                    window
                        .state::<windows::dock::DockLayout>()
                        .remove(id);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = handle.path().app_data_dir()?;
            match db::Db::open(&dir) {
                Ok(database) => {
                    match db::migrate::run(&database) {
                        Ok(report) if report.is_noop() => {}
                        Ok(report) => {
                            eprintln!("schema v{} → v{}", report.from, report.to);
                        }
                        Err(e) => eprintln!("迁移失败，SQLite 侧不可用：{e}"),
                    }
                    // 回收站到期清算（30 天）。清不动只是晚一轮，数据仍在库里，不许带崩启动
                    match db::query::trash::purge_expired(
                        &database,
                        db::query::trash::TRASH_RETENTION_DAYS,
                        db::query::sticky::now_ms(),
                    ) {
                        Ok(0) => {}
                        Ok(n) => eprintln!("回收站到期清算 {n} 条"),
                        Err(e) => eprintln!("回收站清算没跑成：{e}"),
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
                                            eprintln!("开机恢复便签 {} 失败：{e}", row.id);
                                        }
                                    });
                                }
                            }
                            Err(e) => eprintln!("开机恢复读库失败：{e}"),
                        }
                    }
                    app.manage(database);
                }
                Err(e) => eprintln!("主库打不开，数据命令将全部拒绝：{e}"),
            }
            tray::build(&handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // generate_handler 依赖命令宏生成的隐藏项与函数同模块：
            // 这里必须写完整模块路径，不能经由 mod.rs 转发
            commands::db::get_bootstrap,
            commands::db::settings_set,
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
            commands::window::float_dock_register,
            commands::window::float_dock_unregister,
            commands::window::monitor_work_area,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
