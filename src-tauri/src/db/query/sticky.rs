// 便签读写。SQL 全部走列位参数；items/tags 的 JSON 编解码只发生在这一个模块。

use rusqlite::{params, OptionalExtension};

use crate::db::models::{StickyInput, StickyRow};
use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const COLS: &str = "id, title, body, content_type, items_json, timeline_json, tags_json, theme, \
                    pinned, floating, collapsed, private, group_id, x, y, width, height, due_at, \
                    done_at, repeat, deleted, deleted_at, created_at, updated_at, docked, dock_edge";

fn row_to_sticky(row: &rusqlite::Row) -> rusqlite::Result<StickyRow> {
    let items_json: String = row.get("items_json")?;
    let timeline_json: String = row.get("timeline_json")?;
    let tags_json: String = row.get("tags_json")?;
    Ok(StickyRow {
        id: row.get("id")?,
        title: row.get("title")?,
        body: row.get("body")?,
        content_type: row.get("content_type")?,
        items: serde_json::from_str(&items_json).unwrap_or_default(),
        timeline: serde_json::from_str(&timeline_json).unwrap_or_default(),
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        theme: row.get("theme")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        floating: row.get::<_, i64>("floating")? != 0,
        collapsed: row.get::<_, i64>("collapsed")? != 0,
        is_private: row.get::<_, i64>("private")? != 0,
        group_id: row.get("group_id")?,
        x: row.get("x")?,
        y: row.get("y")?,
        width: row.get("width")?,
        height: row.get("height")?,
        due_at: row.get("due_at")?,
        done_at: row.get("done_at")?,
        repeat: row.get("repeat")?,
        deleted: row.get::<_, i64>("deleted")? != 0,
        deleted_at: row.get("deleted_at")?,
        docked: row.get::<_, i64>("docked")? != 0,
        dock_edge: row.get("dock_edge")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 未删除全量（首屏/远端合流）。includeDeleted 供回收站。
pub fn list(db: &Db, include_deleted: bool) -> AppResult<Vec<StickyRow>> {
    let conn = db.lock();
    let sql = if include_deleted {
        format!("SELECT {COLS} FROM stickies ORDER BY updated_at DESC")
    } else {
        format!("SELECT {COLS} FROM stickies WHERE deleted = 0 ORDER BY updated_at DESC")
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_sticky)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 单行读。开窗路径用：窗承载的就是这一行
pub fn get(db: &Db, id: &str) -> AppResult<Option<StickyRow>> {
    let conn = db.lock();
    let sql = format!("SELECT {COLS} FROM stickies WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_sticky)
        .optional()
        .map_err(AppError::from)
}

/// 写一行。时间戳由 Rust 盖：created_at 只在插入时生成、更新时保留；
/// deleted 0→1 的翻转盖一次 deleted_at（删除时钟，回收站 30 天清算用它，重写不续期）。
pub fn upsert(db: &Db, input: StickyInput) -> AppResult<StickyRow> {
    let now = now_ms();
    let items = serde_json::to_string(&input.items)
        .map_err(|e| AppError::new("DB_SQL", format!("items 序列化失败：{e}")))?;
    let timeline = serde_json::to_string(&input.timeline)
        .map_err(|e| AppError::new("DB_SQL", format!("timeline 序列化失败：{e}")))?;
    let tags = serde_json::to_string(&input.tags)
        .map_err(|e| AppError::new("DB_SQL", format!("tags 序列化失败：{e}")))?;
    let deleted_at_on_insert = if input.deleted { Some(now) } else { None };
    {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO stickies (
                id, title, body, content_type, items_json, timeline_json, tags_json, theme,
                pinned, floating, collapsed, private, group_id,
                x, y, width, height, due_at, done_at, repeat,
                deleted, deleted_at, created_at, updated_at, docked, dock_edge
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26
            )
            ON CONFLICT(id) DO UPDATE SET
                title = ?2, body = ?3, content_type = ?4, items_json = ?5, timeline_json = ?6,
                tags_json = ?7, theme = ?8, pinned = ?9, floating = ?10, collapsed = ?11,
                private = ?12, group_id = ?13, x = ?14, y = ?15, width = ?16, height = ?17,
                due_at = ?18, done_at = ?19, repeat = ?20, deleted = ?21,
                deleted_at = CASE
                    WHEN ?21 = 1 AND deleted_at IS NULL THEN ?24
                    WHEN ?21 = 0 THEN NULL
                    ELSE deleted_at
                END,
                updated_at = ?24,
                docked = ?25, dock_edge = ?26",
            params![
                input.id,
                input.title,
                input.body,
                input.content_type,
                items,
                timeline,
                tags,
                input.theme,
                input.pinned as i64,
                input.floating as i64,
                input.collapsed as i64,
                input.is_private as i64,
                input.group_id,
                input.x,
                input.y,
                input.width,
                input.height,
                input.due_at,
                input.done_at,
                input.repeat,
                input.deleted as i64,
                deleted_at_on_insert,
                now,
                now,
                input.docked as i64,
                input.dock_edge,
            ],
        )?;
    }
    // 写后读回：把 Rust 权威时间戳交给调用方回填内存
    get(db, &input.id)?
        .ok_or_else(|| AppError::new("DB_SQL", "写后读不回刚写的便签行"))
}

/// 删除。hard=false 软删（进回收站，盖删除时钟）；hard=true 真删（回收站"彻底删除"）。
pub fn delete(db: &Db, id: &str, hard: bool) -> AppResult<bool> {
    let conn = db.lock();
    let changed = if hard {
        conn.execute("DELETE FROM stickies WHERE id = ?1", [id])?
    } else {
        conn.execute(
            "UPDATE stickies SET deleted = 1, deleted_at = COALESCE(deleted_at, ?2), \
             floating = 0 WHERE id = ?1 AND deleted = 0",
            params![id, now_ms()],
        )?
    };
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{StickyItem, TimelineEntry};
    use rusqlite::Connection;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        // 与生产同序：全量迁移，别只建 v1（upsert 写的是当前 schema）
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
            title: "标题".into(),
            body: "正文".into(),
            content_type: "text".into(),
            items: vec![StickyItem {
                id: "i1".into(),
                text: "条目".into(),
                done: false,
            }],
            timeline: vec![TimelineEntry {
                id: "t1".into(),
                at: 1_700_000_000_000,
                text: "节点".into(),
            }],
            tags: vec!["工作".into()],
            theme: "yellow".into(),
            pinned: true,
            floating: true,
            collapsed: false,
            is_private: false,
            group_id: None,
            x: Some(10),
            y: Some(20),
            width: Some(300),
            height: Some(260),
            due_at: None,
            done_at: None,
            repeat: "none".into(),
            deleted: false,
            docked: false,
            dock_edge: None,
        }
    }

    #[test]
    fn 写后读回字段逐项对齐() {
        let db = db_with_schema();
        let row = upsert(&db, input("s1")).expect("写入");
        assert_eq!(row.id, "s1");
        assert_eq!(row.items.len(), 1);
        assert_eq!(row.items[0].text, "条目");
        assert_eq!(row.timeline.len(), 1);
        assert_eq!(row.timeline[0].text, "节点");
        assert_eq!(row.tags, vec!["工作"]);
        assert!(row.created_at > 0 && row.updated_at >= row.created_at);
        assert!(row.deleted_at.is_none());
    }

    #[test]
    fn 更新保留创建时间并盖更新时间() {
        let db = db_with_schema();
        let first = upsert(&db, input("s1")).expect("首写");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut next = input("s1");
        next.title = "改过的标题".into();
        let second = upsert(&db, next).expect("改写");
        assert_eq!(second.created_at, first.created_at);
        assert!(second.updated_at > first.updated_at);
    }

    #[test]
    fn 软删除盖一次时钟_重写不续期_恢复清空() {
        let db = db_with_schema();
        upsert(&db, input("s1")).expect("首写");
        assert!(delete(&db, "s1", false).expect("软删"));
        let deleted = get(&db, "s1").expect("读回").expect("行在");
        let clock = deleted.deleted_at.expect("删除时钟已盖");
        assert!(deleted.deleted);

        // 软删后重写（回收站里编辑不该发生，但时钟不许被续写）
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut rewrite = input("s1");
        rewrite.deleted = true;
        upsert(&db, rewrite).expect("重写");
        assert_eq!(get(&db, "s1").expect("读回").unwrap().deleted_at, Some(clock));

        // 恢复（deleted=0）清空时钟
        let mut restored = input("s1");
        restored.deleted = false;
        upsert(&db, restored).expect("恢复");
        assert!(get(&db, "s1").expect("读回").unwrap().deleted_at.is_none());
    }

    #[test]
    fn 硬删除真的删行() {
        let db = db_with_schema();
        upsert(&db, input("s1")).expect("首写");
        assert!(delete(&db, "s1", true).expect("硬删"));
        assert!(get(&db, "s1").expect("读回").is_none());
    }

    #[test]
    fn 列表按删除过滤() {
        let db = db_with_schema();
        upsert(&db, input("s1")).expect("写 s1");
        upsert(&db, input("s2")).expect("写 s2");
        delete(&db, "s2", false).expect("软删 s2");
        assert_eq!(list(&db, false).expect("列表").len(), 1);
        assert_eq!(list(&db, true).expect("列表").len(), 2);
    }
}
