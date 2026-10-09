// 私密层命令 — 前端与封套之间唯一的通道。重活（派生/加解密/文件 IO）走 run_task。
// 每条写命令完成后广播 `store:private-changed`（writer 为调用方 label）——
// 全局状态变化，所有窗（包括自己）都要重读状态。

use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::data::private::{self, PrivateVault};
use crate::support::error::AppResult;
use crate::support::log;

use super::{run_db, run_task};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateStatus {
    pub configured: bool,
    pub unlocked: bool,
}

fn emit_changed(win: &WebviewWindow) {
    let _ = win.app_handle().emit("store:private-changed", win.label());
}

#[tauri::command]
pub async fn private_status(vault: State<'_, PrivateVault>) -> AppResult<PrivateStatus> {
    let vault = vault.inner().clone();
    Ok(PrivateStatus {
        configured: vault.is_configured(),
        unlocked: vault.is_unlocked(),
    })
}

#[tauri::command]
pub async fn private_setup(
    win: WebviewWindow,
    vault: State<'_, PrivateVault>,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    run_task(move || private::setup(&vault, &password)).await?;
    emit_changed(&win);
    Ok(())
}

#[tauri::command]
pub async fn private_unlock(
    win: WebviewWindow,
    vault: State<'_, PrivateVault>,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    run_task(move || private::unlock(&vault, &password)).await?;
    emit_changed(&win);
    Ok(())
}

#[tauri::command]
pub async fn private_lock(vault: State<'_, PrivateVault>) -> AppResult<()> {
    let vault = vault.inner().clone();
    private::lock(&vault);
    Ok(())
}

#[tauri::command]
pub async fn private_load(vault: State<'_, PrivateVault>) -> AppResult<String> {
    let vault = vault.inner().clone();
    run_task(move || private::load_data(&vault)).await
}

#[tauri::command]
pub async fn private_save(
    win: WebviewWindow,
    vault: State<'_, PrivateVault>,
    data: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    run_task(move || private::save_data(&vault, &data)).await?;
    emit_changed(&win);
    Ok(())
}

#[tauri::command]
pub async fn private_rekey(
    win: WebviewWindow,
    vault: State<'_, PrivateVault>,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    run_task(move || private::rekey(&vault, &password)).await?;
    emit_changed(&win);
    Ok(())
}

#[tauri::command]
pub async fn private_reset(
    win: WebviewWindow,
    db: State<'_, crate::db::pool::Db>,
    vault: State<'_, PrivateVault>,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    let database = db.inner().clone();
    run_task(move || private::reset(&vault, &password)).await?;
    // 重置换的是**新**媒体密钥：旧的那些私密图字节从此再也解不开。留着既占地方，
    // 又让人以为"图还在"——一并清掉，与"重置清空全部私密内容"同一条口径
    let purged = run_db(database, crate::db::query::media::purge_encrypted).await?;
    log::info(
        "private",
        &format!("重置：同时清掉 {purged} 张再也解不开的私密图"),
    );
    emit_changed(&win);
    Ok(())
}
