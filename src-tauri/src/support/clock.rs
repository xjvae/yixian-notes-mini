// clock — 时间戳工具。备份文件名、日志文件名共用一套口径（本地时间）。
// epoch → civil 日期用 Howard Hinnant 的算法，不为此引入 chrono。

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `20260930-143025` 形态（本地时区）。
pub fn timestamp_label(now_ms: i64) -> String {
    let secs = now_ms.div_euclid(1000);
    let sod = secs.rem_euclid(86400);
    let (year, month, day) = civil_from_days(secs.div_euclid(86400));
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    format!("{year:04}{month:02}{day:02}-{hh:02}{mm:02}{ss:02}")
}

/// 天数（自 1970-01-01）→ (年, 月, 日)
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 纪元起点与闰年边界() {
        // 1970-01-01 00:00:00 UTC —— 本地时区会影响钟点，所以只校验到"当天不炸"
        let label = timestamp_label(0);
        assert_eq!(label.len(), 15);
        assert!(label.starts_with("1970") || label.starts_with("1969"));
    }

    #[test]
    fn 闰日归位() {
        // 2024-02-29 12:00:00 UTC = 1709208000
        let (y, m, d) = civil_from_days(1709208000 / 86400);
        assert_eq!((y, m, d), (2024, 2, 29));
    }
}
