// 快照 — 整库历史快照的产出、列出与一键恢复。
// 一份快照 = `backups\mini-<label>.db`（`VACUUM INTO` 的干净副本）**加一份同名的
// `mini-<label>.private.json`**：主库里的私密行只有空占位，真身全在 private.json 里，
// 只恢复主库等于恢复出一库指向错乱的空壳；缺配套封套的老快照恢复时如实说出来。
// 恢复不动进程：ATTACH 快照 → 每张表整表换过去 → DETACH，被 ATTACH 的库与主库同属一个
// 事务，中途失败就是整笔回滚。换完强制上锁：内存里那把会话密钥对应的是**旧**封套。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::data::private::{self, PrivateVault};
use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};
use crate::support::{clock, log};

use super::run_db;

/// 保留最新多少份（含配套封套）。再往后的价值低于在目录里堆几百个文件
pub const KEEP: usize = 10;
/// 整库要换过去的表。全库正好这几张（见 `db/migrate.rs`），**加表必须加在这里**——
/// 漏一张（历史版本就漏过）等于恢复后一次"回滚上一版"能把刚丢掉的内容原样塞回来。
/// 老快照缺的表整张跳过而不是报错；对不上号的私密残骸由解锁时的孤儿清理收掉。
const TABLES: [&str; 9] = [
    "stickies",
    "groups",
    "settings",
    "window_state",
    "media",
    "sticky_revisions",
    "private_content",
    "private_revision",
    "private_keys",
];
const DB_PREFIX: &str = "mini-";
const DB_SUFFIX: &str = ".db";
const ENVELOPE_SUFFIX: &str = ".private.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// `20261012-094703` 形态。恢复只认这个形状，别的字符串一律不进文件系统
    pub label: String,
    pub bytes: u64,
    /// 文件改动时间（毫秒）。label 本身就是本地时间，取 mtime 只为如实显示
    pub created_at: i64,
    /// 这份快照带不带配套封套；不带 = 恢复后私密真身仍是当前那份
    pub has_envelope: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: String,
    /// 恢复**之前**那一瞬的状态被存成了哪一份（选错了还能一键回到这里）
    pub safety_label: String,
    pub envelope_restored: bool,
    /// 不阻断恢复、但必须让人看见的话（例如这份快照没有配套封套）
    pub warning: Option<String>,
}

pub fn backups_dir(db: &Db) -> PathBuf {
    db.dir().join("backups")
}

pub fn db_path(dir: &Path, label: &str) -> PathBuf {
    dir.join(format!("{DB_PREFIX}{label}{DB_SUFFIX}"))
}

fn envelope_backup_path(dir: &Path, label: &str) -> PathBuf {
    dir.join(format!("{DB_PREFIX}{label}{ENVELOPE_SUFFIX}"))
}

/// label 的合法形状：`YYYYMMDD-HHMMSS`，允许同秒避让用的 `-<序号>` 尾巴。它同时是文件名的
/// 一部分，这一格校验就是防路径穿越那一道——**恢复的入参来自前端**，不校验等于把文件名交给前端拼。
fn label_is_valid(label: &str) -> bool {
    let bytes = label.as_bytes();
    if bytes.len() < 15 || bytes.len() > 18 {
        return false;
    }
    let (stamp, tail) = if bytes.len() == 15 {
        (bytes, &b""[..])
    } else {
        if bytes[15] != b'-' {
            return false;
        }
        (&bytes[..15], &bytes[16..])
    };
    let stamp_ok = stamp[..8].iter().all(u8::is_ascii_digit)
        && stamp[8] == b'-'
        && stamp[9..].iter().all(u8::is_ascii_digit);
    let tail_ok = if bytes.len() == 15 {
        true
    } else {
        !tail.is_empty() && tail.iter().all(u8::is_ascii_digit)
    };
    stamp_ok && tail_ok
}

/// 同一秒里再打一份时往后缀避让：`VACUUM INTO` 拒绝覆盖已存在的文件，一秒点两次与
/// 恢复的安全网撞上刚打的那一份都会走到这里。
fn free_label(dir: &Path, stamp: &str) -> String {
    if !db_path(dir, stamp).exists() {
        return stamp.to_string();
    }
    (2..=99)
        .map(|n| format!("{stamp}-{n}"))
        .find(|candidate| !db_path(dir, candidate).exists())
        .unwrap_or_else(|| format!("{stamp}-99"))
}

fn label_from_file_name(name: &str) -> Option<String> {
    let label = name.strip_prefix(DB_PREFIX)?.strip_suffix(DB_SUFFIX)?;
    label_is_valid(label).then(|| label.to_string())
}

fn mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn bytes_of(path: &Path) -> u64 {
    path.metadata().map(|meta| meta.len()).unwrap_or(0)
}

/// 产出一份快照（库 + 封套），顺手把超额的旧份清掉。返回新快照的 label。
pub fn create(db: &Db, vault: &PrivateVault) -> AppResult<String> {
    let dir = backups_dir(db);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::new("BACKUP", format!("备份目录建不出来：{e}")))?;
    let label = free_label(&dir, &clock::timestamp_label(clock::now_ms()));
    db.lock()
        .execute("VACUUM INTO ?1", [db_path(&dir, &label).to_string_lossy().as_ref()])?;
    // 封套原样拷一份：它是已加密的落盘形状，拷字节就够了，不需要口令
    let envelope = private::envelope_path(vault.dir());
    if envelope.exists() {
        std::fs::copy(&envelope, envelope_backup_path(&dir, &label))
            .map_err(|e| AppError::new("BACKUP", format!("私密封套没拷出去：{e}")))?;
    }
    let left = prune(&dir)?;
    log::info(
        "backup",
        &format!("快照 {label} 已存（保留最新 {KEEP} 份，清完剩 {left} 份）"),
    );
    Ok(label)
}

/// 只留最新 `KEEP` 份，返回剩下几份。删失败不炸：多留一份旧快照不是错误，把恢复这条路整个弄挂才是
fn prune(dir: &Path) -> AppResult<usize> {
    let mut labels = list_labels(dir)?;
    // label 就是零填充的本地时间，字符串序 = 时间序
    labels.sort_unstable_by(|a, b| b.cmp(a));
    if labels.len() > KEEP {
        // split_off 的下标越过 len 会当场 panic，所以先判：不足 KEEP 份时一个都不许删
        for stale in labels.split_off(KEEP) {
            for path in [db_path(dir, &stale), envelope_backup_path(dir, &stale)] {
                if path.exists() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
    Ok(labels.len())
}

fn list_labels(dir: &Path) -> AppResult<Vec<String>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| AppError::new("BACKUP", format!("备份目录读不动：{e}")))?;
    let mut labels = Vec::new();
    for entry in entries {
        let name = entry
            .map_err(|e| AppError::new("BACKUP", format!("备份目录里有一项读不出：{e}")))?
            .file_name()
            .to_string_lossy()
            .to_string();
        if let Some(label) = label_from_file_name(&name) {
            labels.push(label);
        }
    }
    Ok(labels)
}

/// 列出全部快照，新的在前。
pub fn list(db: &Db) -> AppResult<Vec<Snapshot>> {
    let dir = backups_dir(db);
    let mut rows = Vec::new();
    for label in list_labels(&dir)? {
        let path = db_path(&dir, &label);
        rows.push(Snapshot {
            has_envelope: envelope_backup_path(&dir, &label).exists(),
            bytes: bytes_of(&path),
            created_at: mtime_ms(&path),
            label,
        });
    }
    rows.sort_unstable_by(|a, b| b.label.cmp(&a.label));
    Ok(rows)
}

/// 一键恢复到指定快照。
///
/// 次序是定死的：**先验这份快照齐不齐 → 存安全网 → 换库 → 换封套**。换库排在换封套之前，
/// 因为库那一趟是一个事务（失败整笔回滚、现场原样），而封套是第二个文件——
/// 反过来做就是"封套已经换而库没换"，那一刻所有私密便签都对不上号。
/// 封套走 tmp+sync+rename（同 `private::write_atomic`），不拿 `fs::copy` 直接盖活的那份。
pub fn restore(
    db: &Db,
    vault: &PrivateVault,
    app: &AppHandle,
    label: &str,
) -> AppResult<RestoreReport> {
    if !label_is_valid(label) {
        return Err(AppError::new(
            "SNAPSHOT_LABEL",
            format!("认不得的快照名：{label}"),
        ));
    }
    let dir = backups_dir(db);
    let source = db_path(&dir, label);
    if !source.exists() {
        return Err(AppError::new(
            "SNAPSHOT_MISSING",
            format!("没有这份快照：{label}"),
        ));
    }
    // 验完再动任何东西：这两条都是"这份快照恢复不得"，报错时库与封套都还是原样
    let (absent_tables, sealed_rows) = inspect_source(&source)?;
    if !absent_tables.is_empty() {
        return Err(AppError::new(
            "SNAPSHOT_SCHEMA",
            format!(
                "这份快照早于私密层（没有 {}）：恢复它会把带私密标记的行换回来，而当前那批密文与键行\
                 留在原地再也对不上号，且界面上什么都看不出来。要么选一份后来的快照，\
                 要么先用「重置私密密码」清空私密内容再恢复这一份。",
                absent_tables.join("、")
            ),
        ));
    }
    let envelope_snapshot = envelope_backup_path(&dir, label);
    if sealed_rows > 0 && !envelope_snapshot.exists() {
        return Err(AppError::new(
            "SNAPSHOT_ENVELOPE",
            format!(
                "这份快照里有 {sealed_rows} 张私密便签的密文，却没有配套的封套（那份文件没跟着备份或被删了）：\
                 恢复过去这些张永远解不开。库与封套都没有动过。"
            ),
        ));
    }
    // 先给"恢复前的现在"存一份安全网（选错了能一键回到这里）：排在换表之前才留得下现场
    let safety = create(db, vault)?;
    // 上面那次清理可能正好把要恢复的挤掉（它是最老的那批）：此刻库还没动过，直接说清楚
    if !source.exists() {
        return Err(AppError::new(
            "SNAPSHOT_PRUNED",
            format!("快照 {label} 刚被保留策略清掉，库没有动过；可从 {safety} 之后重选"),
        ));
    }
    let mut warning = None;
    let missing = swap_tables(&db.lock(), &source)?;
    if envelope_snapshot.exists() {
        let bytes = std::fs::read(&envelope_snapshot)
            .map_err(|e| AppError::new("SNAPSHOT", format!("快照封套读不出来：{e}")))?;
        private::write_atomic(vault.dir(), &private::envelope_path(vault.dir()), &bytes)
            .map_err(|e| AppError::new("SNAPSHOT", format!("私密封套没换回来：{e}")))?;
        // 盘上那份换了：内存里的 configured/damaged 要跟着重算，否则拒写/放行都对不上新那份
        vault.rescan();
    }
    if !missing.is_empty() {
        let note = format!(
            "这份快照的 schema 里没有表 {}：那几张保持恢复前的内容，没有被换掉。",
            missing.join("、")
        );
        log::warn("backup", &note);
        warning = Some(match warning {
            Some(existing) => format!("{existing} {note}"),
            None => note,
        });
    }
    private::lock(vault);
    log::info(
        "backup",
        &format!("已恢复到快照 {label}（恢复前的状态存为 {safety}）"),
    );
    emit_all(app);
    let _ = prune(&dir);
    Ok(RestoreReport {
        restored: label.to_string(),
        safety_label: safety,
        envelope_restored: envelope_snapshot.exists(),
        warning,
    })
}

/// 恢复前要先验的三张私密表。缺任何一张 = 这份快照早于私密层（1.2.9 之前）：
/// 它那些 `private=1` 的行没有配套的密文表可换，而当前库里那些条留在原地再也对不上号
const PRIVATE_TABLES: [&str; 3] = ["private_content", "private_revision", "private_keys"];

/// 验这份快照能不能恢复：缺哪几张私密表、里面有几种密文。只读打开，动不到任何东西
fn inspect_source(source: &Path) -> AppResult<(Vec<&'static str>, i64)> {
    let snap = Connection::open_with_flags(
        source,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut absent: Vec<&'static str> = Vec::new();
    for table in PRIVATE_TABLES {
        let n: i64 = snap.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        if n != 1 {
            absent.push(table);
        }
    }
    let sealed = if absent.contains(&"private_content") {
        0
    } else {
        snap.query_row("SELECT COUNT(*) FROM private_content", [], |row| row.get(0))?
    };
    Ok((absent, sealed))
}

/// 每张表整表换成快照里那份。同属一个事务：中途任何一步失败 = 整笔回滚。
/// 返回快照里根本没有的表名（老快照缺 `sticky_revisions` / `media`），调用方如实报出去。
fn swap_tables(conn: &Connection, source: &Path) -> AppResult<Vec<&'static str>> {
    conn.execute("ATTACH DATABASE ?1 AS snap", [source.to_string_lossy().as_ref()])?;
    let mut missing: Vec<&'static str> = Vec::new();
    let result = (|| -> AppResult<()> {
        let tx = conn.unchecked_transaction()?;
        for table in TABLES {
            if !has_table(&tx, table)? {
                // 那张表是后来才加的，这份快照早于它：主库这张原样留着，别报错
                missing.push(table);
                continue;
            }
            // 列数对不上（快照来自更旧的 schema）当场报错、事务回滚，主库原样——半新半旧比恢复失败更糟
            tx.execute_batch(&format!(
                "DELETE FROM main.{table}; \
                 INSERT INTO main.{table} SELECT * FROM snap.{table};"
            ))?;
        }
        tx.commit()?;
        Ok(())
    })();
    // 换表成没成都要脱钩：留着 ATTACH 会让下一次 VACUUM INTO 报"库被占着"
    if let Err(e) = conn.execute("DETACH DATABASE snap", []) {
        log::warn("backup", &format!("快照脱钩失败（不影响本次结果）：{e}"));
    }
    result?;
    Ok(missing)
}

/// 快照（已 ATTACH 成 `snap`）里有没有这张表。表名只来自 `TABLES` 常量，不掺用户输入。
fn has_table(conn: &Connection, table: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM snap.sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(n == 1)
}

/// 恢复动了整库，三类变更全发（便签与组、设置、私密状态遮罩落下）；writer 用 "snapshot"——发起方不是一扇窗
fn emit_all(app: &AppHandle) {
    for kind in ["sticky", "group", "setting"] {
        let payload = serde_json::json!({ "writer": "snapshot", "kind": kind });
        let _ = app.emit("db:changed", payload);
    }
    let _ = app.emit("store:private-changed", "snapshot");
}

#[tauri::command]
pub async fn snapshot_list(
    db: State<'_, Db>,
) -> AppResult<Vec<Snapshot>> {
    let db = db.inner().clone();
    run_db(db, list).await
}

#[tauri::command]
pub async fn snapshot_restore(
    app: AppHandle,
    db: State<'_, Db>,
    vault: State<'_, PrivateVault>,
    label: String,
) -> AppResult<RestoreReport> {
    let db = db.inner().clone();
    let vault = vault.inner().clone();
    run_db(db, move |db| restore(db, &vault, &app, &label)).await
}

#[cfg(test)]
mod tests {
    /// 私密层没启用时的那把 vault：这些用例只测本模块的事，不该为它们各建一套封套
    fn off() -> crate::data::private::PrivateVault {
        crate::data::private::PrivateVault::disabled("snapshot")
    }

    use super::*;
    use crate::db::models::StickyInput;
    use crate::db::query::{revision, settings, sticky};
    use rusqlite::{params, Connection};

    #[test]
    fn 快照名只认那个形状() {
        assert!(label_is_valid("20261012-094703"));
        assert!(label_is_valid("20261012-094703-2"), "同秒避让的尾巴要认");
        assert!(!label_is_valid(""));
        assert!(!label_is_valid("..\\..\\evil"), "路径穿越进不来");
        assert!(!label_is_valid("20261012_094703"), "分隔符不对也不行");
        assert!(!label_is_valid("2026101-094703"), "少一位");
        assert!(!label_is_valid("20261012-094703x"));
        assert!(!label_is_valid("20261012-094703-"), "带分隔符却没序号");
        assert!(!label_is_valid("20261012-094703-2/.."));
        assert_eq!(
            label_from_file_name("mini-20261012-094703.db").as_deref(),
            Some("20261012-094703")
        );
        assert_eq!(label_from_file_name("mini-20261012-094703.private.json"), None);
        assert_eq!(label_from_file_name("notes.db"), None);
    }

    /// 一秒内连打两份：第二份不许撞 `VACUUM INTO` 的"文件已存在"，两份都得留下
    #[test]
    fn 同秒连打两份不互相覆盖() {
        let db = db_on_disk("same-second");
        let vault = PrivateVault::scan(db.dir());
        let first = create(&db, &vault).expect("第一份");
        let second = create(&db, &vault).expect("第二份（同一秒）");
        assert_ne!(first, second, "两份必须是两个名字");
        assert_eq!(list(&db).expect("列快照").len(), 2, "两份都数得着");
        let _ = std::fs::remove_dir_all(db.dir());
    }

    fn input(id: &str, title: &str) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: title.to_string(),
            body: String::new(),
            content_type: "text".into(),
            items: Vec::new(),
            timeline: Vec::new(),
            tags: Vec::new(),
            theme: "yellow".into(),
            pinned: true,
            floating: true,
            collapsed: false,
            is_private: false,
            group_id: None,
            x: None,
            y: None,
            width: None,
            height: None,
            due_at: None,
            done_at: None,
            repeat: "none".into(),
            deleted: false,
            docked: false,
            dock_edge: None,
            icon: None,
            auto_size: None,
        }
    }

    /// 临时目录名必须每次都不重——Windows 会复用 pid，只挂 pid 会读到上一轮留下的文件。
    fn temp_dir_for(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("yixian-snap-{tag}-{}-{nanos}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("临时目录");
        dir
    }

    /// 一个带临时文件的库：`create` 要往 `db.dir()/backups` 写东西，内存库没有目录，
    /// 而 `from_connection` 的 dir 是空串（写成相对路径就会落进仓库），所以给真目录。
    fn db_on_disk(tag: &str) -> Db {
        let dir = temp_dir_for(tag);
        let conn = Connection::open(dir.join("mini.db")).expect("临时库");
        let db = Db::from_connection_in(conn, &dir);
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    /// `TABLES` 那份清单必须与迁移产出的表**一一对得上**：加表没进名单 = 恢复时那张表原样留着
    /// 旧内容、不报错也不提示，库从此半新半旧。这种错只有从 `sqlite_master` 现读才拦得住。
    #[test]
    fn 迁移出的表与恢复名单一一对得上() {
        let db = db_on_disk("coverage");
        let conn = db.lock();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .expect("列表");
        let migrated: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("读表名")
            .map(|name| name.expect("一行表名"))
            .collect();
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(db.dir());

        assert!(!migrated.is_empty(), "迁移没建出任何表");
        for table in &migrated {
            assert!(
                TABLES.contains(&table.as_str()),
                "表 {table} 没进快照恢复名单：迁移加表要同时加 TABLES"
            );
        }
        for table in TABLES {
            assert!(
                migrated.iter().any(|name| name == table),
                "恢复名单里的 {table} 在库里根本不存在：名字写错了，或那张表已被删掉"
            );
        }
    }

    /// 恢复前那一趟验收：缺私密层哪张表就报哪张（`restore` 据此整趟拒绝，库与封套都不动），
    /// 三张齐就给个密文条数——有条数而没配套封套同样不许恢复
    #[test]
    fn 缺私密表的快照被验出来() {
        let db = db_on_disk("inspect");
        let vault = PrivateVault::scan(db.dir());
        let label = create(&db, &vault).expect("打快照");
        let source = db_path(&backups_dir(&db), &label);
        let (absent, sealed) = inspect_source(&source).expect("验");
        assert!(absent.is_empty(), "自己这份三张表都该有：{absent:?}");
        assert_eq!(sealed, 0, "还没写过私密内容");

        for missing in ["private_keys", "private_revision", "private_content"] {
            let fresh = create(&db, &vault).expect("再打一份");
            let path = db_path(&backups_dir(&db), &fresh);
            {
                let snap = Connection::open(&path).expect("开副本");
                snap.execute(&format!("DROP TABLE {missing}"), []).expect("删表");
            }
            let (absent, sealed) = inspect_source(&path).expect("再验");
            assert_eq!(absent, vec![missing], "缺的那张要报出来");
            assert_eq!(sealed, 0, "表都不齐时不去数它");
        }
        let _ = std::fs::remove_dir_all(db.dir());
    }

    /// 数密文条数：`restore` 拿它判"有私密内容却没有配套封套"这一种快照
    #[test]
    fn 验收数得出快照里有几张密文便签() {
        let db = db_on_disk("inspect-sealed");
        let vault = PrivateVault::scan(db.dir());
        let label = create(&db, &vault).expect("打快照");
        let path = db_path(&backups_dir(&db), &label);
        {
            let snap = Connection::open(&path).expect("开副本");
            for n in ["a", "b"] {
                snap.execute(
                    "INSERT INTO private_content (note_id, content, updated_at) VALUES (?1, ?2, 1)",
                    params![n, vec![7u8; 8]],
                )
                .expect("塞一条");
            }
        }
        let (absent, sealed) = inspect_source(&path).expect("验");
        assert!(absent.is_empty());
        assert_eq!(sealed, 2, "两条密文 = 两张要配套封套");
        let _ = std::fs::remove_dir_all(db.dir());
    }

    /// 钉住每张表整份换回那一刻：改过的退回、新增的没了、删掉的回来、设置与历史版本跟着回。
    /// 只测换表这一步——`restore` 外壳要 AppHandle 才能广播，为测它造一个不值。
    #[test]
    fn 换表把每张表整份换回快照那一刻() {
        let db = db_on_disk("swap");
        let vault = PrivateVault::scan(db.dir());
        sticky::upsert(&db, &off(), input("keep", "一直都在")).expect("写 keep");
        sticky::upsert(&db, &off(), input("gone", "快照里有它")).expect("写 gone");
        settings::set(&db, "theme", "light").expect("写设置");
        // 快照之前先给 keep 灌一版历史，让这份快照真的带着 `sticky_revisions`
        revision::record(&db.lock(), "keep", sticky::now_ms(), true, false).expect("灌一版");

        let label = create(&db, &vault).expect("打快照");
        assert!(list(&db).expect("列快照").iter().any(|row| row.label == label));

        // 快照之后：改一张、硬删快照里就有的一张、加一张、翻一个设置、再记一版
        sticky::upsert(&db, &off(), input("keep", "改过的")).expect("改 keep");
        sticky::delete(&db, "gone", true).expect("硬删 gone");
        sticky::upsert(&db, &off(), input("added", "快照之后才有")).expect("写 added");
        settings::set(&db, "theme", "dark").expect("翻设置");
        revision::record(&db.lock(), "keep", sticky::now_ms(), true, false).expect("再记一版");
        assert!(sticky::get(&db, &off(), "added").expect("读").is_some());
        assert!(sticky::get(&db, &off(), "gone").expect("读").is_none());

        let missing = swap_tables(&db.lock(), &db_path(&backups_dir(&db), &label)).expect("换表");
        assert!(missing.is_empty(), "名单里每张表这份快照都该有：{missing:?}");

        let rows = sticky::list(&db, &off(), false).expect("读全量");
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert!(ids.contains(&"keep"), "快照里的行要在：{ids:?}");
        assert_eq!(
            rows.iter().find(|row| row.id == "keep").expect("keep").title,
            "一直都在",
            "快照之后的改动要没"
        );
        assert!(!ids.contains(&"added"), "快照之后新增的必须没");
        assert!(ids.contains(&"gone"), "快照之后删掉的要回来");
        assert_eq!(
            settings::get(&db, "theme").expect("读设置").as_deref(),
            Some("light"),
            "设置项也在换表的名单里，跟着回"
        );
        let revisions = revision::list(&db.lock(), "keep").expect("列版本");
        assert_eq!(revisions.len(), 1, "只留快照那一刻的那一版：{revisions:?}");
        assert_eq!(revisions[0].title, "一直都在");
        // ATTACH 必须已经脱钩：留着的话下一次 VACUUM INTO 会被占着的库挡住
        create(&db, &vault).expect("恢复后还能再打一份快照");
        let _ = std::fs::remove_dir_all(db.dir());
    }

    /// 钉住老快照缺的那张表整份跳过并报回名字，而不是在 `INSERT ... snap.sticky_revisions` 上炸串
    #[test]
    fn 老快照缺的表跳过而不是报错() {
        let db = db_on_disk("legacy");
        let vault = PrivateVault::scan(db.dir());
        sticky::upsert(&db, &off(), input("keep", "一直都在")).expect("写 keep");
        let label = create(&db, &vault).expect("打快照");
        // 造一份"那张表还没有"的快照：直接把已经落盘的副本里那张表删掉
        let source = db_path(&backups_dir(&db), &label);
        {
            let snap = Connection::open(&source).expect("开副本");
            snap.execute("DROP TABLE sticky_revisions", []).expect("删表");
        }
        sticky::upsert(&db, &off(), input("keep", "改过的")).expect("改 keep（内部记一版）");
        revision::record(&db.lock(), "keep", sticky::now_ms(), true, false).expect("再记一版");
        let before = revision::list(&db.lock(), "keep").expect("列版本").len();
        assert_eq!(before, 2, "用例自己先把历史灌出来");

        let missing = swap_tables(&db.lock(), &source).expect("缺表不该报错");
        assert_eq!(missing, vec!["sticky_revisions"], "只跳过那一张");
        assert_eq!(
            sticky::get(&db, &off(), "keep").expect("读").expect("在").title,
            "一直都在",
            "其余各张照旧换回快照那一刻"
        );
        assert_eq!(
            revision::list(&db.lock(), "keep").expect("列版本").len(),
            before,
            "缺的那张整份跳过，当前的历史一条不动"
        );
        let _ = std::fs::remove_dir_all(db.dir());
    }

    /// 保留策略：只认 `.db` 那份算一份，配套的封套文件跟着一起走；留下的是最新 10 份
    #[test]
    fn 超额的老快照被清掉_配套的封套副本一起走() {
        let dir = temp_dir_for("prune");
        let labels: Vec<String> = (0..12)
            .map(|index| format!("20261001-1{index:05}"))
            .collect();
        for label in &labels {
            assert!(label_is_valid(label), "用例自己先把 label 形状写错");
            std::fs::write(db_path(&dir, label), b"x").expect("写库副本");
            std::fs::write(envelope_backup_path(&dir, label), b"y").expect("写封套副本");
        }
        let left = prune(&dir).expect("清理");
        assert_eq!(left, KEEP);
        assert_eq!(list_labels(&dir).expect("重读").len(), KEEP);
        assert!(!db_path(&dir, &labels[0]).exists(), "最老的那批要没");
        assert!(
            !envelope_backup_path(&dir, &labels[0]).exists(),
            "配套的封套副本不许孤儿留在盘上"
        );
        assert!(db_path(&dir, labels.last().expect("最新那份")).exists(), "最新的要留着");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 钉住不足保留线时一个都不许删——这条盯的是 `split_off` 的下标：越过 len 会当场 panic，而"没攒够 10 份"是常态
    #[test]
    fn 不到保留线一个都不删() {
        let dir = temp_dir_for("few");
        let missing = dir.join("还没有这个目录");
        assert_eq!(prune(&missing).expect("目录不存在也不许炸"), 0);
        for index in 0..3 {
            let label = format!("20261002-2{index:05}");
            std::fs::write(db_path(&dir, &label), b"x").expect("写库副本");
        }
        assert_eq!(prune(&dir).expect("清理"), 3);
        assert_eq!(list_labels(&dir).expect("重读").len(), 3, "三份都在保留线以内");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
