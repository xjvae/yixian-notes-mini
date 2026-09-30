// 迁移 — user_version 逐版本推进。每个版本一次事务（execute_batch 整段 DDL），
// 预备份（迁移前拷库）随 ROADMAP M4 加入；v1 是全新起点，无存量可保。

use rusqlite::Connection;

use super::pool::Db;
use crate::support::error::{AppError, AppResult};

pub const TARGET_VERSION: i64 = 2;

/// (目标版本, 整段 DDL)。执行顺序即数组顺序。
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../migrations/0001_init.sql")),
    (2, include_str!("../../migrations/0002_timeline.sql")),
];

#[derive(Debug)]
pub struct MigrationReport {
    pub from: i64,
    pub to: i64,
}

impl MigrationReport {
    pub fn is_noop(&self) -> bool {
        self.from == self.to
    }
}

pub fn run(db: &Db) -> AppResult<MigrationReport> {
    let conn = db.lock();
    let from: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    // 库 schema 比程序新（用户回装了旧版）：绝不往下猜，直接拒绝写路径
    if from > TARGET_VERSION {
        return Err(AppError::new(
            "DB_FUTURE_VERSION",
            format!("库 schema v{from} 比程序支持的 v{TARGET_VERSION} 新"),
        ));
    }
    let mut to = from;
    for &(version, sql) in MIGRATIONS {
        if version <= from {
            continue;
        }
        apply(&conn, version, sql)?;
        to = version;
    }
    Ok(MigrationReport { from, to })
}

fn apply(conn: &Connection, version: i64, sql: &str) -> AppResult<()> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::new("DB_MIGRATE", e.to_string()))?;
    tx.execute_batch(sql)
        .map_err(|e| AppError::new("DB_MIGRATE", format!("v{version} 应用失败：{e}")))?;
    tx.pragma_update(None, "user_version", version)
        .map_err(|e| AppError::new("DB_MIGRATE", e.to_string()))?;
    tx.commit()
        .map_err(|e| AppError::new("DB_MIGRATE", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Db {
        // 内存库走同一条 open 语义：目录 ":memory:" 不适用，这里直接拼连接
        Db::from_connection(Connection::open_in_memory().expect("内存库"))
    }

    #[test]
    fn 全新库一次推到目标版本() {
        let db = mem_db();
        let report = run(&db).expect("迁移成功");
        assert_eq!(report.from, 0);
        assert_eq!(report.to, TARGET_VERSION);
        assert!(!report.is_noop());
    }

    #[test]
    fn 库版本比程序新要拒绝() {
        let db = mem_db();
        {
            let conn = db.lock();
            conn.pragma_update(None, "user_version", TARGET_VERSION + 1)
                .expect("盖一个未来版本");
        }
        let err = run(&db).expect_err("必须拒绝");
        assert_eq!(err.code, "DB_FUTURE_VERSION");
    }

    #[test]
    fn 重跑迁移是无操作() {
        let db = mem_db();
        run(&db).expect("首次");
        let again = run(&db).expect("二次");
        assert!(again.is_noop());
        assert_eq!(again.from, TARGET_VERSION);
    }

    #[test]
    fn 迁移后的表都在() {
        let db = mem_db();
        run(&db).expect("迁移");
        let conn = db.lock();
        for table in ["stickies", "groups", "settings", "window_state"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("查表");
            assert_eq!(n, 1, "缺表 {table}");
        }
    }
}
