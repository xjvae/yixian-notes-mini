// win_hook — WH_MOUSE_LL 低级鼠标钩子：吞 down + 阈值 + 补偿注入 + 白名单采样。
//
// 线程模型（三条铁律）：
//   1. **回调里零跨进程调用、零阻塞锁、零日志、零 emit**。任何可能"向别的线程
//      要东西"的 Win32 调用都会把全系统输入链卡住（低级钩子同步串在输入流上，
//      超时默认 300ms）。回调只做：读原子量、`try_lock` + `try_send`、
//      `SetTimer`/`KillTimer`、`SendInput`。判定"前台是否在白名单"由采样线程
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

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicIsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
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
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow,
    GetMessageW, GetWindowThreadProcessId, HHOOK, HWND_MESSAGE, KillTimer, LLMHF_INJECTED,
    WM_MOUSEMOVE,
    MSG, MSLLHOOKSTRUCT, PostThreadMessageW, RegisterClassExW, SetTimer,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WINDOW_STYLE,
    WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_TIMER, WNDCLASSEXW,
};

use super::allowlist;
use super::state::{Action, Event, Machine, Phase};
use super::{hold_ms, is_paused, whitelist};
use crate::support::log;

const TIMER_ID: usize = 1;

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
/// 出盘事件通道：回调 try_send，消费线程转投星环
type OpenSender = SyncSender<(i32, i32)>;
static OPEN_SENDER: OnceLock<Mutex<Option<OpenSender>>> = OnceLock::new();

// —— 装配 ——

pub fn spawn(app: tauri::AppHandle) {
    let (sender, receiver) = sync_channel::<(i32, i32)>(8);
    OPEN_SENDER
        .set(Mutex::new(Some(sender)))
        .expect("input 只装配一次");

    // 消费线程：出盘事件 → 唤起星环（ IPC/窗口操作绝不进回调）
    {
        let app = app.clone();
        std::thread::spawn(move || {
            for (x, y) in receiver {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::windows::ring::open_at(&app, x, y).await {
                        log::warn("input", &format!("唤起星环失败：{e}"));
                    }
                });
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

    // 白名单采样线程：结论只写原子量
    std::thread::Builder::new()
        .name("yixian-allowlist".into())
        .spawn(sampler_loop)
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
            if msg.message == WM_TIMER && msg.wParam.0 == TIMER_ID {
                // 阈值到点：与钩子回调共用同一把 try_lock（同线程，锁必然空闲）
                step_and_execute(Event::TimerFired, hwnd);
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // GetMessageW 返回 0 = 收到 WM_QUIT
        let _ = KillTimer(Some(hwnd), TIMER_ID);
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

unsafe extern "system" fn hook_proc(ncode: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY：全部操作只读原子量/状态机、try_send 通道、调用 Win32 的
    // SetTimer/KillTimer/SendInput（无阻塞、无分配路径、无跨线程等待）。
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
        if !is_right_down && !is_right_up && !is_move {
            return CallNextHookEx(None, ncode, wparam, lparam);
        }

        // 新手势的准入判定（只在 down 时做；采样线程的结论已经是算好的原子量）
        if is_right_down && (is_paused() || ALLOWED.load(Ordering::Relaxed)) {
            return CallNextHookEx(None, ncode, wparam, lparam);
        }

        let event = match msg {
            _ if is_right_down => Event::RightDown { x: info.pt.x, y: info.pt.y },
            _ if is_right_up => Event::RightUp,
            _ => Event::Move { x: info.pt.x, y: info.pt.y },
        };

        let (actions, swallow) = match MACHINE.try_lock() {
            Ok(mut machine) => {
                let pre_passing = machine.phase == Phase::Passing;
                let pre_in_gesture =
                    machine.phase == Phase::Pressed || machine.phase == Phase::Armed;
                let actions = machine.step(event);
                let post = machine.phase;
                // 吞噬口径：手势内的事件吞（down 起手、Pressed/Armed 的移动、
                // Pressed/Armed 的抬起）；判定转透传的那一下移动要放行——
                // 应用刚被补发了 down，得跟上位移
                let swallow = match msg {
                    _ if is_right_down => post == Phase::Pressed,
                    _ if is_right_up => pre_in_gesture,
                    _ => pre_in_gesture && post != Phase::Passing && !pre_passing,
                };
                (actions, swallow)
            }
            Err(_) => {
                // 状态机被占着（理论上不该发生：泵与回调同线程）：宁可放行也不等
                return CallNextHookEx(None, ncode, wparam, lparam);
            }
        };

        execute(&actions);
        if swallow {
            LRESULT(1)
        } else {
            CallNextHookEx(None, ncode, wparam, lparam)
        }
    }
}

/// 泵线程（WM_TIMER）与回调共用的执行入口
fn step_and_execute(event: Event, hwnd: HWND) {
    let Ok(mut machine) = MACHINE.try_lock() else {
        return;
    };
    let actions = machine.step(event);
    drop(machine);
    execute(&actions);
    let _ = hwnd;
}

fn execute(actions: &[Action]) {
    for action in actions {
        match action {
            Action::StartTimer => unsafe {
                let hwnd = HOOK_WINDOW.load(Ordering::SeqCst);
                SetTimer(Some(HWND(hwnd as *mut _)), TIMER_ID, hold_ms(), None);
            },
            Action::KillTimer => unsafe {
                let hwnd = HOOK_WINDOW.load(Ordering::SeqCst);
                let _ = KillTimer(Some(HWND(hwnd as *mut _)), TIMER_ID);
            },
            Action::InjectFullClick => {
                send_input(&[MOUSEEVENTF_RIGHTDOWN.0, MOUSEEVENTF_RIGHTUP.0]);
            }
            Action::InjectPress => {
                send_input(&[MOUSEEVENTF_RIGHTDOWN.0]);
            }
            Action::EmitOpen { x, y } => {
                if let Some(sender) = OPEN_SENDER
                    .get_or_init(|| Mutex::new(None))
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                {
                    let _ = sender.try_send((*x, *y));
                }
            }
        }
    }
}

fn send_input(flags: &[u32]) {
    let inputs: Vec<INPUT> = flags
        .iter()
        .map(|&flag| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS(flag),
                    ..Default::default()
                },
            },
        })
        .collect();
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

// —— 白名单采样线程 ——

fn sampler_loop() {
    loop {
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(Duration::from_millis(SAMPLER_INTERVAL_MS));
        let base = foreground_executable_base();
        let is_blocked = base
            .as_deref()
            .map(|name| allowlist::blocked(name, &whitelist()))
            .unwrap_or(false);
        ALLOWED.store(is_blocked, Ordering::Relaxed);
        *FOREGROUND.lock().unwrap_or_else(|p| p.into_inner()) = base;
    }
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
