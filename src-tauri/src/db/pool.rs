// pool — 一条连接就够。单用户桌面应用、所有写都排在 spawn_blocking 里串行化，
// 一个 Mutex<Connection> 就是全部需要的并发控制。连接池换来的不是吞吐，
// 而是"WAL 下不同连接读快照不一致"这类新 bug。
//
// 两条硬规矩：
//   1. `lock()` 绝不返回 Err：release 构建是 panic = "abort"，锁一旦中毒只能
//      照常往下走（into_inner），否则一次 panic 之后每次取连接都是 PoisonError。
//   2. MutexGuard 不是 Send：拿锁的代码只能待在同步函数里。这不是限制，是防线——
//      跨 .await 持锁会把整条 IPC 通道路死。命令层因此统一走 `run_db`（commands/mod.rs）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use crate::support::error::{AppError, AppResult};

/// 主库文件名
pub const DB_FILE: &str = "mini.db";

#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
    /// 数据目录（备份、导入等路径用）
    #[allow(dead_code)] // 随 ROADMAP M4 的备份/旧库导入启用
    dir: PathBuf,
}

impl Db {
    /// 生产入口：按数据目录打开（自动建目录、设 pragma）
    pub fn open(dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::new("DB_OPEN", format!("数据目录建不出来：{e}")))?;
        let conn = Connection::open(dir.join(DB_FILE))
            .map_err(|e| AppError::new("DB_OPEN", format!("打不开 {DB_FILE}：{e}")))?;
        Ok(Self::from_connection(conn))
    }

    /// 测试入口：由调用方给定连接（内存库）
    pub fn from_connection(conn: Connection) -> Self {
        // journal_mode 返回结果行，走 query_row 而不是 pragma_update
        let _ = conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        });
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
        Self {
            inner: Arc::new(Mutex::new(conn)),
            dir: PathBuf::new(),
        }
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
