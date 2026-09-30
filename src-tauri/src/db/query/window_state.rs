// window_state — 面板窗（搜索/回收站/设置）的位置尺寸记忆。
// 实体浮窗的位置记在自己的 stickies 行上，不走这张表。

use rusqlite::{OptionalExtension, params};

use crate::db::pool::Db;
use crate::support::error::AppResult;

pub fn set(db: &Db, label: &str, x: i64, y: i64, width: i64, height: i64) -> AppResult<()> {
    db.lock().execute(
        "INSERT INTO window_state (label, x, y, width, height) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(label) DO UPDATE SET x=?2, y=?3, width=?4, height=?5",
        params![label, x, y, width, height],
    )?;
    Ok(())
}

/// (x, y, width, height)，物理像素。没记过 = None。
pub fn get(db: &Db, label: &str) -> AppResult<Option<(i64, i64, i64, i64)>> {
    let conn = db.lock();
    conn.query_row(
        "SELECT x, y, width, height FROM window_state WHERE label = ?1",
        [label],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .optional()
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn 往返与覆盖() {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        db.lock()
            .execute_batch(include_str!("../../../migrations/0001_init.sql"))
            .expect("建表");
        assert_eq!(get(&db, "search").expect("读"), None);
        set(&db, "search", 100, 90, 480, 420).expect("写");
        assert_eq!(
            get(&db, "search").expect("读"),
            Some((100, 90, 480, 420))
        );
        set(&db, "search", 200, 80, 500, 460).expect("覆盖");
        assert_eq!(get(&db, "search").expect("读"), Some((200, 80, 500, 460)));
    }
}
