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
    // 一把事务：六发断在中间就是半清——附属表没了而便签行还躺在回收站里，
    // 恢复回来是一张再也读不出内容的空壳
    let tx = conn.unchecked_transaction()?;
    // 这句批量清算不枚举 id（一句 DELETE 完事），所以几张附属表都得用**同一个条件**自己挑一遍：
    // 漏一张就是每 30 天留一堆没人再看得见的孤儿字节/版本。私密切文行不需要密钥就能删，锁着也清得干净
    tx.execute(
        "DELETE FROM sticky_revisions WHERE note_id IN \
         (SELECT id FROM stickies WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1)",
        [cutoff],
    )?;
    tx.execute(
        "DELETE FROM private_revision WHERE note_id IN \
         (SELECT id FROM stickies WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1)",
        [cutoff],
    )?;
    tx.execute(
        "DELETE FROM private_content WHERE note_id IN \
         (SELECT id FROM stickies WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1)",
        [cutoff],
    )?;
    tx.execute(
        "DELETE FROM media WHERE note_id IN \
         (SELECT id FROM stickies WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1)",
        [cutoff],
    )?;
    // 键行也在这条批删里：全库没有外键，漏了它就是每 30 天留一堆谁也解不开、
    // 又再也对不上号包（迁移 0012 的判据"有键行=这张已搬进自己钥匙"会被这些孤儿搅浑）
    tx.execute(
        "DELETE FROM private_keys WHERE note_id IN \
         (SELECT id FROM stickies WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1)",
        [cutoff],
    )?;
    let changed = tx.execute(
        "DELETE FROM stickies WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1",
        [cutoff],
    )?;
    tx.commit()?;
    Ok(changed as i64)
}

/// 一键清空：把**所有**软删行连图一起真删。与 purge_expired 同一条批删路，差别只在不看删除时钟——躺几天都算数。
pub fn clear(db: &Db) -> AppResult<i64> {
    let conn = db.lock();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM sticky_revisions WHERE note_id IN (SELECT id FROM stickies WHERE deleted = 1)",
        [],
    )?;
    // 密文行一起走：行没了而密文留着，就是再也对不上号的孤儿
    tx.execute(
        "DELETE FROM private_revision WHERE note_id IN (SELECT id FROM stickies WHERE deleted = 1)",
        [],
    )?;
    tx.execute(
        "DELETE FROM private_content WHERE note_id IN (SELECT id FROM stickies WHERE deleted = 1)",
        [],
    )?;
    tx.execute(
        "DELETE FROM media WHERE note_id IN (SELECT id FROM stickies WHERE deleted = 1)",
        [],
    )?;
    // 键行同一条理由：这张便签彻底没了，包着它那把钥匙的行留着就是再也对不上号的孤儿
    tx.execute(
        "DELETE FROM private_keys WHERE note_id IN (SELECT id FROM stickies WHERE deleted = 1)",
        [],
    )?;
    let changed = tx.execute("DELETE FROM stickies WHERE deleted = 1", [])?;
    tx.commit()?;
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
    fn off() -> crate::data::private::PrivateVault {
        crate::data::private::PrivateVault::disabled("trash")
    }

    use super::*;
    use crate::db::models::StickyInput;
    use crate::db::query::{media, sticky};
    use rusqlite::Connection;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        // 与生产同一条路：跑 migrate::run，别再手抄迁移清单
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn picture(id: &str, note_id: &str) -> media::MediaRow {
        media::MediaRow {
            id: id.to_string(),
            note_id: note_id.to_string(),
            mime: "image/png".to_string(),
            bytes: vec![1, 2, 3, 4],
            enc: false,
            width: 8,
            height: 8,
            created_at: 1,
        }
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
            icon: None,
            auto_size: None,
        }
    }

    fn age_deleted_at(db: &Db, id: &str, now: i64, age_days: i64) {
        db.lock()
            .execute(
                "UPDATE stickies SET deleted_at = ?2 WHERE id = ?1",
                params![id, now - age_days * DAY_MS],
            )
            .expect("拨时钟");
    }

    /// 钉：清算连图一起带走（media 用同条件子查询自挑），没到期那张的图必须原样留着
    #[test]
    fn 到期的行被清_没到期的留着_未删的不动() {
        let db = db_with_schema();
        sticky::upsert(&db, &off(), input("old")).expect("写 old");
        sticky::upsert(&db, &off(), input("fresh")).expect("写 fresh");
        sticky::upsert(&db, &off(), input("alive")).expect("写 alive");
        media::save(&db, &picture("m-old", "old")).expect("old 的图");
        media::save(&db, &picture("m-fresh", "fresh")).expect("fresh 的图");
        let now = sticky::now_ms();
        assert!(sticky::delete(&db, "old", false).expect("软删"));
        assert!(sticky::delete(&db, "fresh", false).expect("软删"));
        age_deleted_at(&db, "old", now, 40);

        let purged = purge_expired(&db, TRASH_RETENTION_DAYS, now).expect("清算");
        assert_eq!(purged, 1);
        assert!(sticky::get(&db, &off(), "old").expect("读").is_none(), "到期的行真没了");
        assert!(sticky::get(&db, &off(), "fresh").expect("读").is_some());
        assert!(sticky::get(&db, &off(), "alive").expect("读").is_some());
        assert_eq!(
            media::count_for_note(&db, "old").expect("数"),
            0,
            "到期清算要带走图，不然就是永久孤儿字节"
        );
        assert_eq!(
            media::count_for_note(&db, "fresh").expect("数"),
            1,
            "没到期的那张的图不许跟着没"
        );
    }

    #[test]
    fn 恢复清时钟并回桌面() {
        let db = db_with_schema();
        sticky::upsert(&db, &off(), input("s1")).expect("写");
        sticky::delete(&db, "s1", false).expect("软删");
        assert!(restore(&db, "s1").expect("恢复"));
        let row = sticky::get(&db, &off(), "s1").expect("读").expect("行在");
        assert!(!row.deleted);
        assert!(row.deleted_at.is_none());
        assert!(row.floating);
        assert!(!row.collapsed);
        assert!(!restore(&db, "s1").expect("二次恢复"), "未删行恢复返回 false");
    }

    /// 钉：清空不看时钟，软删的全部连图走，没删的一张不许动
    #[test]
    fn 清空把所有软删行连图带走_没删的不动() {
        let db = db_with_schema();
        sticky::upsert(&db, &off(), input("fresh")).expect("写 fresh");
        sticky::upsert(&db, &off(), input("old")).expect("写 old");
        sticky::upsert(&db, &off(), input("alive")).expect("写 alive");
        media::save(&db, &picture("m-old", "old")).expect("old 的图");
        media::save(&db, &picture("m-alive", "alive")).expect("alive 的图");
        let now = sticky::now_ms();
        assert!(sticky::delete(&db, "fresh", false).expect("软删"));
        assert!(sticky::delete(&db, "old", false).expect("软删"));
        age_deleted_at(&db, "old", now, 40);

        let cleared = clear(&db).expect("清空");
        assert_eq!(cleared, 2, "软删几张清几张，与躺了几天无关");
        assert!(sticky::get(&db, &off(), "fresh").expect("读").is_none());
        assert!(sticky::get(&db, &off(), "old").expect("读").is_none());
        assert!(sticky::get(&db, &off(), "alive").expect("读").is_some(), "没删的一张不许动");
        assert_eq!(
            media::count_for_note(&db, "old").expect("数"),
            0,
            "清空要带走图，不然就是永久孤儿字节"
        );
        assert_eq!(
            media::count_for_note(&db, "alive").expect("数"),
            1,
            "留在桌面的那张的图不许跟着没"
        );
        assert_eq!(clear(&db).expect("二次清空"), 0, "空的回收站清掉 0 张");
    }

    /// 钉：清算/清空把键行一起批删——留下"有键行没便签"的孤儿会搅浑迁移 0012 的判据
    #[test]
    fn 清算与清空把私密便签的键行一起带走() {
        use crate::data::private;
        use crate::db::query::private_note;

        let db = db_with_schema();
        let dir = std::env::temp_dir().join(format!(
            "yixian-trash-keys-test-{}",
            crate::support::clock::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("临时目录");
        let vault = private::PrivateVault::scan(&dir);
        private::setup(&vault, "口令至少八个字符").expect("设置口令");
        private_note::reveal(&db, &vault, "p1", "口令至少八个字符").expect("揭开 p1");
        private_note::reveal(&db, &vault, "p2", "口令至少八个字符").expect("揭开 p2");
        let mut p1 = input("p1");
        p1.is_private = true;
        p1.body = "私密正文".into();
        let mut p2 = input("p2");
        p2.is_private = true;
        p2.body = "私密正文二".into();
        sticky::upsert(&db, &vault, p1).expect("写 p1");
        sticky::upsert(&db, &vault, p2).expect("写 p2");
        assert_eq!(count(&db, "private_keys"), 2, "两张各有键行");

        assert!(sticky::delete(&db, "p1", false).expect("软删 p1"));
        assert!(sticky::delete(&db, "p2", false).expect("软删 p2"));
        assert_eq!(
            count(&db, "private_keys"),
            2,
            "软删不动密文与键行：从回收站恢复回来还得认得它"
        );
        assert_eq!(clear(&db).expect("清空"), 2);
        assert_eq!(count(&db, "private_keys"), 0, "清空把两条键行一起带走");
        assert_eq!(count(&db, "private_content"), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn count(db: &Db, table: &str) -> i64 {
        db.lock()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .expect("数")
    }
}
