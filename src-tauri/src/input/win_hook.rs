// win_hook — WH_MOUSE_LL 低级鼠标钩子：吞 down + 阈值 + 补偿注入 + 白名单采样。
// 铁律 1：回调坐在全系统输入链上（超时默认 300ms，本回调预算 ≤1ms）——只许读原子量、
//   try_lock/try_send、SetTimer/KillTimer/PostMessageW；禁日志、禁阻塞锁、禁跨进程调用；
//   SendInput 一律推给泵线程做（见 request_inject）。
// 铁律 2：钩子与消息泵同线程（SetTimer 要 message-only 窗做载体，WM_TIMER 与事件判定无跨线程竞态）；状态机 try_lock，竞争即放行。
// 铁律 3：退出必卸钩子——泵线程任一退出路径置 PUMP_DONE，主线程 500ms 等不到就自己 UnhookWindowsHookEx（见 mod.rs 的 shutdown）。
// 自反馈防线：注入的事件带 LLMHF_INJECTED，回调看到即放行，否则注入的 down 被自己再吞一遍。

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEINPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW,
    FindWindowW, GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowThreadProcessId, HHOOK,
    HWND_MESSAGE, KillTimer, MSG, MSLLHOOKSTRUCT, PostMessageW, PostThreadMessageW,
    RegisterClassExW, SetTimer, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_MOUSE_LL, WINDOW_STYLE, WM_LBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
    WM_TIMER, WNDCLASSEXW,
};

use super::allowlist;
use super::policy;
use super::state::{Action, Event, Machine};
use super::{hold_ms, is_paused, whitelist};
use crate::support::log;

const TIMER_ID: usize = 1;
/// 充电弧的引导期计时器（比 Hold 早到点，见 `charge_lead_ms`）
const CHARGE_TIMER: usize = 0x514F;

// 充电弧的**留尾**：只在离阈值还剩这么多毫秒时才亮起来。不"按下即亮"——亮弧要给
// 360×360 顶层 webview 窗做摆位+show+设穿透+一次 IPC，而"有意识地右键"正常时长恰落在
// 150~250ms：即亮等于每次右键都付这个开销，还正压在系统上下文菜单要出现的那一瞬间。
const CHARGE_TAIL_MS: u32 = 150;

// 引导期 = 阈值 - 留尾，但不早于半个阈值（否则阈值调到下限 150ms 时弧只剩几毫秒，
// 看不出来），也必须严格小于阈值（否则永远不亮 = 这条功能被静默关掉）。
fn charge_lead_ms(hold_ms: u32) -> u32 {
    let hold = hold_ms.clamp(1, u32::MAX);
    let tail = hold.saturating_sub(CHARGE_TAIL_MS);
    tail.max(hold / 2).max(1).min(hold.saturating_sub(1))
}

const SAMPLER_INTERVAL_MS: u64 = 200;

static HOOK: AtomicIsize = AtomicIsize::new(0);
static PUMP_DONE: AtomicBool = AtomicBool::new(false);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static PUMP_THREAD: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
static HOOK_WINDOW: AtomicIsize = AtomicIsize::new(0);
static MACHINE: Mutex<Machine> = Mutex::new(Machine::new());

/// 前台是否在白名单内（= 不劫持）。采样线程写，回调读。
static ALLOWED: AtomicBool = AtomicBool::new(false);
/// 最近一次采样到的前台进程基名（hook_status 给设置界面的"上一个前台程序"）
static FOREGROUND: Mutex<Option<String>> = Mutex::new(None);
/// 出盘链路上的事件（回调 try_send，消费线程转投窗口/前端广播）
pub enum RingEvent {
    /// 在这一点（物理像素，按下点快照）开出整盘
    Open { x: i32, y: i32 },
    /// 引导期走完：星环窗**在按下点**亮起，前端画充电弧（带上此刻真正生效的阈值）
    Charging { x: i32, y: i32, hold_ms: u32 },
    /// 松手/转拖拽：弧淡出，整盘随后开（长按那条路不发这条）
    Up,
    /// 盘驻留期间**盘外**左键按下：前端收环，这次点击原样放行
    Dismiss,
}
type OpenSender = SyncSender<RingEvent>;
/// 直接 OnceLock 不套 Mutex：读它的是钩子回调（铁律 1 禁锁），而写侧只在 spawn 时装一次，
/// 之后只有 try_send，本就没有需要互斥的写。
static OPEN_SENDER: OnceLock<OpenSender> = OnceLock::new();

// —— 装配 ——

/// `panic = "abort"` 下崩的那一趟走不到日志的收尾，而这一格若崩在启动里，真机上看到的
/// 就是"程序没起来"、现场一行都没有。先把话落到那份文件里再 panic
fn abort_with_log(what: &str) -> ! {
    log::error("input", &format!("{what} —— 钩子起不来，这一趟启动就此中止"));
    panic!("{what}");
}

pub fn spawn(app: tauri::AppHandle) {
    let (sender, receiver) = sync_channel::<RingEvent>(8);
    if OPEN_SENDER.set(sender).is_err() {
        abort_with_log("装配 OPEN_SENDER 失败：input 只该装配一次");
    }

    // 消费线程：开窗/广播（IPC/窗口操作绝不进回调）
    {
        let app = app.clone();
        std::thread::spawn(move || {
            use tauri::Emitter;
            for event in receiver {
                match event {
                    RingEvent::Open { x, y } => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            // ring:open 的广播与矩形公告都在 ring.rs::reveal 里做——出盘只有一条路，别重复发
                            if let Err(e) = crate::windows::ring::open_at(&app, x, y).await {
                                log::warn("input", &format!("唤起星环失败：{e}"));
                            }
                        });
                    }
                    // 到这里已是引导期走完、手还按着（不是按下即亮）。兜两道：开关关掉或盘还驻留
                    // 就什么都不做——充电态要把同一个窗改成鼠标穿透，会把用户正在看的盘点掉。
                    RingEvent::Charging { x, y, hold_ms } => {
                        if !crate::input::charging() || crate::input::ring_present() {
                            continue;
                        }
                        if let Err(e) = crate::windows::ring::show_charging(&app, x, y, hold_ms) {
                            log::warn("input", &format!("亮起充电弧失败：{e}"));
                        }
                    }
                    // 弧淡出：只广播**不 hide 窗口**——90ms 淡出归前端画，画完它自己调 close_ring_window
                    RingEvent::Up => {
                        let _ = app.emit("ring:up", ());
                    }
                    RingEvent::Dismiss => {
                        let _ = app.emit("ring:dismiss", ());
                    }
                }
            }
        });
    }

    let pump = std::thread::Builder::new()
        .name("yixian-hook".into())
        .spawn(pump_loop)
        .unwrap_or_else(|e| abort_with_log(&format!("起钩子线程失败：{e}")));
    if PUMP_THREAD.set(Mutex::new(Some(pump))).is_err() {
        abort_with_log("装配 PUMP_THREAD 失败：input 只该装配一次");
    }

    // 白名单采样线程：结论只写原子量；另管两件"贵调用"——任务栏矩形与屏表缓存（星环摆位用）
    let sampler_app = app.clone();
    std::thread::Builder::new()
        .name("yixian-allowlist".into())
        .spawn(move || sampler_loop(&sampler_app))
        .unwrap_or_else(|e| abort_with_log(&format!("起采样线程失败：{e}")));
}

/// 退出清理：通知泵退出并等 500ms；等不到就从这里直接卸钩子兜底（RunEvent::Exit 里调用）。
pub fn shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    let thread_id = PUMP_THREAD_ID.load(Ordering::SeqCst);
    if thread_id != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    while !PUMP_DONE.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if !PUMP_DONE.load(Ordering::SeqCst) {
        let hook = HOOK.load(Ordering::SeqCst);
        if hook != 0 {
            log::warn("input", "泵线程 500ms 没退出，主线程直接卸钩子");
            unsafe {
                let _ = UnhookWindowsHookEx(HHOOK(hook as *mut _));
            }
        }
    }
}

static PUMP_THREAD_ID: AtomicU32 = AtomicU32::new(0);

// —— 钩子线程：message-only 窗 + 钩子 + 消息泵 ——

fn pump_loop() {
    unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(def_proc),
            lpszClassName: windows::core::w!("yixian_input_hook_wnd"),
            hInstance: instance,
            ..Default::default()
        };
        let class_atom = RegisterClassExW(&wc);
        if class_atom == 0 {
            log::error("input", "注册钩子窗口类失败，长按右键唤星环不可用");
            PUMP_DONE.store(true, Ordering::SeqCst);
            return;
        }
        let Ok(hwnd) = CreateWindowExW(
            Default::default(),
            windows::core::w!("yixian_input_hook_wnd"),
            windows::core::w!("yixian_input_hook_wnd"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        ) else {
            log::error("input", "建钩子窗口失败，长按右键唤星环不可用");
            PUMP_DONE.store(true, Ordering::SeqCst);
            return;
        };
        HOOK_WINDOW.store(hwnd.0 as isize, Ordering::SeqCst);

        // PostThreadMessageW(WM_QUIT) 要的是 Win32 线程 id，不是 Rust 的 ThreadId
        PUMP_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

        let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), Some(instance), 0)
            .unwrap_or_default();
        if hook.is_invalid() {
            log::error("input", "装钩子失败，长按右键唤星环不可用");
            PUMP_DONE.store(true, Ordering::SeqCst);
            return;
        }
        HOOK.store(hook.0 as isize, Ordering::SeqCst);
        log::info("input", "WH_MOUSE_LL 已装（长按右键唤星环）");

        let mut msg = MSG::default();
        // GetMessageW 出错返回 -1：非零但不是"继续泵"——按 >0 判，防错误死循环
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_APP_INJECT {
                // 回调把注入推到这里才做：此刻整条系统输入链已经不在等我们了
                send_input(inject_flags(msg.wParam.0));
                continue;
            }
            if msg.message == WM_TIMER && msg.wParam.0 == TIMER_ID {
                // 阈值到点：与钩子回调共用同一把 try_lock（同线程，锁必然空闲）
                step_and_execute(Event::TimerFired);
                continue;
            }
            if msg.message == WM_TIMER && msg.wParam.0 == CHARGE_TIMER {
                // 引导期到点（比阈值早）：该亮充电弧了
                step_and_execute(Event::ChargeFired);
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        let _ = KillTimer(Some(hwnd), TIMER_ID);
        let _ = KillTimer(Some(hwnd), CHARGE_TIMER);
        let stored = HOOK.swap(0, Ordering::SeqCst);
        if stored != 0 {
            let _ = UnhookWindowsHookEx(HHOOK(stored as *mut _));
        }
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd);
        PUMP_DONE.store(true, Ordering::SeqCst);
    }
}

unsafe extern "system" fn def_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY：参数原样来自系统窗口消息
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

// —— 钩子回调：全系统输入链上的一段，只许做最便宜的事 ——

/// 回调自证计数：全部 relaxed 原子读改，**回调里绝不写日志**；聚合成一行由采样线程做。
static CB_COUNT: AtomicU64 = AtomicU64::new(0);
/// 我们这段自身耗时（不含 CallNextHookEx 与后续链）的历史最大值
static CB_OWN_MAX_US: AtomicU64 = AtomicU64::new(0);
static CB_OWN_SUM_US: AtomicU64 = AtomicU64::new(0);
static CB_OVER_1MS: AtomicU64 = AtomicU64::new(0);
/// 超 1ms 的尖刺按消息种类分账（种类见 `spike_kind`）：MOUSEMOVE 那支只读原子量就放行，它也超时说明线程被系统抢走，账不在本模块
static CB_SPIKE: [AtomicU64; 4] = [const { AtomicU64::new(0) }; 4];
/// 右键三计数：进了手势逻辑的、被任务栏豁免掉的、被吞掉的
static RB_DOWN: AtomicU64 = AtomicU64::new(0);
static RB_EXEMPT: AtomicU64 = AtomicU64::new(0);
static RB_SWALLOW: AtomicU64 = AtomicU64::new(0);

unsafe extern "system" fn hook_proc(ncode: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // 两次 Instant::now() 是纯读（纳秒级），换"这段有没有卡过 1ms"的证据；不测含 CallNextHookEx 的总时长（不归我们）
    CB_COUNT.fetch_add(1, Ordering::Relaxed);
    let started = std::time::Instant::now();
    let out = unsafe { hook_body(ncode, wparam, lparam) };
    let own = started.elapsed().as_micros() as u64;
    CB_OWN_MAX_US.fetch_max(own, Ordering::Relaxed);
    CB_OWN_SUM_US.fetch_add(own, Ordering::Relaxed);
    if own > 1000 {
        CB_OVER_1MS.fetch_add(1, Ordering::Relaxed);
        CB_SPIKE[policy::spike_kind(wparam.0 as u32)].fetch_add(1, Ordering::Relaxed);
    }
    out
}

/// 回调体：读 Win32 的事实 → 交给 `policy::classify` 判 → 执行判定结果。
/// 判的东西全在 policy 里（那边是无锁无分配纯函数，每种组合都有用例）。
unsafe extern "system" fn hook_body(ncode: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY：这段只读一个系统递进来的结构、读原子量、try_send 通道、调用 SetTimer/KillTimer/
    // PostMessageW（无阻塞、无分配、无跨线程等待）；注入不在这段做。
    unsafe {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let msg = wparam.0 as u32;
        // 只在真要判的那几发上读那两片缓存：这条链坐在**全系统**输入链上
        let ring_may_dismiss = msg == WM_LBUTTONDOWN && crate::input::ring_present();
        let facts = policy::Facts {
            chained: ncode < 0,
            shutting_down: SHUTTING_DOWN.load(Ordering::Relaxed),
            injected: policy::is_injected(info.flags),
            over_taskbar: msg == WM_RBUTTONDOWN
                && crate::input::over_taskbar(info.pt.x, info.pt.y),
            ring_present: crate::input::ring_present(),
            in_ring: ring_may_dismiss && crate::input::ring_contains(info.pt.x, info.pt.y),
            guide_holds_ring: crate::input::guide_holds_ring(),
            paused: is_paused(),
            whitelisted: ALLOWED.load(Ordering::Relaxed),
        };
        if msg == WM_RBUTTONDOWN {
            RB_DOWN.fetch_add(1, Ordering::Relaxed);
        }
        match policy::classify(msg, info.pt.x, info.pt.y, &facts) {
            policy::Verdict::Pass(reason) => {
                if reason == policy::Pass::Taskbar {
                    RB_EXEMPT.fetch_add(1, Ordering::Relaxed);
                }
                if reason == policy::Pass::Dismissed {
                    notify(RingEvent::Dismiss);
                }
                CallNextHookEx(None, ncode, wparam, lparam)
            }
            policy::Verdict::Feed(event) => {
                let (actions, swallow) = match MACHINE.try_lock() {
                    Ok(mut machine) => {
                        let pre = machine.phase;
                        let actions = machine.step(event);
                        let post = machine.phase;
                        (actions, policy::swallows(pre, post, &event))
                    }
                    Err(_) => {
                        // 状态机被占着（理论上不该发生：泵与回调同线程）：宁可放行也不等
                        return CallNextHookEx(None, ncode, wparam, lparam);
                    }
                };
                execute(actions.as_slice(), true);
                if swallow {
                    RB_SWALLOW.fetch_add(1, Ordering::Relaxed);
                    LRESULT(1)
                } else {
                    CallNextHookEx(None, ncode, wparam, lparam)
                }
            }
        }
    }
}

/// 泵线程（WM_TIMER）与回调共用的执行入口
fn step_and_execute(event: Event) {
    let Ok(mut machine) = MACHINE.try_lock() else {
        return;
    };
    let actions = machine.step(event);
    drop(machine);
    execute(actions.as_slice(), false);
}

fn notify(event: RingEvent) {
    if let Some(sender) = OPEN_SENDER.get() {
        let _ = sender.try_send(event);
    }
}

/// 注入种类（走 WM_APP_INJECT 的 wParam）
const INJECT_FULL_CLICK: usize = 1;
const INJECT_PRESS: usize = 2;
/// 回调 → 泵线程的"去做这次注入"私有消息
const WM_APP_INJECT: u32 = 0x8001;

fn inject_flags(what: usize) -> &'static [u32] {
    match what {
        INJECT_FULL_CLICK => &[MOUSEEVENTF_RIGHTDOWN.0, MOUSEEVENTF_RIGHTUP.0],
        INJECT_PRESS => &[MOUSEEVENTF_RIGHTDOWN.0],
        _ => &[],
    }
}

/// **注入只能发生在消息泵线程，不能发生在回调里**：回调返回之前整条系统输入链都停在
/// 这里，而注入出去那对事件还要再走一遍这条链、再进目标应用队列，才生成 WM_CONTEXTMENU。
/// 投递失败（队列满、消息窗已毁）就当场自己做——宁可慢那一次，不能让上下文菜单弹不出来。
fn request_inject(what: usize, in_callback: bool) {
    if in_callback {
        let hwnd_raw = HOOK_WINDOW.load(Ordering::SeqCst);
        if hwnd_raw != 0 {
            let posted = unsafe {
                PostMessageW(
                    Some(HWND(hwnd_raw as *mut _)),
                    WM_APP_INJECT,
                    WPARAM(what),
                    LPARAM(0),
                )
            }
            .is_ok();
            if posted {
                return;
            }
        }
    }
    send_input(inject_flags(what));
}

fn execute(actions: &[Action], in_callback: bool) {
    for action in actions {
        match action {
            Action::StartHoldTimer => unsafe {
                let hwnd = HOOK_WINDOW.load(Ordering::SeqCst);
                SetTimer(Some(HWND(hwnd as *mut _)), TIMER_ID, hold_ms(), None);
            },
            // 阈值与引导期都在这里现读：设置窗改了阈值不必重装钩子
            Action::StartChargeTimer => unsafe {
                if crate::input::charging() {
                    let lead = charge_lead_ms(hold_ms());
                    if lead > 0 {
                        let hwnd = HOOK_WINDOW.load(Ordering::SeqCst);
                        SetTimer(Some(HWND(hwnd as *mut _)), CHARGE_TIMER, lead, None);
                    }
                }
            },
            Action::StopTimers => unsafe {
                let hwnd = HOOK_WINDOW.load(Ordering::SeqCst);
                let _ = KillTimer(Some(HWND(hwnd as *mut _)), TIMER_ID);
                let _ = KillTimer(Some(HWND(hwnd as *mut _)), CHARGE_TIMER);
            },
            Action::InjectFullClick => request_inject(INJECT_FULL_CLICK, in_callback),
            Action::InjectPress => request_inject(INJECT_PRESS, in_callback),
            Action::EmitCharging { x, y } => notify(RingEvent::Charging {
                x: *x,
                y: *y,
                hold_ms: hold_ms(),
            }),
            Action::EmitUp => notify(RingEvent::Up),
            Action::EmitOpen { x, y } => notify(RingEvent::Open { x: *x, y: *y }),
            Action::Nop => {}
        }
    }
}

/// 定长栈数组：一次注入最多两个事件，这条路径上不碰堆
fn send_input(flags: &[u32]) {
    if flags.is_empty() {
        return;
    }
    let make = |flag: u32| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS(flag),
                ..Default::default()
            },
        },
    };
    let take = flags.len().min(2);
    let mut buf = [make(0), make(0)];
    for (slot, flag) in buf[..take].iter_mut().zip(flags) {
        *slot = make(*flag);
    }
    unsafe {
        SendInput(&buf[..take], std::mem::size_of::<INPUT>() as i32);
    }
}

// —— 采样线程：白名单结论、任务栏矩形、回调耗时聚合（回调那边只读原子量）——

/// 每 5 轮（≈1s）刷一次任务栏矩形：它的形状只有移动任务栏/插拔显示器时会变
const TASKBAR_REFRESH_TICKS: u32 = 5;
/// 每 30 轮（≈6s）聚一行回调耗时（无活动就不写）
const COST_REPORT_TICKS: u32 = 30;

fn sampler_loop(app: &tauri::AppHandle) {
    let mut tick: u32 = 0;
    let mut last_hwnd: isize = 0;
    let mut last_base: Option<String> = None;
    // 开机先把屏表填上：第一次长按就在副屏上的话，"缓存还没建"就等于盘不夹取
    crate::windows::monitor::refresh(app);
    loop {
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(Duration::from_millis(SAMPLER_INTERVAL_MS));
        tick = tick.wrapping_add(1);

        // 前台进程名只在换了前台窗时才查（OpenProcess + QueryFullProcessImageNameW 是贵调用）；
        // 名单结论每轮重算——设置窗里改白名单不必等切窗口就生效
        let hwnd_raw = foreground_hwnd_raw();
        if hwnd_raw != last_hwnd {
            last_hwnd = hwnd_raw;
            last_base = foreground_executable_base();
        }
        ALLOWED.store(
            last_base
                .as_deref()
                .is_some_and(|name| allowlist::blocked(name, &whitelist())),
            Ordering::Relaxed,
        );
        *FOREGROUND.lock().unwrap_or_else(|p| p.into_inner()) = last_base.clone();

        if tick.is_multiple_of(TASKBAR_REFRESH_TICKS) {
            crate::input::set_taskbar_rects(&collect_taskbar_rects());
            // 布局（插拔显示器 / 改缩放）与任务栏一样是"几乎不变"的几何，同一拍刷
            crate::windows::monitor::refresh(app);
        }
        if tick.is_multiple_of(COST_REPORT_TICKS) {
            report_costs();
        }
    }
}

/// 当前前台窗口句柄的原始值（0 = 没有前台窗）。采样线程用它做"换窗才查"的判据
fn foreground_hwnd_raw() -> isize {
    unsafe { GetForegroundWindow() }.0 as isize
}

/// 收一条任务栏矩形，槽满即丢（丢弃的后果见 mod.rs 的 `TASKBAR_SLOTS` 说明）
fn push_taskbar_rect(out: &mut Vec<(i32, i32, i32, i32)>, hwnd: HWND) {
    if out.len() >= crate::input::TASKBAR_SLOTS {
        return;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
        out.push((rect.left, rect.top, rect.right, rect.bottom));
    }
}

/// 主任务栏 + 各副屏任务栏的物理矩形。副屏用 FindWindowExW 顺着同类走下一个，
/// 不必 EnumWindows 一趟回调；空表 = 没有豁免区（口径见 `over_taskbar`）。
fn collect_taskbar_rects() -> Vec<(i32, i32, i32, i32)> {
    let mut out = Vec::new();
    unsafe {
        // 注意：FindWindowW 的类名是**第一个**参数（FindWindowExW 里才在第三位）——摆错就是拿它当
        // 标题去找，主屏任务栏永远进不了这张表，豁免只剩副屏生效。
        if let Ok(main) = FindWindowW(windows::core::w!("Shell_TrayWnd"), None)
            && !main.is_invalid()
        {
            push_taskbar_rect(&mut out, main);
        }
        let mut next = HWND::default();
        while out.len() < crate::input::TASKBAR_SLOTS {
            let Ok(found) = FindWindowExW(
                None,
                Some(next),
                windows::core::w!("Shell_SecondaryTrayWnd"),
                None,
            ) else {
                break;
            };
            if found.is_invalid() {
                break;
            }
            push_taskbar_rect(&mut out, found);
            next = found;
        }
    }
    out
}

/// 把回调攒下的计数聚成一行文件日志。只在采样线程调用（回调里禁日志）。
fn report_costs() {
    let count = CB_COUNT.swap(0, Ordering::Relaxed);
    let own_max = CB_OWN_MAX_US.swap(0, Ordering::Relaxed);
    let own_sum = CB_OWN_SUM_US.swap(0, Ordering::Relaxed);
    let over_1ms = CB_OVER_1MS.swap(0, Ordering::Relaxed);
    let down = RB_DOWN.swap(0, Ordering::Relaxed);
    let exempt = RB_EXEMPT.swap(0, Ordering::Relaxed);
    let swallow = RB_SWALLOW.swap(0, Ordering::Relaxed);
    if count == 0 {
        return; // 没动过鼠标就不刷日志
    }
    let spikes: [u64; 4] = [
        CB_SPIKE[0].swap(0, Ordering::Relaxed),
        CB_SPIKE[1].swap(0, Ordering::Relaxed),
        CB_SPIKE[2].swap(0, Ordering::Relaxed),
        CB_SPIKE[3].swap(0, Ordering::Relaxed),
    ];
    log::info(
        "input",
        &format!(
            "回调 {count} 次·最长 {own_max}µs·均值 {}µs·超 1ms {over_1ms} 次（移动 {}·按下 {}·抬手 {}·其它 {}）|| 右键 {down} 次·任务栏豁免 {exempt}·吞 {swallow}",
            own_sum / count.max(1),
            spikes[0],
            spikes[1],
            spikes[2],
            spikes[3]
        ),
    );
}

/// 前台窗口所属进程的可执行基名（已小写、去 .exe）。
/// 读不到（提权程序、受保护进程）返回 None——按"不在名单"算。
fn foreground_executable_base() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut length: u32 = 1024;
        let mut buffer = vec![0u16; 1024];
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .is_ok();
        // 句柄用完即关：采样线程每 200ms 走一遍，泄漏不可容忍
        let _ = CloseHandle(process);
        if !ok || length == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        allowlist::normalize(&path)
    }
}

/// 最近一次采样到的前台进程名（hook_status 用）
pub fn foreground_name() -> Option<String> {
    FOREGROUND
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

#[cfg(test)]
mod tests {
    use super::charge_lead_ms;

    /// 钉住"贴阈值亮"：引导期必须严格早于阈值、不早于半个阈值、留尾不拖成长等待。
    #[test]
    fn 引导期贴阈值亮() {
        assert_eq!(charge_lead_ms(450), 300);
        assert_eq!(charge_lead_ms(2000), 1850);
        assert_eq!(charge_lead_ms(150), 75);
        for hold in [150u32, 200, 450, 900, 2000] {
            let lead = charge_lead_ms(hold);
            assert!(lead < hold, "{hold} 的引导期必须早于阈值，否则永远不亮");
            assert!(lead >= hold / 2, "{hold} 的引导期不早于半个阈值");
            assert!(hold - lead <= 150 + hold / 2, "{hold} 的留尾不该拖成长等待");
        }
    }

    #[test]
    fn 退化输入不炸() {
        assert_eq!(charge_lead_ms(0), 0);
        assert_eq!(charge_lead_ms(1), 0);
    }
}
