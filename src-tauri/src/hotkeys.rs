// 全局快捷键 — 逐条注册、逐条容忍失败：任何一条被占用都不许让启动失败
// （曾经就是这条路径上的 `?` 把整个应用 panic 掉 = "装完打不开"）。
//
// 默认绑定是四条直达（Alt+1..4）加「唤起星环」的 Alt+Space。
// 改键：settings 表 `hotkeys` 键存 JSON map（action → accelerator 字符串，
// 空串 = 显式不绑），`app_set_hotkey` 落库并即时重绑，跨启动生效。
//
// 铁律：兄弟实例活着时本实例不注册（两份快捷键抢不出胜负），由 lib.rs 把关。

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::db::pool::Db;
use crate::db::query::settings;
use crate::support::error::{AppError, AppResult};
use crate::support::log;
use crate::windows::settings as settings_window;
use crate::windows::{float, ring, search, trash};

pub const HOTKEYS_SETTING_KEY: &str = "hotkeys";

/// (动作, 默认键)。顺序即设置界面的展示顺序（改键 UI 随设置窗热键节落地）。
pub const DEFAULT_BINDINGS: &[(&str, &str)] = &[
    ("sticky", "Alt+1"),
    ("search", "Alt+2"),
    ("trash", "Alt+3"),
    ("settings", "Alt+4"),
    ("ring", "Alt+Space"),
];

/// 当前生效的绑定：action → accelerator。管理态，命令层经它解旧绑。
#[derive(Default)]
pub struct HotkeyRegistry(Mutex<HashMap<String, String>>);

impl HotkeyRegistry {
    pub fn current(&self, action: &str) -> Option<String> {
        self.lock().get(action).cloned()
    }

    fn set(&self, action: &str, key: Option<String>) {
        let mut map = self.lock();
        match key {
            Some(k) => {
                map.insert(action.to_string(), k);
            }
            None => {
                map.remove(action);
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 从设置值解析覆盖表：非法/非字符串/空串的条目一律跳过（空串 = 显式不绑）。
pub fn bindings_override_from(value: Option<&str>) -> HashMap<String, String> {
    let Some(raw) = value else {
        return HashMap::new();
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return HashMap::new();
    };
    map.into_iter()
        .filter_map(|(action, key)| key.as_str().map(|k| (action, k.to_string())))
        .collect()
}

/// 注册全部默认绑定（应用了覆盖表）。注册表只记**实际生效**的那份。
pub fn register_all(app: &AppHandle, overrides: &HashMap<String, String>) {
    let registry = app.state::<HotkeyRegistry>();
    for (action, default_key) in DEFAULT_BINDINGS {
        let key = overrides
            .get(*action)
            .cloned()
            .unwrap_or_else(|| (*default_key).to_string());
        if key.trim().is_empty() {
            log::info("hotkeys", &format!("{action} 被显式停用"));
            continue;
        }
        if bind(app, action, &key) {
            registry.set(action, Some(key));
        }
    }
}

/// 绑一条。成功返回 true；键被占用/不合法只记日志不 panic。
fn bind(app: &AppHandle, action: &str, key: &str) -> bool {
    let Ok(shortcut) = key.parse::<Shortcut>() else {
        log::warn("hotkeys", &format!("{action} 的键位 {key:?} 不合法，跳过"));
        return false;
    };
    let action_owned = action.to_string();
    let result = app.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            fire(app, &action_owned);
        }
    });
    match result {
        Ok(()) => {
            log::info("hotkeys", &format!("{action} ← {key}"));
            true
        }
        Err(e) => {
            log::warn("hotkeys", &format!("{action} 的 {key} 注册失败（可能被占用）：{e}"));
            false
        }
    }
}

fn unbind(app: &AppHandle, key: &str) {
    if let Ok(shortcut) = key.parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

fn fire(app: &AppHandle, action: &str) {
    match action {
        "sticky" => {
            let Some(db) = app.try_state::<Db>() else {
                return;
            };
            let db = db.inner().clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = float::create_sticky(&app, db).await {
                    log::error("hotkeys", &format!("新建便签失败：{e}"));
                }
            });
        }
        "search" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = search::open(&app).await;
            });
        }
        "trash" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = trash::open(&app).await;
            });
        }
        "settings" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = settings_window::open(&app).await;
            });
        }
        "ring" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ring::open(&app).await {
                    log::warn("hotkeys", &format!("唤起星环失败：{e}"));
                }
            });
        }
        other => {
            log::warn("hotkeys", &format!("未知动作 {other}，忽略"));
        }
    }
}

/// 改一条绑定并落库（热键设置 JSON map 的单条覆盖）。
/// key 传空串 = 显式停用该动作。
pub fn set_binding(app: &AppHandle, db: &Db, action: &str, key: &str) -> AppResult<()> {
    // 校验新键（空串合法 = 停用）
    if !key.trim().is_empty() && key.parse::<Shortcut>().is_err() {
        return Err(AppError::new("BAD_SHORTCUT", format!("键位 {key:?} 不合法")));
    }
    let registry = app.state::<HotkeyRegistry>();
    // 先解旧绑（无论成败都继续：旧绑可能本来就没注册上）
    if let Some(old) = registry.current(action) {
        unbind(app, &old);
        registry.set(action, None);
    }
    let mut overrides = bindings_override_from(
        settings::get(db, HOTKEYS_SETTING_KEY)?.as_deref(),
    );
    if key.trim().is_empty() {
        overrides.remove(action);
        // 显式停用要在覆盖表里留空串，否则回退到默认键
        overrides.insert(action.to_string(), String::new());
    } else {
        if !bind(app, action, key) {
            // 新键绑不上（被占用）：把旧默认绑回去，别让用户两手空空
            if let Some((_, default_key)) = DEFAULT_BINDINGS.iter().find(|(a, _)| *a == action)
                && bind(app, action, default_key)
            {
                registry.set(action, Some((*default_key).to_string()));
            }
            return Err(AppError::new(
                "SHORTCUT_BUSY",
                format!("{key} 已被其它程序或本应用占用"),
            ));
        }
        overrides.insert(action.to_string(), key.to_string());
        registry.set(action, Some(key.to_string()));
    }
    let serialized = serde_json::to_string(&overrides)
        .map_err(|e| AppError::new("SERIALIZE", e.to_string()))?;
    settings::set(db, HOTKEYS_SETTING_KEY, &serialized)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 覆盖表解析_跳过非法与空串以外的怪值() {
        let json = r#"{"sticky":"Ctrl+1","search":"","trash":7,"bad":null}"#;
        let map = bindings_override_from(Some(json));
        assert_eq!(map.get("sticky").map(String::as_str), Some("Ctrl+1"));
        assert_eq!(map.get("search").map(String::as_str), Some(""));
        assert!(!map.contains_key("trash"));
        assert!(!map.contains_key("bad"));
    }

    #[test]
    fn 无值或坏_json_给空表() {
        assert!(bindings_override_from(None).is_empty());
        assert!(bindings_override_from(Some("not json")).is_empty());
    }

    #[test]
    fn 默认绑定表_四条直达加星环() {
        assert_eq!(DEFAULT_BINDINGS.len(), 5);
        assert!(
            DEFAULT_BINDINGS
                .iter()
                .all(|(action, key)| { (!action.is_empty()) && key.starts_with("Alt+") }),
            "默认表里的动作不许有空名，键位都在 Alt+ 一档"
        );
        assert!(DEFAULT_BINDINGS.contains(&("ring", "Alt+Space")));
    }
}
