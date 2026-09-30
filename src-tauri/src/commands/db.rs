// 引导命令 — 首屏一次 IPC 拿齐挂载前需要的数据。

use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::db::models::StickyRow;
use crate::db::pool::Db;
use crate::db::query::{settings, sticky};
use crate::support::error::{AppError, AppResult};
use crate::support::{clock, log};

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

/// 立即备份：`VACUUM INTO` 产出一份干净快照（含 WAL 内容、独立可开），
/// 存到数据目录的 backups/ 下，返回完整路径。
#[tauri::command]
pub async fn data_backup(db: State<'_, Db>) -> AppResult<String> {
    let db = db.inner().clone();
    run_db(db, |db| {
        let backups = db.dir().join("backups");
        std::fs::create_dir_all(&backups)
            .map_err(|e| AppError::new("BACKUP", format!("备份目录建不出来：{e}")))?;
        let path = backups.join(format!("mini-{}.db", clock::timestamp_label(clock::now_ms())));
        db.lock()
            .execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])?;
        log::info("backup", &format!("已备份到 {}", path.display()));
        Ok(path.to_string_lossy().to_string())
    })
    .await
}
