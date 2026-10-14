// 检索 — 子串匹配（LIKE）而非 FTS。便签量级是几十到几百条，LIKE 全列扫毫无压力；
// 换 FTS5（中文分词/三字组）等量级或检索延迟成为问题时再做，索引同步才是它真正的成本。
// 私密便签**不进检索**：未解锁时正文根本不在主库，锁上的内容不该被搜出半句。
// 命中排序：标题命中 > 其它，同级按最近改动。tags/items/timeline 搜的是 JSON 原文，
// 等价于"标签名/条目文本/时间轴文本都能搜到"。
// 空查询 = 最近 50 张，不是空结果：搜索窗一开就该有东西可点，而不是一句提示。

use rusqlite::params;

use crate::db::models::{StickyItem, TimelineEntry};
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
    /// 清单类的正文就住在 items 上，时间轴类住在 timeline 上。不带着回来，这两类命中
    /// 在结果列表里只剩一句空话——摘要得从它们身上取。
    pub items: Vec<StickyItem>,
    pub timeline: Vec<TimelineEntry>,
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

/// 一次检索的结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    /// 这次**根本没参与**检索的私密便签张数（未解锁时它们的正文不在主库）。
    /// 不说这句，"没有命中"会被读成"我那张便签丢了"
    pub private_skipped: usize,
}

/// 空查询传空串进去：`?1 = ''` 让匹配整段短路，排序里的标题优先也随之失效，
/// 于是同一条 SQL 退化成"最近改动 50 张"。
const SELECT_SQL: &str = "SELECT id, title, body, content_type, theme, items_json, timeline_json \
     FROM stickies \
     WHERE deleted = 0 AND private = 0 \
       AND (?1 = '' \
            OR title LIKE ?1 ESCAPE '\\' \
            OR body LIKE ?1 ESCAPE '\\' \
            OR items_json LIKE ?1 ESCAPE '\\' \
            OR timeline_json LIKE ?1 ESCAPE '\\' \
            OR tags_json LIKE ?1 ESCAPE '\\') \
     ORDER BY CASE WHEN ?1 <> '' AND title LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END, \
              updated_at DESC \
     LIMIT ?2";

/// 锁着的有几张。这一格不问口令、也不看内容，只数行上的标记
const LOCKED_COUNT_SQL: &str = "SELECT COUNT(*) FROM stickies WHERE deleted = 0 AND private = 1";

pub fn search(db: &Db, query: &str) -> AppResult<SearchOutcome> {
    let trimmed = query.trim();
    let pattern = if trimmed.is_empty() {
        String::new()
    } else {
        like_pattern(trimmed)
    };
    let conn = db.lock();
    let mut stmt = conn.prepare(SELECT_SQL)?;
    let hits = stmt
        .query_map(params![pattern, SEARCH_LIMIT], |row| {
            let items_json: String = row.get("items_json")?;
            let timeline_json: String = row.get("timeline_json")?;
            Ok(SearchHit {
                id: row.get("id")?,
                title: row.get("title")?,
                body: row.get("body")?,
                content_type: row.get("content_type")?,
                theme: row.get("theme")?,
                items: serde_json::from_str(&items_json).unwrap_or_default(),
                timeline: serde_json::from_str(&timeline_json).unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let private_skipped: i64 = conn.query_row(LOCKED_COUNT_SQL, [], |row| row.get(0))?;
    Ok(SearchOutcome {
        hits,
        private_skipped: private_skipped as usize,
    })
}

#[cfg(test)]
mod tests {
    /// 私密层没启用时的那把 vault：这些用例只测本模块的事，不该为它们各建一套封套
    fn off() -> crate::data::private::PrivateVault {
        crate::data::private::PrivateVault::disabled("search")
    }

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
        sticky::upsert(&db, &off(), input("a", "会议纪要", "正文提到复查")).expect("写 a");
        sticky::upsert(&db, &off(), input("b", "随手记", "今天开了会议")).expect("写 b");
        let hits = search(&db, "会议").expect("检索").hits;
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "a", "标题命中优先");
    }

    #[test]
    fn 软删与私密的行不进结果() {
        let db = db_with_schema();
        sticky::upsert(&db, &off(), input("a", "体检报告", "")).expect("写 a");
        sticky::delete(&db, "a", false).expect("软删");
        assert!(search(&db, "体检").expect("检索").hits.is_empty());

        let mut private = input("b", "体检预约", "");
        private.is_private = true;
        sticky::upsert(&db, &off(), private).expect("写 b");
        assert!(search(&db, "体检").expect("检索").hits.is_empty());
    }

    /// 锁着的没参与这件事要**报出来**：空结果只说"没有命中"，人会觉得便签丢了
    #[test]
    fn 有几张锁着没参与要说出来() {
        let db = db_with_schema();
        sticky::upsert(&db, &off(), input("a", "公开的那张", "")).expect("写 a");
        assert_eq!(search(&db, "体检").expect("检索").private_skipped, 0);

        for n in ["p1", "p2"] {
            let mut locked = input(n, "体检预约", "");
            locked.is_private = true;
            sticky::upsert(&db, &off(), locked).expect("写私密");
        }
        let out = search(&db, "体检").expect("检索");
        assert!(out.hits.is_empty(), "锁着的正文不参与检索");
        assert_eq!(out.private_skipped, 2, "要说清是有两张没参与，不是什么都没有");
        // 软删的那张不算在"锁着"里：它本来就不在任何一个结果里
        sticky::delete(&db, "p1", false).expect("软删 p1");
        assert_eq!(search(&db, "体").expect("检索").private_skipped, 1);
    }

    #[test]
    fn 通配符不越权() {
        let db = db_with_schema();
        sticky::upsert(&db, &off(), input("a", "abc", "")).expect("写 a");
        // % 与 _ 是 LIKE 通配符，必须被转义成字面量
        assert!(search(&db, "%").expect("检索").hits.is_empty());
        assert!(search(&db, "_").expect("检索").hits.is_empty());
        assert_eq!(search(&db, "abc").expect("检索").hits.len(), 1);
    }

    #[test]
    fn 空查询列最近改动的便签() {
        let db = db_with_schema();
        sticky::upsert(&db, &off(), input("old", "早写的", "")).expect("写 old");
        // 排序按 updated_at，同一毫秒内写完就成了平局：隔一点才测得出"最近在前"
        std::thread::sleep(std::time::Duration::from_millis(3));
        sticky::upsert(&db, &off(), input("new", "刚写的", "")).expect("写 new");
        let mut locked = input("secret", "锁着的", "");
        locked.is_private = true;
        sticky::upsert(&db, &off(), locked).expect("写 secret");
        sticky::upsert(&db, &off(), input("trash", "已删的", "")).expect("写 trash");
        sticky::delete(&db, "trash", false).expect("软删 trash");

        let hits = search(&db, "").expect("检索").hits;
        assert_eq!(
            hits.iter().map(|hit| hit.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "old"],
            "空查询给最近的便签，私密与已删的照旧不进"
        );
        assert_eq!(
            search(&db, "   ").expect("检索").hits.len(),
            2,
            "一串空格也算空查询"
        );
    }

    /// 待办类和时间轴类的正文住在 items / timeline 上：命中时必须跟着回来，
    /// 否则结果列表里这两类永远是一句空话。
    #[test]
    fn 待办与时间轴的条目跟着命中回来() {
        let db = db_with_schema();
        let mut list = input("l", "购物", "");
        list.content_type = "todo".into();
        list.items = vec![crate::db::models::StickyItem {
            id: "i1".into(),
            text: "买牛奶".into(),
            done: false,
        }];
        sticky::upsert(&db, &off(), list).expect("写清单");

        let mut track = input("t", "就诊记录", "");
        track.content_type = "timeline".into();
        track.timeline = vec![crate::db::models::TimelineEntry {
            id: "e1".into(),
            at: 1_700_000_000_000,
            text: "复查血常规".into(),
        }];
        sticky::upsert(&db, &off(), track).expect("写时间轴");

        // 两张的 body 都是空的，搜的就是条目里那行字
        let hits = search(&db, "牛奶").expect("检索").hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].items[0].text, "买牛奶", "body 为空也要拿得出摘要的料");

        let hits = search(&db, "血常规").expect("检索").hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].timeline[0].text, "复查血常规");
    }
}
