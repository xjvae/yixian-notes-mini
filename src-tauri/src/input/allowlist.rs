// allowlist — "哪些前台程序里右键不该被劫持"的**纯**判定。
//
// 比对不在钩子回调里发生：回调里做任何跨进程 Win32 都会把全系统输入链卡住。
// 所以是采样线程读一次前台进程名 → 调这里的 `blocked` → 把结果写进原子量，
// 回调只读那个原子量。本模块因此不带任何 IO，所有分支都能单测穷尽。
//
// 三条判定口径，都是"猜错了代价不对称"推出来的：
//   · 只比对可执行文件的**基名**，去掉 `.exe`，大小写无关——用户能看见、能自己
//     填的就只有这一个东西（任务管理器"进程"列给的就是它）。
//   · 名字读不到算**没命中**（取名要 OpenProcess，提权程序/受保护进程读不到是
//     常态）。反过来做的话，主入口会在别人机器上悄悄失效——比偶尔多弹一次
//     星环难查得多。这条要在界面上说出来，不能只写在注释里。
//   · `*` 只当**结尾通配**（`idea*` 命中 `idea64`）。中间/开头通配一律不当模式：
//     越强的模式，用户越容易一条规则放走一片进程。

/// 名单长度上限。超过就是配歪了，截断并说明。
pub const MAX_ENTRIES: usize = 32;
/// 单条字符上限：进程基名再长也长不过这个数，超长一定是粘贴错了。
pub const MAX_LEN: usize = 64;

/// 归一化成"可比对的形状"：取基名、转小写、去结尾 `.exe`。
/// 返回 None = 这条没内容或太离谱（空串、超长、带控制字符），不该进名单。
pub fn normalize(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_LEN {
        return None;
    }
    if trimmed.chars().any(char::is_control) {
        return None;
    }
    // 允许粘贴整条路径：只取最后一段，`\` 与 `/` 都算分隔
    let base = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed);
    let lowered = base.trim().to_lowercase();
    let stripped = lowered.strip_suffix(".exe").unwrap_or(&lowered);
    let final_name = stripped.trim();
    if final_name.is_empty() {
        return None;
    }
    Some(final_name.to_string())
}

/// 整表解析：逐条 normalize，去重，截断到上限。
pub fn parse_list(raws: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for raw in raws {
        if seen.len() >= MAX_ENTRIES {
            break;
        }
        if let Some(name) = normalize(raw)
            && !seen.contains(&name)
        {
            seen.push(name);
        }
    }
    seen
}

/// 该前台进程是否被名单拦住（= 不劫持）。空名单永远 false。
/// `executable_base` 是采样线程取到的进程基名（已小写、已去 .exe）。
pub fn blocked(executable_base: &str, list: &[String]) -> bool {
    if executable_base.is_empty() {
        return false;
    }
    list.iter().any(|entry| {
        match entry.strip_suffix('*') {
            Some(prefix) => executable_base.starts_with(prefix),
            None => executable_base == entry,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 归一化取基名去exe转小写() {
        assert_eq!(normalize("Code.exe"), Some("code".into()));
        assert_eq!(normalize(r"C:\Program Files\IDEA\idea64.EXE"), Some("idea64".into()));
        assert_eq!(normalize("  explorer  "), Some("explorer".into()));
        assert_eq!(normalize("wezterm"), Some("wezterm".into()));
    }

    #[test]
    fn 离谱输入不进名单() {
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize(&"长".repeat(MAX_LEN + 1)), None);
        assert_eq!(normalize("bad\u{7}name"), None);
        assert_eq!(normalize(".exe"), None, "剥完 .exe 就空了");
    }

    #[test]
    fn 整表去重截断() {
        let raws: Vec<String> = ["code.exe", "CODE", "idea*", "wezterm"]
            .into_iter()
            .map(String::from)
            .chain((0..40).map(|i| format!("app{i}.exe")))
            .collect();
        let list = parse_list(&raws);
        assert_eq!(list.len(), MAX_ENTRIES, "截断到上限");
        assert_eq!(list[0], "code");
        assert_eq!(list[1], "idea*", "重复的 code 被去重");
        assert_eq!(list[2], "wezterm");
        assert!(!list.contains(&"app39".to_string()), "超上限的条目被丢");
    }

    #[test]
    fn 精确与结尾通配() {
        let list = parse_list(&["code.exe".into(), "idea*".into()]);
        assert!(blocked("code", &list));
        assert!(blocked("idea64", &list));
        assert!(blocked("idea", &list));
        assert!(!blocked("notepad", &list));
    }

    #[test]
    fn 空名单与空名字永远不命中() {
        assert!(!blocked("code", &[]));
        assert!(!blocked("", &parse_list(&["code".into()])));
    }
}
