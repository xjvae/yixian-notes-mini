// 前端日志落盘 — 发布版没有控制台，`console.*` 出了窗就没人接得住。
//
// 作者拍的口径（2026-10-13）：**只落 warn 与 error**。debug/info 留在内存环形缓冲里
// （`src/platform/logger.ts`），不然每扇窗每次落库都要往盘上刷一行，7 天的保留期
// 会被噪音吃掉，而真正要还原现场的那几条反而翻不到。
//
// 这一条不返回任何东西、也不许抛：日志写不上就是写不上，绝不能把调用方（错误处理
// 那条路本身）再绊一次。前端那一侧同样不 await。

use tauri::WebviewWindow;

use crate::support::log;

/// 单条最长留多少个字。`String(error)` 可能是一整坨序列化出来的对象，
/// 再长的一条也说不完"哪儿坏了"，把文件撑爆倒是真的
const MAX_CHARS: usize = 400;

fn clip(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    if chars.len() <= MAX_CHARS {
        return input.to_string();
    }
    let mut head: String = chars[..MAX_CHARS].iter().collect();
    head.push_str(&format!("…（{} 字，截到 {MAX_CHARS}）", chars.len()));
    head
}

/// 前端的一条 warn/error 落进 `logs/mini.log.YYYYMMDD`。
/// scope 拼上窗 label：出问题的总是某一扇窗，"谁说的"和"说了什么"一样重要。
#[tauri::command]
pub async fn log_write(win: WebviewWindow, level: String, scope: String, message: String) {
    let scope = clip(&format!("{}/{}", win.label(), scope));
    let message = clip(&message);
    match level.as_str() {
        "error" => log::error(&scope, &message),
        // warn 以外的一律按 warn 落：前端只转发 warn/error，
        // 有人绕过它多传了级别也不该把这条通道变成 info 刷屏
        _ => log::warn(&scope, &message),
    }
}
