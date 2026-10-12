// 单张便签的历史版本 — 一行 = 这张被换掉之前的内容形状。
// 表的设计理由（为什么存"之前"、为什么只存内容、为什么私密不记）写在 0009_revisions.sql。
//
// **所有函数收 `&Connection` 而不是 `&Db`**：记录发生在 `sticky::upsert` 已经拿着
// 那把库锁的时候，而 `Db` 是一个不可重入的 `Mutex<Connection>`——再进一次就自锁。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::models::{StickyItem, TimelineEntry};
use crate::support::error::{AppError, AppResult};

/// 每张留最新多少条
pub const KEEP_PER_NOTE: i64 = 50;
/// 超过这么多天的版本一律不要
pub const KEEP_DAYS: i64 = 7;
/// 同一张两次记录之间的最小间隔。写路径每 250ms 就 flush 一次（store 的去抖），
/// 不夹一下的话打一段字就能把 50 条填满，"历史"退化成"上一次按键"
pub const COALESCE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// 列表里那一行给多少个字的摘要
const PREVIEW_CHARS: usize = 60;

/// 一版的内容。**只有内容字段**——摆位/尺寸/置顶/贴边/收起/归组不进版本，
/// 回滚一次历史不该把便签从屏幕右下角搬走。
/// 三个 `*_json` 存列里那份原样字符串（回滚时直接写回，键序不漂）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Content {
    pub title: String,
    pub body: String,
    pub content_type: String,
    pub items_json: String,
    pub timeline_json: String,
    pub tags_json: String,
    pub theme: String,
    pub icon: Option<String>,
    pub due_at: Option<i64>,
    pub done_at: Option<i64>,
    pub repeat: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RevisionMeta {
    pub seq: i64,
    pub created_at: i64,
    pub title: String,
    pub content_type: String,
    /// 那一版的头几十个字（清单/时间轴取第一条），给列表当辨认用
    pub preview: String,
}

/// 在**换掉那一张之前**记一版。记不上不该挡住写，所以调用方把它的错误降成一条日志。
///
/// `force = true` 只给"回滚"用：回滚会把当前内容整个换掉，而当前内容可能正是
/// 三秒前刚打的字——夹在冷却里不记，就没有第二次回滚回到它的路了。
pub fn record(conn: &Connection, id: &str, now: i64, force: bool) -> AppResult<()> {
    let current = conn
        .query_row(
            "SELECT title, body, content_type, items_json, timeline_json, tags_json, theme, \
             icon, due_at, done_at, repeat, private \
             FROM stickies WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    Content {
                        title: row.get(0)?,
                        body: row.get(1)?,
                        content_type: row.get(2)?,
                        items_json: row.get(3)?,
                        timeline_json: row.get(4)?,
                        tags_json: row.get(5)?,
                        theme: row.get(6)?,
                        icon: row.get(7)?,
                        due_at: row.get(8)?,
                        done_at: row.get(9)?,
                        repeat: row.get(10)?,
                    },
                    row.get::<_, i64>(11)?,
                ))
            },
        )
        .optional()?;
    // 读不回这一行 = 这张是新建的。新建没有"之前"，没什么可留
    let Some((content, private)) = current else {
        return Ok(());
    };
    if private == 1 {
        return Ok(());
    }
    let payload = serde_json::to_string(&content)
        .map_err(|e| AppError::new("REVISION", format!("版本序列化失败：{e}")))?;
    let last: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT seq, created_at, content_json FROM sticky_revisions \
             WHERE note_id = ?1 ORDER BY seq DESC LIMIT 1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let mut next_seq = 1;
    if let Some((seq, created_at, previous)) = last {
        // 内容没变（比如只是拖动了一下窗、翻了个置顶）不配占一格
        if previous == payload {
            return Ok(());
        }
        if !force && now - created_at < COALESCE_MS {
            return Ok(());
        }
        next_seq = seq + 1;
    }
    conn.execute(
        "INSERT INTO sticky_revisions (note_id, seq, content_json, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![id, next_seq, payload, now],
    )?;
    prune_note(conn, id, now)?;
    Ok(())
}

/// 一张的保留量：先按天清，再按条数清到最新 50。
fn prune_note(conn: &Connection, id: &str, now: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sticky_revisions WHERE note_id = ?1 AND created_at < ?2",
        params![id, now - KEEP_DAYS * DAY_MS],
    )?;
    conn.execute(
        "DELETE FROM sticky_revisions WHERE note_id = ?1 AND seq NOT IN \
         (SELECT seq FROM sticky_revisions WHERE note_id = ?1 ORDER BY seq DESC LIMIT ?2)",
        params![id, KEEP_PER_NOTE],
    )?;
    Ok(())
}

/// 硬删一张时带走它的全部版本（全库没有外键兜着，漏在这里就是永久孤儿行）。
pub fn delete_for_note(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM sticky_revisions WHERE note_id = ?1", [id])?;
    Ok(())
}

/// 那一版的列表（新的在前）。
pub fn list(conn: &Connection, id: &str) -> AppResult<Vec<RevisionMeta>> {
    let mut stmt = conn.prepare(
        "SELECT seq, created_at, content_json FROM sticky_revisions \
         WHERE note_id = ?1 ORDER BY seq DESC",
    )?;
    let rows = stmt.query_map([id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, created_at, raw) = row?;
        let content: Content = serde_json::from_str(&raw).map_err(|e| {
            AppError::new("REVISION", format!("版本 {seq} 读不出（内容形状不认识）：{e}"))
        })?;
        out.push(RevisionMeta {
            preview: preview_of(&content),
            title: content.title.clone(),
            content_type: content.content_type.clone(),
            seq,
            created_at,
        });
    }
    Ok(out)
}

/// 取某一版的完整内容（回滚用）。
pub fn load(conn: &Connection, id: &str, seq: i64) -> AppResult<Option<Content>> {
    conn.query_row(
        "SELECT content_json FROM sticky_revisions WHERE note_id = ?1 AND seq = ?2",
        params![id, seq],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .map(|raw| {
        serde_json::from_str::<Content>(&raw)
            .map_err(|e| AppError::new("REVISION", format!("版本 {seq} 解不开：{e}")))
    })
    .transpose()
}

/// 列表里那一行的摘要。四类便签的正文不在同一个字段（文本/提醒是 `body`、
/// 清单是 `items[].text`、时间轴是 `timeline[].text`），所以得跟着类型分岔——
/// 与 `data/note-types.ts::plainBody` 同一个理由。
fn preview_of(content: &Content) -> String {
    let source = match content.content_type.as_str() {
        "todo" => serde_json::from_str::<Vec<StickyItem>>(&content.items_json)
            .ok()
            .and_then(|items| items.into_iter().next().map(|item| item.text))
            .unwrap_or_default(),
        "timeline" => serde_json::from_str::<Vec<TimelineEntry>>(&content.timeline_json)
            .ok()
            .and_then(|rows| rows.into_iter().next().map(|row| row.text))
            .unwrap_or_default(),
        _ => content.body.clone(),
    };
    let flat = source.replace('\n', " ").trim().to_string();
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() <= PREVIEW_CHARS {
        return chars.into_iter().collect();
    }
    let mut head: String = chars[..PREVIEW_CHARS].iter().collect();
    head.push('…');
    head
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::StickyInput;
    use crate::db::pool::Db;
    use crate::db::query::sticky;
    use rusqlite::Connection;

    fn db() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn input(id: &str, body: &str) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: format!("标题{id}"),
            body: body.to_string(),
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

    /// 换正文但不触发记录。这些用例测的是 `record` 自己的判定，而 `sticky::upsert`
    /// 现在也会用**真实时钟**记一版——混用两套时钟只会让冷却判据看着不相符。
    fn set_body(conn: &Connection, id: &str, body: &str) {
        conn.execute(
            "UPDATE stickies SET body = ?2 WHERE id = ?1",
            params![id, body],
        )
        .expect("改正文");
    }

    /// 一版合法的内容快照（灌历史表用，字段一个都不能少）
    fn content_json(body: &str) -> String {
        serde_json::to_string(&Content {
            title: "t".into(),
            body: body.into(),
            content_type: "text".into(),
            items_json: "[]".into(),
            timeline_json: "[]".into(),
            tags_json: "[]".into(),
            theme: "yellow".into(),
            icon: None,
            due_at: None,
            done_at: None,
            repeat: "none".into(),
        })
        .expect("序列化")
    }

    /// upsert 走的是 `sticky::upsert`，它内部会调 `record`。所以这几条用例测的
    /// 就是生产写路径，不是绕开它自己拼一遍
    #[test]
    fn 改一次记一版_记的是改之前那份() {
        let db = db();
        sticky::upsert(&db, input("s1", "第一版")).expect("新建");
        let conn = db.lock();
        assert!(
            list(&conn, "s1").expect("列").is_empty(),
            "新建没有\"之前\"，不该记"
        );
        record(&conn, "s1", 1_700_000_000_000, false).expect("记");
        set_body(&conn, "s1", "第二版");
        let rows = list(&conn, "s1").expect("列");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].preview, "第一版", "存的必须是换掉之前那一份");
        assert_eq!(
            load(&conn, "s1", rows[0].seq)
                .expect("取")
                .expect("那一版要在")
                .body,
            "第一版"
        );
    }

    #[test]
    fn 打字流被夹住_内容没变不占格() {
        let db = db();
        let t0 = 1_700_000_000_000;
        sticky::upsert(&db, input("s1", "甲")).expect("新建");
        // 同一分钟内连打五次（真实打字就是这个节奏：每 250ms flush 一次）
        let mut at = t0;
        for offset in 1..=5 {
            at = t0 + offset * 3_000;
            let conn = db.lock();
            record(&conn, "s1", at, false).expect("记");
            set_body(&conn, "s1", &format!("甲{}", offset));
        }
        let conn = db.lock();
        let rows = list(&conn, "s1").expect("列");
        assert_eq!(rows.len(), 1, "第一条记下了，后四次全被冷却夹掉");
        assert_eq!(rows[0].preview, "甲");
        // 冷却之外且内容确实变了 → 记第二条
        record(&conn, "s1", at + 61_000, false).expect("记");
        assert_eq!(list(&conn, "s1").expect("列").len(), 2);
        // 再记一次但内容没变（只是翻了个置顶）→ 不占格
        record(&conn, "s1", at + 122_000, false).expect("再记");
        assert_eq!(list(&conn, "s1").expect("列").len(), 2, "内容没变不重复占格");
    }

    /// 回滚必须绕过冷却：否则"刚打的字 + 立刻点恢复"就没有回头路了
    #[test]
    fn force_绕过冷却() {
        let db = db();
        let t0 = 1_700_000_000_000;
        sticky::upsert(&db, input("s1", "甲")).expect("新建");
        let conn = db.lock();
        record(&conn, "s1", t0, false).expect("记");
        set_body(&conn, "s1", "乙");
        // 三秒后就回滚：冷却内，但 force 那一发必须落得下
        record(&conn, "s1", t0 + 3_000, true).expect("force 记");
        let rows = list(&conn, "s1").expect("列");
        assert_eq!(rows.len(), 2, "force 那一发必须落得下");
        assert_eq!(rows[0].preview, "乙", "新的在前：刚打的这份才是回滚要救的那个");
    }

    #[test]
    fn 保留量按条数与天数两头夹() {
        let db = db();
        let t0 = 1_700_000_000_000;
        let conn = db.lock();
        for seq in 1..=60 {
            conn.execute(
                "INSERT INTO sticky_revisions (note_id, seq, content_json, created_at) \
                 VALUES ('s1', ?1, ?2, ?3)",
                params![seq, content_json(&format!("第{seq}版")), t0],
            )
            .expect("灌版本");
        }
        prune_note(&conn, "s1", t0).expect("清理");
        let rows = list(&conn, "s1").expect("列");
        assert_eq!(rows.len(), KEEP_PER_NOTE as usize, "只留最新 50 条");
        assert_eq!(rows[0].seq, 60, "新的在前");
        assert_eq!(rows.last().expect("最老那条").seq, 11, "1..=10 被挤掉");
        // 7 天前的整批走
        conn.execute(
            "INSERT INTO sticky_revisions (note_id, seq, content_json, created_at) \
             VALUES ('s1', 900, ?1, ?2)",
            params![content_json("很久以前"), t0 - (KEEP_DAYS + 1) * DAY_MS],
        )
        .expect("灌一条过期的");
        prune_note(&conn, "s1", t0).expect("再清理");
        assert_eq!(list(&conn, "s1").expect("列").len(), KEEP_PER_NOTE as usize);
    }

    #[test]
    fn 硬删便签带走全部版本() {
        let db = db();
        let t0 = 1_700_000_000_000;
        sticky::upsert(&db, input("s1", "甲")).expect("新建");
        let conn = db.lock();
        record(&conn, "s1", t0, false).expect("记");
        // 内容没再变，这条走的是"没变就不占格"那条路（与冷却无关）
        record(&conn, "s1", t0 + 61_000, false).expect("记二");
        drop(conn);
        assert!(sticky::delete(&db, "s1", true).expect("硬删"));
        assert!(list(&db.lock(), "s1").expect("列").is_empty(), "不留孤儿版本行");
    }

    /// 私密便签不进版本历史：这张表明文落盘，记它就是拆掉私密层
    #[test]
    fn 私密便签一条都不记() {
        let db = db();
        let mut seed = input("p1", "明文正文");
        seed.is_private = true;
        sticky::upsert(&db, seed).expect("新建私密");
        let conn = db.lock();
        record(&conn, "p1", 1_700_000_000_000, true).expect("连 force 也不记");
        assert!(list(&conn, "p1").expect("列").is_empty());
    }

    #[test]
    fn 摘要跟着便签类型取对应字段() {
        let mut content = Content {
            title: "清单".into(),
            body: "".into(),
            content_type: "todo".into(),
            items_json: "[{\"id\":\"i1\",\"text\":\"第一条\\n第二行\",\"done\":false}]".into(),
            timeline_json: "[]".into(),
            tags_json: "[]".into(),
            theme: "yellow".into(),
            icon: None,
            due_at: None,
            done_at: None,
            repeat: "none".into(),
        };
        assert_eq!(preview_of(&content), "第一条 第二行", "换行压成空格");
        content.content_type = "timeline".into();
        content.timeline_json = "[{\"id\":\"t1\",\"at\":1,\"text\":\"那天\"}]".into();
        assert_eq!(preview_of(&content), "那天");
        content.body = "x".repeat(80);
        content.content_type = "text".into();
        let long = preview_of(&content);
        assert_eq!(long.chars().count(), PREVIEW_CHARS + 1, "超长要带省略号");
        assert!(long.ends_with('…'));
    }
}
