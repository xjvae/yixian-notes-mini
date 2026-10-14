// 便签读写。SQL 全部走列位参数；items/tags 的 JSON 编解码只发生在这一个模块。
// 私密层收口也在这一格：`upsert`/`list`/`get`/`delete` 全收 `&PrivateVault`，敏感字段在这里抹成
// 占位（真身交给 `private_note`），读时再合并。为什么收在这里：**每一条**写这张的路都必须过这里，
// 收在唯一写入口上，绕过判断就成了编译错误。

use rusqlite::{params, Connection, OptionalExtension};

use crate::data::private::PrivateVault;
use crate::db::models::{StickyInput, StickyRow};
use crate::db::pool::Db;
use crate::db::query::private_note::{self, SealedContent};
use crate::db::query::revision;
use crate::support::error::{AppError, AppResult};
use crate::support::id;
use crate::support::log;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const COLS: &str = "id, title, body, content_type, items_json, timeline_json, tags_json, theme, \
                    pinned, floating, collapsed, private, group_id, x, y, width, height, due_at, \
                    done_at, repeat, deleted, deleted_at, created_at, updated_at, docked, dock_edge, \
                    icon, auto_size";

/// 三态列的读法：只有 0/1 算表过态，NULL/2/文本一律当**没表过态**（跟全局走）——
/// 猜错等于替用户改了这张的模式。走 Value 而非 `Option<i64>`：脏文本会让整行读不出来。
fn three_state(raw: rusqlite::types::Value) -> Option<bool> {
    match raw {
        rusqlite::types::Value::Integer(0) => Some(false),
        rusqlite::types::Value::Integer(1) => Some(true),
        _ => None,
    }
}

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
        icon: row.get("icon")?,
        auto_size: three_state(row.get::<_, rusqlite::types::Value>("auto_size")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 库里那一行（不做合并）。已经拿着锁的路径用它，别再绕回 `get` 二次取锁
fn read_one(conn: &Connection, id: &str) -> AppResult<Option<StickyRow>> {
    let sql = format!("SELECT {COLS} FROM stickies WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_sticky)
        .optional()
        .map_err(AppError::from)
}

/// 未删除全量（首屏/远端合流）。includeDeleted 供回收站。
/// 私密便签那几张在返回前合并回真身（锁着就是占位，判据全在 `private_note::merge`）
pub fn list(
    db: &Db,
    vault: &PrivateVault,
    include_deleted: bool,
) -> AppResult<Vec<StickyRow>> {
    let conn = db.lock();
    let mut rows = list_raw_conn(&conn, include_deleted)?;
    private_note::merge(&conn, vault, &mut rows)?;
    Ok(rows)
}

/// 只要行本身，**不合并私密内容**。给"读了就为了摆位/归属/在不在"的那些路径：
/// 开机恢复那一段要的是每扇窗落在哪个坐标，`get_raw` 同理。
/// 少解一次密就少一次"为一个没人看的字段把真身摊进内存"
pub fn list_raw(db: &Db, include_deleted: bool) -> AppResult<Vec<StickyRow>> {
    let conn = db.lock();
    list_raw_conn(&conn, include_deleted)
}

fn list_raw_conn(conn: &Connection, include_deleted: bool) -> AppResult<Vec<StickyRow>> {
    let sql = if include_deleted {
        format!("SELECT {COLS} FROM stickies ORDER BY updated_at DESC")
    } else {
        format!("SELECT {COLS} FROM stickies WHERE deleted = 0 ORDER BY updated_at DESC")
    };
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt
        .query_map([], row_to_sticky)?
        .collect::<Result<Vec<_>, _>>()?)
}

/// 单行读。开窗路径用：窗承载的就是这一行
pub fn get(db: &Db, vault: &PrivateVault, id: &str) -> AppResult<Option<StickyRow>> {
    let conn = db.lock();
    let mut row = read_one(&conn, id)?;
    if let Some(row) = row.as_mut() {
        private_note::merge_one(&conn, vault, row)?;
    }
    Ok(row)
}

/// 单行读，不合并私密内容（同 `list_raw` 的理由）
pub fn get_raw(db: &Db, id: &str) -> AppResult<Option<StickyRow>> {
    let conn = db.lock();
    read_one(&conn, id)
}

/// 这一张此刻私不私密。**不合并内容**：判密级只要这一个布尔，不该顺手解一次密
/// （`commands/media.rs::seal_for` 与历史版本那两条路每回都要问一遍）
pub fn private_flag(db: &Db, id: &str) -> AppResult<Option<bool>> {
    let conn = db.lock();
    private_flag_conn(&conn, id)
}

/// 同一件事，收已拿着的锁（`Db` 不可重入，命令层在事务里问就得走这条）
pub fn private_flag_conn(conn: &Connection, id: &str) -> AppResult<Option<bool>> {
    Ok(conn
        .query_row(
            "SELECT private FROM stickies WHERE id = ?1",
            [id],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .optional()?)
}

/// 写一行。时间戳由 Rust 盖：created_at 只插入时生成、更新保留；deleted 0→1 盖一次 deleted_at（回收站清算用）。
/// 一次调用 = 一个事务：stickies 行、private_content、private_revision 三者同生同死——
/// 断在中间留下"行是占位、真身没进去"比写失败难查得多。
pub fn upsert(db: &Db, vault: &PrivateVault, input: StickyInput) -> AppResult<StickyRow> {
    // id 摆不进窗的那几种形状先挡在写入口（理由见 `support::id::label_safe`）：
    // 放过去的话，这一行在库里好好的，而它那一扇永远建不起来
    if !id::label_safe(&input.id) {
        return Err(AppError::new(
            "STICKY_ID",
            format!("这个 id 摆不进一扇窗：{}/{:?}", input.id.len(), input.id),
        ));
    }
    if let Some(gid) = &input.group_id
        && !id::label_safe(gid)
    {
        return Err(AppError::new(
            "GROUP_ID",
            format!("这个组 id 摆不进叠窗：{}/{:?}", gid.len(), gid),
        ));
    }
    let now = now_ms();
    let items = serde_json::to_string(&input.items)
        .map_err(|e| AppError::new("DB_SQL", format!("items 序列化失败：{e}")))?;
    let timeline = serde_json::to_string(&input.timeline)
        .map_err(|e| AppError::new("DB_SQL", format!("timeline 序列化失败：{e}")))?;
    let tags = serde_json::to_string(&input.tags)
        .map_err(|e| AppError::new("DB_SQL", format!("tags 序列化失败：{e}")))?;
    let deleted_at_on_insert = if input.deleted { Some(now) } else { None };
    // 那三个 *_json 就是这一拍要落库/要封的同一份串：序列化只发生在这里一次
    let content = SealedContent::from_input(&input, &items, &timeline, &tags);

    let conn = db.lock();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    // 换掉前先留一版历史（判据见 `revision.rs`）。记不上不许挡住这次写：少一版可解释，"改了存不进"是事故。
    // 这一拍存成私密的，`record` 会清掉它以前的明文版本而不是记新版；
    // 私密便签自己那一版跟着密文走（`private_note::save` 里记）。
    if let Err(e) = revision::record(&tx, &input.id, now, false, input.is_private) {
        log::warn("revision", &format!("记历史版本失败（这次写照走）：{e}"));
    }
    let plan = private_note::plan(&tx, vault, &input.id, input.is_private, &content)?;
    // 拒绝的一拍：抛回去之前事务没提交，`record` 那一发 INSERT 跟着回滚
    let (fields, sealed_now) =
        private_note::write(&tx, vault, plan, &content, &input, now, false)?;
    tx.execute(
        "INSERT INTO stickies (
            id, title, body, content_type, items_json, timeline_json, tags_json, theme,
            pinned, floating, collapsed, private, group_id,
            x, y, width, height, due_at, done_at, repeat,
            deleted, deleted_at, created_at, updated_at, docked, dock_edge, icon, auto_size
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19, ?20,
            ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28
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
            docked = ?25, dock_edge = ?26, icon = ?27, auto_size = ?28",
        params![
            input.id,
            fields.title,
            fields.body,
            input.content_type,
            fields.items_json,
            fields.timeline_json,
            fields.tags_json,
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
            input.icon,
            input.auto_size,
        ],
    )?;
    // 写后读回：把 Rust 权威时间戳交给调用方。返回值必须是**合并过的**那一行——调用方拿它整份换掉
    // 内存实体，给占位就等于把这张的标题正文从内存里抹掉
    let mut row = read_one(&tx, &input.id)?
        .ok_or_else(|| AppError::new("DB_SQL", "写后读不回刚写的便签行"))?;
    match sealed_now {
        // 这一拍刚把它封进表里，手里就是那份真身：直接盖回去，不必再解一次密
        Some(content) => private_note::apply(&mut row, &content),
        None => private_note::merge_one(&tx, vault, &mut row)?,
    }
    tx.commit()
        .map_err(|e| AppError::new("DB_SQL", e.to_string()))?;
    Ok(row)
}

/// 删除。hard=false 软删（进回收站，盖删除时钟，不动密文与历史——恢复回来内容还得在）；hard=true 真删。
/// 真删要顺手带走这张的图与私密内容：全库没有外键兜着（见 0005_media.sql），漏在这里就是永久孤儿字节。
/// 删密文行不需要密钥，所以**锁着也照样删干净**。
pub fn delete(db: &Db, id: &str, hard: bool) -> AppResult<bool> {
    let conn = db.lock();
    let changed = if hard {
        // 一把事务：这四发断在中间就是"密文与图没了而便签行还在"（或反过来）的空壳行，
        // 而空壳行在界面上长得跟"读不出来的那张"一模一样
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM media WHERE note_id = ?1", [id])?;
        // 历史版本也跟着走：这张都不在了，留着就是谁也读不到的孤儿行
        revision::delete_for_note(&tx, id)?;
        private_note::delete_for_note(&tx, id)?;
        let changed = tx.execute("DELETE FROM stickies WHERE id = ?1", [id])?;
        tx.commit()?;
        changed
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
    use super::super::media;
    use super::*;
    use crate::db::models::{StickyItem, TimelineEntry};
    use rusqlite::Connection;

    /// 一张最小合法的图（字节与宽高都不重要，这里只验行有没有跟着删）
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

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        // 与生产同一条路：跑 migrate::run。手抄迁移清单的那种写法加一列就得改七个 helper，
        // 漏一处就是"table stickies has no column named icon"这类假崩溃
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    /// 私密层没启用的那条路（这些用例只测便签行本身）
    fn off() -> PrivateVault {
        PrivateVault::disabled("sticky")
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
            icon: None,
            auto_size: None,
        }
    }

    /// id 摆不进窗的那几种形状在写入口就被拒。放过去的话，库里那一行好好的，
    /// 而它那一扇永远建不起来——看起来就是"便签丢了"
    #[test]
    fn 摆不进窗的id不落库() {
        let db = db_with_schema();
        let too_long = "x".repeat(41);
        for bad in ["", "a/b", "a b", "a\"b", too_long.as_str()] {
            let err = upsert(&db, &off(), input(bad)).expect_err("要拒");
            assert_eq!(err.code, "STICKY_ID", "坏 id：{bad:?}");
        }
        assert_eq!(count_rows(&db, "stickies"), 0, "被拒的这一次一个字都没进库");

        // 组 id 同一条：叠窗的 label 也吃它
        let mut grouped = input("s1");
        grouped.group_id = Some("g/1".into());
        assert_eq!(
            upsert(&db, &off(), grouped).expect_err("要拒").code,
            "GROUP_ID"
        );

        // 旧库那种短 id、带连字符的 UUID 形都要认，别把合法数据挡在外面
        for ok in ["s1", "note-1700000000000-3", "550e8400-e29b-41d4-a716-446655440000"] {
            upsert(&db, &off(), input(ok)).expect("合法 id 要写得进");
        }
    }

    fn count_rows(db: &Db, table: &str) -> i64 {
        db.lock()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .expect("数")
    }

    #[test]
    fn 写后读回字段逐项对齐() {
        let db = db_with_schema();
        let row = upsert(&db, &off(), input("s1")).expect("写入");
        assert_eq!(row.id, "s1");
        assert_eq!(row.items.len(), 1);
        assert_eq!(row.items[0].text, "条目");
        assert_eq!(row.timeline.len(), 1);
        assert_eq!(row.timeline[0].text, "节点");
        assert!(row.created_at > 0 && row.updated_at >= row.created_at);
        assert!(row.deleted_at.is_none());
    }

    #[test]
    fn 更新保留创建时间并盖更新时间() {
        let db = db_with_schema();
        let first = upsert(&db, &off(), input("s1")).expect("首写");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut next = input("s1");
        next.title = "改过的标题".into();
        let second = upsert(&db, &off(), next).expect("改写");
        assert_eq!(second.created_at, first.created_at);
        assert!(second.updated_at > first.updated_at);
    }

    #[test]
    fn 软删除盖一次时钟_重写不续期_恢复清空() {
        let db = db_with_schema();
        upsert(&db, &off(), input("s1")).expect("首写");
        assert!(delete(&db, "s1", false).expect("软删"));
        let deleted = get(&db, &off(), "s1").expect("读回").expect("行在");
        let clock = deleted.deleted_at.expect("删除时钟已盖");
        assert!(deleted.deleted);

        // 软删后重写（回收站里编辑不该发生，但时钟不许被续写）
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut rewrite = input("s1");
        rewrite.deleted = true;
        upsert(&db, &off(), rewrite).expect("重写");
        assert_eq!(
            get(&db, &off(), "s1").expect("读回").unwrap().deleted_at,
            Some(clock)
        );

        // 恢复（deleted=0）清空时钟
        let mut restored = input("s1");
        restored.deleted = false;
        upsert(&db, &off(), restored).expect("恢复");
        assert!(get(&db, &off(), "s1").expect("读回").unwrap().deleted_at.is_none());
    }

    /// `auto_size` 是三态不是布尔：NULL = 跟全局走，0 = 这张强制固定，1 = 强制自动。
    /// 压成布尔就分不开头两种，而那正是这个模式要留的口子。
    /// 库里被手改成 2 或文本时按"没表过态"算，且**不许把整行读失败**
    #[test]
    fn auto_size三态读得回来_脏值当没表过态() {
        let db = db_with_schema();
        let mut row = input("s1");

        upsert(&db, &off(), row.clone()).expect("NULL 落库");
        assert_eq!(
            get(&db, &off(), "s1").expect("读").expect("有").auto_size,
            None,
            "没表过态"
        );

        row.auto_size = Some(false);
        upsert(&db, &off(), row.clone()).expect("0 落库");
        assert_eq!(
            get(&db, &off(), "s1").expect("读").expect("有").auto_size,
            Some(false),
            "0 是表过态，不等于 NULL"
        );

        row.auto_size = Some(true);
        upsert(&db, &off(), row).expect("1 落库");
        assert_eq!(
            get(&db, &off(), "s1").expect("读").expect("有").auto_size,
            Some(true)
        );

        for dirty in ["2", "'yes'"] {
            db.lock()
                .execute(
                    &format!("UPDATE stickies SET auto_size = {dirty} WHERE id = 's1'"),
                    [],
                )
                .expect("写脏值");
            let back = get(&db, &off(), "s1").expect("脏值也得把整行读出来");
            assert_eq!(back.expect("行在").auto_size, None, "脏值 = 没表过态");
        }
    }

    /// 硬删要顺手带走这张的图：全库没有外键兜着（见 0005_media.sql 那段），漏在这里
    /// 就是永久孤儿字节。软删不带走——回收站恢复回来图还得在
    #[test]
    fn 硬删除真的删行() {
        let db = db_with_schema();
        upsert(&db, &off(), input("s1")).expect("首写");
        media::save(&db, &picture("m1", "s1")).expect("存一张图");
        assert_eq!(media::count_for_note(&db, "s1").expect("数"), 1);

        delete(&db, "s1", false).expect("软删");
        assert_eq!(
            media::count_for_note(&db, "s1").expect("再数"),
            1,
            "软删不许动图"
        );

        assert!(delete(&db, "s1", true).expect("硬删"));
        assert!(get(&db, &off(), "s1").expect("读回").is_none());
        assert_eq!(media::count_for_note(&db, "s1").expect("数"), 0, "硬删要带走图");
    }

    #[test]
    fn 列表按删除过滤() {
        let db = db_with_schema();
        upsert(&db, &off(), input("s1")).expect("写 s1");
        upsert(&db, &off(), input("s2")).expect("写 s2");
        delete(&db, "s2", false).expect("软删 s2");
        assert_eq!(list(&db, &off(), false).expect("列表").len(), 1);
        assert_eq!(list(&db, &off(), true).expect("列表").len(), 2);
    }

    /// 私密层没配置 = 直通：`private` 只是个标记，内容照旧明文在主库
    /// （与 `commands/media.rs::seal_for` 那条口径一字不差）
    #[test]
    fn 私密层没启用时私密便签照旧明文落库() {
        let db = db_with_schema();
        let mut seed = input("p1");
        seed.is_private = true;
        let row = upsert(&db, &off(), seed.clone()).expect("写私密");
        assert_eq!(row.body, "正文", "没启用加密就没有占位这回事");
        assert_eq!(private_flag(&db, "p1").expect("问一次"), Some(true));
        assert_eq!(
            db.lock()
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM private_content",
                    [],
                    |row| row.get(0)
                )
                .expect("数"),
            0,
            "没启用就一条密文都不该有"
        );
    }

    /// `private_flag` 只问那一个布尔：不许为了判密级去解一次密
    /// （`media_save` 每贴一张图都要问一遍）
    #[test]
    fn private_flag_不解密只问标记() {
        let db = db_with_schema();
        let vault = PrivateVault::disabled("flag");
        upsert(&db, &vault, input("s1")).expect("写公开");
        assert_eq!(private_flag(&db, "s1").expect("问"), Some(false));
        assert_eq!(private_flag(&db, "没这一张").expect("问"), None);
    }
}
