// lib — 应用装配。
//
// 模块地图：
//   support  ：错误类型（AppError）/ 时钟 / 文件日志
//   db       ：SQLite 主库（pool / migrate / models / query）——唯一主存
//   commands ：前端 invoke 的入口（db 引导与设置 / entity 便签与回收站 /
//              search 检索 / window 窗口域与贴边与工作区）
//   windows  ：窗口构建（factory 声明式规格 + 防重复注册 / float 浮窗与叠窗 /
//              dock 贴边槽位 / search·trash·settings·unlock·ring 面板窗 /
//              monitor 工作区取值的唯一一份）
//   hotkeys  ：全局快捷键（逐条注册、逐条容忍失败、改键落库）
//   tray     ：系统托盘
//
// 装配顺序：状态先 manage（命令与托盘都拿它）→ 数据层（开库 → 迁移 → 导入 →
// 清算 → 开机恢复）→ 托盘 → 快捷键 → 鼠标钩子。库打不开时不 manage：数据命令
// 统一失败，托盘的「退出」仍然可用——应用必须留一条用户能自己退出去的路。
//
// 退出清理（RunEvent::Exit）：先卸鼠标钩子再走其余清理——钩子不卸，进程收尸后
// 全系统右键都会被一个死人钩子吞掉，症状是"退出了右键还是坏的"。

mod commands;
mod data;
mod db;
mod hotkeys;
mod import;
mod input;
mod support;
mod tray;
mod windows;

use tauri::Manager;

use crate::db::pool::Db;
use crate::support::log;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 二次启动 = 唤起星环：星环没有窗内状态，重复唤起只是再显示一次。
            // 回调里不碰锁不碰 DB（这条路可能跑在别人家的线程上，且此刻兄弟进程还活着）
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = windows::ring::open(&app).await {
                    support::log::warn("single-instance", &format!("唤起星环失败：{e}"));
                }
            });
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(windows::factory::CreatingRegistry::default())
        .manage(windows::dock::DockLayout::default())
        .manage(windows::frames::PanelFrames::default())
        .manage(hotkeys::HotkeyRegistry::default())
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                // 销毁清账：贴边注册表不清，槽位号会越涨越大
                tauri::WindowEvent::Destroyed => {
                    if let Some(id) = label.strip_prefix(windows::float::FLOAT_PREFIX) {
                        window.state::<windows::dock::DockLayout>().remove(id);
                    }
                }
                // 面板窗几何记忆（合流后落 window_state）
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    windows::frames::track(window.app_handle(), label);
                }
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = handle.path().app_data_dir()?;
            // 日志落盘排在所有事之前：真机报障时能还原现场的只有这份文件
            support::log::init(&dir);
            log::info("app", "应用启动");
            // 私密层状态扫描：盘上有合法封套才算"配置过"（损坏按没配置算，现场进日志）
            app.manage(data::private::PrivateVault::scan(&dir));
            match db::Db::open(&dir) {
                Ok(database) => {
                    match db::migrate::run(&database) {
                        Ok(report) if report.is_noop() => {}
                        Ok(report) => {
                            support::log::info("db", &format!("schema v{} → v{}", report.from, report.to));
                        }
                        Err(e) => support::log::error("db", &format!("迁移失败，SQLite 侧不可用：{e}")),
                    }
                    // 旧版一次性导入（幂等，标记同事务；只读旧库，旧应用文件不动）。
                    // 排在清算之前：旧库带进来的过期回收站条目当轮就该清掉。
                    import::run(&dir, &database);
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
                    // 清算可能带走某个组的最后一张：组行跟着清，绝不留空组（叠窗按组恢复读的就是组行）
                    if let Err(e) = db::query::group::prune_empty(&database) {
                        support::log::warn("db", &format!("空组清理没跑成：{e}"));
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
                                for row in rows.into_iter().filter(|row| {
                                    row.floating && row.group_id.is_none()
                                }) {
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
                        // 叠窗按组恢复：一叠一扇（组员的单窗不开，成员在叠窗里翻页）
                        match db::query::group::stacks_to_restore(&database) {
                            Ok(gids) => {
                                for gid in gids {
                                    let handle = handle.clone();
                                    let database = database.clone();
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) =
                                            windows::float::open_group_stack(
                                                &handle, &database, &gid, None,
                                            )
                                                .await
                                        {
                                            support::log::warn(
                                                "restore",
                                                &format!("开机恢复叠窗 {gid} 失败：{e}"),
                                            );
                                        }
                                    });
                                }
                            }
                            Err(e) => support::log::warn("restore", &format!("叠窗恢复读库失败：{e}")),
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
            // 长按右键钩子最后装（准出判定在回调里是原子量读，装晚不亏）。
            // 持久化配置（阈值/白名单）先于 spawn 灌进去，钩子起跑就是生效值。
            if let Some(database) = app.try_state::<Db>() {
                if let Ok(Some(hold)) =
                    db::query::settings::get(database.inner(), commands::hook::HOLD_MS_KEY)
                    && let Ok(ms) = hold.parse::<u32>()
                {
                    input::set_hold_ms(ms);
                }
                if let Ok(Some(list)) =
                    db::query::settings::get(database.inner(), commands::hook::WHITELIST_KEY)
                    && let Ok(raws) = serde_json::from_str::<Vec<String>>(&list)
                {
                    input::set_whitelist(&raws);
                }
            }
            let ring_handle = handle.clone();
            // 星环预热：先把 WebView 建出来藏着，第一次长按才有即时的充电弧
            tauri::async_runtime::spawn(async move {
                if let Err(e) = windows::ring::prewarm(&ring_handle).await {
                    support::log::warn("ring", &format!("星环预热失败：{e}"));
                }
            });
            input::spawn(handle);
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
            commands::entity::sticky_set_group,
            commands::entity::group_list,
            commands::search::search_query,
            commands::private::private_status,
            commands::private::private_setup,
            commands::private::private_unlock,
            commands::private::private_lock,
            commands::private::private_load,
            commands::private::private_save,
            commands::private::private_rekey,
            commands::private::private_reset,
            commands::window::create_floating_sticky,
            commands::window::open_floating_sticky,
            commands::window::close_floating_sticky,
            commands::window::open_trash_window,
            commands::window::close_trash_window,
            commands::window::open_search_window,
            commands::window::close_search_window,
            commands::window::open_settings_window,
            commands::window::close_settings_window,
            commands::window::open_unlock_window,
            commands::window::close_unlock_window,
            commands::window::open_ring_window,
            commands::window::close_ring_window,
            commands::window::close_group_stack,
            commands::window::float_dock_register,
            commands::window::float_dock_unregister,
            commands::window::monitor_work_area,
            commands::hotkey::app_set_hotkey,
            commands::hotkey::hotkey_list,
            commands::hook::hook_status,
            commands::hook::hook_set_config,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        // 退出清理的**第一件事**是卸鼠标钩子：钩子还挂着时进程若先死，
        // 全系统右键会被一个死人的钩子吞掉——这条必须排在一切清理之前。
        if let tauri::RunEvent::Exit = event {
            input::shutdown();
        }
    });
}
