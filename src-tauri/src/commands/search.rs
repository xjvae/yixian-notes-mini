// 检索命令 — 搜索窗的取数入口。

use tauri::State;

use crate::db::pool::Db;
use crate::db::query::search::{self, SearchHit};
use crate::support::error::AppResult;

use super::run_db;

#[tauri::command]
pub async fn search_query(db: State<'_, Db>, query: String) -> AppResult<Vec<SearchHit>> {
    let db = db.inner().clone();
    run_db(db, move |db| search::search(db, &query)).await
}
