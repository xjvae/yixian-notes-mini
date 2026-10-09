// win_hook — WH_MOUSE_LL 低级鼠标钩子：吞 down + 阈值 + 补偿注入 + 白名单采样。
//
// 线程模型（三条铁律）：
//   1. **回调里零跨进程调用、零阻塞锁、零日志、零 emit**。任何可能"向别的线程
//      要东西"的 Win32 调用都会把全系统输入链卡住（低级钩子同步串在输入流上，
//      超时默认 300ms）。回调只做：读原子量、`try_lock` + `try_send`、
//      `SetTimer`/`KillTimer`、`PostMessageW`（注入推给泵线程做，见 `request_inject`，
//      `SendInput` 一律不进回调）。判定"前台是否在白名单"由采样线程
//      每 200ms 算好写进原子量，回调只读结论。预算：本回调 ≤1ms。
//   2. **钩子与消息泵同线程**：SetTimer 需要窗口载体（message-only 窗），
//      WM_TIMER 在同一条 GetMessageW 泵里收到——"到阈值置 armed"与事件判定
//      跑在同一线程，没有跨线程竞态。互斥的状态机用 `try_lock`：竞争即放行，
//      宁可少劫一次，不可卡全系统一毫秒。
//   3. **退出必须真的卸钩子**：泵线程任一退出路径置 PUMP_DONE；主线程等待
//      500ms，等不到就自己 UnhookWindowsHookEx 兜底（见 mod.rs 的 shutdown）。
//
// 自反馈防线：本模块 SendInput 注入的事件带 LLMHF_INJECTED，回调看到即放行——
// 不做这一条，注入的 down 会被自己再吞一遍，死循环。

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
    HWND_MESSAGE, KillTimer, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PostMessageW, PostThreadMessageW,
    RegisterClassExW, SetTimer, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_MOUSE_LL, WINDOW_STYLE, WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_TIMER, WNDCLASSEXW,
};

use super::allowlist;
use super::state::{Action, Event, Machine, Phase};
use super::{hold_ms, is_paused, whitelist};
use crate::support::log;

const TIMER_ID: usize = 1;
/// 充电弧的引导期计时器（比 Hold 早到点，见 `charge_lead_ms`）
const CHARGE_TIMER: usize = 0x514F;

// 充电弧的**留尾**：只在离阈值还剩这么多毫秒时才亮起来。
//
// 为什么不"按下即亮"：亮弧这条路径要给 360×360 的顶层 webview 窗做"摆位 + show +
// 设穿透 + 一次 IPC"。旧项目把它设在固定 120ms，结果真机反馈"整个右键都变慢，浏览器
// 和桌面都一样"——因为"有意识地右键"的正常时长恰好落在 150~250ms 这一带，于是每一次
// 右键都付一次上述开销，还正压在系统上下文菜单要出现的那一瞬间。
// 贴着阈值亮之后：只有真在长按才碰窗口，普通右键一次都不碰。
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
    /// 松手/转拖拽：弧淡出，整盘随后开（长按那条路不发这条，见 state.rs）
    Up,
    /// 盘驻留期间**盘外**左键按下：前端收环，这次点击原样放行
    Dismiss,
}
type OpenSender = SyncSender<RingEvent>;
/// 直接 OnceLock，不套 Mutex：读它的是钩子回调（见 `notify`），
/// 在系统输入链上拿锁就是铁律 1 禁止的事，而这里根本没有需要互斥的写侧——
/// sender 只在 spawn 时装一次，之后只有 try_send。
static OPEN_SENDER: OnceLock<OpenSender> = OnceLock::new();

// —— 装配 ——

pub fn spawn(app: tauri::AppHandle) {
    let (sender, receiver) = sync_channel::<RingEvent>(8);
    OPEN_SENDER.set(sender).expect("input 只装配一次");

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
                            // ring:open 的广播与"盘在这里"的矩形公告都在
                            // windows/ring.rs::reveal 里做——出盘只有一条路，
                            // 交接事件和公告跟着 show 走，别在这里各发一次
                            // （发两遍前端就要重放两遍入场）
                            if let Err(e) = crate::windows::ring::open_at(&app, x, y).await {
                                log::warn("input", &format!("唤起星环失败：{e}"));
                            }
                        });
                    }
                    // 走到这里已经是引导期走完、手还按着（**不是按下即亮**）。
                    // "每次右键都闪一下"正是全局工具最容易招致卸载的那类打扰，
                    // 所以这里再兜一道：开关关掉、或者盘还驻留着，就什么都不做。
                    // 后一条尤其要紧：充电态要把这同一个窗改成鼠标穿透，
                    // 盘正开着的时候那么干等于把用户正在看的盘点掉。
                    RingEvent::Charging { x, y, hold_ms } => {
                        if !crate::input::charging() || crate::input::ring_present() {
                            continue;
                        }
                        if let Err(e) = crate::windows::ring::show_charging(&app, x, y, hold_ms) {
                            log::warn("input", &format!("亮起充电弧失败：{e}"));
                        }
                    }
                    // 弧淡出：只广播，**不 hide 窗口**。那 90ms 归前端画，
                    // 画完它自己调 close_ring_window；后端抢着收窗就是把淡出抹平，
                    // 症状是"反馈闪一下就没"。
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
        .expect("起钩子线程");
    PUMP_THREAD
        .set(Mutex::new(Some(pump)))
        .expect("input 只装配一次");

    // 白名单采样线程：结论只写原子量。它另外管两件"贵调用"——任务栏矩形与屏表缓存
    // （星环摆位要按"按下点在哪块屏、那块屏缩放多少"，见 windows/monitor.rs）
    let sampler_app = app.clone();
    std::thread::Builder::new()
        .name("yixian-allowlist".into())
        .spawn(move || sampler_loop(&sampler_app))
        .expect("起采样线程");
}

/// 退出清理：通知泵退出并等 500ms；等不到就从这里直接卸钩子兜底。
/// 在 RunEvent::Exit 里调用——这条路上再卡死，进程就只能靠外部收尸了。
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

        // GetMessageW 返回 0 = 收到 WM_QUIT
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

/// 自证计数：排"右键慢"时第一件想知道的就是"慢不赖我"还是"赖我"。
/// 全部 relaxed 原子读改，**回调里绝不写日志**；聚合成一行由采样线程做。
static CB_COUNT: AtomicU64 = AtomicU64::new(0);
/// 我们这段自身耗时（不含 CallNextHookEx 与后续链）的历史最大值
static CB_OWN_MAX_US: AtomicU64 = AtomicU64::new(0);
static CB_OWN_SUM_US: AtomicU64 = AtomicU64::new(0);
static CB_OVER_1MS: AtomicU64 = AtomicU64::new(0);
/// 超 1ms 的那几次分别是什么消息：0 移动 / 1 右键按下 / 2 右键抬手 / 3 其它。
/// 分账的理由：最长一次到过 5425µs，光看总数定不了责——WM_MOUSEMOVE 走的是最前面
/// 那条放行分支（读两个原子量就 `CallNextHookEx`），它要是也能超 1ms，账就不在本模块
/// 头上，而是这条线程被系统抢走了。分开了才知道下一步该改代码还是该改线程优先级。
static CB_SPIKE: [AtomicU64; 4] = [const { AtomicU64::new(0) }; 4];
/// 右键三计数：进了手势逻辑的、被任务栏豁免掉的、被吞掉的
static RB_DOWN: AtomicU64 = AtomicU64::new(0);
static RB_EXEMPT: AtomicU64 = AtomicU64::new(0);
static RB_SWALLOW: AtomicU64 = AtomicU64::new(0);

unsafe extern "system" fn hook_proc(ncode: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // 两次 Instant::now() 是纯读（各几十纳秒），换到的是"这段有没有卡过 1ms"的证据。
    // 不测含 CallNextHookEx 的总时长：那一段本来就不归我们，测了也解释不了。
    CB_COUNT.fetch_add(1, Ordering::Relaxed);
    let started = std::time::Instant::now();
    let out = unsafe { hook_body(ncode, wparam, lparam) };
    let own = started.elapsed().as_micros() as u64;
    CB_OWN_MAX_US.fetch_max(own, Ordering::Relaxed);
    CB_OWN_SUM_US.fetch_add(own, Ordering::Relaxed);
    if own > 1000 {
        CB_OVER_1MS.fetch_add(1, Ordering::Relaxed);
        CB_SPIKE[spike_kind(wparam.0 as u32)].fetch_add(1, Ordering::Relaxed);
    }
    out
}

/// 尖刺分账用的消息种类：0 移动 / 1 右键按下 / 2 右键抬手 / 3 其它。
/// if 链而不是 match：这里的 `WM_*` 是 u32 常量，走模式匹配不如直接比。
fn spike_kind(msg: u32) -> usize {
    if msg == WM_MOUSEMOVE {
        0
    } else if msg == WM_RBUTTONDOWN {
        1
    } else if msg == WM_RBUTTONUP {
        2
    } else {
        3
    }
}

unsafe extern "system" fn hook_body(ncode: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY：全部操作只读原子量/状态机、try_send 通道、调用 Win32 的
    // SetTimer/KillTimer/PostMessageW（无阻塞、无分配路径、无跨线程等待）。
    // 注入不在这段做（见 request_inject）。
    unsafe {
        if ncode < 0 {
            return CallNextHookEx(None, ncode, wparam, lparam);
        }
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            return CallNextHookEx(None, ncode, wparam, lparam);
        }
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        if info.flags & LLMHF_INJECTED != 0 {
            // 自己注入的补偿事件：直接放行，防自反馈
            return CallNextHookEx(None, ncode, wparam, lparam);
        }
        let msg = wparam.0 as u32;
        let is_right_down = msg == WM_RBUTTONDOWN;
        let is_right_up = msg == WM_RBUTTONUP;
        let is_move = msg == WM_MOUSEMOVE;
        // 盘驻留期间的左键也要进来看一眼——早退里必须把它排除掉，否则下面那条
        // Dismiss 分支永远进不来（实测过：环收不掉，只能再按一次右键）。
        // 但只有**盘外**那一下才算"收环"，判据在下面。
        let is_left_down = msg == WM_LBUTTONDOWN;
        let ring_may_dismiss = is_left_down && crate::input::ring_present();
        if !is_right_down && !is_right_up && !is_move && !ring_may_dismiss {
            return CallNextHookEx(None, ncode, wparam, lparam);
        }

        // 任务栏/托盘整条豁免：那上面的右键归系统（托盘图标、任务栏按钮的跳转列表）。
        // 不豁免的话每一次托盘右键都要走"吞 down + 注入一对 down/up"，用户感知的
        // 卡顿正出在这条路径上。读的是采样线程缓存好的物理矩形，无锁。
        if is_right_down && crate::input::over_taskbar(info.pt.x, info.pt.y) {
            RB_EXEMPT.fetch_add(1, Ordering::Relaxed);
            return CallNextHookEx(None, ncode, wparam, lparam);
        }

        // 盘驻留期间的**盘外**左键：发 Dismiss 让前端收环，这次点击照常放行。
        // 盘内那一下必须什么都不发：低级钩子看得见的坐标是全屏幕的，点格子那一下
        // 同样会走到这里——只有布尔账本时就把它判成盘外，症状是
        // "点节点没反应，环却收了"。读的是 reveal 公告好的物理矩形，无锁。
        if ring_may_dismiss {
            if !crate::input::ring_contains(info.pt.x, info.pt.y) {
                notify(RingEvent::Dismiss);
            }
            return CallNextHookEx(None, ncode, wparam, lparam);
        }

        // 新手势的准入判定（只在 down 时做；采样线程的结论已经是算好的原子量）
        if is_right_down {
            RB_DOWN.fetch_add(1, Ordering::Relaxed);
            if is_paused() || ALLOWED.load(Ordering::Relaxed) {
                return CallNextHookEx(None, ncode, wparam, lparam);
            }
        }

        let event = match msg {
            _ if is_right_down => Event::RightDown { x: info.pt.x, y: info.pt.y },
            _ if is_right_up => Event::RightUp,
            _ => Event::Move { x: info.pt.x, y: info.pt.y },
        };

        let (actions, swallow) = match MACHINE.try_lock() {
            Ok(mut machine) => {
                let pre = machine.phase;
                let actions = machine.step(event);
                let post = machine.phase;
                // 只吞右键的 down 与 up，**move 一条都不吞**——旧实现把这条写进了
                // 用例名："框选要能用：本条 move 必须放行"。吞掉手势期间的移动有
                // 两个代价：按住时指针冻在原地，而判定转透传的那一下应用刚收到
                // 补发的 down、正等位移跟上。
                // down 只在真起手（→Pressed）时吞；up 在 Pressed/Armed 里吞——
                // 短按要换成注入的补偿、长按要出盘，两种都不该让应用收到抬手。
                let in_gesture = matches!(pre, Phase::Pressed | Phase::Armed);
                let swallow = if is_right_down {
                    post == Phase::Pressed
                } else if is_right_up {
                    in_gesture
                } else {
                    false
                };
                (actions, swallow)
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

/// **注入只能发生在消息泵线程，不能发生在回调里**（旧实现原话：以前就在这里
/// `SendInput`，结果是"每一次右键都慢半拍，浏览器和桌面都一样"）。
/// 理由：我们没返回之前整条系统输入链都停在这段回调上，而注入出去那对事件还要
/// 再走一遍这条链（还要再进我们自己的 LLMHF_INJECTED 分支）、再进目标应用队列，
/// 才由 DefWindowProc 生成 WM_CONTEXTMENU——放在回调里就是把这串塞进用户
/// 按住与松手之间的那几十毫秒。
/// 投递失败（队列满、消息窗已毁）就当场自己做：宁可慢那一次，
/// 也不能让用户的上下文菜单干脆弹不出来——补偿注入是这功能不惹恼用户的底线。
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
            // 阈值与引导期都在这里现读：设置窗改了阈值不必重装钩子。
            // 充电弧被关掉时这张表根本不建——那条路每次都要碰一扇 360×360 的窗
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

// —— 采样线程：白名单结论、任务栏矩形、回调耗时聚合 ——
//
// 三条活都在这个线程做，回调那边只读原子量。旧实现的两条经验一并搬过来：
//  · 前台窗口没换就不重复做那串贵调用（OpenProcess + QueryFullProcessImageNameW）；
//  · 回调耗时不写日志、只攒原子计数，攒够了由这里聚成一行落文件——
//    "右键慢不赖本模块"得能被证明，而不是靠猜。

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

        // 前台进程名只在换了前台窗口时才查（OpenProcess + QueryFullProcessImageNameW
        // 那串是贵调用，每 200ms 一次白跑）；名单结论每轮都重算，
        // 这样在设置窗里改白名单不必等切窗口就生效
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

/// 收一条任务栏矩形；满了就不收（超出的屏回到"被劫持"的默认行为）
fn push_taskbar_rect(out: &mut Vec<(i32, i32, i32, i32)>, hwnd: HWND) {
    if out.len() >= crate::input::TASKBAR_SLOTS {
        return;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
        out.push((rect.left, rect.top, rect.right, rect.bottom));
    }
}

/// 主任务栏 + 各副屏任务栏的物理矩形（最多 4 条）。
///
/// `Shell_SecondaryTrayWnd` 用 FindWindowExW 顺着句柄走同类的下一个，
/// 不必 EnumWindows 一趟回调。一条都没查到就返回空表——空表在 `over_taskbar`
/// 里算"没命中"，也就是不豁免，与白名单读不到名字算不命中同一条规矩。
fn collect_taskbar_rects() -> Vec<(i32, i32, i32, i32)> {
    let mut out = Vec::new();
    unsafe {
        if let Ok(main) = FindWindowW(None, windows::core::w!("Shell_TrayWnd"))
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
/// 读不到（提权程序、受保护进程）返回 None——按"不在名单"算，见 allowlist 头注释。
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

    /// 引导期必须落在"贴阈值"那一带：这是整条延迟修复的判据。
    /// 数值取自旧实现的同一组断言。
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
