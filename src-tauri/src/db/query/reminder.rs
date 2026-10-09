// 提醒扫描 — 到点该响的那几张。判据是纯函数 `due_to_fire`，可以穷举，不碰连接。
//
// 为什么在 Rust 侧扫而不是前端定时器：窗可能是隐藏的（贴边、收起、根本没开），
// 隐藏页里的 `setInterval` 会被 WebView2 节流甚至暂停，"到点不响"就是这么来的。
// 应用本身常驻（托盘 + 星环 + 全局钩子），所以计时放这儿。
//
// 发生点（occurrence）算法：锚点 + k×24h（daily）/ + k×7d（weekly）。这与前端
// `data/due.ts::nextOccurrence`（按日历天 + 墙上时刻）在**无夏令时的时区里完全等价**；
// 有 DST 的地方两者会差一小时，那条口径写在前端那份注释里，这里不另发明一套轮子。

use crate::db::pool::Db;
use crate::support::error::AppResult;

/// 过期太久就不补弹：开机时对着一年前的提醒弹一条通知，只会让人觉得这功能疯了。
/// 24 小时是拍的（作者口径"超 24h 不补"）。
pub const REMIND_GRACE_MS: i64 = 24 * 60 * 60 * 1000;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const WEEK_MS: i64 = 7 * DAY_MS;

/// 一条到期提醒的扫描结果。`occurrence` 是这一次发生的时刻，直接写回 `reminded_at`。
///
/// `group_id` 决定"拉到屏上"去找哪扇窗：组员住在 `stickygrp-*` 那一叠里，
/// `sticky-<id>` 那扇单窗对它压根不存在（漏了这一列，组里的提醒就只有通知、没有落点）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub id: String,
    pub title: String,
    pub private: bool,
    pub floating: bool,
    pub group_id: Option<String>,
    /** 这张纸的颜色（`themes` 里那个键）。卡要跟着它画——提醒不该长得像个系统对话框 */
    pub theme: String,
    pub occurrence: i64,
}

/// 该不该响、为哪一次发生响。返回 `Some(发生点)` = 该弹一次。
///
/// 三条判据缺一不可：
///
/// - 发生点必须**已经过去**（`occurrence <= now`）；
/// - 但不能过去太久（`now - occurrence <= REMIND_GRACE_MS`），否则陈年提醒会补弹一堆；
/// - 而且这一次**没弹过**（`reminded_at != occurrence`）。存的不是时间戳而是发生点，
///   所以用户一改到期时间就自动重新生效，不用谁记得去清标记。
///
/// 还没完成（`done_at` 为空）才谈得上提醒，这条由调用方的 WHERE 挡（这里不重复判）。
pub fn due_to_fire(
    due_at: i64,
    repeat: &str,
    reminded_at: Option<i64>,
    now: i64,
) -> Option<i64> {
    let occurrence = match repeat {
        "daily" if due_at <= now => due_at + ((now - due_at) / DAY_MS) * DAY_MS,
        "weekly" if due_at <= now => due_at + ((now - due_at) / WEEK_MS) * WEEK_MS,
        // 不重复的：锚点就是唯一那次；重复但锚点还在未来：还没到第一轮
        _ => due_at,
    };
    if occurrence > now {
        return None;
    }
    if now - occurrence > REMIND_GRACE_MS {
        return None;
    }
    if reminded_at == Some(occurrence) {
        return None;
    }
    Some(occurrence)
}

/// 捞该响的那几张。`content_type='reminder'` 是唯一的门槛——别的类型即便填了 due_at
/// 也不该响（那字段对它们没有意义）。
pub fn pending(db: &Db, now: i64) -> AppResult<Vec<Due>> {
    let conn = db.lock();
    let mut stmt = conn.prepare(
        "SELECT id, title, private, floating, group_id, theme, due_at, repeat, reminded_at \
         FROM stickies \
         WHERE deleted = 0 AND content_type = 'reminder' AND due_at IS NOT NULL AND done_at IS NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        let due_at: Option<i64> = row.get("due_at")?;
        let repeat: Option<String> = row.get("repeat")?;
        let reminded_at: Option<i64> = row.get("reminded_at")?;
        let occurrence = match due_at {
            Some(at) => due_to_fire(at, repeat.as_deref().unwrap_or("none"), reminded_at, now),
            None => None,
        };
        Ok((
            Due {
                id: row.get("id")?,
                title: row.get("title")?,
                private: row.get::<_, i64>("private")? != 0,
                floating: row.get::<_, i64>("floating")? != 0,
                group_id: row.get("group_id")?,
                theme: row.get("theme")?,
                occurrence: occurrence.unwrap_or(0),
            },
            occurrence.is_some(),
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (due, fire) = row?;
        if fire {
            out.push(due);
        }
    }
    Ok(out)
}

/// 记下"这一次已经弹过了"。**发完再写**：先写后发，一旦发通知那步崩了，
/// 这条提醒就永远哑了（用户看不到任何东西，还以为自己没设）。
pub fn mark(db: &Db, id: &str, occurrence: i64) -> AppResult<()> {
    let conn = db.lock();
    // 目标行可能在这中间被删了/改时间了：写 0 行不算错（下一次扫描再判一遍）
    conn.execute(
        "UPDATE stickies SET reminded_at = ?2 WHERE id = ?1 AND deleted = 0",
        rusqlite::params![id, occurrence],
    )?;
    Ok(())
}

/// 一行当前的 `reminded_at`。**没有"改到期时间时清标记"那条路**：存的本来就是发生点，
/// 改完对不上自然就重新生效，多一个清标记的入口只是多一处能写错的地方。
/// 只有用例读它（生产路径不需要），所以 `pub(crate)` + 允许 dead-code 之外的写法：
/// 直接放进 tests，避免给 lib 留一个只有测试用的公开 API。
#[cfg(test)]
fn fired_for(db: &Db, id: &str) -> Option<i64> {
    use rusqlite::OptionalExtension;

    let conn = db.lock();
    // 两层 Option：外层"这行在不在"（.optional() 把 QueryDne 换成 None），
    // 内层是那一列本身可空
    let found: Option<Option<i64>> = conn
        .query_row(
            "SELECT reminded_at FROM stickies WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .expect("读 reminded_at");
    found.flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 60 * 60 * 1000;

    #[test]
    fn 到点才响_没到点不响() {
        let due_at = 1_000_000;
        assert_eq!(due_to_fire(due_at, "none", None, due_at - 1), None);
        assert_eq!(due_to_fire(due_at, "none", None, due_at), Some(due_at));
    }

    #[test]
    fn 过期超过24小时就不补弹() {
        let due_at = 0;
        assert_eq!(
            due_to_fire(due_at, "none", None, REMIND_GRACE_MS),
            Some(due_at),
            "正好 24 小时还在宽限内"
        );
        assert_eq!(due_to_fire(due_at, "none", None, REMIND_GRACE_MS + 1), None);
    }

    #[test]
    fn 同一次发生只弹一次() {
        let due_at = 5 * HOUR;
        assert_eq!(due_to_fire(due_at, "none", Some(due_at), due_at + HOUR), None);
        // 改了到期时间 = 发生点变了 = 自动重新生效（不用谁去清标记）
        assert_eq!(due_to_fire(due_at, "none", Some(0), due_at + HOUR), Some(due_at));
    }

    #[test]
    fn 每天提醒按锚点推到最近那次发生() {
        let anchor = 9 * HOUR; // 锚点：某天 09:00
        let now = anchor + 3 * DAY_MS + 2 * HOUR; // 第三天 11:00
        assert_eq!(
            due_to_fire(anchor, "daily", Some(anchor), now),
            Some(anchor + 3 * DAY_MS),
            "弹过锚点那次之后，第三天的 09:00 还要再弹"
        );
        // 同一天里再扫一遍不能重复弹
        let fired = anchor + 3 * DAY_MS;
        assert_eq!(due_to_fire(anchor, "daily", Some(fired), now + HOUR), None);
    }

    #[test]
    fn 每周提醒锚点还在未来时不响() {
        let anchor = 10 * DAY_MS;
        assert_eq!(due_to_fire(anchor, "weekly", None, anchor - HOUR), None);
        assert_eq!(due_to_fire(anchor, "weekly", None, anchor), Some(anchor));
    }

    #[test]
    fn 认不出的重复值按不重复处理() {
        let due_at = 100;
        assert_eq!(due_to_fire(due_at, "hourly", None, due_at), Some(due_at));
        assert_eq!(due_to_fire(due_at, "", None, due_at), Some(due_at));
    }

    // —— 下面这几条走真库：SQL 里写错列名、WHERE 少一个条件，纯函数测不出来 ——

    use crate::db::models::StickyInput;
    use rusqlite::Connection;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn reminder_row(id: &str, due_at: Option<i64>, repeat: &str) -> StickyInput {
        StickyInput {
            id: id.to_string(),
            title: format!("买{name}", name = if id == "s1" { "菜" } else { "东西" }),
            body: String::new(),
            content_type: "reminder".into(),
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
            due_at,
            done_at: None,
            repeat: repeat.into(),
            deleted: false,
            docked: false,
            dock_edge: None,
            icon: None,
            auto_size: None,
        }
    }

    #[test]
    fn 扫描捞得到_勾完成的捞不到() {
        let db = db_with_schema();
        let now = 10 * DAY_MS;
        crate::db::query::sticky::upsert(&db, reminder_row("s1", Some(now - HOUR), "none"))
            .expect("写到期提醒");
        crate::db::query::sticky::upsert(&db, reminder_row("s2", Some(now + HOUR), "none"))
            .expect("写未来提醒");
        let mut done = reminder_row("s3", Some(now - HOUR), "none");
        done.done_at = Some(now);
        crate::db::query::sticky::upsert(&db, done).expect("写已勾掉的");
        // 非 reminder 类型就算填了 due_at 也不该响
        let mut text = reminder_row("s4", Some(now - HOUR), "none");
        text.content_type = "text".into();
        crate::db::query::sticky::upsert(&db, text).expect("写文本便签");

        let got = pending(&db, now).expect("扫描");
        assert_eq!(
            got.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["s1"],
            "只有那条到期未处理的 reminder 该响"
        );
        assert_eq!(got[0].occurrence, now - HOUR);
        assert_eq!(got[0].title, "买菜");
        assert_eq!(got[0].theme, "yellow", "卡要跟着这张纸的颜色画，这一列不能不捞");
    }

    #[test]
    fn 组里的提醒带得出组id() {
        let db = db_with_schema();
        let now = 10 * DAY_MS;
        db.lock()
            .execute(
                "INSERT INTO groups (id, name, created_at, updated_at) \
                 VALUES ('g1', '组', 1, 1)",
                [],
            )
            .expect("建组");
        let mut member = reminder_row("s1", Some(now - HOUR), "none");
        member.group_id = Some("g1".into());
        crate::db::query::sticky::upsert(&db, member).expect("写组员");
        crate::db::query::sticky::upsert(&db, reminder_row("s2", Some(now - HOUR), "none"))
            .expect("写散着的");

        let got = pending(&db, now).expect("扫描");
        assert_eq!(got.len(), 2);
        // SELECT 没有 ORDER BY，所以按 id 认领，不比位置
        let member = got.iter().find(|row| row.id == "s1").expect("组员该被捞到");
        let loose = got.iter().find(|row| row.id == "s2").expect("散着的该被捞到");
        assert_eq!(
            member.group_id.as_deref(),
            Some("g1"),
            "落点信息不许在 SQL 那一步丢掉"
        );
        assert_eq!(loose.group_id, None, "散着的就是 None，别给个假组");
    }

    #[test]
    fn 标过弹过的不再捞_普通保存冲不掉这个记号() {
        let db = db_with_schema();
        let now = 10 * DAY_MS;
        let row = reminder_row("s1", Some(now - HOUR), "none");
        crate::db::query::sticky::upsert(&db, row.clone()).expect("写");
        let occurrence = now - HOUR;

        assert_eq!(pending(&db, now).expect("扫").len(), 1);
        mark(&db, "s1", occurrence).expect("标记");
        assert!(pending(&db, now).expect("扫").is_empty(), "弹过的这一轮不再捞");
        assert_eq!(fired_for(&db, "s1"), Some(occurrence));

        // 关键一条：前端一次普通保存（同一个 due_at 原样写回）不许把记号冲没
        crate::db::query::sticky::upsert(&db, row.clone()).expect("再存一次");
        assert_eq!(
            fired_for(&db, "s1"),
            Some(occurrence),
            "upsert 的列清单里没有 reminded_at，保存不该动它"
        );

        // 改了到期时间 = 新的发生点 = 自动重新生效
        let mut moved = row;
        moved.due_at = Some(now - 2 * HOUR);
        crate::db::query::sticky::upsert(&db, moved).expect("改时间");
        assert_eq!(pending(&db, now).expect("扫").len(), 1, "改完要能再响");
    }
}
