// 迁移 — user_version 逐版本推进。每个版本一次事务（execute_batch 整段 DDL），
// v1 是全新起点，无存量可保。
// **迁移前没有自动备份**（原来这句写着"预备份随 M4 加入"，代码里从来没有过）：
// 唯一的副本是设置窗那条「立即备份」，而它要人自己按。升带 DDL 的版本前先手动备份一次。

use rusqlite::Connection;

use super::pool::Db;
use crate::support::error::{AppError, AppResult};

pub const TARGET_VERSION: i64 = 13;

/// (目标版本, 整段 DDL)。执行顺序即数组顺序。
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../migrations/0001_init.sql")),
    (2, include_str!("../../migrations/0002_timeline.sql")),
    (3, include_str!("../../migrations/0003_dock.sql")),
    (4, include_str!("../../migrations/0004_icon.sql")),
    (5, include_str!("../../migrations/0005_media.sql")),
    (6, include_str!("../../migrations/0006_auto_size.sql")),
    (7, include_str!("../../migrations/0007_reminder.sql")),
    (8, include_str!("../../migrations/0008_dock_group.sql")),
    (9, include_str!("../../migrations/0009_revisions.sql")),
    (
        10,
        include_str!("../../migrations/0010_purge_sealed_history.sql")
    ),
    (
        11,
        include_str!("../../migrations/0011_private_rows.sql")
    ),
    (
        12,
        include_str!("../../migrations/0012_private_keys.sql")
    ),
    (
        13,
        include_str!("../../migrations/0013_drop_redundant_indexes.sql")
    ),
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

    /// v13 删掉两条与主键重复的索引。这里钉两件事：那两棵确实没了，
    /// 而"取那张最近几版"那条查询**仍走主键**——删它们不改变计划，只是每次记版少写一棵 B 树
    #[test]
    fn v13_删冗余索引而查询计划不变() {
        let db = mem_db();
        run(&db).expect("迁移");
        let conn = db.lock();
        for gone in ["idx_revisions_note", "idx_private_revision_note"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [gone],
                    |row| row.get(0),
                )
                .expect("查索引");
            assert_eq!(n, 0, "{gone} 该被 v13 删掉");
        }
        conn.execute(
            "INSERT INTO sticky_revisions (note_id, seq, created_at, content_json) \
             VALUES ('s1', 1, 1, '{}'), ('s1', 2, 2, '{}')",
            [],
        )
        .expect("塞两版");
        let mut plan: Vec<String> = Vec::new();
        let mut stmt = conn
            .prepare("EXPLAIN QUERY PLAN SELECT seq FROM sticky_revisions \
                      WHERE note_id = 's1' ORDER BY seq DESC LIMIT 5")
            .expect("计划");
        for row in stmt
            .query_map([], |row| row.get::<_, String>(3))
            .expect("跑计划")
        {
            plan.push(row.expect("一行计划"));
        }
        let joined = plan.join(" / ");
        assert!(
            joined.contains("sqlite_autoindex") || joined.contains("PRIMARY"),
            "这条查询该走主键那棵，实际计划：{joined}"
        );
        assert!(
            !joined.contains("idx_revisions_note"),
            "不许还引用被删掉的那棵：{joined}"
        );
    }

    /// v10 是唯一一条会**删数据**的迁移：把"标记成私密之前"留在明文历史表里的那些版本清掉。
    /// 判据只认行上的 private 标记，公开便签的历史一条都不许动。
    #[test]
    fn v10_只清私密行的历史_公开的不动() {
        let db = mem_db();
        // 先停在 v9（那张表刚刚建好、还没有清理），再往前推一格
        {
            let conn = db.lock();
            for &(version, sql) in MIGRATIONS.iter().take(9) {
                apply(&conn, version, sql).expect("推到 v9");
            }
            for id in ["p1", "s1"] {
                conn.execute(
                    "INSERT INTO stickies (id, title, body, content_type, items_json, \
                     timeline_json, tags_json, theme, pinned, floating, collapsed, private, \
                     deleted, created_at, updated_at, docked, repeat) \
                     VALUES (?1, 't', 'b', 'text', '[]', '[]', '[]', 'yellow', 1, 1, 0, \
                             ?2, 0, 1, 1, 0, 'none')",
                    rusqlite::params![id, if id == "p1" { 1 } else { 0 }],
                )
                .expect("塞便签行");
                conn.execute(
                    "INSERT INTO sticky_revisions (note_id, seq, content_json, created_at) \
                     VALUES (?1, 1, '{}', 1)",
                    [id],
                )
                .expect("塞历史行");
            }
        }
        let report = run(&db).expect("推到 v10");
        assert_eq!(report.from, 9);
        let conn = db.lock();
        let left: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT note_id FROM sticky_revisions ORDER BY note_id")
                .expect("准备");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("查历史表");
            rows.map(|r| r.expect("读")).collect()
        };
        assert_eq!(left, vec!["s1".to_string()], "只剩公开便签那一条历史");
    }
}
