// 设置项 — KV 表。value 存字符串（约定："0" = 显式关，缺 key = 默认值），
// 各设置项的键名与解析随功能落地时各归各的模块，这里只管读写。

use rusqlite::OptionalExtension;

use crate::db::pool::Db;
use crate::support::error::AppResult;

pub fn get(db: &Db, key: &str) -> AppResult<Option<String>> {
    let conn = db.lock();
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(Into::into)
}

pub fn set(db: &Db, key: &str, value: &str) -> AppResult<()> {
    db.lock().execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
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
        assert_eq!(get(&db, "k").expect("读"), None);
        set(&db, "k", "1").expect("写");
        assert_eq!(get(&db, "k").expect("读"), Some("1".into()));
        set(&db, "k", "0").expect("覆盖");
        assert_eq!(get(&db, "k").expect("读"), Some("0".into()));
    }
}
