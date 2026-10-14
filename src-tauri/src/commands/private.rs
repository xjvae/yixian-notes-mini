// 私密层命令 — 前端与封套之间唯一的通道。重活（派生/加解密/文件 IO）走 run_task。
// 一扇口令门开**一张**：`private_reveal` 只把那一张的钥匙放进内存，别的便签连密文都解不开；
// `PrivateStatus` 交回**已揭开的那几张**，前端据此决定每一张蒙不蒙。
// 广播 `store:private-changed` 只在全局状态变化时发（设置/揭开/收回/改密/重置/快照恢复）；
// 内容落库走 `sticky_upsert` 的 `db:changed`，不再触发它。
// 口令命令完成后拨 NoteIdle 时钟——人在口令窗输密码那段不算"便签内无操作"，否则自动上锁提前起数。

use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewWindow};

use crate::autolock::NoteIdle;
use crate::data::private::{self, PrivateVault};
use crate::db::pool::Db;
use crate::db::query::{private_note, settings};
use crate::support::error::{AppError, AppResult};
use crate::support::{clock, log};
use crate::windows::unlock;

use super::{run_db, run_task};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateStatus {
    pub configured: bool,
    /// 盘上那份读不出来。与 configured=false 同时出现时意思是"有东西但打不开"，
    /// 前端据此不再摆"设置口令"那张脸（那条路只会覆盖掉唯一那份材料）
    pub damaged: bool,
    /// **已揭开的那几张**的 id，前端据此决定每一张蒙不蒙
    pub revealed: Vec<String>,
}

fn emit_changed(win: &WebviewWindow) {
    let _ = win.app_handle().emit("store:private-changed", win.label());
}

#[tauri::command]
pub async fn private_status(vault: State<'_, PrivateVault>) -> AppResult<PrivateStatus> {
    let vault = vault.inner().clone();
    Ok(PrivateStatus {
        configured: vault.is_configured(),
        damaged: vault.is_damaged(),
        revealed: vault.revealed_ids(),
    })
}

#[tauri::command]
pub async fn private_setup(
    win: WebviewWindow,
    vault: State<'_, PrivateVault>,
    idle: State<'_, NoteIdle>,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    run_task({
        let vault = vault.clone();
        move || private::setup(&vault, &password)
    })
    .await?;
    // 这一刻**不**收编已有私密标记的张：那步要拿 master 现造钥匙，而 master 只在揭开某张那一拍
    // 活着——等第一张被揭开时顺带做（见 reveal）。时钟口径见文件头。
    idle.stamp(clock::now_ms());
    emit_changed(&win);
    Ok(())
}

/// 揭开**那一张**：口令 → master → 那张自己的钥匙。
/// 顺带做只有握着 master 才做得到的全局活（`private_note::reveal` 第 1 步），
/// 再补一发孤儿收割（便签行没了而密文/键行留着的；不需要密钥，挑此刻最省事）。
#[tauri::command]
pub async fn private_reveal(
    win: WebviewWindow,
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    idle: State<'_, NoteIdle>,
    note_id: String,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    let database = db.inner().clone();
    let for_event = note_id.clone();
    run_db(database.clone(), {
        let vault = vault.clone();
        move |db| private_note::reveal(db, &vault, &note_id, &password)
    })
    .await?;
    run_db(database, move |db| {
        let conn = db.lock();
        private_note::reap_orphans(&conn, &vault.revealed_ids())
    })
    .await
    .inspect_err(|e| log::warn("private", &format!("收割孤儿密文条目失败（下次揭开再试）：{e}")))
    .ok();
    idle.stamp(clock::now_ms());
    emit_changed(&win);
    emit_verified(&win, unlock::UnlockPurpose::Reveal, &for_event);
    Ok(())
}

/// 只验身份，**不开任何一张**：删除那道门要的是"证明你知道口令"，不是把那张摊开给人看。
/// 走完这一发被删的那张仍然蒙着 —— 否则删完反而把它亮出来了
#[tauri::command]
pub async fn private_verify(
    win: WebviewWindow,
    vault: State<'_, PrivateVault>,
    idle: State<'_, NoteIdle>,
    intent: State<'_, unlock::IntentState>,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    run_task(move || private::master_of(&vault, &password).map(|_| ())).await?;
    idle.stamp(clock::now_ms());
    // 挂起的删除动作等的就是这一声（窗关了不算：放弃也是窗自己关的）
    if let Some(current) = intent.current() {
        let _ = win.app_handle().emit(unlock::VERIFIED_EVENT, current);
    }
    Ok(())
}

/// 「这一发口令过了」——挂起的那一下由它落地（口径与理由见 `windows::unlock::VERIFIED_EVENT`）
fn emit_verified(win: &WebviewWindow, purpose: unlock::UnlockPurpose, note_id: &str) {
    let _ = win.app_handle().emit(
        unlock::VERIFIED_EVENT,
        unlock::UnlockIntent {
            note_id: note_id.to_string(),
            purpose,
        },
    );
}

/// 便签窗内"动了一下"（前端自节流上报）：只拨时钟，不碰封套，所以不广播。
#[tauri::command]
pub async fn private_note_activity(idle: State<'_, NoteIdle>) -> AppResult<()> {
    idle.stamp(clock::now_ms());
    Ok(())
}

/// 收回**全部**（口令窗里的"锁上"、托盘「立即锁定」、自动上锁都走这一格）。
/// 逐张模型里没有"只锁一层"的半动作：一次擦干净，界面上所有私密便签同时回蒙版
#[tauri::command]
pub async fn private_lock(win: WebviewWindow, vault: State<'_, PrivateVault>) -> AppResult<()> {
    let vault = vault.inner().clone();
    private::lock(&vault);
    // 与托盘「立即锁定」同一个动作就发同一条广播。少了它，动手那一窗缓存停在"已解锁"，内容照旧摊着。
    emit_changed(&win);
    Ok(())
}

/// 改密：三步——`rekey_stage`（验旧口令、造新封套落到 pending）→ 库里那一拍（重裹键行 + 写标记，
/// 一个事务）→ `rekey_finish`（把 pending 提成 live）。
/// 正文、历史、图片字节一个都不动（改的是包钥匙的那 32 字节×N 张）——逐张钥匙这一层正是这句能成立的原因。
/// 最后那步失败不 rollback：pending 与标记都还在，**下次启动自己补完**（`recover_stage`），
/// 而"重裹完了而封套没换上"那个死形已经被这两样事实堵住了。
#[tauri::command]
pub async fn private_rekey(
    win: WebviewWindow,
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    idle: State<'_, NoteIdle>,
    password: String,
    new_password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    let database = db.inner().clone();
    let moved = run_task({
        let database = database.clone();
        move || {
            private::rekey(&vault, &password, &new_password, |from, to| {
                let conn = database.lock();
                private_note::rewrap_and_mark(&conn, from, to)
            })
        }
    })
    .await
    .map_err(defer_if_write_failed)?;
    clear_stage_marker(&database).await;
    log::info("private", &format!("改密：{moved} 张的钥匙按新口令重裹了一遍"));
    idle.stamp(clock::now_ms());
    emit_changed(&win);
    Ok(())
}

/// 换封套那一步没落盘 ≠ 改密丢了：留底与标记都在，下次启动 `recover_stage` 自己补完。
/// 这一格只把错误换个说法，逻辑一步都不多做
fn defer_if_write_failed(e: AppError) -> AppError {
    if e.code != "PRIVATE_WRITE" {
        return e;
    }
    AppError::new(
        "REKEY_DEFERRED",
        format!(
            "改密的最后一步没落盘（{e}）：库里那些钥匙已经按新口令重裹好，\
             **重启一次应用**就补完这一步，届时请用刚设的新口令。"
        ),
    )
}

/// 换完封套就该清掉那一格标记。清不掉不影响正确性（启动那趟认"标记在而 pending 不在 = 只差清标记"），
/// 所以这一发失败只记日志
async fn clear_stage_marker(database: &Db) {
    let result = run_db(database.clone(), |db| {
        let conn = db.lock();
        settings::remove_conn(&conn, private::STAGE_MARKER_KEY)
    })
    .await;
    if let Err(e) = result {
        log::warn("private", &format!("改密/重置的标记没清掉（下次启动自己收尾）：{e}"));
    }
}

/// 忘记密码的唯一出路：清空全部私密内容，换成新口令的新封套。只允许在一张都没开着时走。
/// 与改密同样的三步（留底 → 库里那一拍清空 + 写标记，一个事务 → 换封套），
/// 所以被杀在任何一步都有明确的处置：库里那一拍没成就丢掉留底，成了就启动时补上换封套。
#[tauri::command]
pub async fn private_reset(
    win: WebviewWindow,
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    idle: State<'_, NoteIdle>,
    password: String,
) -> AppResult<()> {
    let vault = vault.inner().clone();
    let database = db.inner().clone();
    let purged = run_task({
        let database = database.clone();
        move || {
            private::reset(&vault, &password, || {
                let conn = database.lock();
                private_note::purge_and_mark(&conn)
            })
        }
    })
    .await
    .map_err(|e| {
        if e.code != "PRIVATE_WRITE" {
            return e;
        }
        AppError::new(
            "RESET_DEFERRED",
            format!(
                "重置的最后一步没落盘（{e}）：私密内容已经清空，**重启一次应用**就把新封套换上；\
                 在那之前旧口令还算数。"
            ),
        )
    })?;
    clear_stage_marker(&database).await;
    log::info(
        "private",
        &format!("重置：清掉 {purged} 条再也解不开的私密内容、版本、钥匙与私密图"),
    );
    // 与 setup/reveal/rekey 同一口径：口令命令完成后拨 NoteIdle 时钟（见文件头）
    idle.stamp(clock::now_ms());
    emit_changed(&win);
    Ok(())
}
