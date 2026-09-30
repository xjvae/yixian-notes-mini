// 回收站查询 — 软删行的恢复与到期清算。
// 清算跑在启动流程里（见 lib.rs），清不动只是晚一轮，数据仍在库里。

use rusqlite::params;

use crate::db::pool::Db;
use crate::support::error::AppResult;

pub const TRASH_RETENTION_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 清掉删除时钟早过保留期的行，返回清掉多少条。
/// 没有 deleted_at 的行不动（时钟由删除动作盖，理论上不存在缺时钟的软删行）。
pub fn purge_expired(db: &Db, retention_days: i64, now: i64) -> AppResult<i64> {
    let cutoff = now - retention_days * DAY_MS;
    let conn = db.lock();
    let changed = conn.execute(
        "DELETE FROM stickies WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1",
        [cutoff],
    )?;
    Ok(changed as i64)
}

/// 恢复一张软删便签：清删除时钟、回到桌面（floating=1、展开态）。
pub fn restore(db: &Db, id: &str) -> AppResult<bool> {
    let conn = db.lock();
    let changed = conn.execute(
        "UPDATE stickies SET deleted = 0, deleted_at = NULL, floating = 1, collapsed = 0 \
         WHERE id = ?1 AND deleted = 1",
        params![id],
    )?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::StickyInput;
    use crate::db::query::sticky;
    use rusqlite::Connection;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        // 与生产同序：全量迁移
        db.lock()
            .execute_batch(include_str!("../../../migrations/0001_init.sql"))
            .expect("建表");
        db.lock()
            .execute_batch(include_str!("../../../migrations/0002_timeline.sql"))
            .expect("补列");
        db.lock()
            .execute_batch(include_str!("../../../migrations/0003_dock.sql"))
            .expect("补贴边列");
        db
    }

    fn input(id: &str) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: format!("标题{id}"),
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
        }
    }

    /// 直接把 deleted_at 拨回到 now - age_days 天，模拟"删了很久"
    fn age_deleted_at(db: &Db, id: &str, now: i64, age_days: i64) {
        db.lock()
            .execute(
                "UPDATE stickies SET deleted_at = ?2 WHERE id = ?1",
                params![id, now - age_days * DAY_MS],
            )
            .expect("拨时钟");
    }

    #[test]
    fn 到期的行被清_没到期的留着_未删的不动() {
        let db = db_with_schema();
        sticky::upsert(&db, input("old")).expect("写 old");
        sticky::upsert(&db, input("fresh")).expect("写 fresh");
        sticky::upsert(&db, input("alive")).expect("写 alive");
        let now = sticky::now_ms();
        assert!(sticky::delete(&db, "old", false).expect("软删"));
        assert!(sticky::delete(&db, "fresh", false).expect("软删"));
        age_deleted_at(&db, "old", now, 40);

        let purged = purge_expired(&db, TRASH_RETENTION_DAYS, now).expect("清算");
        assert_eq!(purged, 1);
        assert!(sticky::get(&db, "old").expect("读").is_none(), "到期的行真没了");
        assert!(sticky::get(&db, "fresh").expect("读").is_some());
        assert!(sticky::get(&db, "alive").expect("读").is_some());
    }

    #[test]
    fn 恢复清时钟并回桌面() {
        let db = db_with_schema();
        sticky::upsert(&db, input("s1")).expect("写");
        sticky::delete(&db, "s1", false).expect("软删");
        assert!(restore(&db, "s1").expect("恢复"));
        let row = sticky::get(&db, "s1").expect("读").expect("行在");
        assert!(!row.deleted);
        assert!(row.deleted_at.is_none());
        assert!(row.floating);
        assert!(!row.collapsed);
        assert!(!restore(&db, "s1").expect("二次恢复"), "未删行恢复返回 false");
    }
}
