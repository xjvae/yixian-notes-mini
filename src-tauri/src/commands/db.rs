// 引导命令 — 首屏一次 IPC 拿齐挂载前需要的数据。

use serde::Serialize;
use tauri::State;

use crate::db::models::StickyRow;
use crate::db::pool::Db;
use crate::db::query::sticky;
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
