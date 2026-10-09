// 一键收起 / 恢复全部便签 — **会话级**，不落库。
//
// 记的是"这一次被这一手藏起来的窗 label"，不是"这张便签被隐藏了"这个状态。两条理由：
//  · 恢复只把**这些**窗放回来。期间他自己新建/打开的那扇本来就开着，不该被多 show 一次；
//  · 落库反而骗人：那条路会做出"我明明开着它，重开应用却没了"。"从此不显示"这件事
//    已经有归宿（关掉那扇窗、`floating` 那一列），不在这儿。
//
// 只动便签那一类窗（单窗 + 叠窗）。面板窗（搜索/回收站/设置）、令窗、星环、
// 提醒卡都不在名单里——判据是 label 前缀，见 `is_note_window`（那条用例钉着，
// 判错的形状是"点一下收起，连设置窗一起没了"或者"叠窗没被收进去"）。
//
// 还有一处会被这条影响：**到点的提醒本来要把那张窗拉到屏上**。全收着的时候这一步
// 跳过（卡照画，点卡仍然会开那一扇），否则这条"一键隐藏"就成了"只隐藏三十秒"。

use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::support::log;
use crate::windows::float;

/// 被这一手藏起来的窗 label（按隐藏顺序存着，恢复就按这个顺序放回来）
#[derive(Default)]
pub struct Hidden(Mutex<Vec<String>>);

/// 这一类窗里，哪些算"便签"（单窗与叠窗）。
pub fn is_note_window(label: &str) -> bool {
    label.starts_with(float::FLOAT_PREFIX) || label.starts_with(float::GROUP_PREFIX)
}

/// 收起全部。返回藏了几扇（0 = 已经没有可藏的了）。
pub fn hide_all(app: &AppHandle) -> usize {
    let state = app.state::<Hidden>();
    let mut hidden = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let mut count = 0;
    for (label, window) in app.webview_windows() {
        if !is_note_window(&label) || !window.is_visible().unwrap_or(false) {
            continue;
        }
        if window.hide().is_err() {
            continue; // 关不掉就留着它：宁可屏幕上多一张，也别记一笔"它已经藏了"
        }
        if !hidden.contains(&label) {
            hidden.push(label);
        }
        count += 1;
    }
    log::info("tray", &format!("收起全部便签：藏了 {count} 扇（会话级，不落库）"));
    count
}

/// 恢复全部。只放**这一手藏起来的那些**，放完清账。
pub fn show_all(app: &AppHandle) -> usize {
    let state = app.state::<Hidden>();
    let mut hidden = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let labels = std::mem::take(&mut *hidden);
    let mut count = 0;
    for label in labels {
        let Some(window) = app.get_webview_window(&label) else {
            continue; // 中间被关掉了（销毁了）：没什么可恢复的，跳过
        };
        // 不 set_focus：一次放好几扇，聚焦哪一扇都是瞎选；而且抢焦点这条本工程一直不干
        if window.show().is_ok() {
            count += 1;
        }
    }
    log::info("tray", &format!("恢复全部便签：放回来 {count} 扇"));
    count
}

/// 现在是不是"全收着"的状态（提醒那一路要问它）。
pub fn is_hidden_all(app: &AppHandle) -> bool {
    let state = app.try_state::<Hidden>();
    let Some(state) = state else { return false };
    let hidden = state.0.lock().unwrap_or_else(|p| p.into_inner());
    // 名单里还有**仍然存在的窗**才算收着：只剩一行已经关掉的记录不算（那等于没在藏东西）
    hidden.iter().any(|label| {
        app.get_webview_window(label)
            .is_some_and(|window| !window.is_visible().unwrap_or(true))
    })
}

#[cfg(test)]
mod tests {
    use super::is_note_window;
    use crate::windows::float;

    /// 判据只认那两个前缀。列出来的每一行都是"点收起全部时该不该动它"的答案，
    /// 判错的两种形状都见过：连面板窗一起藏（用户以为设置没了）、叠窗没藏（还是乱）。
    #[test]
    fn 只有单窗与叠窗算便签() {
        assert!(is_note_window("sticky-s1a11e71b7d20"));
        assert!(is_note_window("sticky-sticky_mukscivmapzlt3"));
        assert!(is_note_window("stickygrp-g1a1155c83cf0"));
        assert!(!is_note_window("search"));
        assert!(!is_note_window("trash"));
        assert!(!is_note_window("settings"));
        assert!(!is_note_window("unlock"));
        assert!(!is_note_window("ring"));
        assert!(!is_note_window("reminder-card"), "卡不是便签");
        // 两个前缀互不包含：`stickygrp-*` 不会被 `sticky-` 那条吃掉（float.rs 里同一条用例）
        assert!(!"stickygrp-g1".starts_with(float::FLOAT_PREFIX));
    }
}
