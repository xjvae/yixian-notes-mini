// 检索 — 子串匹配（LIKE）而非 FTS。便签量级是几十到几百条，LIKE 全列扫毫无压力；
// 换 FTS5（中文分词/三字组）等量级或检索延迟成为问题时再做，索引同步才是它真正的成本。
// 私密便签**不进检索**：未解锁时正文根本不在主库，锁上的内容不该被搜出半句。
// 命中排序：标题命中 > 其它，同级按最近改动。tags/items/timeline 搜的是 JSON 原文，
// 等价于"标签名/条目文本/时间轴文本都能搜到"。

use rusqlite::params;

use crate::db::pool::Db;
use crate::support::error::AppResult;

const SEARCH_LIMIT: i64 = 50;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub body: String,
    pub content_type: String,
    pub theme: String,
}

/// LIKE 通配符转义（\ % _），查询串两头加 %
fn like_pattern(query: &str) -> String {
    let escaped = query
        .trim()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn search(db: &Db, query: &str) -> AppResult<Vec<SearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = like_pattern(trimmed);
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, title, body, content_type, theme FROM stickies
         WHERE deleted = 0 AND private = 0
           AND (title LIKE ?1 ESCAPE '\\'
                OR body LIKE ?1 ESCAPE '\\'
                OR items_json LIKE ?1 ESCAPE '\\'
                OR timeline_json LIKE ?1 ESCAPE '\\'
                OR tags_json LIKE ?1 ESCAPE '\\')
         ORDER BY CASE WHEN title LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT ?2",
    )?;
    let hits = stmt
        .query_map(params![pattern, SEARCH_LIMIT], |row| {
            Ok(SearchHit {
                id: row.get("id")?,
                title: row.get("title")?,
                body: row.get("body")?,
                content_type: row.get("content_type")?,
                theme: row.get("theme")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::StickyInput;
    use crate::db::query::sticky;
    use rusqlite::Connection;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn input(id: &str, title: &str, body: &str) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: title.into(),
            body: body.into(),
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

    #[test]
    fn 标题命中排在正文命中前面() {
        let db = db_with_schema();
        sticky::upsert(&db, input("a", "会议纪要", "正文提到复查")).expect("写 a");
        sticky::upsert(&db, input("b", "随手记", "今天开了会议")).expect("写 b");
        let hits = search(&db, "会议").expect("检索");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "a", "标题命中优先");
    }

    #[test]
    fn 软删与私密的行不进结果() {
        let db = db_with_schema();
        sticky::upsert(&db, input("a", "体检报告", "")).expect("写 a");
        sticky::delete(&db, "a", false).expect("软删");
        assert!(search(&db, "体检").expect("检索").is_empty());

        let mut private = input("b", "体检预约", "");
        private.is_private = true;
        sticky::upsert(&db, private).expect("写 b");
        assert!(search(&db, "体检").expect("检索").is_empty());
    }

    #[test]
    fn 通配符不越权() {
        let db = db_with_schema();
        sticky::upsert(&db, input("a", "abc", "")).expect("写 a");
        // % 与 _ 是 LIKE 通配符，必须被转义成字面量
        assert!(search(&db, "%").expect("检索").is_empty());
        assert!(search(&db, "_").expect("检索").is_empty());
        assert_eq!(search(&db, "abc").expect("检索").len(), 1);
    }

    #[test]
    fn 空查询返回空() {
        let db = db_with_schema();
        sticky::upsert(&db, input("a", "abc", "")).expect("写 a");
        assert!(search(&db, "").expect("检索").is_empty());
        assert!(search(&db, "   ").expect("检索").is_empty());
    }
}
