// unlock — 口令窗（单例，常置顶）。
// 相位由前端按 `private_status` + 这一次的**意图**分岔：没配置 = 设置表单；带某张的意图 = 揭开那张
// （"点哪张开哪张"，见迁移 0012）；没意图 = "已收回，点一张私密便签再输口令"加上忘记密码的出路（重置）。
// 「立即锁定」之后**总是**开这扇窗：没配过口令的人看到设置表单——"锁了没反应"与"根本没锁"界面必须分得开。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::support::error::{AppError, AppResult};
use crate::windows::factory::{build_window, WindowSpec};
use crate::windows::monitor;

pub const UNLOCK_LABEL: &str = "unlock";
const UNLOCK_ENTRY: &str = "unlock.html";
const UNLOCK_SIZE: (f64, f64) = (420.0, 470.0);
/// 口令窗"没了"这件事的广播。挂起动作靠它收口：解锁成功是窗自己关的，
/// 放弃也是窗自己关的，两者对挂着的删除动作含义完全相反，所以关掉之后还要再读一次
/// 权威状态才决定执行还是作废。见 `src/window/private-gate.ts`。
pub const DISMISSED_EVENT: &str = "unlock:dismissed";
/// 意图变了（窗还开着，人点了另一张的蒙版）：已挂载的窗重读一次 `unlock_intent`
pub const INTENT_EVENT: &str = "unlock:intent";
/// **这一发口令验过了**，负载是当时的意图。挂起的那一下靠它收口：
/// 删除那条路不会改变任何状态（只验身份、不开任何一张），所以"窗关了"不等于"口令过了"，
/// 两者必须分两条信号说。见 `src/window/private-gate.ts`
pub const VERIFIED_EVENT: &str = "unlock:verified";

/// 这一次口令窗为哪张、干什么。`Delete` 只改文案不改动作：口令验过之后都是同一发 `private_reveal`，
/// 差别只在"已开着的那张要不要再问一遍"（删除一律再问一次）。
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnlockIntent {
    pub note_id: String,
    #[serde(default)]
    pub purpose: UnlockPurpose,
}

#[derive(Clone, Copy, Serialize, Deserialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UnlockPurpose {
    /// 蒙版上点开的"揭开这一张"
    #[default]
    Reveal,
    /// 删除前的那道门
    Delete,
}

/// 意图住 Rust 这一侧，不走 URL 也不走 `init_script`：这扇窗是**复用**的
/// （`show_on_reuse`），人在没输完之前点了另一张的蒙版，意图会变而窗不会重建。
/// 挂在前端 `private-gate` 里那份 pending 动作与它必须对得上同一张
#[derive(Default)]
pub struct IntentState(Mutex<Option<UnlockIntent>>);

impl IntentState {
    pub fn current(&self) -> Option<UnlockIntent> {
        self.lock().clone()
    }

    fn set(&self, intent: Option<UnlockIntent>) {
        *self.lock() = intent;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<UnlockIntent>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub async fn open(app: &AppHandle, intent: Option<UnlockIntent>) -> AppResult<()> {
    // 先记账再开窗：窗一出现就发 `unlock_intent()` 读，反过来会读到上一张。
    // 窗已经存在（复用）时挂载那次读不会再跑，所以建完之后补发一条事件让它重读
    let reused = app.get_webview_window(UNLOCK_LABEL).is_some();
    if let Some(state) = app.try_state::<IntentState>() {
        state.set(intent);
    }
    build_window(app, spec()).await?;
    if reused {
        let _ = app.emit_to(UNLOCK_LABEL, INTENT_EVENT, ());
    }
    Ok(())
}

fn spec() -> WindowSpec {
    WindowSpec {
        label: UNLOCK_LABEL.into(),
        url: UNLOCK_ENTRY.into(),
        title: "一闲笔记 · 私密密码".into(),
        size: UNLOCK_SIZE,
        // 一次性窗、不参与位置记忆（frames::is_tracked 不认它）：每次落光标屏工作区正中——
        // 交回系统摆会在同一机器每次位置不同，而这是要人打字输入的窗。
        position: monitor::spawn_centered(UNLOCK_SIZE, (0.0, 0.0)),
        min_size: Some((360.0, 400.0)),
        transparent: false,
        always_on_top: true,
        skip_taskbar: true,
        focused: true,
        visible: true,
        reveal_timeout_ms: None,
        show_on_reuse: true,
        init_script: None,
    }
}

/// 完成（解锁/设置/重置成功，或用户取消）：这扇窗是一次性的，用 destroy
/// （close 依赖前端监听器往返，会留僵尸窗）。
pub async fn close(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window(UNLOCK_LABEL)
        .ok_or_else(|| AppError::new("WINDOW_MISSING", "口令窗没有打开"))?;
    window
        .destroy()
        .map_err(|e| AppError::new("WINDOW_CLOSE", e.to_string()))?;
    // 先 destroy 再广播：监听方回头查"窗还在不在"时不该看见它
    let _ = app.emit(DISMISSED_EVENT, UNLOCK_LABEL);
    Ok(())
}
