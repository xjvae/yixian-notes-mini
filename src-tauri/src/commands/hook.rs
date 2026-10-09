// 钩子命令 — 设置界面的劫持配置（阈值/白名单/暂停/充电弧）与运行态回读。
//
// 口令纪律（hotkeys 同款）：hold_ms 由 Rust 夹回区间，界面上显示的就是实际跑的值；
// 白名单写入即归一化，界面上显示的**永远是 Rust 回传的那份生效名单**。
// paused 刻意不落库（见 input/mod.rs），charging 落库（关掉了就一直是关的）。

use serde::Serialize;

use crate::input;
use crate::support::error::{AppError, AppResult};

pub const HOLD_MS_KEY: &str = "ring.trigger.hold_ms";
pub const WHITELIST_KEY: &str = "hook.whitelist";
pub const CHARGING_KEY: &str = "ring.charging";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub paused: bool,
    pub hold_ms: u32,
    pub whitelist: Vec<String>,
    /// 长按引导期的充电弧（关掉=长按过程中零反馈，见 windows/ring.rs）
    pub charging: bool,
    /// 最近采样的前台进程基名；None = 读不到（提权程序等），界面要说明这一点
    pub foreground: Option<String>,
}

#[tauri::command]
pub async fn hook_status() -> HookStatus {
    HookStatus {
        paused: input::is_paused(),
        hold_ms: input::hold_ms(),
        whitelist: input::whitelist(),
        charging: input::charging(),
        foreground: input::foreground_name(),
    }
}

/// 改劫持配置。四项独立可选，只动传来的那几项。
#[tauri::command]
pub async fn hook_set_config(
    db: tauri::State<'_, crate::db::pool::Db>,
    paused: Option<bool>,
    hold_ms: Option<u32>,
    charging: Option<bool>,
    whitelist: Option<Vec<String>>,
) -> AppResult<()> {
    let db = db.inner().clone();
    if let Some(paused) = paused {
        input::set_paused(paused);
    }
    if let Some(charging) = charging {
        input::set_charging(charging);
        super::run_db(db.clone(), move |db| {
            crate::db::query::settings::set(db, CHARGING_KEY, if charging { "1" } else { "0" })
        })
        .await?;
    }
    if let Some(hold_ms) = hold_ms {
        input::set_hold_ms(hold_ms);
        let effective = input::hold_ms();
        super::run_db(db.clone(), move |db| {
            crate::db::query::settings::set(db, HOLD_MS_KEY, &effective.to_string())
        })
        .await?;
        if effective != hold_ms {
            return Err(AppError::new(
                "HOLD_MS_CLAMPED",
                format!("阈值已被夹到 {effective} 毫秒"),
            ));
        }
    }
    if let Some(raws) = whitelist {
        input::set_whitelist(&raws);
        let list = input::whitelist();
        let json = serde_json::to_string(&list)
            .map_err(|e| AppError::new("SERIALIZE", e.to_string()))?;
        super::run_db(db, move |db| {
            crate::db::query::settings::set(db, WHITELIST_KEY, &json)
        })
        .await?;
    }
    Ok(())
}
