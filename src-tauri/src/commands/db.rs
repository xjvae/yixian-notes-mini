// 引导命令 — 首屏一次 IPC 拿齐挂载前需要的数据。

use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::data::private::PrivateVault;
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
pub async fn get_bootstrap(
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
) -> AppResult<Bootstrap> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    run_db(db, move |db| {
        Ok(Bootstrap {
            stickies: sticky::list(db, &vault, false)?,
        })
    })
    .await
}

/// 写设置项。value 是字符串（"0" = 显式关）；键名与解析归各设置模块。
/// 写完广播 kind:"setting"——scheme 等监听方各自重读（payload 不带值）。
#[tauri::command]
pub async fn settings_set(
    win: WebviewWindow,
    db: State<'_, Db>,
    key: String,
    value: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    run_db(db, move |db| settings::set(db, &key, &value)).await?;
    let payload = serde_json::json!({ "writer": win.label(), "kind": "setting" });
    let _ = win.app_handle().emit("db:changed", payload);
    Ok(())
}

/// 读单个设置项。scheme 等启动期需要的键在各自模块里经它取值。
#[tauri::command]
pub async fn settings_get(db: State<'_, Db>, key: String) -> AppResult<Option<String>> {
    let db = db.inner().clone();
    run_db(db, move |db| settings::get(db, &key)).await
}

/// 立即备份 = 打一份快照（`snapshot::create`：库 + 配套私密封套，并清到只留最新若干份）。
/// 返回那份 .db 的完整路径——设置窗那句"已备份到 …"回显的就是它，口径没变。
#[tauri::command]
pub async fn data_backup(db: State<'_, Db>, vault: State<'_, PrivateVault>) -> AppResult<String> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    run_db(db, move |db| {
        let label = super::snapshot::create(db, &vault)?;
        Ok(super::snapshot::db_path(&super::snapshot::backups_dir(db), &label)
            .to_string_lossy()
            .to_string())
    })
    .await
}
