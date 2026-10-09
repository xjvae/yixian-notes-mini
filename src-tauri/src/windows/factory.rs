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
use crate::support::log;

#[derive(Default)]
pub struct CreatingRegistry(Mutex<HashSet<String>>);

pub struct WindowSpec {
    pub label: String,
    pub url: String,
    pub title: String,
    /// 初始尺寸（逻辑像素）
    pub size: (f64, f64),
    /// 出生位置（逻辑像素）。
    ///
    /// **必须在建之前给它**：窗一 `visible` 就出现在系统给的位置上，事后再
    /// `set_position` 就是"先在错误的地方闪一阵，再跳到记下的位置"——真机报的
    /// "刚打开弹出便签时闪烁一阵，然后才出现记录的位置"正是这条时序。
    pub position: Option<(f64, f64)>,
    pub min_size: Option<(f64, f64)>,
    pub transparent: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    pub focused: bool,
    /// 创建即显示？（星环走 false：先建好/摆好位再由 open 路径显式 show）
    pub visible: bool,
    /// 给了 = 这扇窗**建的时候不显示**，等前端把内容画完自己喊 `float_reveal` 亮出来。
    /// 到点还没等到就强行 show。
    ///
    /// **为什么要有这条**：便签窗是透明窗，而 Tauri 只在 `background_color` **显式给了**
    /// 的时候才往下传（tauri-runtime-wry 里是 `if let Some(color) = ...`），没给就吃
    /// WebView2 的默认白；于是开机恢复那阵子先亮一块白屏，等 hydrate + 首帧画完才出便签
    /// （作者报的"打开软件时白屏一阵"）。走"先隐后 show"就不会出现任何颜色的闪，
    /// 星环早就是这条路（`ring.rs` 建隐窗再 show）。
    ///
    /// **为什么必须有兜底**：前端要是崩了/卡了没来喊，便签就永远不出现——
    /// "看不见我的便签"比"闪一下白"严重得多，所以到点无条件 show。
    pub reveal_timeout_ms: Option<u64>,
    /// 复用已有窗时是否 show + focus（星环走 false：先摆位再显式 show，避免闪在旧位）
    pub show_on_reuse: bool,
    /// 注入的前端全局脚本（浮窗用它携带数据 id）
    pub init_script: Option<String>,
}

/// 已存在则复用（按 spec 决定是否 show + focus），否则构建。构建完成后必须释放注册表占位。
pub async fn build_window(app: &AppHandle, spec: WindowSpec) -> AppResult<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(&spec.label) {
        if spec.show_on_reuse {
            let _ = existing.show();
            let _ = existing.set_focus();
        }
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
    .focused(spec.focused)
    .visible(spec.visible);
    if let Some((x, y)) = spec.position {
        // 建之前就把位置定下来：可见窗一出生就在它该在的地方
        builder = builder.position(x, y);
    }
    if let Some((width, height)) = spec.min_size {
        builder = builder.min_inner_size(width, height);
    }
    if let Some(script) = &spec.init_script {
        builder = builder.initialization_script(script.as_str());
    }
    let window = builder
        .build()
        .map_err(|e| AppError::new("WINDOW_BUILD", e.to_string()))?;
    // 透明窗一律关掉系统阴影。开着它，Windows 绕着**窗口矩形**画一圈 1px 亮边再叠一份
    // 矩形投影，而卡片自己是圆角的（window-chrome 的 rounded-lg）——四角就露出那条亮边，
    // 症状正是"边角不圆润、有白边"。星环早就踩过（ring.rs 原来自己调了一句），
    // 便签与叠窗是漏的那个，所以收到建窗这一处，不再各调各的。
    // 卡片自己那道 CSS 投影也删了：预览台量过卡片 rect 与视口分毫不差（318×298），
    // 影子 0 像素可见，留着只会让人以为角上那点灰是它。
    // **结果必须上报**：这一句在 Windows 上走 DWM 的属性设置，能不能成取决于系统版本与
    // 窗的样式，之前拿 `let _ =` 吞掉——真机上到底关没关，谁都不知道，症状（白纸上还能
    // 看到一圈阴影）就成了猜。现在成功一行、失败一行，日志直接给结论。
    if spec.transparent {
        match window.set_shadow(false) {
            Ok(()) => log::info(
                "window",
                &format!("{}：系统阴影已关（set_shadow(false) 返回 Ok）", spec.label),
            ),
            Err(e) => log::warn(
                "window",
                &format!("{}：系统阴影关不掉，四角那圈可能就是它：{e}", spec.label),
            ),
        }
    }
    // 等前端那声 `float_reveal`；到点没来就自己 show（见 WindowSpec.reveal_timeout_ms
    // 为什么必须有兜底）。这里单开一条短命线程而不是 async_runtime::spawn：本 crate
    // 没有直接依赖 tokio，而睡一觉这件事不需要占着任何异步任务槽。
    if let Some(ms) = spec.reveal_timeout_ms {
        let app = app.clone();
        let label = spec.label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            if let Some(window) = app.get_webview_window(&label)
                && !window.is_visible().unwrap_or(true)
            {
                log::warn("window", &format!("{label}：前端没来报就绪，到点强行显示"));
                let _ = window.show();
            }
        });
    }
    Ok(window)
}
