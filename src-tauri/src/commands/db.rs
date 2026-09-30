// 引导命令 — 首屏一次 IPC 拿齐挂载前需要的数据。

use serde::Serialize;
use tauri::State;

use crate::db::models::StickyRow;
use crate::db::pool::Db;
use crate::db::query::{settings, sticky};
use crate::support::error::AppResult;

use super::run_db;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub stickies: Vec<StickyRow>,
}

#[tauri::command]
pub async fn get_bootstrap(db: State<'_, Db>) -> AppResult<Bootstrap> {
    let db = db.inner().clone();
    run_db(db, |db| {
        Ok(Bootstrap {
            stickies: sticky::list(db, false)?,
        })
    })
    .await
}

/// 写设置项。value 是字符串（"0" = 显式关）；键名与解析归各设置模块（M2 起）。
#[tauri::command]
pub async fn settings_set(db: State<'_, Db>, key: String, value: String) -> AppResult<()> {
    let db = db.inner().clone();
    run_db(db, move |db| settings::set(db, &key, &value)).await
}
