// 日志 — 落盘 + stderr 双写。装包复测时作者只会说"点了没反应"，
// 能还原现场的只有这份文件；发布版没有控制台，stderr 那路只在开发期有用。
//
// 按天一个文件（mini.log.YYYYMMDD），保留最近 KEEP_DAYS 天，初始化时顺手清旧的。
// 目录没建成（权限/路径异常）不影响启动：只剩 stderr，调用方无感。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::clock;

const KEEP_DAYS: i64 = 7;

static LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(dir: &Path) {
    let logs = dir.join("logs");
    if std::fs::create_dir_all(&logs).is_err() {
        return;
    }
    prune_old(&logs);
    *LOG_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(logs);
}

pub fn info(scope: &str, message: &str) {
    write("INFO", scope, message);
}

pub fn warn(scope: &str, message: &str) {
    write("WARN", scope, message);
}

pub fn error(scope: &str, message: &str) {
    write("ERROR", scope, message);
}

fn write(level: &str, scope: &str, message: &str) {
    let now = clock::now_ms();
    let label = clock::timestamp_label(now);
    let line = format!(
        "{} [{level:<5}] {scope}: {message}",
        label
    );
    eprintln!("{line}");
    let dir = LOG_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let Some(dir) = dir else { return };
    let path = dir.join(format!("mini.log.{}", &label[..8]));
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// 清掉保留期之外的旧日志（按文件修改时间）
fn prune_old(logs_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(logs_dir) else {
        return;
    };
    let cutoff = clock::now_ms() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let age_ms = clock::now_ms()
            - modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
        if age_ms > KEEP_DAYS * 24 * 60 * 60 * 1000 && meta.is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
        let _ = cutoff; // 保留期口径即上面的 age_ms 判定
    }
}
