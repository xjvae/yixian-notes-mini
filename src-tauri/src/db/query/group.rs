// 组合查询 — 降级口径：无新建入口（随墙退役），组合来自旧库导入；
// 能力只剩"移进/移出已有组 + 空组自动清 + 叠窗"。
// 成员关系的唯一住址是 stickies.group_id；组行删了成员自动散着（读侧认不到组就当散）。

use rusqlite::{params, OptionalExtension};

use crate::db::models::GroupRow;
use crate::db::pool::Db;
use crate::support::error::AppResult;

pub fn list(db: &Db) -> AppResult<Vec<GroupRow>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, color, collapsed, x, y, width, height, created_at, updated_at \
         FROM groups ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(GroupRow {
                id: row.get("id")?,
                name: row.get("name")?,
                color: row.get("color")?,
                collapsed: row.get::<_, i64>("collapsed")? != 0,
                x: row.get("x")?,
                y: row.get("y")?,
                width: row.get("width")?,
                height: row.get("height")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn exists(db: &Db, id: &str) -> AppResult<bool> {
    let conn = db.lock();
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM groups WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// 单组读。叠窗开窗路径取几何用。
pub fn get(db: &Db, id: &str) -> AppResult<Option<GroupRow>> {
    let conn = db.lock();
    conn.query_row(
        "SELECT id, name, color, collapsed, x, y, width, height, created_at, updated_at \
         FROM groups WHERE id = ?1",
        [id],
        |row| {
            Ok(GroupRow {
                id: row.get("id")?,
                name: row.get("name")?,
                color: row.get("color")?,
                collapsed: row.get::<_, i64>("collapsed")? != 0,
                x: row.get("x")?,
                y: row.get("y")?,
                width: row.get("width")?,
                height: row.get("height")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// 成员归属：写 stickies.group_id。Some 必须指向存在的组（认不到就拒，防手滑
/// 把便签塞进幽灵组）——指向已删组本是无害态，但作为**写入口**必须严格。
pub fn set_member(db: &Db, id: &str, group_id: Option<&str>) -> AppResult<bool> {
    if let Some(gid) = group_id
        && !exists(db, gid)?
    {
        return Err(crate::support::error::AppError::new(
            "GROUP_MISSING",
            format!("组合 {gid} 不存在"),
        ));
    }
    let conn = db.lock();
    let changed = conn.execute(
        "UPDATE stickies SET group_id = ?2, updated_at = ?3 WHERE id = ?1 AND deleted = 0",
        params![id, group_id, crate::db::query::sticky::now_ms()],
    )?;
    Ok(changed > 0)
}

/// 空组自动清：删掉没有任何未删成员的组行。返回清掉几组。
pub fn prune_empty(db: &Db) -> AppResult<usize> {
    let conn = db.lock();
    conn.execute(
        "DELETE FROM groups WHERE id NOT IN (
            SELECT DISTINCT group_id FROM stickies
            WHERE group_id IS NOT NULL AND deleted = 0
        )",
        [],
    )?;
    Ok(conn.changes() as usize)
}

/// 开机要拉起的叠窗：有 ≥1 张 floating 成员的组。
pub fn stacks_to_restore(db: &Db) -> AppResult<Vec<String>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT g.id FROM groups g
         JOIN stickies s ON s.group_id = g.id
         WHERE s.floating = 1 AND s.deleted = 0
         ORDER BY g.created_at ASC",
    )?;
    let ids = stmt.query_map([], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::StickyInput;
    use crate::db::query::sticky;
    use rusqlite::Connection;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
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

    fn sticky(id: &str, group_id: Option<&str>) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: format!("便签{id}"),
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
            group_id: group_id.map(str::to_string),
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

    fn make_group(db: &Db, id: &str) {
        db.lock()
            .execute(
                "INSERT INTO groups (id, name, created_at, updated_at) VALUES (?1, '组', 1, 1)",
                [id],
            )
            .expect("建组");
    }

    #[test]
    fn 移进_移出_空组自动清() {
        let db = db_with_schema();
        make_group(&db, "g1");
        make_group(&db, "g2");
        sticky::upsert(&db, sticky("s1", None)).expect("写 s1");

        assert!(set_member(&db, "s1", Some("g1")).expect("移进"));
        assert!(exists(&db, "g1").expect("组在"));
        assert_eq!(prune_empty(&db).expect("清"), 1, "g2 是空组被清");
        assert!(!exists(&db, "g2").expect("g2 没了"));
        assert!(exists(&db, "g1").expect("g1 有成员还在"));

        set_member(&db, "s1", None).expect("移出");
        assert_eq!(prune_empty(&db).expect("清"), 1, "g1 空了被清");
        assert!(!exists(&db, "g1").expect("g1 没了"));
    }

    #[test]
    fn 移进不存在的组被拒() {
        let db = db_with_schema();
        sticky::upsert(&db, sticky("s1", None)).expect("写");
        let err = set_member(&db, "s1", Some("ghost")).expect_err("必须拒");
        assert_eq!(err.code, "GROUP_MISSING");
    }

    #[test]
    fn 已删成员不算组员_空组随之清() {
        let db = db_with_schema();
        make_group(&db, "g1");
        sticky::upsert(&db, sticky("s1", Some("g1"))).expect("写");
        sticky::delete(&db, "s1", false).expect("软删");
        assert_eq!(prune_empty(&db).expect("清"), 1, "成员全删的组被清");
    }

    #[test]
    fn 叠窗恢复清单_只含有浮窗成员的组() {
        let db = db_with_schema();
        make_group(&db, "g1");
        make_group(&db, "g2");
        sticky::upsert(&db, sticky("s1", Some("g1"))).expect("写 s1（浮窗）");
        let mut wall = sticky("s2", Some("g2"));
        wall.floating = false; // 墙存量（导入摊回前）
        sticky::upsert(&db, wall).expect("写 s2");
        assert_eq!(stacks_to_restore(&db).expect("清单"), vec!["g1"]);
    }
}
