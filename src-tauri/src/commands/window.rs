// 窗口域命令 — 建窗/关窗/贴边注册/工作区。销毁一律用 destroy 而非 close：close 只发
// CloseRequested、依赖前端监听器往返，监听器没注册成功就留僵尸窗（真机实锤）。
// 面板窗例外：close 语义是 hide（窗内无状态要销毁，留着还能记住摆位）。

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};
use crate::support::log;
use crate::windows::{
    card, dock::DockLayout, float, guide, monitor, ring, search, settings, trash, unlock,
};

use super::run_db;

#[tauri::command]
pub async fn create_floating_sticky(app: AppHandle, db: State<'_, Db>) -> AppResult<String> {
    let db = db.inner().clone();
    float::create_sticky(&app, db).await
}

#[tauri::command]
pub async fn open_floating_sticky(app: AppHandle, db: State<'_, Db>, id: String) -> AppResult<()> {
    let db = db.inner().clone();
    float::open_sticky(&app, &db, &id).await
}

#[tauri::command]
pub async fn close_floating_sticky(app: AppHandle, id: String) -> AppResult<()> {
    float::close_sticky(&app, &id).await
}

#[tauri::command]
pub async fn open_trash_window(app: AppHandle) -> AppResult<()> {
    trash::open(&app).await
}

#[tauri::command]
pub async fn close_trash_window(app: AppHandle) -> AppResult<()> {
    trash::close(&app).await
}

#[tauri::command]
pub async fn open_search_window(app: AppHandle) -> AppResult<()> {
    search::open(&app).await
}

#[tauri::command]
pub async fn close_search_window(app: AppHandle) -> AppResult<()> {
    search::close(&app).await
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> AppResult<()> {
    settings::open(&app).await
}

#[tauri::command]
pub async fn close_settings_window(app: AppHandle) -> AppResult<()> {
    settings::close(&app).await
}

#[tauri::command]
pub async fn open_guide_window(app: AppHandle) -> AppResult<()> {
    guide::open(&app).await
}

/// 讲星环那几步：报回屏幕上那只环的真实中心（逻辑像素），气泡据此摆过去。
#[tauri::command]
pub async fn guide_show_ring(app: AppHandle) -> AppResult<guide::RingSpot> {
    guide::show_ring(&app).await
}

/// 离开讲环的那几步：闸门放下、环还开着就收掉。
#[tauri::command]
pub async fn guide_release_ring(app: AppHandle) {
    guide::release_ring(&app).await;
}

/// 托盘里我们那一格的矩形（**物理**像素），问不到回 null（气泡退右下角那一档摆法）。
/// UIA 那一路要跨进程问 Explorer，几十到几百毫秒，所以放去阻塞线程池里跑，
/// 别占着异步运行时的 worker。
#[tauri::command]
pub async fn tray_rect() -> Option<crate::tray::TrayRect> {
    tauri::async_runtime::spawn_blocking(|| crate::tray::icon_rect())
        .await
        .unwrap_or(None)
}

/// 虚拟演示便签：**凑够** `want` 张给讲便签的那几步指着（已有的不动，缺几张补几张）。
/// 为什么由引导放纸而不是让他按新建：并叠那一步要说"把那张拖到这一张上"，桌上得真有两张。
/// 上一版写的是"你自己按 1"，他照做就变成"又新建了一张便签"——那是在重复第三步，不是在并叠。
/// 走完引导直接销毁、不进回收站（作者拍的）—— 那是引导造的纸，不是他写的东西。
/// 返回最后那张的窗 label，气泡照 label 摆位（不用猜"哪张是新出现的"）。
#[tauri::command]
pub async fn guide_demo_note(app: AppHandle, want: u8) -> AppResult<String> {
    let db = app
        .try_state::<Db>()
        .ok_or_else(|| AppError::new("DB_MISSING", "主库不可用，建不出演示便签"))?
        .inner()
        .clone();
    let want = want.clamp(1, 4) as usize;
    let mut ids = live_demo_ids(&app, &db).await?;
    while ids.len() < want {
        let id = crate::support::id::sticky();
        // 只有一张时叫「引导演示」，补出来的才编号：后缀那个 1 是噪音
        let title = if ids.is_empty() {
            "引导演示".to_string()
        } else {
            format!("引导演示 {}", ids.len() + 1)
        };
        let input = float::demo_input(&id, &title);
        run_db(db.clone(), move |db| crate::db::query::sticky::upsert(db, input)).await?;
        float::open_sticky(&app, &db, &id).await?;
        ids.push(id);
        log::info("guide", &format!("放出演示便签「{title}」，共 {} 张", ids.len()));
    }
    let joined = ids.join(",");
    run_db(db.clone(), move |db| {
        crate::db::query::settings::set(db, guide::GUIDE_DEMO_NOTE_KEY, &joined)
    })
    .await?;
    ids.last()
        .cloned()
        .map(|id| format!("{}{id}", float::FLOAT_PREFIX))
        .ok_or_else(|| AppError::new("GUIDE_DEMO", "一张演示便签都没凑出来"))
}

/// 库里记的那串 id 里**现在还活着**的那几张。他自己删过或应用被直接关过，记号就会留着死 id：
/// 死 id 一并抹掉，顺手把它那扇可能还开着的窗关掉（关掉失败不算错，窗本来就不在）。
async fn live_demo_ids(app: &AppHandle, db: &Db) -> AppResult<Vec<String>> {
    let stored = run_db(db.clone(), |db| {
        crate::db::query::settings::get(db, guide::GUIDE_DEMO_NOTE_KEY)
    })
    .await?
    .unwrap_or_default();
    let mut live = Vec::new();
    for id in stored.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let for_check = id.to_string();
        let exists = run_db(db.clone(), move |db| {
            crate::db::query::sticky::get(db, &for_check).map(|row| row.is_some())
        })
        .await?;
        if exists {
            live.push(id.to_string());
        } else if let Err(e) = float::close_sticky(app, id).await {
            log::info("guide", &format!("死掉的演示便签 {id} 那扇窗没关掉：{e}"));
        }
    }
    Ok(live)
}

/// 销毁引导自己造的那几张：硬删（不进回收站）+ 抹掉记号 + 关掉它们的窗。
/// 每一步都允许失败：删不掉只是多留一张纸，而"关不掉引导"才是真把人困住。
async fn destroy_demo_notes(app: &AppHandle, db: Db, ids: &[String]) {
    for id in ids {
        let for_del = id.clone();
        if let Err(e) = run_db(db.clone(), move |db| {
            crate::db::query::sticky::delete(db, &for_del, true)?;
            crate::db::query::group::prune_empty(db)
        })
        .await
        {
            log::warn("guide", &format!("演示便签没销毁掉（多留一张纸）：{e}"));
        }
        // 删行不带走窗：窗还开着就是一张指向不存在的数据的纸
        if let Err(e) = float::close_sticky(app, id).await {
            log::warn("guide", &format!("演示便签那扇窗没关掉：{e}"));
        }
    }
    if let Err(e) = run_db(db, |db| {
        crate::db::query::settings::set(db, guide::GUIDE_DEMO_NOTE_KEY, "")
    })
    .await
    {
        log::warn("guide", &format!("演示便签的记号没抹掉：{e}"));
    }
}

/// 关引导窗 + 顺手销账。**顺序是刻意的**：先销账再关，但销账失败不许拦住关窗——
/// 写不动只是下次启动多演一次，而"关不掉"是真的把人困住。
/// 销账摆在这条命令而不是窗内：窗上有 × 与 Esc 两条关法，写在窗内就得两处各写一遍。
#[tauri::command]
pub async fn close_guide_window(app: AppHandle) -> AppResult<()> {
    if let Some(db) = app.try_state::<Db>() {
        let database = db.inner().clone();
        if let Err(e) =
            run_db(database.clone(), |db| {
                crate::db::query::settings::set(db, guide::GUIDE_SEEN_KEY, "1")
            })
            .await
        {
            log::warn("guide", &format!("销账失败（下次启动会再演一次）：{e}"));
        }
        // 它造的那几张跟着引导一起没（这一步在关窗之前：窗一关，前端就再也没机会说了）
        if let Ok(ids) = live_demo_ids(&app, &database).await {
            if !ids.is_empty() {
                destroy_demo_notes(&app, database, &ids).await;
            }
        }
    }
    guide::close(&app).await
}

#[tauri::command]
pub async fn open_unlock_window(app: AppHandle) -> AppResult<()> {
    unlock::open(&app).await
}

#[tauri::command]
pub async fn close_unlock_window(app: AppHandle) -> AppResult<()> {
    unlock::close(&app).await
}

#[tauri::command]
pub async fn open_ring_window(app: AppHandle) -> AppResult<()> {
    ring::open(&app).await
}

#[tauri::command]
pub async fn close_ring_window(app: AppHandle) -> AppResult<()> {
    ring::close(&app).await
}

/// 关闭并销毁一扇叠窗（成员清空时由叠窗自己调用退场）
#[tauri::command]
pub async fn close_group_stack(app: AppHandle, gid: String) -> AppResult<()> {
    float::close_stack(&app, &gid).await
}

// —— 拖拽进组的命中判定 ——

/// 桌面上一扇浮窗的位置尺寸（**物理**像素，与 `moved` 事件同一套坐标，
/// 前端拿着就能直接比，不需要再乘除缩放）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatFrame {
    pub label: String,
    /// "sticky" = 一张一扇，"stack" = 一叠一扇
    pub kind: &'static str,
    /// 单窗给便签 id，叠窗给组 id（前端按它查名字、判"进已有叠"还是"新立一叠"）
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 桌面上开着的浮窗矩形，一次给全。
///
/// 为什么非要这条命令：**系统拖着窗走的时候前端收不到 pointermove**（鼠标被系统
/// 捕获），只有 `moved` 事件流。于是"我这一下压在谁身上"只能前端自己算——自己的位置
/// 从 moved 拿，别人的位置就从这一份快照拿。快照在拖起时取一次就够（这一趟里别的窗
/// 不会自己跑），不必逐帧问。隐藏的窗（星环那扇常驻窗）不参与：拖到它身上没有意义。
#[tauri::command]
pub fn float_frames(app: AppHandle) -> Vec<FloatFrame> {
    let mut frames = Vec::new();
    for (label, window) in app.webview_windows() {
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        let (kind, id) = if let Some(gid) = label.strip_prefix(float::GROUP_PREFIX) {
            ("stack", gid.to_string())
        } else if let Some(id) = label.strip_prefix(float::FLOAT_PREFIX) {
            ("sticky", id.to_string())
        } else {
            continue;
        };
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            continue;
        };
        frames.push(FloatFrame {
            label,
            kind,
            id,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        });
    }
    frames
}

// —— 贴边 ——

#[tauri::command]
pub async fn float_dock_register(
    layout: State<'_, DockLayout>,
    id: String,
    edge: String,
) -> AppResult<i64> {
    Ok(layout.inner().register(&id, &edge))
}

#[tauri::command]
pub async fn float_dock_unregister(layout: State<'_, DockLayout>, id: String) -> AppResult<()> {
    layout.inner().unregister(&id);
    Ok(())
}

// —— 工作区 ——

/// 当前显示器的工作区（物理像素）。贴边细丝贴的是工作区边缘，不是屏幕边缘——
/// 任务栏底下不留东西。多显示器的"最近屏"按窗口当前位置判定。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkArea {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// 便签窗报"内容画完了"，于是这扇窗才亮出来。
///
/// 建窗时 `visible: false`（见 `windows/factory.rs` 的 `reveal_timeout_ms`），为的是
/// 不让他看到那块 WebView2 默认白。命令只作用在**调用方自己那扇窗**（`WebviewWindow`
/// 由 Tauri 注入），前端报不了别的窗，也不需要传 label。
/// 到点没来喊的兜底在 factory 那边：强行 show，绝不让便签不出现。
///
/// `focus` 给了 `false` 就只 show 不抢焦点——提醒卡那一扇走这条：一条到点的提醒
/// 不该把用户正在打字的应用的焦点抢走（星环那条老理由，一模一样成立）。
/// 默认拿焦点，所以别处（单窗、叠窗）一个字都不用改。
#[tauri::command]
pub fn float_reveal(win: WebviewWindow, focus: Option<bool>) -> AppResult<()> {
    win.show().map_err(|e| AppError::new("WINDOW_SHOW", e.to_string()))?;
    // 屏幕上真有东西了，开场就该收——这条同时管提醒卡与叠窗（它们也走 float_reveal）。
    // 只投递不等回执，所以在这条同步命令里也不会卡主线程
    crate::splash::dismiss(crate::splash::Reason::Revealed);
    // 焦点这一步失败了不算什么：窗已经在了，宁可少个焦点也别回一个错让前端猜
    if focus.unwrap_or(true) {
        let _ = win.set_focus();
    }
    Ok(())
}

/// 点提醒卡：收卡 + 把那张便签拉到眼前（组员由 `open_sticky` 并进叠窗并翻到那一张）。
///
/// **两端都要留日志**：作者报"点了『去看这张便签』没反应"，而前端那份 logger 只进内存与
/// console（发布版看不见）——只有 Rust 这边记一行，下一次才分得清"命令没到"还是"到了但那扇
/// 窗本来就在前台，所以看着像没动"。后一种是真的：所以这里 `unminimize` + `show` +
/// `set_focus` 之后再 `ping` 一下，让那圈纸边替它答一声。
/// 先收再开：那张可能已经被删了，卡照样该走。
#[tauri::command]
pub async fn reminder_open(app: AppHandle, db: State<'_, Db>, id: String) -> AppResult<()> {
    let db = db.inner().clone();
    log::info("reminder", &format!("点卡：要打开 {id}"));
    card::dismiss(&app);
    if let Some(window) = app.get_webview_window(&float::label_for(&id)) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else if let Err(e) = float::open_sticky(&app, &db, &id).await {
        log::warn("reminder", &format!("点卡打开便签失败：{e}"));
        return Ok(());
    }
    float::ping(&app, &id);
    Ok(())
}

/// 卡上的 ×：只收卡，不动便签
#[tauri::command]
pub fn reminder_dismiss(app: AppHandle) -> AppResult<()> {
    card::dismiss(&app);
    Ok(())
}

#[tauri::command]
pub async fn monitor_work_area(win: WebviewWindow) -> AppResult<WorkArea> {    let position = win
        .outer_position()
        .map_err(|e| AppError::new("WINDOW_POS", e.to_string()))?;
    // SAFETY 那份集中在 windows/monitor.rs，这里只搬运结果
    let area = monitor::at((position.x as i64, position.y as i64))
        .ok_or_else(|| AppError::new("MONITOR", "取显示器工作区失败"))?;
    Ok(WorkArea {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
    })
}
