// 命令层 — 前端 invoke 的全部入口都在 commands/ 下；实现留在各自模块。
// 命令必须是 async：同步命令跑在主线程上，一行 SQL 就能把 UI 卡住。
// 重活统一走 run_db / run_task（spawn_blocking），MutexGuard 永不跨 .await。

// 子模块必须 pub：generate_handler! 要在同模块里找命令宏生成的隐藏项
pub mod autostart;
pub mod db;
pub mod entity;
pub mod hook;
pub mod hotkey;
pub mod media;
pub mod private;
pub mod search;
pub mod window;

use crate::db::pool::Db;
use crate::support::error::{AppError, AppResult};

/// DB 调用：拿锁的同步函数留在闭包里，连库一起挪进阻塞线程池
async fn run_db<T, F>(db: Db, task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Db) -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || task(&db))
        .await
        .map_err(|e| AppError::new("DB_TASK", e.to_string()))?
}

/// 无状态的重活（加解密/文件 IO）：同一条纪律的另一种形状
async fn run_task<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| AppError::new("TASK", e.to_string()))?
}
