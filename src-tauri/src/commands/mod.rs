// 命令层 — 前端 invoke 的全部入口都在 commands/ 下；实现留在各自模块。
// 命令必须是 async：同步命令跑在主线程上，一行 SQL 就能把 UI 卡住。
// DB 操作统一走 `run_db`（spawn_blocking），MutexGuard 永不跨 .await。

// 子模块必须 pub：generate_handler! 要在同模块里找命令宏生成的隐藏项
pub mod db;
pub mod entity;
pub mod hotkey;
pub mod search;
pub mod window;

use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};

/// 把 DB 调用丢进阻塞线程池：拿锁的同步函数留在 spawn_blocking 的闭包里
async fn run_db<T, F>(db: Db, task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Db) -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || task(&db))
        .await
        .map_err(|e| AppError::new("DB_TASK", e.to_string()))?
}
