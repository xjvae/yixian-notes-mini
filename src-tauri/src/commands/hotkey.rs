// 快捷键命令 — 改键（校验 + 热重绑 + 落库）与生效清单。

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::pool::Db;
use crate::hotkeys;
use crate::support::error::AppResult;

use super::run_db;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBinding {
    pub action: String,
    /// 当前生效的键位；空串 = 显式停用
    pub key: String,
    /// 系统有没有真的收下这个键。**false = 按下去什么都不发生**（被别的程序占着），
    /// 界面上必须说出来：只显示键位就等于让用户对着一行"看着已绑"的死键
    pub bound: bool,
}

/// 改键界面的事实来源：注册表里**实际生效**的那份（不是用户上次的愿望）。
#[tauri::command]
pub async fn hotkey_list(app: AppHandle) -> AppResult<Vec<HotkeyBinding>> {
    use tauri::Manager;
    let registry = app.state::<hotkeys::HotkeyRegistry>();
    Ok(registry
        .list()
        .into_iter()
        .map(|(action, key, bound)| HotkeyBinding { action, key, bound })
        .collect())
}

/// 改一条绑定。key 空串 = 停用；失败（被占用/不合法）旧键自动还原，错误码见 hotkeys。
#[tauri::command]
pub async fn app_set_hotkey(
    app: AppHandle,
    db: State<'_, Db>,
    action: String,
    key: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    run_db(db, move |db| hotkeys::set_binding(&app, db, &action, &key)).await
}
