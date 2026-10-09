// 全局快捷键 — 逐条注册、逐条容忍失败：任何一条被占用都不许让启动失败
// （曾经就是这条路径上的 `?` 把整个应用 panic 掉 = "装完打不开"）。
//
// 默认绑定是四条直达（Alt+1..4）加「唤起星环」的 Alt+Space。
// 改键：settings 表 `hotkeys` 键存 JSON map（action → accelerator 字符串，
// 空串 = 显式不绑），`app_set_hotkey` 落库并即时重绑，跨启动生效。
//
// 铁律：兄弟实例活着时本实例不注册（两份快捷键抢不出胜负），由 lib.rs 把关。
//
// 注册表记的是**事实**而不是愿望：每条连同"系统到底收没收"一起记。这条不是装饰——
// 本机日志连着几天都是 `ring 的 Alt+Space 注册失败（可能被占用）：HotKey already
// registered`（那句来自 RegisterHotKey 返回 ERROR_HOTKEY_ALREADY_REGISTERED，
// 同表 Alt+1..4 全成功，所以是别的程序占着）。不记失败时 `list()` 查不到就回落默认键，
// 设置窗于是照旧显示"Alt + 空格"，用户看不出这一条根本没绑上，只当功能坏了。

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
use crate::windows::{float, hide_all, ring, search, trash};

pub const HOTKEYS_SETTING_KEY: &str = "hotkeys";

/// (动作, 默认键)。顺序即设置界面的展示顺序（改键 UI 随设置窗热键节落地）。
///
/// 动作 id 与**托盘菜单的 id 同一条**（`hide-all` / `show-all`）：同一个动作用两个名字
/// 迟早会分叉——菜单改了键位表里没改，就是"设置里那个键按了没反应"。
pub const DEFAULT_BINDINGS: &[(&str, &str)] = &[
    ("sticky", "Alt+1"),
    ("search", "Alt+2"),
    ("trash", "Alt+3"),
    ("settings", "Alt+4"),
    ("ring", "Alt+Space"),
    // 收起 / 恢复全部便签。挑 6 与 7 是为了跟 1..4 那一族连着（5 被星环占了，
    // 而星环那条 Alt+Space 在本机是被别人占着的——注册结果由 `bound` 说，不在这儿猜）
    ("hide-all", "Alt+6"),
    ("show-all", "Alt+7"),
];

/// 一条绑定的事实：请求过哪个键 + 系统有没有真的收下。
/// `bound == false` 只可能来自系统的答复（键被占），不是"用户没配过"——
/// 界面上必须把这两件事分开，否则就是一行"看着已绑、按下去没反应"的键位。
#[derive(Clone, Debug)]
struct Binding {
    key: String,
    bound: bool,
}

/// 当前生效的绑定：action → 绑定事实。管理态，命令层经它解旧绑。
#[derive(Default)]
pub struct HotkeyRegistry(Mutex<HashMap<String, Binding>>);

impl HotkeyRegistry {
    pub fn current(&self, action: &str) -> Option<String> {
        self.lock().get(action).map(|b| b.key.clone())
    }

    /// 当前生效的绑定表（改键 UI 用）：action →（键, 有没有绑上）。
    /// 没记过的一条回落**默认键 + 没绑上**：注册表为空 = 一条都没注册过
    /// （`register_all` 还没跑到，或这个实例压根不注册），说"已绑"就是撒谎。
    pub fn list(&self) -> Vec<(String, String, bool)> {
        let map = self.lock();
        DEFAULT_BINDINGS
            .iter()
            .map(|(action, default)| {
                match map.get(*action) {
                    Some(binding) => {
                        ((*action).to_string(), binding.key.clone(), binding.bound)
                    }
                    None => ((*action).to_string(), (*default).to_string(), false),
                }
            })
            .collect()
    }

    fn set(&self, action: &str, key: Option<String>, bound: bool) {
        let mut map = self.lock();
        match key {
            Some(k) => {
                map.insert(
                    action.to_string(),
                    Binding {
                        key: k,
                        bound,
                    },
                );
            }
            None => {
                map.remove(action);
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Binding>> {
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

/// 注册全部默认绑定（应用了覆盖表）。注册表记**每一条的下落**，绑不上也记——
/// 只有成功才记，失败的那条就会在界面上冒充成"已绑默认键"。
pub fn register_all(app: &AppHandle, overrides: &HashMap<String, String>) {
    let registry = app.state::<HotkeyRegistry>();
    for (action, default_key) in DEFAULT_BINDINGS {
        let key = overrides
            .get(*action)
            .cloned()
            .unwrap_or_else(|| (*default_key).to_string());
        if key.trim().is_empty() {
            log::info("hotkeys", &format!("{action} 被显式停用"));
            // 注册表里记空串：改键 UI 要能区分"显式停用"和"没配过"。
            // 停用是用户要的结果，算绑好了（bound = true）
            registry.set(action, Some(String::new()), true);
            continue;
        }
        let bound = bind(app, action, &key);
        registry.set(action, Some(key), bound);
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
        "hide-all" => {
            // 不 spawn：这两条就是一串 hide()/show()，本身不 await 任何东西。
            // 计数进日志（0 扇也记）——"按了没反应"要么是没绑上，要么是本来就没开着窗
            let n = hide_all::hide_all(app);
            log::info("hotkeys", &format!("Alt 收起全部便签：{n} 扇"));
        }
        "show-all" => {
            let n = hide_all::show_all(app);
            log::info("hotkeys", &format!("Alt 恢复全部便签：{n} 扇"));
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
        registry.set(action, None, false);
    }
    let mut overrides = bindings_override_from(
        settings::get(db, HOTKEYS_SETTING_KEY)?.as_deref(),
    );
    if key.trim().is_empty() {
        overrides.remove(action);
        // 显式停用要在覆盖表里留空串，否则回退到默认键
        overrides.insert(action.to_string(), String::new());
        // 注册表也要跟着记空串：只改覆盖表的话，重启前这一行显示的还是刚解掉的那个键，
        // 用户以为还绑着（覆盖表是重启后才读的那份，救不了当下这次）
        registry.set(action, Some(String::new()), true);
    } else {
        if !bind(app, action, key) {
            // 新键绑不上（被占用）：把旧默认绑回去，别让用户两手空空。
            // 连默认键都还回不去也要如实记进注册表——那一条现在是"没绑上"
            if let Some((_, default_key)) = DEFAULT_BINDINGS.iter().find(|(a, _)| *a == action) {
                let rebound = bind(app, action, default_key);
                registry.set(action, Some((*default_key).to_string()), rebound);
            }
            return Err(AppError::new(
                "SHORTCUT_BUSY",
                format!("{key} 已被其它程序或本应用占用"),
            ));
        }
        overrides.insert(action.to_string(), key.to_string());
        registry.set(action, Some(key.to_string()), true);
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

    /// 默认表的两条硬不变量：**每个动作都有个能解析的键，且没有两个动作抢同一个键**。
    /// 撞车的症状是"其中一条按了永远没反应"（后注册的那条把前一条顶掉），
    /// 而这件事在界面上完全看不出来。
    ///
    /// 故意**不**断条数：条数每轮都变，写死就是等着过期；整张表的顺序与内容由
    /// `preview/hotkey-table.test.ts` 拿三份抄本一起比（漂了那边红）。
    #[test]
    fn 默认绑定表_动作不重键位不撞() {
        assert!(
            DEFAULT_BINDINGS
                .iter()
                .all(|(action, key)| { (!action.is_empty()) && key.starts_with("Alt+") }),
            "默认表里的动作不许有空名，键位都在 Alt+ 一档"
        );
        assert!(DEFAULT_BINDINGS.contains(&("ring", "Alt+Space")));
        // 托盘那两条批量动作也在表里，且 id 与菜单 id 同一条（两个名字迟早分叉）
        assert!(DEFAULT_BINDINGS.contains(&("hide-all", "Alt+6")));
        assert!(DEFAULT_BINDINGS.contains(&("show-all", "Alt+7")));

        let actions: Vec<&str> = DEFAULT_BINDINGS.iter().map(|(a, _)| *a).collect();
        assert_eq!(
            actions.len(),
            actions.iter().collect::<std::collections::HashSet<_>>().len(),
            "动作 id 重复：{actions:?}"
        );
        let keys: Vec<&str> = DEFAULT_BINDINGS.iter().map(|(_, k)| *k).collect();
        assert_eq!(
            keys.len(),
            keys.iter().collect::<std::collections::HashSet<_>>().len(),
            "默认键位撞车：{keys:?}"
        );
    }

    /// 绑不上的那条留在表里、并标着没生效。反例就是原来的行为：只记成功，
    /// `list()` 查不到就回落默认键，设置窗于是显示"Alt + 空格"而它根本没绑上
    #[test]
    fn 没绑上的键仍留在表里且标着未生效() {
        let registry = HotkeyRegistry::default();
        registry.set("ring", Some("Alt+Space".to_string()), false);
        let ring = registry
            .list()
            .into_iter()
            .find(|(action, _, _)| action == "ring")
            .expect("ring 在表里");
        assert_eq!(ring.1, "Alt+Space", "显示用户要的那个键，不是回落值");
        assert!(!ring.2, "系统没收这条，界面要说没绑上");
        assert_eq!(
            registry.current("ring").as_deref(),
            Some("Alt+Space"),
            "改键时要拿它去解旧绑"
        );
    }

    /// 空表 = 一条都没注册过（`register_all` 还没跑到）。键位照样回落默认值好让界面有东西
    /// 显示，但每条都标没生效——这时说"已绑"就是撒谎
    #[test]
    fn 空表回落默认键且全部标未生效() {
        let registry = HotkeyRegistry::default();
        let list = registry.list();
        assert_eq!(list.len(), DEFAULT_BINDINGS.len());
        assert!(
            list.iter().all(|(_, _, bound)| !bound),
            "没注册过就不能说绑上了"
        );
        assert_eq!(list[0].1, DEFAULT_BINDINGS[0].1, "键位照旧回落默认");
    }

    /// 显式停用算"生效"（那是用户要的结果），界面对它只说「已停用」，不该报没绑上
    #[test]
    fn 停用记空串且算生效() {
        let registry = HotkeyRegistry::default();
        registry.set("sticky", Some(String::new()), true);
        assert_eq!(registry.list()[0].1, "");
        assert!(registry.list()[0].2);
        assert!(
            registry.current("settings").is_none(),
            "没记过的动作不该有旧键"
        );
    }
}
