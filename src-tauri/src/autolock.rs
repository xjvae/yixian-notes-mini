// 私密层自动上锁 — 「便签窗内 N 分钟没有操作就锁」。
//
// 时钟为什么住 Rust 这一侧：便签窗可能被全部收起、面板窗可能正开着，只有这里能给出
// 一个跨窗唯一的答案。前端只负责"我在便签里动了一下"这一声（命令
// `private_note_activity`，前端自己节流到 ≤每 5 秒一次）。
//
// 档位读 settings 的 `private.auto_lock_min`：显式 "0" 才算不锁，缺键与脏值回到 5 分钟
// （与设置窗那排按钮的默认档同一个数）。这条与 `sticky.auto_size` 的"脏值按关"
// 口径**反过来**：那是一条会改变窗体行为的开关，脏值打开它比让它关着难查；
// 这一条是保护隐私的，脏值把它悄悄关掉，用户看到的是"锁没锁上"，比按默认锁上危险得多。
//
// 走一条自己的线程而不是 `tauri::async_runtime::spawn`：与 `reminders::spawn` 同一条
// 理由——每轮要睡十几秒的循环放在异步运行时里等于长期占掉一格 worker。

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::data::private::{self, PrivateVault};
use crate::db::pool::Db;
use crate::db::query::settings;
use crate::support::{clock, log};

pub const AUTO_LOCK_SETTING_KEY: &str = "private.auto_lock_min";
/// 缺键/脏值走这一档，设置窗那排按钮的默认档必须是同一个数
pub const DEFAULT_MINUTES: i64 = 5;
/// 检查间隔。锁晚 15 秒没人看得出，再密就是常驻线程空转过勤（每轮过一次 SQLite）
const CHECK_EVERY: Duration = Duration::from_secs(15);

/// 最后一次「便签窗内有操作」的时刻（毫秒）。
/// 0 = 这一轮还没人动过便签：第一轮先把它拨成当前时刻再走判定，否则开机 5 分钟
/// 就把人锁了，而那 5 分钟里用户压根没碰过便签——那是白锁。
#[derive(Default)]
pub struct NoteIdle {
    last_ms: AtomicI64,
}

impl NoteIdle {
    pub fn stamp(&self, now: i64) {
        self.last_ms.store(now, Ordering::Relaxed);
    }

    pub fn last(&self) -> i64 {
        self.last_ms.load(Ordering::Relaxed)
    }
}

/// 设置值 → 分钟数。`0` = 不锁；非数字、负数、认不得的值一律按默认档。
pub fn minutes_from(stored: Option<String>) -> i64 {
    match stored.and_then(|raw| raw.trim().parse::<i64>().ok()) {
        Some(n) if (0..=1440).contains(&n) => n,
        _ => DEFAULT_MINUTES,
    }
}

/// 到点该不该锁。纯函数，判定只问这一格（线程那圈壳没有可测的东西）。
/// `last == 0`（起点还没摆过）一律不锁——那时"多久没动"这个问题还没有答案。
fn should_lock(now: i64, last: i64, minutes: i64, unlocked: bool) -> bool {
    unlocked && minutes > 0 && last > 0 && now - last >= minutes * 60_000
}

/// 起循环。**必须在 `manage::<NoteIdle>` 与 `manage::<PrivateVault>` 之后调用**。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(CHECK_EVERY);
        // 上锁这个动作在三个 State 借用还活着时做，广播留到外面发（emit 要的
        // AppHandle 正是它们借出来的那个）。主库没开成（应用照常起，走的是明确
        // 错误界面）或状态没就位，这一轮整个跳过。
        let mut just_locked: Option<i64> = None;
        if let (Some(db), Some(vault), Some(idle)) = (
            app.try_state::<Db>(),
            app.try_state::<PrivateVault>(),
            app.try_state::<NoteIdle>(),
        ) {
            let now = clock::now_ms();
            if idle.last() == 0 {
                // 第一轮只摆起点：这一刻还没有人在便签里待过，锁了是白锁
                idle.stamp(now);
            } else {
                let minutes = minutes_from(
                    settings::get(db.inner(), AUTO_LOCK_SETTING_KEY).ok().flatten(),
                );
                if should_lock(now, idle.last(), minutes, vault.is_unlocked()) {
                    private::lock(&vault);
                    just_locked = Some(minutes);
                }
            }
        }
        if let Some(minutes) = just_locked {
            // 广播走与托盘那条锁路同一个事件：所有窗重读状态 → 遮罩当场落下。
            // writer 用 "autolock" 而不是某个窗的 label——发起方压根不是一扇窗。
            let _ = app.emit("store:private-changed", "autolock");
            log::info(
                "autolock",
                &format!("便签窗内 {minutes} 分钟无操作，私密层已自动上锁"),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    /// 脏值的口径是"按默认档"，不是"关掉"——这条开关关掉比开着危险
    #[test]
    fn 档位解析_只有显式零才算不锁() {
        assert_eq!(minutes_from(None), DEFAULT_MINUTES);
        assert_eq!(minutes_from(Some(String::new())), DEFAULT_MINUTES);
        assert_eq!(minutes_from(Some("5".into())), 5);
        assert_eq!(minutes_from(Some(" 15 ".into())), 15);
        assert_eq!(minutes_from(Some("0".into())), 0, "显式 0 = 不锁");
        assert_eq!(minutes_from(Some("yes".into())), DEFAULT_MINUTES);
        assert_eq!(minutes_from(Some("-1".into())), DEFAULT_MINUTES);
        assert_eq!(minutes_from(Some("99999".into())), DEFAULT_MINUTES);
    }

    #[test]
    fn 到点就锁_没到点不锁_没解锁不锁() {
        let now = 1_700_000_000_000;
        assert!(should_lock(now, now - 5 * MIN, 5, true));
        assert!(
            !should_lock(now, now - 5 * MIN + 1, 5, true),
            "差一毫秒不算到点"
        );
        assert!(!should_lock(now, now - 60 * MIN, 5, false), "锁着就没什么可锁");
        assert!(!should_lock(now, now - 60 * MIN, 0, true), "0 档 = 不锁");
    }

    /// 从没动过便签（时钟还是 0）时不许当场锁人——`spawn` 的第一轮先拨起点，
    /// 这条判据保证"万一先跑到判定"也不会锁
    #[test]
    fn 起点没摆之前不锁() {
        assert!(!should_lock(1_700_000_000_000, 0, 5, true));
    }
}
