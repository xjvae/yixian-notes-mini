// 快捷键命令 — 改键（校验 + 热重绑 + 落库）。

use tauri::{AppHandle, State};

use crate::db::pool::Db;
use crate::hotkeys;
use crate::support::error::AppResult;

use super::run_db;

/// 改一条绑定。key 空串 = 停用；失败（被占用/不合法）旧键自动还原，错误码见 hotkeys。
#[tauri::command]
pub async fn app_set_hotkey(
    app: AppHandle,
    db: State<'_, Db>,
    action: String,
    key: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    run_db(db, move |db| hotkeys::set_binding(&app, db, &action, &key)).await
}
