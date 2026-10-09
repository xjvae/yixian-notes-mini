// id — 全项目唯一的 id 生成法：前缀 + 毫秒的十六进制 + 进程内序号的十六进制。
//
// 三条理由收在这儿，别再各写一套：
//  · **绝不让前端传**：传进来的 id 能撞车也能伪造（float.rs 里那句原话）；
//  · 不为此引 uuid crate：同一进程内"毫秒 + 单调序号"已唯一，重启之间靠毫秒隔开；
//  · 前缀是**语义**的一部分：认前缀的地方不少（窗 label `sticky-<id>`、组 `g…`、
//    正文里的 `media://m…`），多一套形状就多一处坑。

use std::sync::atomic::{AtomicU64, Ordering};

use super::clock::now_ms;

/// 便签 id（`s…`）
pub fn sticky() -> String {
    with_prefix("s")
}

/// 组 id（`g…`）
pub fn group() -> String {
    with_prefix("g")
}

/// 图片 id（`m…`）。正文里 `media://<这个>` 认的就是它
pub fn media() -> String {
    with_prefix("m")
}

fn with_prefix(prefix: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{:x}{:x}", now_ms(), seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一进程内不撞车：序号在走，毫秒可以一样
    #[test]
    fn 连号也不重复() {
        let ids: Vec<String> = (0..500).map(|_| media()).collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
    }

    /// 前缀是形状的一部分：长度落在 8..=30 内，正文那条正则才认（两边同口径）
    #[test]
    fn 前缀与字符集照约定() {
        for (id, prefix) in [(sticky(), "s"), (group(), "g"), (media(), "m")] {
            assert!(id.starts_with(prefix), "{id} 该以 {prefix} 开头");
            assert!((9..=30).contains(&id.len()), "{id} 长度 {len}", len = id.len());
            assert!(
                id[1..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{id} 尾巴只该有小写十六进制"
            );
        }
    }
}
