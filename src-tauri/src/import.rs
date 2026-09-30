// import — 旧版应用（com.yixian.notes.mini）mini.db 的一次性导入。
//
// 三条纪律：
//  1. **幂等**：标记写在 settings 表（legacy_import_done_v1），与数据同一个事务——
//     导入成功但标记没写成 = 回滚重来，绝不会导入两份；
//  2. **只读旧库**：旧库以只读方式打开，旧应用的文件一个字节都不动（两边共存期间
//     用户随时可以回旧版）；
//  3. **摊回桌面**：旧库 floating=0 的未删便签是"只在墙上"的存量，新版没有墙——
//     导入时统一 floating=1、collapsed=0，否则它们永远不可达。
//
// 列映射（旧 → 新）：text→title、color→theme、w/h→width/height、always_on_top→pinned、
// remind_repeat→repeat；items_json（"[x] 文本" 字符串数组）+ item_ids_json 合成
// {id,text,done} 对象数组；timeline_json 去掉 exact 位。丢弃不迁移：monitor/sort/
// opacity/locked/pin_mode/pinned（新版没有对应能力）。

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::db::models::StickyItem;
use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};
use crate::support::log;

pub const MARKER_KEY: &str = "legacy_import_done_v1";
const LEGACY_DIR_NAME: &str = "com.yixian.notes.mini";

pub struct ImportReport {
    pub stickies: usize,
    pub groups: usize,
    pub spread: usize,
}

/// 旧库路径：本应用数据目录的兄弟目录（同一个 %APPDATA% 父目录下）。
pub fn legacy_db_path(our_dir: &Path) -> Option<PathBuf> {
    let path = our_dir
        .parent()?
        .join(LEGACY_DIR_NAME)
        .join("mini.db");
    path.exists().then_some(path)
}

/// 启动入口。失败不挡启动（下次启动重试），成功后标记防重入。
pub fn run(our_dir: &Path, db: &Db) {
    let Some(path) = legacy_db_path(our_dir) else {
        return;
    };
    match import_from(&path, db) {
        Ok(Some(report)) => {
            log::info(
                "import",
                &format!(
                    "旧库导入完成：便签 {} 张（含摊回桌面 {} 张）、组合 {} 组",
                    report.stickies, report.spread, report.groups
                ),
            );
        }
        Ok(None) => {}
        Err(e) => log::warn("import", &format!("旧库导入失败（下次启动重试）：{e}")),
    }
}

/// 执行导入。返回 None = 标记已存在（导入过）。整个导入 + 标记在同一个事务里。
pub fn import_from(legacy_path: &Path, db: &Db) -> AppResult<Option<ImportReport>> {
    let legacy = Connection::open_with_flags(
        legacy_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| AppError::new("IMPORT", format!("打不开旧库 {}：{e}", legacy_path.display())))?;

    let conn = db.lock();
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [MARKER_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if done.is_some() {
        return Ok(None);
    }

    let tx = conn.unchecked_transaction()?;
    let mut stickies = 0usize;
    let mut groups = 0usize;

    {
        let mut stmt = legacy.prepare(
            "SELECT id, text, body, color, content_type, x, y, w, h, always_on_top, \
             collapsed, private, floating, deleted, deleted_at, due_at, done_at, \
             remind_repeat, items_json, item_ids_json, tags_json, timeline_json, \
             docked, dock_edge, group_id, created_at, updated_at \
             FROM stickies",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(LegacySticky {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                color: row.get(3)?,
                content_type: row.get(4)?,
                x: row.get(5)?,
                y: row.get(6)?,
                w: row.get(7)?,
                h: row.get(8)?,
                always_on_top: row.get::<_, i64>(9)? != 0,
                collapsed: row.get::<_, i64>(10)? != 0,
                private: row.get::<_, i64>(11)? != 0,
                floating: row.get::<_, i64>(12)? != 0,
                deleted: row.get::<_, i64>(13)? != 0,
                deleted_at: row.get(14)?,
                due_at: row.get(15)?,
                done_at: row.get(16)?,
                remind_repeat: row.get(17)?,
                items_json: row.get(18)?,
                item_ids_json: row.get(19)?,
                tags_json: row.get(20)?,
                timeline_json: row.get(21)?,
                docked: row.get::<_, i64>(22)? != 0,
                dock_edge: row.get(23)?,
                group_id: row.get(24)?,
                created_at: row.get(25)?,
                updated_at: row.get(26)?,
            })
        })?;
        for row in rows {
            let legacy = row.map_err(|e| AppError::new("IMPORT", format!("读旧行失败：{e}")))?;
            let mapped = legacy.into_new();
            tx.execute(
                "INSERT OR IGNORE INTO stickies (
                    id, title, body, content_type, items_json, timeline_json, tags_json, theme,
                    pinned, floating, collapsed, private, group_id,
                    x, y, width, height, due_at, done_at, repeat,
                    deleted, deleted_at, created_at, updated_at, docked, dock_edge
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)",
                params![
                    mapped.id,
                    mapped.title,
                    mapped.body,
                    mapped.content_type,
                    mapped.items_json,
                    mapped.timeline_json,
                    mapped.tags_json,
                    mapped.theme,
                    mapped.pinned as i64,
                    mapped.floating,
                    mapped.collapsed as i64,
                    mapped.private as i64,
                    mapped.group_id,
                    mapped.x,
                    mapped.y,
                    mapped.width,
                    mapped.height,
                    mapped.due_at,
                    mapped.done_at,
                    mapped.repeat,
                    mapped.deleted as i64,
                    mapped.deleted_at,
                    mapped.created_at,
                    mapped.updated_at,
                    mapped.docked as i64,
                    mapped.dock_edge,
                ],
            )?;
            stickies += tx.changes() as usize;
        }
    }

    {
        let mut stmt = legacy.prepare(
            "SELECT id, name, color, collapsed, x, y, w, h, created_at, updated_at FROM groups",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)? != 0,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })?;
        for row in rows {
            let (id, name, color, collapsed, x, y, w, h, created_at, updated_at) =
                row.map_err(|e| AppError::new("IMPORT", format!("读旧组失败：{e}")))?;
            tx.execute(
                "INSERT OR IGNORE INTO groups (id, name, color, collapsed, x, y, width, height, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![id, name, color, collapsed, x, y, w, h, created_at, updated_at],
            )?;
            groups += tx.changes() as usize;
        }
    }

    // 摊回桌面：旧库 floating=0 的未删便签是"只在墙上"的存量，新版没有墙。
    // 只动刚导入的这一批没有意义——新应用自己创建的便签 floating 恒为 1，
    // 全表 UPDATE 天然只影响导入进来的墙存量。
    let spread = tx.execute(
        "UPDATE stickies SET floating = 1, collapsed = 0 WHERE deleted = 0 AND floating = 0",
        [],
    )?;

    let stamp = crate::support::clock::timestamp_label(crate::support::clock::now_ms());
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [MARKER_KEY, stamp.as_str()],
    )?;
    tx.commit()?;

    Ok(Some(ImportReport { stickies, groups, spread }))
}

struct LegacySticky {
    id: String,
    title: String,
    body: String,
    color: String,
    content_type: String,
    x: Option<i64>,
    y: Option<i64>,
    w: Option<i64>,
    h: Option<i64>,
    always_on_top: bool,
    collapsed: bool,
    private: bool,
    floating: bool,
    deleted: bool,
    deleted_at: Option<i64>,
    due_at: Option<i64>,
    done_at: Option<i64>,
    remind_repeat: String,
    items_json: String,
    item_ids_json: String,
    tags_json: String,
    timeline_json: String,
    docked: bool,
    dock_edge: Option<String>,
    group_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl LegacySticky {
    fn into_new(self) -> NewSticky {
        NewSticky {
            id: self.id,
            title: self.title,
            body: self.body,
            content_type: self.content_type,
            items_json: serde_json::to_string(&map_items(&self.items_json, &self.item_ids_json))
                .unwrap_or_else(|_| "[]".into()),
            timeline_json: map_timeline(&self.timeline_json),
            tags_json: normalize_string_array(&self.tags_json),
            theme: self.color,
            pinned: self.always_on_top,
            floating: self.floating,
            collapsed: self.collapsed,
            private: self.private,
            group_id: self.group_id,
            x: self.x,
            y: self.y,
            width: self.w,
            height: self.h,
            due_at: self.due_at,
            done_at: self.done_at,
            repeat: normalize_repeat(&self.remind_repeat),
            deleted: self.deleted,
            deleted_at: self.deleted_at,
            docked: self.docked,
            dock_edge: normalize_edge(self.dock_edge),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

struct NewSticky {
    id: String,
    title: String,
    body: String,
    content_type: String,
    items_json: String,
    timeline_json: String,
    tags_json: String,
    theme: String,
    pinned: bool,
    floating: bool,
    collapsed: bool,
    private: bool,
    group_id: Option<String>,
    x: Option<i64>,
    y: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    due_at: Option<i64>,
    done_at: Option<i64>,
    repeat: String,
    deleted: bool,
    deleted_at: Option<i64>,
    docked: bool,
    dock_edge: Option<String>,
    created_at: i64,
    updated_at: i64,
}

/// 旧 items：`["[ ] 买牛奶", "[x] 寄快递"]` + 独立的 item_ids 数组
/// → 新 items：`[{id, text, done}]`。id 缺行就现造（对齐后多余的可容忍）。
fn map_items(items_json: &str, ids_json: &str) -> Vec<StickyItem> {
    let items: Vec<String> = serde_json::from_str(items_json).unwrap_or_default();
    let ids: Vec<String> = serde_json::from_str(ids_json).unwrap_or_default();
    items
        .into_iter()
        .enumerate()
        .map(|(index, raw)| {
            let (done, text) = if let Some(rest) = raw.strip_prefix("[x] ") {
                (true, rest.to_string())
            } else if let Some(rest) = raw.strip_prefix("[ ] ") {
                (false, rest.to_string())
            } else {
                (false, raw)
            };
            let id = ids.get(index).cloned().unwrap_or_else(|| {
                format!("i{}{:x}", index, crate::db::query::sticky::now_ms())
            });
            StickyItem { id, text, done }
        })
        .collect()
}

/// 旧 timeline 条目 {id, text, at, exact?} → 新 {id, at, text}（exact 位丢弃）
fn map_timeline(timeline_json: &str) -> String {
    let entries: Vec<Value> = serde_json::from_str(timeline_json).unwrap_or_default();
    let mapped: Vec<serde_json::Value> = entries
        .into_iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_string();
            let text = entry.get("text")?.as_str()?.to_string();
            let at = entry.get("at")?.as_i64().unwrap_or(0);
            Some(serde_json::json!({ "id": id, "at": at, "text": text }))
        })
        .collect();
    serde_json::to_string(&mapped).unwrap_or_else(|_| "[]".into())
}

/// 字符串数组原样搬，但形状不对（非数组/含非字符串）时落成 []
fn normalize_string_array(json: &str) -> String {
    let parsed: Result<Vec<String>, _> = serde_json::from_str(json);
    serde_json::to_string(&parsed.unwrap_or_default()).unwrap_or_else(|_| "[]".into())
}

fn normalize_repeat(value: &str) -> String {
    match value {
        "daily" | "weekly" => value.to_string(),
        _ => "none".into(),
    }
}

fn normalize_edge(value: Option<String>) -> Option<String> {
    match value.as_deref() {
        Some("left" | "right" | "top" | "bottom") => value,
        _ => None,
    }
}

use serde_json::Value;

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 旧库 schema 的最小重建（只含导入读得到的列）
    fn make_legacy_db(path: &Path) {
        let conn = Connection::open(path).expect("开旧库");
        conn.execute_batch(
            r#"
            CREATE TABLE stickies (
              id TEXT PRIMARY KEY, text TEXT DEFAULT '', body TEXT DEFAULT '',
              color TEXT DEFAULT 'yellow', content_type TEXT DEFAULT 'todo',
              x INTEGER, y INTEGER, w INTEGER, h INTEGER,
              always_on_top INTEGER DEFAULT 1, collapsed INTEGER DEFAULT 0,
              private INTEGER DEFAULT 0, floating INTEGER DEFAULT 0,
              deleted INTEGER DEFAULT 0, deleted_at INTEGER,
              due_at INTEGER, done_at INTEGER,
              remind_repeat TEXT DEFAULT 'none',
              items_json TEXT DEFAULT '[]', item_ids_json TEXT DEFAULT '[]',
              tags_json TEXT DEFAULT '[]', timeline_json TEXT DEFAULT '[]',
              docked INTEGER DEFAULT 0, dock_edge TEXT,
              group_id TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
            );
            CREATE TABLE groups (
              id TEXT PRIMARY KEY, name TEXT DEFAULT '', color TEXT,
              collapsed INTEGER DEFAULT 0, x INTEGER, y INTEGER, w INTEGER, h INTEGER,
              created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
            );
            INSERT INTO stickies (id, text, body, color, content_type, x, y, w, h, items_json, item_ids_json, tags_json, floating, created_at, updated_at)
            VALUES ('s1', '标题甲', '正文', 'blue', 'text', 10, 20, 320, 300, '[]', '[]', '["工作"]', 1, 100, 200);
            INSERT INTO stickies (id, text, color, content_type, items_json, item_ids_json, floating, created_at, updated_at)
            VALUES ('s2', '待办乙', 'green', 'todo',
                    '["[ ] 买牛奶","[x] 寄快递"]', '["i1","i2"]', 1, 100, 200);
            INSERT INTO stickies (id, text, color, floating, deleted, deleted_at, created_at, updated_at)
            VALUES ('s3', '已删的', 'gray', 0, 1, 555, 100, 200);
            INSERT INTO stickies (id, text, color, floating, collapsed, created_at, updated_at)
            VALUES ('s4', '只在墙上', 'yellow', 0, 0, 100, 200);
            INSERT INTO groups (id, name, color, collapsed, w, h, created_at, updated_at)
            VALUES ('g1', '一叠', NULL, 0, 300, 260, 100, 200);
            UPDATE stickies SET group_id = 'g1' WHERE id = 's2';
            "#,
        )
        .expect("建旧库");
    }

    fn new_db() -> Db {
        let db = Db::from_connection(Connection::open_in_memory().expect("内存库"));
        db.lock()
            .execute_batch(include_str!("../migrations/0001_init.sql"))
            .expect("建表");
        db.lock()
            .execute_batch(include_str!("../migrations/0002_timeline.sql"))
            .expect("补列");
        db.lock()
            .execute_batch(include_str!("../migrations/0003_dock.sql"))
            .expect("补贴边列");
        db
    }

    #[test]
    fn 全量导入_列映射逐格对齐() {
        let dir = std::env::temp_dir().join("yixian-import-test-full");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("目录");
        let legacy = dir.join("legacy").join("mini.db");
        std::fs::create_dir_all(legacy.parent().unwrap()).expect("旧目录");
        make_legacy_db(&legacy);
        let db = new_db();

        let report = import_from(&legacy, &db).expect("导入").expect("首跑有报告");
        assert_eq!(report.stickies, 4);
        assert_eq!(report.groups, 1);

        let conn = db.lock();
        let (title, theme, w): (String, String, i64) = conn
            .query_row(
                "SELECT title, theme, width FROM stickies WHERE id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("读 s1");
        assert_eq!((title.as_str(), theme.as_str(), w), ("标题甲", "blue", 320));

        let items: String = conn
            .query_row("SELECT items_json FROM stickies WHERE id='s2'", [], |r| r.get(0))
            .expect("读 s2 items");
        let parsed: Vec<StickyItem> = serde_json::from_str(&items).expect("新形状");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].text, "买牛奶");
        assert!(!parsed[0].done);
        assert_eq!(parsed[1].text, "寄快递");
        assert!(parsed[1].done);
        assert_eq!(parsed[1].id, "i2", "旧条目 id 照搬");
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT group_id FROM stickies WHERE id='s2'",
                [],
                |r| r.get(0)
            )
            .expect("组"),
            "g1"
        );
        let group_name: String = conn
            .query_row("SELECT name FROM groups WHERE id='g1'", [], |r| r.get(0))
            .expect("组行");
        assert_eq!(group_name, "一叠");
    }

    #[test]
    fn 墙存量摊回桌面_已删的不动() {
        let dir = std::env::temp_dir().join("yixian-import-test-spread");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("目录");
        let legacy = dir.join("legacy").join("mini.db");
        std::fs::create_dir_all(legacy.parent().unwrap()).expect("旧目录");
        make_legacy_db(&legacy);
        let db = new_db();

        let report = import_from(&legacy, &db).expect("导入").expect("报告");
        assert_eq!(report.spread, 1, "只有 s4（墙存量）需要摊回");

        let conn = db.lock();
        let (floating, collapsed): (i64, i64) = conn
            .query_row(
                "SELECT floating, collapsed FROM stickies WHERE id='s4'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("读 s4");
        assert_eq!((floating, collapsed), (1, 0), "摊回桌面且展开");

        let floating_deleted: i64 = conn
            .query_row(
                "SELECT floating FROM stickies WHERE id='s3'",
                [],
                |r| r.get(0),
            )
            .expect("读 s3");
        assert_eq!(floating_deleted, 0, "已删的行摊回无意义，保持原样");
    }

    #[test]
    fn 标记同事务_重跑不导入两份() {
        let dir = std::env::temp_dir().join("yixian-import-test-idempotent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("目录");
        let legacy = dir.join("legacy").join("mini.db");
        std::fs::create_dir_all(legacy.parent().unwrap()).expect("旧目录");
        make_legacy_db(&legacy);
        let db = new_db();

        import_from(&legacy, &db).expect("首跑").expect("首跑有报告");
        let second = import_from(&legacy, &db).expect("二跑");
        assert!(second.is_none(), "标记已写，二跑是空操作");

        let count: i64 = db
            .lock()
            .query_row("SELECT COUNT(*) FROM stickies", [], |r| r.get(0))
            .expect("计数");
        assert_eq!(count, 4, "不会出现两份");
    }
}
