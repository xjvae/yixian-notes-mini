// media — 便签正文里的图片。表和"为什么住库不住目录"见 migrations/0005_media.sql。
//
// 这一层只管字节进字节出：`enc` 只是"这行是密文"的记号，本层不知道密钥、不碰密码学
// （加解密在命令层，走 data/private.rs 的媒体密钥）。这样查询层能被单测穷举，
// 不必先配一遍口令。

use rusqlite::{params, OptionalExtension};

use super::super::pool::Db;
use crate::support::error::{AppError, AppResult};

/// 单张字节上限。前端粘贴/拖入前先用 canvas 缩到最长边 2560，还能超这个数的是
/// 本来就巨大的图（几千万像素的相机图），那种图贴进便签没意义
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

/// 一张便签最多几张图。正文上限 2000 字，而一条 `![截图](media://m…)` 引用本身
/// 就占 20+ 字 —— 20 张吃掉 ~460 字，再多正文就没地方写字了，这条上限其实正文先到
pub const MAX_PER_NOTE: usize = 20;

/// mime 白名单。`image/svg+xml` 刻意不在内：它是文本格式，能带脚本，
/// 白名单里少一类就少一处要记住的例外（要看矢量图，截成 png 再贴）
pub const ALLOWED_MIME: &[&str] =
    &["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];

/// 形状与宽高合法吗。宽高是给渲染层占位用的（没拿到字节前也能按比例的框）
pub fn check(mime: &str, byte_len: usize, existing: i64) -> AppResult<()> {
    if !ALLOWED_MIME.contains(&mime) {
        return Err(AppError::new(
            "MEDIA_MIME",
            format!("不支持的图片类型 {mime}（认 {:?}）", ALLOWED_MIME),
        ));
    }
    if byte_len == 0 {
        return Err(AppError::new("MEDIA_EMPTY", "图片字节是空的"));
    }
    if byte_len > MAX_BYTES {
        return Err(AppError::new(
            "MEDIA_TOO_BIG",
            format!(
                "这张图 {} MB，超过单张 {} MB 上限",
                (byte_len as f64 / 1024.0 / 1024.0 * 10.0).round() / 10.0,
                MAX_BYTES / 1024 / 1024
            ),
        ));
    }
    if existing >= MAX_PER_NOTE as i64 {
        return Err(AppError::new(
            "MEDIA_TOO_MANY",
            format!("这张便签已经有 {existing} 张图，上限 {MAX_PER_NOTE} 张"),
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub struct MediaRow {
    pub id: String,
    pub note_id: String,
    pub mime: String,
    /// enc=false 时是图片原字节；true 时是密文（seal_blob 的产物，nonce 打头）
    pub bytes: Vec<u8>,
    pub enc: bool,
    pub width: i64,
    pub height: i64,
    pub created_at: i64,
}

const COLUMNS: &str = "id, note_id, mime, bytes, enc, width, height, created_at";

fn materialize(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaRow> {
    Ok(MediaRow {
        id: row.get(0)?,
        note_id: row.get(1)?,
        mime: row.get(2)?,
        bytes: row.get(3)?,
        enc: row.get::<_, i64>(4)? != 0,
        width: row.get(5)?,
        height: row.get(6)?,
        created_at: row.get(7)?,
    })
}

pub fn save(db: &Db, row: &MediaRow) -> AppResult<()> {
    db.lock()
        .execute(
            "INSERT INTO media (id, note_id, mime, bytes, enc, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                row.id,
                row.note_id,
                row.mime,
                row.bytes,
                row.enc as i64,
                row.width,
                row.height,
                row.created_at,
            ],
        )?;
    Ok(())
}

pub fn get(db: &Db, id: &str) -> AppResult<Option<MediaRow>> {
    let sql = format!("SELECT {COLUMNS} FROM media WHERE id = ?1");
    Ok(db
        .lock()
        .query_row(&sql, [id], materialize)
        .optional()?)
}

/// 删一张图。返回真删掉的行数（0 = 本来就没有，幂等）
pub fn delete(db: &Db, id: &str) -> AppResult<usize> {
    Ok(db.lock().execute("DELETE FROM media WHERE id = ?1", [id])?)
}

/// 一张便签有几张图。存之前要问一次（上限见 MAX_PER_NOTE）
pub fn count_for_note(db: &Db, note_id: &str) -> AppResult<i64> {
    Ok(db.lock().query_row(
        "SELECT COUNT(*) FROM media WHERE note_id = ?1",
        [note_id],
        |row| row.get(0),
    )?)
}

/// 一张便签的全部图（按写入顺序）。私密层翻转加密状态时要逐行重过一遍密文
pub fn list_for_note(db: &Db, note_id: &str) -> AppResult<Vec<MediaRow>> {
    // 先把那把锁落成变量：`db.lock().prepare(..)` 会让 guard 在语句结束时就被丢掉，
    // 而 stmt 还借着它里面的连接（E0716）
    let conn = db.lock();
    let sql = format!("SELECT {COLUMNS} FROM media WHERE note_id = ?1 ORDER BY created_at, id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([note_id], materialize)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 换掉一行的字节与加密标记（id 与宽高不动）。私密翻转专用
pub fn replace_bytes(db: &Db, id: &str, bytes: &[u8], enc: bool) -> AppResult<usize> {
    Ok(db.lock().execute(
        "UPDATE media SET bytes = ?2, enc = ?3 WHERE id = ?1",
        params![id, bytes, enc as i64],
    )?)
}

/// 清掉全部密文图。私密层**重置**之后要跑一次：重置造的是新的媒体密钥，
/// 旧的那些字节永远解不开了，留着既占地方又让人以为"图还在"
pub fn purge_encrypted(db: &Db) -> AppResult<usize> {
    Ok(db
        .lock()
        .execute("DELETE FROM media WHERE enc = 1", [])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::pool::Db;

    fn db_with_schema() -> Db {
        let db = Db::from_connection(rusqlite::Connection::open_in_memory().expect("内存库"));
        crate::db::migrate::run(&db).expect("建表");
        db
    }

    fn row(id: &str, note: &str, enc: bool) -> MediaRow {
        MediaRow {
            id: id.to_string(),
            note_id: note.to_string(),
            mime: "image/png".to_string(),
            bytes: vec![0x89, b'P', b'N', b'G'],
            enc,
            width: 320,
            height: 200,
            created_at: 1,
        }
    }

    #[test]
    fn 存进去的字节形状原样回来() {
        let db = db_with_schema();
        save(&db, &row("m1", "s1", false)).expect("存");
        let back = get(&db, "m1").expect("读").expect("有");
        assert_eq!(back.bytes, vec![0x89, b'P', b'N', b'G'], "BLOB 不该被改一个字节");
        assert!(!back.enc);
        assert_eq!((back.width, back.height), (320, 200));
        assert_eq!(back.note_id, "s1");
    }

    #[test]
    fn enc_标记分得清明文与密文() {
        let db = db_with_schema();
        save(&db, &row("m1", "s1", false)).expect("存明文");
        save(&db, &row("m2", "s1", true)).expect("存密文");
        assert!(!get(&db, "m1").expect("读").expect("有").enc);
        assert!(get(&db, "m2").expect("读").expect("有").enc);
        assert_eq!(purge_encrypted(&db).expect("清密文"), 1, "只带走 enc=1");
        assert!(get(&db, "m1").expect("读").is_some(), "明文那张不动");
        assert!(get(&db, "m2").expect("读").is_none());
    }

    #[test]
    fn 读不到就是_none_不是错() {
        let db = db_with_schema();
        assert!(get(&db, "no-such").expect("查不该报错").is_none());
        assert_eq!(delete(&db, "no-such").expect("删不该报错"), 0, "幂等");
    }

    /// 私密标记翻了要逐行重过密文，所以得能按写入顺序把一张便签的图捞全
    #[test]
    fn 列一张便签的图_按写入顺序_只列自己的() {
        let db = db_with_schema();
        for (id, note) in [("m1", "s1"), ("m2", "s1"), ("m3", "s2")] {
            let mut row = row(id, note, false);
            row.created_at = match id {
                "m1" => 100,
                "m2" => 50,
                _ => 200,
            };
            save(&db, &row).expect("存");
        }
        let ids: Vec<String> = list_for_note(&db, "s1")
            .expect("列")
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(ids, vec!["m2", "m1"], "created_at 早的在前，别人的不许混进来");
        assert_eq!(count_for_note(&db, "s1").expect("数"), 2);
    }

    #[test]
    fn 三条限制各自报得清() {
        // 类型：白名单外一律拒，svg 就是典型
        assert_eq!(
            check("image/svg+xml", 10, 0).expect_err("svg 要拒").code,
            "MEDIA_MIME"
        );
        assert_eq!(check("application/pdf", 10, 0).expect_err("pdf 要拒").code, "MEDIA_MIME");
        for mime in ALLOWED_MIME {
            assert!(check(mime, 10, 0).is_ok(), "{mime} 该收");
        }
        // 空字节
        assert_eq!(check("image/png", 0, 0).expect_err("空要拒").code, "MEDIA_EMPTY");
        // 单张体积：卡在边界上
        assert!(check("image/png", MAX_BYTES, 0).is_ok(), "正好 5 MB 算收");
        assert_eq!(
            check("image/png", MAX_BYTES + 1, 0).expect_err("超一点就拒").code,
            "MEDIA_TOO_BIG"
        );
        // 张数
        assert!(check("image/png", 10, MAX_PER_NOTE as i64 - 1).is_ok());
        assert_eq!(
            check("image/png", 10, MAX_PER_NOTE as i64)
                .expect_err("满了还塞")
                .code,
            "MEDIA_TOO_MANY"
        );
    }
}
