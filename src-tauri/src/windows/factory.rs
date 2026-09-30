// factory — 声明式窗口规格与唯一构建路径。
//
// 三条并发/时序约束（旧产品线真机换来的，全部保留）：
//   1. 防重复建窗："先查后建"不是原子检查——并发两路都读到空就会按同一 label
//      建两扇窗。`CreatingRegistry` 把"开始创建"变成原子占位：同一 label 任一时刻
//      至多一个创建者。
//   2. 建窗必须 async：同步构建 WebView 会阻塞主线程/IPC 导致冻结。调用方
//      （命令/托盘）一律在 async 上下文里走 `build_window`。
//   3. 浮窗销毁用 destroy 而非 close（见 commands/window.rs）。

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::support::error::{AppError, AppResult};

#[derive(Default)]
pub struct CreatingRegistry(Mutex<HashSet<String>>);

pub struct WindowSpec {
    pub label: String,
    pub url: String,
    pub title: String,
    /// 初始尺寸（逻辑像素）
    pub size: (f64, f64),
    pub min_size: Option<(f64, f64)>,
    pub transparent: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    pub focused: bool,
    /// 注入的前端全局脚本（浮窗用它携带数据 id）
    pub init_script: Option<String>,
}

/// 已存在则复用（show + focus），否则构建。构建完成后必须释放注册表占位。
pub async fn build_window(app: &AppHandle, spec: WindowSpec) -> AppResult<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(&spec.label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }
    let registry = app.state::<CreatingRegistry>();
    {
        let mut creating = registry.0.lock().unwrap_or_else(|p| p.into_inner());
        if !creating.insert(spec.label.clone()) {
            return Err(AppError::new(
                "WINDOW_CREATING",
                format!("窗口 {} 正在创建中", spec.label),
            ));
        }
    }
    let label = spec.label.clone();
    let result = do_build(app, spec).await;
    {
        let mut creating = registry.0.lock().unwrap_or_else(|p| p.into_inner());
        creating.remove(&label);
    }
    result
}

async fn do_build(app: &AppHandle, spec: WindowSpec) -> AppResult<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        &spec.label,
        WebviewUrl::App(spec.url.clone().into()),
    )
    .title(spec.title.as_str())
    .inner_size(spec.size.0, spec.size.1)
    .decorations(false)
    .transparent(spec.transparent)
    .always_on_top(spec.always_on_top)
    .skip_taskbar(spec.skip_taskbar)
    .focused(spec.focused);
    if let Some((width, height)) = spec.min_size {
        builder = builder.min_inner_size(width, height);
    }
    if let Some(script) = &spec.init_script {
        builder = builder.initialization_script(script.as_str());
    }
    builder
        .build()
        .map_err(|e| AppError::new("WINDOW_BUILD", e.to_string()))
}
