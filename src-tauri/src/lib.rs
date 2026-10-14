// lib — 应用装配（模块：support 错误/时钟/文件日志、db 唯一主存（SQLite）、commands 前端 invoke
// 入口、windows 建窗（factory 声明式规格 + float 浮窗与叠窗 + 面板窗 + monitor 工作区唯一一份）、
// hotkeys 逐条注册逐条容忍失败、autolock 便签窗内无操作自动上锁、autostart（状态在注册表 Run 键里，
// 不落库）、splash 开场窗（原生分层窗，不碰 WebView2）、tray 系统托盘）。
// 装配顺序：状态先 manage → 开场窗（排在开库之前，盖住开库 + 首扇 WebView 那一段）→ 数据层
// （开库→迁移→导入→清算→开机恢复）→ 托盘 → 快捷键 → 鼠标钩子。库打不开不 manage：数据命令统一
// 失败但托盘「退出」仍然可用——必须留一条用户能自己退出去的路；退出清理见 RunEvent::Exit 那一处。

mod autolock;
mod autostart;
mod commands;
mod data;
mod db;
mod hotkeys;
mod import;
mod input;
mod reminders;
mod splash;
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
        // 正文里的链接要真开系统浏览器（webview 自己开新窗被默认拦掉）；权限只给 open-url
        .plugin(tauri_plugin_opener::init())
        // 提醒到点发系统通知（判据与循环在 `reminders.rs`）。前端不调它，capabilities 没给
        // 这条权限也一样能发——是 Rust 侧自己用。
        .plugin(tauri_plugin_notification::init())
        // 开机启动：注册表那条 Run 键的读写（托盘的勾选项与设置窗共用一条路）；不传启动参数
        // ——开机拉起来就按平时的样子恢复便签。插件的 setup 跑在下面的闭包之前，tray::build 读得到它。
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(windows::factory::CreatingRegistry::default())
        .manage(windows::dock::DockLayout::default())
        .manage(windows::hide_all::Hidden::default())
        .manage(windows::frames::PanelFrames::default())
        .manage(hotkeys::HotkeyRegistry::default())
        .on_window_event(|window, event| {
            let label = window.label();
            match event {
                // 销毁清账：贴边注册表不清，槽位号会越涨越大。单窗与叠窗**都要剥**——只认
                // FLOAT_PREFIX 的话一叠贴边后被关掉，那个槽位永远留在册上，细丝会一路往后爬。
                tauri::WindowEvent::Destroyed => {
                    let id = label
                        .strip_prefix(windows::float::FLOAT_PREFIX)
                        .or_else(|| label.strip_prefix(windows::float::GROUP_PREFIX));
                    if let Some(id) = id {
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
            // 它自己演它的，绝不分走建窗的时间（失败也只是没开场，不影响启动）
            splash::spawn(&handle);
            // 私密层状态扫描：盘上有合法封套才算"配置过"；那份读不出来就记成 damaged
            // （与"没配置"分开，写私密一律停手），现场进日志
            app.manage(data::private::PrivateVault::scan(&dir));
            // 口令窗"这一次为哪张"的意图。住 Rust 而不是走 URL：这扇窗是复用的，
            // 人在没输完之前点了另一张的蒙版，意图会变而窗不会重建
            app.manage(windows::unlock::IntentState::default());
            // 自动上锁的时钟住 Rust 这一侧才跨窗唯一（便签窗可能被全部收起、面板窗可能正开着）。
            // 起点 0 = "这一轮还没人动过便签"，那条循环的第一轮先把它拨成当前时刻
            app.manage(autolock::NoteIdle::default());
            // 开机恢复那几扇窗的任务句柄。留着是为了让星环排在它们**之后**预热
            // （WebView2 的创建是串着的，抢在前面只会把便签窗的第一帧往后推）
            let mut restore_tasks: Vec<tauri::async_runtime::JoinHandle<()>> = Vec::new();
            match db::Db::open(&dir) {
                Ok(database) => {
                    match db::migrate::run(&database) {
                        Ok(report) if report.is_noop() => {}
                        Ok(report) => {
                            support::log::info("db", &format!("schema v{} → v{}", report.from, report.to));
                        }
                        Err(e) => support::log::error("db", &format!("迁移失败，SQLite 侧不可用：{e}")),
                    }
                    // 改密/重置停在半路时的补完。只看两样问得出来的事实：settings 那一格标记、
                    // `private.json.pending` 在不在——都不需要口令。
                    // 排在导入与清算之前：后面每一步都默认盘上这份封套就是当前该用的那份
                    {
                        let marker = {
                            let conn = database.lock();
                            db::query::settings::get_conn(
                                &conn,
                                data::private::STAGE_MARKER_KEY,
                            )
                            .ok()
                            .flatten()
                        };
                        match data::private::recover_stage(&dir, marker.as_deref()) {
                            Ok(Some(note)) => {
                                support::log::info("private", &format!("补完改密/重置那一步：{note}"));
                                if marker.is_some() {
                                    let conn = database.lock();
                                    if let Err(e) = db::query::settings::remove_conn(
                                        &conn,
                                        data::private::STAGE_MARKER_KEY,
                                    ) {
                                        support::log::warn(
                                            "private",
                                            &format!("那一格标记没清掉（不影响结果）：{e}"),
                                        );
                                    }
                                }
                                // 换上来的那份才是当前真相：内存里的 configured/damaged 跟着重算
                                if let Some(vault) = app.try_state::<data::private::PrivateVault>() {
                                    vault.rescan();
                                }
                            }
                            Ok(None) => {}
                            Err(e) => support::log::error(
                                "private",
                                &format!("改密/重置的留底没能收尾：{e}"),
                            ),
                        }
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
                        match db::query::sticky::list_raw(&database, false) {
                            Ok(rows) => {
                                for row in rows.into_iter().filter(|row| {
                                    row.floating && row.group_id.is_none()
                                }) {
                                    let handle = handle.clone();
                                    let database = database.clone();
                                    restore_tasks.push(tauri::async_runtime::spawn(async move {
                                        if let Err(e) =
                                            windows::float::open_sticky(&handle, &database, &row.id).await
                                        {
                                            support::log::warn(
                                                "restore",
                                                &format!("开机恢复便签 {} 失败：{e}", row.id),
                                            );
                                        }
                                    }));
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
                                    restore_tasks.push(tauri::async_runtime::spawn(async move {
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
                                    }));
                                }
                            }
                            Err(e) => support::log::warn("restore", &format!("叠窗恢复读库失败：{e}")),
                        }
                    }
                    // 首次启动自动演一次引导教程（判据与 close_guide_window 同一个键：缺键 = 没看过）。
                    // 读不动库就按看过处理——"每次启动都跳出一扇教程窗"比"这一次没演"糟得多。
                    let guide_seen =
                        match db::query::settings::get(&database, windows::guide::GUIDE_SEEN_KEY) {
                            Ok(value) => value.as_deref() == Some("1"),
                            Err(_) => true,
                        };
                    if !guide_seen {
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = windows::guide::open(&handle).await {
                                support::log::warn("guide", &format!("首次引导没开起来：{e}"));
                            }
                        });
                    }
                    app.manage(database);
                }
                Err(e) => support::log::error("db", &format!("主库打不开，数据命令将全部拒绝：{e}")),
            }
            // 提醒调度：库管起来之后才起（循环每轮都要 `try_state::<Db>()`，
            // 主库没开成就只是空转，不会 panic）。
            reminders::spawn(handle.clone());
            // 私密层自动上锁的循环：与提醒同一条形状（自己的线程，每轮睡十几秒）
            autolock::spawn(handle.clone());
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
            // 持久化配置（阈值/充电弧/白名单）先于 spawn 灌进去，钩子起跑就是生效值。
            if let Some(database) = app.try_state::<Db>() {
                if let Ok(Some(hold)) =
                    db::query::settings::get(database.inner(), commands::hook::HOLD_MS_KEY)
                    && let Ok(ms) = hold.parse::<u32>()
                {
                    input::set_hold_ms(ms);
                }
                // "0" 才是关：读不到、或值漂了都按默认（开着）处理
                if let Ok(Some(value)) =
                    db::query::settings::get(database.inner(), commands::hook::CHARGING_KEY)
                {
                    input::set_charging(value != "0");
                }
                if let Ok(Some(list)) =
                    db::query::settings::get(database.inner(), commands::hook::WHITELIST_KEY)
                    && let Ok(raws) = serde_json::from_str::<Vec<String>>(&list)
                {
                    input::set_whitelist(&raws);
                }
            }
            let ring_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                // 排空开机恢复再预热：隐藏的那一扇晚几十毫秒没有任何人看得见，
                // 而它要是插在一叠便签窗前面，那些窗的第一帧就各自往后让
                for task in restore_tasks {
                    let _ = task.await;
                }
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
            commands::snapshot::snapshot_list,
            commands::snapshot::snapshot_restore,
            commands::entity::sticky_list,
            commands::entity::sticky_upsert,
            commands::entity::sticky_delete,
            commands::entity::trash_restore,
            commands::entity::trash_clear_all,
            commands::entity::sticky_set_group,
            commands::revision::sticky_revisions,
            commands::revision::sticky_revert,
            commands::entity::group_list,
            commands::entity::group_rename,
            commands::entity::group_set_collapsed,
            commands::entity::group_set_dock,
            commands::search::search_query,
            commands::private::private_status,
            commands::private::private_setup,
            commands::private::private_reveal,
            commands::private::private_verify,
            commands::private::private_note_activity,
            commands::private::private_lock,
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
            commands::window::open_guide_window,
            commands::window::close_guide_window,
            commands::window::guide_show_ring,
            commands::window::guide_release_ring,
            commands::window::tray_rect,
            commands::window::guide_demo_note,
            commands::window::open_unlock_window,
            commands::window::unlock_intent,
            commands::window::close_unlock_window,
            commands::window::open_ring_window,
            commands::window::close_ring_window,
            commands::window::close_group_stack,
            commands::window::float_frames,
            commands::entity::sticky_merge_into,
            commands::window::float_dock_register,
            commands::window::float_dock_unregister,
            commands::window::float_reveal,
            commands::window::reminder_open,
            commands::window::reminder_dismiss,
            commands::window::reminder_snooze,
            commands::window::monitor_work_area,
            commands::hotkey::app_set_hotkey,
            commands::hotkey::hotkey_list,
            commands::autostart::autostart_get,
            commands::autostart::autostart_set,
            commands::media::media_save,
            commands::media::media_get,
            commands::media::media_delete,
            commands::media::media_set_private,
            commands::hook::hook_status,
            commands::hook::hook_set_config,
            commands::log::log_write,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        // 退出清理的**第一件事**是卸鼠标钩子：钩子还挂着时进程若先死，
        // 全系统右键会被一个死人的钩子吞掉——这条必须排在一切清理之前。
        if let tauri::RunEvent::Exit = event {
            input::shutdown();
            // 尽力而为：这会儿事件循环已经在收尾，投得到的话能收干净，投不到窗口随进程没。
            // 排在卸钩子**之后**——那条才是"退出了右键还是坏的"的根源
            splash::dismiss(splash::Reason::Exit);
        }
    });
}
