// float — 便签浮窗的规格与开窗路径。一便签一窗（label = sticky-<id>）。
// `__STICKY_ID__` 注入脚本是跨语言契约：前端 identity.ts 读它，别处不得另造来源。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalSize, WebviewWindow};

use crate::db::models::StickyInput;
use crate::db::pool::Db;
use crate::db::query::{group, sticky};
use crate::support::error::{AppError, AppResult};
use crate::support::id;
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::frames;

pub const FLOAT_PREFIX: &str = "sticky-";
pub const GROUP_PREFIX: &str = "stickygrp-";
const MAIN_ENTRY: &str = "index.html";
const DEFAULT_SIZE: (f64, f64) = (320.0, 300.0);
const MIN_SIZE: (f64, f64) = (220.0, 200.0);
/// 收起成标题栏形态的固定高度与最大宽度（前端收起按钮走同一套常量口径）
const BAR_HEIGHT: f64 = 62.0;
const BAR_MAX_WIDTH: f64 = 360.0;

pub fn label_for(id: &str) -> String {
    format!("{FLOAT_PREFIX}{id}")
}

pub fn group_label_for(gid: &str) -> String {
    format!("{GROUP_PREFIX}{gid}")
}

/// 收起档与展开档各自的「出生尺寸 + 原生下限」——单窗与叠窗**共用这一条**。
///
/// 收起那一档高是死的 62，而**必须同时把 `min_size` 摘掉**：builder 的
/// `min_inner_size(220, 200)` 是在建窗那一刻生效的，62 会被当场夹回 200。
/// 症状就是作者报的"收起态退出应用、重开后那条栏占一大块"——前端那条撤下限的
/// effect 跑得再对也来不及，夹发生在窗出生之前。
pub fn mode_geometry(collapsed: bool, expand: (f64, f64)) -> ((f64, f64), Option<(f64, f64)>) {
    if collapsed {
        ((expand.0.min(BAR_MAX_WIDTH), BAR_HEIGHT), None)
    } else {
        (expand, Some(MIN_SIZE))
    }
}

/// 新建默认便签并开窗，返回新 id（托盘与命令共用这一条路径）
pub async fn create_sticky(app: &AppHandle, db: Db) -> AppResult<String> {
    let id = gen_id();
    sticky::upsert(&db, default_input(&id))?;
    open_sticky(app, &db, &id).await?;
    Ok(id)
}

/// 打开（或聚焦已存在的）一扇便签窗。几何取行里存的值，没摆过位就级联落点。
pub async fn open_sticky(app: &AppHandle, db: &Db, id: &str) -> AppResult<()> {
    let label = label_for(id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let row = sticky::get(db, id)?
        .ok_or_else(|| AppError::new("STICKY_MISSING", format!("便签 {id} 不存在")))?;
    // 组员住叠窗（一叠一窗），不再单开一扇：搜索点结果、回收站恢复都走这条路，
    // 否则同一张便签会在单窗和叠窗里各显形一次。
    // 指向已删组的悬空成员按散着算——组行没了就当没组（见 query/group.rs 头部）。
    if let Some(gid) = row.group_id.as_deref()
        && group::exists(db, gid)?
    {
        // 带着"要看哪一张"进去：点结果/恢复点的就是这一张
        return open_group_stack(app, db, gid, Some(id)).await;
    }
    let position = match (row.x, row.y) {
        (Some(x), Some(y)) => (x as f64, y as f64),
        _ => cascade_position(app),
    };
    // 收起态的行记的仍是展开尺寸：开机恢复按这一档开窗（尺寸与下限都归 `mode_geometry`）
    let expand = (
        row.width.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.0),
        row.height.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.1),
    );
    let (size, min_size) = mode_geometry(row.collapsed, expand);
    let spec = WindowSpec {
        label,
        url: MAIN_ENTRY.into(),
        title: "一闲便签".into(),
        size,
        position: Some(position),
        min_size,
        transparent: true,
        always_on_top: row.pinned,
        skip_taskbar: true,
        // 焦点交给 `float_reveal` 那一步（画完才亮，亮了才谈得上焦点）；
        // 对一扇还没显示的窗调 set_focus 没有意义，留着只可能添乱
        focused: false,
        visible: false,
        // 前端报就绪后由 `float_reveal` 亮出来；2s 是给的余量（首启要起 webview、
        // 解析 bundle、hydrate 一轮），到点没等到就强行 show
        reveal_timeout_ms: Some(2000),
        show_on_reuse: true,
        init_script: Some(format!("window.__STICKY_ID__ = {:?};", id)),
    };
    // 位置在 spec 里就给了（不在建完之后 set_position）：那一下会让窗先在系统
    // 默认位置亮起来、再跳到记下的地方——真机看到的"闪一阵才到位"就是这两跳。
    build_window(app, spec).await?;
    Ok(())
}

/// 关闭并销毁一扇便签窗。窗不存在不算错（调用方往往只是"让它别再显示"）
pub async fn close_sticky(app: &AppHandle, id: &str) -> AppResult<()> {
    destroy_window(app, &label_for(id)).await
}

/// 关闭并销毁一扇叠窗。叠窗的 label 整串由 `group_label_for` 定形，
/// 绝不能借道 `close_sticky`——那会再套一层 FLOAT_PREFIX，destroy 找不到窗，静默 no-op。
pub async fn close_stack(app: &AppHandle, gid: &str) -> AppResult<()> {
    destroy_window(app, &group_label_for(gid)).await
}

async fn destroy_window(app: &AppHandle, label: &str) -> AppResult<()> {
    if let Some(window) = app.get_webview_window(label) {
        window
            .destroy()
            .map_err(|e| AppError::new("WINDOW_CLOSE", e.to_string()))?;
    }
    Ok(())
}

/// 叠窗要落在哪一张：搜索点的是组员、刚移进来的那一张、回收站恢复的那一张。
/// 冷开走 init_script 的 `__STICKY_FOCUS_ID__`，窗已经在了走 `sticky:reveal` 事件——
/// 一条信息两条路，缺了后者就是"点了第一张却看到别的张"。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StickyReveal<'a> {
    pub group_id: &'a str,
    pub sticky_id: &'a str,
}

/// 叠窗翻到指定那张的事件名（前端 contracts.ts 有同名常量镜像）
pub const REVEAL_EVENT: &str = "sticky:reveal";

/// "就是这一张"的事件名（提醒卡点开来用的，前端 contracts.ts 有镜像）。
///
/// 为什么要单独一条：那张便签**本来就开着**的时候，`show()` + `set_focus()` 在它身上
/// 什么也没改变（它已经在前台），作者报的"点了去看这张便签没反应"就是这个。
/// 于是除了摆位之外还要给它一个能看见的回应：纸边上闪一圈。
pub const PING_EVENT: &str = "sticky:ping";

/// 让承载这张便签的那扇窗闪一下（单窗按 id 认，叠窗按"这一叠里有没有它"认）。
pub fn ping(app: &AppHandle, sticky_id: &str) {
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Ping<'a> {
        sticky_id: &'a str,
    }
    let _ = app.emit(PING_EVENT, Ping { sticky_id });
}

/// 打开（或聚焦）一扇叠窗：一叠一扇，窗内翻页，成员由前端按 group_id 捞。
/// 注入 `__STICKY_GROUP_ID__`（与 `__STICKY_ID__` 互斥，二者是"这扇窗是谁"的唯一出处）。
pub async fn open_group_stack(
    app: &AppHandle,
    db: &Db,
    gid: &str,
    focus: Option<&str>,
) -> AppResult<()> {
    let label = group_label_for(gid);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        if let Some(sid) = focus {
            // 广播给所有窗，叠窗自己按 groupId 认领（与 db:changed 同一口径）
            let _ = app.emit(
                REVEAL_EVENT,
                StickyReveal {
                    group_id: gid,
                    sticky_id: sid,
                },
            );
        }
        return Ok(());
    }
    // 首次落点：groups 行记过就用（旧库导入带进来的摆位），没记过走级联。
    // 用户此后拖动/缩放的记忆落在 window_state（frames::is_tracked 认 stickygrp-*），
    // 由下面的 apply_saved 原样放回——groups 行不再是几何的活住址，只当出生点。
    //
    // 但 apply_saved 是"建完之后"才搬：窗已经可见了，于是先在出生点闪一下再跳到位。
    // 所以记住过就直接按那份**出生**（位置与尺寸都在建之前定），apply_saved 照旧
    // 再纠一次物理值——两者一致时那一写是空操作。
    let (position, (group_w, group_h)) = match frames::saved_placement(app, &label) {
        Some((saved_position, saved_size)) => (Some(saved_position), saved_size),
        None => (
            Some(group_position(app, db, gid)),
            group_frame(db, gid)?,
        ),
    };
    // 叠窗也有收起态（作者要的"给组合加最小化按钮"）：读组行那一列，其余与单窗同一条
    let collapsed = crate::db::query::group::get(db, gid)?.is_some_and(|row| row.collapsed);
    let (size, min_size) = mode_geometry(collapsed, (group_w, group_h));
    // 同一个布尔注入两份（几何 + 全局）不是重复：前端**首帧**就得知道自己该画哪一档。
    // 只给几何不给旗子，首帧会在那 62 高里画一整张正文，等 group_list 回来才改形状——
    // 而那一下正好发生在 reveal 之后，用户看见的就是"打开时抖了一下"。
    let identity = match focus {
        Some(sid) => format!(
            "window.__STICKY_GROUP_ID__ = {:?}; window.__STICKY_FOCUS_ID__ = {:?};",
            gid, sid
        ),
        None => format!("window.__STICKY_GROUP_ID__ = {:?};", gid),
    };
    let init_script = format!("{identity} window.__STICKY_COLLAPSED__ = {};", collapsed);
    let spec = WindowSpec {
        label,
        url: MAIN_ENTRY.into(),
        title: "一叠便签".into(),
        size,
        position,
        min_size,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focused: false,
        visible: false,
        reveal_timeout_ms: Some(2000),
        show_on_reuse: true,
        init_script: Some(init_script),
    };
    let window = build_window(app, spec).await?;
    // 建完不再 set_position：位置已经在出生时就定了（那一句正是"先闪再跳"的来源）。
    // apply_saved 留着做物理像素的精确纠正——与出生值一致时它是一写空操作。
    frames::apply_saved(&window);
    if collapsed {
        clamp_bar_height(&window);
    }
    Ok(())
}

/// 收起那一档的高度是**死的**，压过 `window_state` 里记着的那份。
///
/// 为什么要有这一手：叠窗是 resizable 的，有人会把那条 62 的栏往下拽高（收起态没有
/// 任何东西告诉系统"这一档只能 62"），于是 window_state 记下 200 高的栏；下次开机
/// 出生尺寸虽然按栏给，`apply_saved` 又把记着的 200 原样放回——症状是"收起了，
/// 下面还空一大块白"。宽度不管：那条栏横着长没有坏处，位置也不动（那是刚放好的物理值）。
fn clamp_bar_height(window: &WebviewWindow) {
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        return; // 量不到就不纠：宁可是那条栏高一点，也别把窗摆到不知道哪儿去
    };
    let bar = (BAR_HEIGHT * scale).round().max(1.0) as u32;
    if size.height != bar {
        let _ = window.set_size(PhysicalSize::new(size.width, bar));
    }
}

/// 叠窗尺寸：组行记过就用，没记过用默认
fn group_frame(db: &Db, gid: &str) -> AppResult<(f64, f64)> {
    let row = crate::db::query::group::get(db, gid)?
        .ok_or_else(|| AppError::new("GROUP_MISSING", format!("组合 {gid} 不存在")))?;
    Ok((
        row.width.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.0),
        row.height.map(|v| v as f64).unwrap_or(DEFAULT_SIZE.1),
    ))
}

/// 叠窗位置：组行记过就用，没记过按已有浮窗数级联
fn group_position(app: &AppHandle, db: &Db, gid: &str) -> (f64, f64) {
    if let Ok(Some(row)) = crate::db::query::group::get(db, gid)
        && let (Some(x), Some(y)) = (row.x, row.y)
    {
        return (x as f64, y as f64);
    }
    cascade_position(app)
}

/// 没摆过位的便签按开窗数级联落点，一眼能看出是新开的
fn cascade_position(app: &AppHandle) -> (f64, f64) {
    let count = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(FLOAT_PREFIX))
        .count() as f64;
    (80.0 + count * 26.0, 90.0 + count * 26.0)
}

/// 便签 id：`s…`
fn gen_id() -> String {
    id::sticky()
}

/// 组 id：与便签 id **同一套生成法**，只是前缀换成 g（认前缀的地方不少，多一套
/// 形状就多一处坑）。拖拽并组要就地立一叠时用它，绝不让前端传——传进来的 id
/// 能撞车也能伪造。生成法本体在 `support/id.rs`（图片 id 也走那一套）。
pub fn gen_group_id() -> String {
    id::group()
}

/// 引导的**虚拟演示便签**：与默认那张同一条路，只是给它一个名字。
/// 起名是为了演的时候一眼看得懂"这张是引导造的"；销毁不靠名字，靠库里记的那串 id ——
/// 他自己写一张同名便签不该被引导吃掉。
pub fn demo_input(id: &str, title: &str) -> StickyInput {
    StickyInput {
        title: title.to_string(),
        ..default_input(id)
    }
}

fn default_input(id: &str) -> StickyInput {
    StickyInput {
        id: id.to_string(),
        title: String::new(),
        body: String::new(),
        content_type: "text".into(),
        items: Vec::new(),
        timeline: Vec::new(),
        tags: Vec::new(),
        theme: "yellow".into(),
        pinned: true,
        floating: true,
        collapsed: false,
        is_private: false,
        group_id: None,
        x: None,
        y: None,
        width: None,
        height: None,
        due_at: None,
        done_at: None,
        repeat: "none".into(),
        deleted: false,
        docked: false,
        dock_edge: None,
        icon: None,
        auto_size: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一叠一窗与一签一窗靠 label 前缀分流（on_window_event 的贴边清账也按前缀认）。
    /// 前缀一旦互相包含，销毁与清账都会静默走错分支——这里钉住互不重叠。
    #[test]
    fn 两种窗label前缀互不重叠() {
        assert!(!GROUP_PREFIX.starts_with(FLOAT_PREFIX));
        assert!(group_label_for("g1").starts_with(GROUP_PREFIX));
        assert!(!group_label_for("g1").starts_with(FLOAT_PREFIX));
        assert!(!label_for("s1").starts_with(GROUP_PREFIX));
    }

    /// 收起那一档必须**连原生下限一起摘**。挂着 220×200 去建 62 高的栏，
    /// builder 在建窗当场就把高夹回 200 —— 作者报的"收起态退出重开，尺寸不一致"就是它。
    /// 这条以前只在叠窗那份里对，单窗那份漏了（两个地方各写一遍就会有一个漏）。
    #[test]
    fn 收起档给死高并且不挂下限() {
        let (size, min) = mode_geometry(true, (500.0, 300.0));
        assert_eq!(size, (BAR_MAX_WIDTH, BAR_HEIGHT), "宽夹到 360、高就是 62");
        assert!(min.is_none(), "下限一挂，62 会被夹回 200");

        // 比 360 窄的窗收起后不该被拉长：那是用户自己拉的宽
        assert_eq!(mode_geometry(true, (240.0, 300.0)).0, (240.0, BAR_HEIGHT));

        let (open, min) = mode_geometry(false, (500.0, 300.0));
        assert_eq!(open, (500.0, 300.0), "展开档照行里的尺寸");
        assert_eq!(min, Some(MIN_SIZE), "展开档要保住'手拉不能拉到捏不住'那条下限");
    }
}
