// splash — 启动开场窗：**原生分层窗**，全程不碰 WebView2。
//
// 为什么只能是原生：这条要盖住的就是"双击到第一张便签之间那段无反馈"，而它的长度
// ≈ 一扇 WebView2 冷启动（约 1s，见 `windows/ring.rs` 文件头）。用 webview 做开场窗
// 等于把要盖住的代价再付一遍，也直接撞 ARCHITECTURE 那条定稿纪律——"为一条进度反馈
// 去冷启动一扇 webview，恰恰会制造这功能想消掉的那种闪"。原生分层窗的首帧是几十毫秒级，
// 正好排在开库之前落下去。
//
// 三条不许改的性质（改了就等于把便签挡在开场后面）：
//  1. **绝不吃输入、绝不抢焦点**：`WS_EX_TRANSPARENT | NOACTIVATE | TOOLWINDOW`，全程不叫
//     `SetForegroundWindow`。于是长按右键的低级钩子照旧（钩子看硬件输入，与窗样式无关），
//     而**前台进程不变** → `input` 那套白名单判定完全不受影响。也**不向 input 公告矩形**：
//     开场窗不是盘，公告了"盘外左键 = 收环"那笔账就乱了。
//  2. **两条退路都比画面重要**：第一扇窗亮起来就退（`dismiss`），外加 `MAX_ALIVE_MS` 无条件
//     退。便签自己的 reveal 兜底是 2000ms（`windows/float.rs`），这里给的是它 + 余量。
//     还是那条定稿纪律：看不见便签比闪一下白严重。
//  3. **演不成不许带走应用**：这一身跑在它自己的线程上，任何一步失败就记一行日志然后静默
//     放弃。release 是 `panic = "abort"` 且没有 unwind，所以这条路上一个 unwrap 都不许留。
//
// 画面：与星环同一套语言的环。底环是 8% 墨（`data/theme.ts` 的 `RING_INK.divider`：浅色档
// 0.08 / 深色档 0.10，这里同值），弧从 12 点扫满一圈，曲线 `cubic-bezier(0.22, 0.8, 0.28, 1)`
// —— 项目里唯一现成的一条（`index.css`）；图标在 `ICON_FROM_MS` 起淡入；之后**停在满环静态
// 待命**，不循环（等一个长度未知的东西还循环，就是 nagging）。
//
// 颜色跟系统深浅色（HKCU 的 `AppsUseLightTheme`）：scheme 存在 SQLite 的 settings 表里，
// 而开场窗比开库更早。显式选了 light/dark 的人在开机那 600ms 可能差一档——这是刻意的取舍，
// 换回来的是不开库也能有第一帧。
//
// 图标按它**自己的物理尺寸**画，不放大：Windows 上 `default_window_icon()` 取的是
// `SM_CXICON` 那一档（96DPI 下 32×32，随系统缩放走），拉到 96 会糊，宁可小而清晰。
//
// 没有新依赖：`CreateDIBSection` 在 `Win32_Graphics_Gdi`，`UpdateLayeredWindow`/
// `SystemParametersInfoW` 在 `Win32_UI_WindowsAndMessaging`，两个 feature 早就开着；
// 只为读深浅色那一个值多开了 `Win32_System_Registry`（同一个 windows crate 的 cfg 开关）。

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::time::Instant;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, CreateCompatibleDC,
    CreateDIBSection, DeleteDC, DeleteObject, DIB_RGB_COLORS, GetDC, GetDeviceCaps, HDC,
    HBITMAP, HGDIOBJ, LOGPIXELSX, ReleaseDC, SelectObject,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_DWORD, RegGetValueW};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetMessageW, HCURSOR, IDC_ARROW, KillTimer, LoadCursorW, MSG, PostMessageW, PostQuitMessage,
    RegisterClassExW, SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetTimer,
    ShowWindow, SW_SHOWNOACTIVATE, SystemParametersInfoW, TranslateMessage, ULW_ALPHA,
    UpdateLayeredWindow, WM_APP, WM_DESTROY, WM_TIMER, WNDCLASSEXW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

use crate::support::log;
use crate::windows::monitor;

/// 画面见方（**逻辑**像素）。星环的盘是 360，开场要明显更克制
const BOX_LOGICAL: f64 = 200.0;
/// 环带内外径（逻辑像素）
const BAND_INNER_LOGICAL: f64 = 62.0;
const BAND_OUTER_LOGICAL: f64 = 70.0;
/// 弧扫满一圈
const ARC_MS: u32 = 600;
/// 图标起淡入 / 淡入时长
const ICON_FROM_MS: u32 = 380;
const ICON_SPAN_MS: u32 = 220;
/// 退场淡出——与星环那条弧的下台同档（`features/ring/window.tsx` 的 90ms）
const FADE_MS: u32 = 90;
/// 无条件退场的上限：便签的 reveal 兜底 2000ms + 余量
const MAX_ALIVE_MS: u32 = 2500;
const FRAME_MS: u32 = 16;
/// 外部线程叫开场窗退场投递的消息（WM_APP 段是留给应用自己用的）
const WM_APP_DISMISS: u32 = WM_APP + 1;
const TIMER_ID: usize = 1;
const CLASS_NAME: &str = "YixianNotesSplash";

/// 退场是谁叫的。日志只说最初那一声——后到的第二次、第三次不改写它
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// 有窗亮起来了（便签单窗/叠窗/提醒卡/星环任一）
    Revealed,
    /// 到时长上限还没人叫（`restore_on_boot` 关着的人走这一条）
    Timeout,
    /// 应用要退出
    Exit,
}

const REASON_NONE: u8 = 0;

impl Reason {
    fn code(self) -> u8 {
        match self {
            Self::Revealed => 1,
            Self::Timeout => 2,
            Self::Exit => 3,
        }
    }

    fn text(code: u8) -> &'static str {
        match code {
            1 => "第一扇窗已亮",
            2 => "到时长上限兜底",
            3 => "应用要退出",
            _ => "未知原因",
        }
    }
}

/// 已经有人叫退场（`dismiss` 与超时都写它）。建窗之后第一件事读它——
/// 早于建窗到达的退场（比如极快的 reveal）不能丢
static GONE: AtomicBool = AtomicBool::new(false);
/// 第一个叫退场的原因（0 = 还没人叫过）
static REASON: AtomicU8 = AtomicU8::new(REASON_NONE);
/// 开场窗的 HWND（0 = 还没建或已收）。dismiss 只读它做投递。
/// 存 usize 而不是指针：`HWND` 在这台 windows 版本上是指针型句柄，原子量只装得下整数
static HWND_ATOM: AtomicUsize = AtomicUsize::new(0);
/// 这一身在进程里只跑一次
static SPAWNED: AtomicBool = AtomicBool::new(false);

fn call_reason(code: u8) {
    // 只记第一次的原因；GONE 一律置真（原因记不上也得让窗退）
    let _ = REASON.compare_exchange(
        REASON_NONE,
        code,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
    GONE.store(true, Ordering::Release);
}

/// 开场窗的构成：每像素的半径/角度在创建时算一次，帧循环里只做比较与写像素
/// （`atan2` 每帧重算 90k 次是白扔，而这条弧的时长是毫秒级）
struct Painter {
    size: u32,
    radius: Vec<f32>,
    angle: Vec<f32>,
    inner: f32,
    outer: f32,
    /// 墨色 RGB（写进 DIB 时才换 BGRA 的序）
    ink: [u8; 3],
    /// 底环不透明度（浅/深两档不同值，与 `RING_INK.divider` 同）
    track: f32,
    /// 预乘 alpha 的 BGRA 图标覆盖层，按行存
    icon: Vec<u8>,
    icon_side: u32,
    icon_off: u32,
}

impl Painter {
    fn new(scale: f64, dark: bool, icon: Option<(Vec<u8>, u32, u32)>) -> Self {
        let size = (BOX_LOGICAL * scale).max(24.0) as u32;
        let center = (size as f32 - 1.0) / 2.0;
        let mut radius = vec![0f32; (size * size) as usize];
        let mut angle = vec![0f32; (size * size) as usize];
        for y in 0..size {
            for x in 0..size {
                let dx = x as f32 - center;
                let dy = y as f32 - center;
                let i = (y * size + x) as usize;
                radius[i] = (dx * dx + dy * dy).sqrt();
                // 时钟角：12 点是 0，顺时针增（`atan2(dx, -dy)`）
                angle[i] = dx.atan2(-dy).rem_euclid(std::f32::consts::TAU);
            }
        }
        // 图标按它自己的物理尺寸画（不放大），居中；读不到就不画中心那块。
        // 空覆盖层必须把边长一起归零：`paint` 里"icon_side > 0 就一定有位图可取"这条
        // 依赖配对，配错了就是越界 panic（而这条线程一 panic 就带走整个应用）
        let (icon, icon_side, icon_off) = match icon {
            Some((rgba, w, h)) if w > 0 && w == h => {
                let side = w.min(size);
                let off = ((size - side) / 2).min(size / 2);
                let buf = icon_overlay(&rgba, side);
                if buf.is_empty() {
                    (Vec::new(), 0, 0)
                } else {
                    (buf, side, off)
                }
            }
            _ => (Vec::new(), 0, 0),
        };
        Self {
            size,
            radius,
            angle,
            inner: (BAND_INNER_LOGICAL * scale) as f32,
            outer: (BAND_OUTER_LOGICAL * scale) as f32,
            // 与 `data/theme.ts` 的 `RING_INK.label` 同值（light #1d2329 / dark #E7E9EC）
            ink: if dark {
                [231, 233, 236]
            } else {
                [29, 35, 41]
            },
            track: if dark { 0.10 } else { 0.08 },
            icon,
            icon_side,
            icon_off,
        }
    }

    /// 画一帧到 DIB 的像素缓冲里。`sweep` 是弧扫到的角度，`icon_a`/`fade` 各是 0..1
    ///
    /// 像素格式是 `CreateDIBSection` 给的 32bpp **预乘** BGRA——`UpdateLayeredWindow`
    /// 配 `AC_SRC_ALPHA` 只收预乘的份，写非预乘会得到一圈发白的边。
    fn paint(&self, bits: *mut u8, sweep: f32, icon_a: f32, fade: f32) {
        if bits.is_null() || fade <= 0.0 {
            return;
        }
        let out = unsafe { std::slice::from_raw_parts_mut(bits, (self.size * self.size * 4) as usize) };
        let (ri, gi, bi) = (self.ink[0] as f32, self.ink[1] as f32, self.ink[2] as f32);
        let side = self.icon_side as usize;
        let off = self.icon_off as usize;
        let w = self.size as usize;
        let want_icon = icon_a > 0.0 && side > 0;
        for idx in 0..(w * w) {
            let band = band_coverage(self.radius[idx], self.inner, self.outer);
            // 环带底：带内才有东西，扫过的段落实色，没扫到的留那条底环
            let mut base = [0f32; 4];
            if band > 0.0 {
                let swept = self.angle[idx] <= sweep;
                let a = band * if swept { 1.0 } else { self.track } * fade;
                base = [bi * a, gi * a, ri * a, a];
            }
            let px = if want_icon {
                let x = idx % w;
                let y = idx / w;
                if x >= off
                    && y >= off
                    && x - off < side
                    && y - off < side
                {
                    let j = ((y - off) * side + (x - off)) * 4;
                    // 一律走 get：不变量"icon_side > 0 就必然有位图"已经在 Painter::new
                    // 里配好了，但配错的形式是越界 panic —— 而这条线程一 panic 就带走整个应用
                    let byte = |k: usize| self.icon.get(j + k).copied().unwrap_or(0) as f32 / 255.0;
                    let ia = byte(3) * icon_a * fade;
                    if ia > 0.0 {
                        let inv = 1.0 - ia;
                        [
                            byte(0) * icon_a * fade + base[0] * inv,
                            byte(1) * icon_a * fade + base[1] * inv,
                            byte(2) * icon_a * fade + base[2] * inv,
                            ia + base[3] * inv,
                        ]
                    } else {
                        base
                    }
                } else {
                    base
                }
            } else {
                base
            };
            let o = idx * 4;
            out[o] = (px[0] * 255.0).clamp(0.0, 255.0) as u8;
            out[o + 1] = (px[1] * 255.0).clamp(0.0, 255.0) as u8;
            out[o + 2] = (px[2] * 255.0).clamp(0.0, 255.0) as u8;
            out[o + 3] = (px[3] * 255.0).clamp(0.0, 255.0) as u8;
        }
    }
}

/// 环带的覆盖率：内外各 1 物理像素线性过渡。分层窗没有 GDI 的抗锯齿，边只能这样自己抹
fn band_coverage(r: f32, inner: f32, outer: f32) -> f32 {
    if outer <= inner {
        return 0.0;
    }
    (r - inner).clamp(0.0, 1.0).min((outer - r).clamp(0.0, 1.0))
}

/// 贝塞尔单轴 `p(t)`，P0=0、P3=1（CSS 的 cubic-bezier 就是这条）
fn bezier_axis(t: f64, p1: f64, p2: f64) -> f64 {
    let u = 1.0 - t;
    3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t
}

/// CSS 那条 `cubic-bezier(0.22, 0.8, 0.28, 1)` 在 Rust 侧的等价实现：入参是时间占比，
/// 返回进度占比。二分求参数 t（不用牛顿——端点处导数会抖，24 次二分已经到 1e-7 以下）
fn ease(x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let (mut a, mut b) = (0.0f64, 1.0f64);
    for _ in 0..24 {
        let mid = (a + b) / 2.0;
        if bezier_axis(mid, 0.22, 0.28) < x {
            a = mid;
        } else {
            b = mid;
        }
    }
    bezier_axis((a + b) / 2.0, 0.8, 1.0)
}

/// 弧扫到哪儿（弧度）。`reduce` 档直接给满环：停在起点等于整条弧都不画，
/// 那与"关掉动画却把反馈也关掉"是同一个错误（`index.css` 的 reduce 分支同口径）
fn sweep_at(now_ms: u32, reduce: bool) -> f32 {
    if reduce {
        return std::f32::consts::TAU;
    }
    (std::f64::consts::TAU * ease(now_ms as f64 / ARC_MS as f64)) as f32
}

/// 图标的不透明度
fn icon_alpha_at(now_ms: u32, reduce: bool) -> f32 {
    if reduce {
        return 1.0;
    }
    if now_ms < ICON_FROM_MS {
        0.0
    } else {
        ((now_ms - ICON_FROM_MS) as f64 / ICON_SPAN_MS as f64).clamp(0.0, 1.0) as f32
    }
}

/// 退场淡出：1 → 0。`reduce` 档不给淡（要的是"不演"，不是"演得快一点"）
fn fade_at(elapsed_ms: u32, reduce: bool) -> f32 {
    if reduce {
        return 0.0;
    }
    (1.0 - elapsed_ms as f64 / FADE_MS as f64).clamp(0.0, 1.0) as f32
}

/// 宽字符缓冲：`PCWSTR` 只吃以 0 结尾的 u16 串，用完这段内存得活着
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 8 位通道的预乘：`c * a / 255` 四舍五入。分层窗只收预乘的份。
///
/// 这里别玩移位花招：`(c*a*257)>>8` 算出来是 `c*a*1.004`，大出 256 倍，
/// 截成 u8 就是一团脏色（上一版踩的正是这条）。
fn premultiply(c: u8, a: u32) -> u8 {
    (((c as u32 * a) + 127) / 255) as u8
}

/// 图标：源是 RGBA（tauri 的 `Image::rgba`），覆盖层要的是**预乘 BGRA**。
///
/// 取字节一律走 `get`：这条在开场线程上，而 release 是 `panic = "abort"` 且没有 unwind——
/// 一次越界就会把整个应用带走，而开场窗凭什么都决定应用活不活。
/// 源不够长就当图标读不到（返回空覆盖层，环照扫）。
fn icon_overlay(rgba: &[u8], side: u32) -> Vec<u8> {
    let need = (side * side * 4) as usize;
    if rgba.len() < need {
        return Vec::new();
    }
    let mut buf = vec![0u8; need];
    for i in 0..(side * side) as usize {
        let byte = |k: usize| rgba.get(i * 4 + k).copied().unwrap_or(0);
        let a = byte(3) as u32;
        buf[i * 4] = premultiply(byte(2), a); // B
        buf[i * 4 + 1] = premultiply(byte(1), a); // G
        buf[i * 4 + 2] = premultiply(byte(0), a); // R
        buf[i * 4 + 3] = a as u8;
    }
    buf
}

/// 系统用的是浅色还是深色应用模式。读不到按**浅色**——猜错的代价只是配色不合适，
/// 而开机头一帧给一块深灰，在浅色桌面上更刺眼
fn apps_dark_theme() -> bool {
    let sub = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let name = wide("AppsUseLightTheme");
    let mut value: u32 = 1;
    let mut len: u32 = 4;
    // 返回的是 WIN32_ERROR（不是 Result）：`.is_ok()` 就是"读到了"
    let error = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut c_void),
            Some(&mut len),
        )
    };
    if error.is_ok() {
        value == 0
    } else {
        false
    }
}

/// Windows 的"提供动画效果"开关（设置 → 辅助功能 → 视觉效果）。
/// 问不到按**开着**处理：那是绝大多数机器的现状，也是这套画面本来设计的样子
fn motion_reduced() -> bool {
    let mut on: u32 = 1;
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut on as *mut u32 as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    match ok {
        Ok(()) => on == 0,
        Err(_) => false,
    }
}

/// 这一身的所有跨调用状态。只由开场线程读写 → 所以放 thread_local，
/// 连带原始指针也不用编 `unsafe impl Send`
struct Session {
    painter: Painter,
    hwnd: HWND,
    screen_dc: HDC,
    mem_dc: HDC,
    bitmap: HBITMAP,
    old_obj: HGDIOBJ,
    bits: *mut u8,
    left: i32,
    top: i32,
    started: Instant,
    /// 退场淡出的起点（None = 还没开始退）
    fading: Option<Instant>,
    reduce: bool,
    shown: bool,
    logged: bool,
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

impl Session {
    /// 画一帧并交给系统。第一次交完才 `SW_SHOWNOACTIVATE` 露脸——
    /// 分层窗在 `UpdateLayeredWindow` 之前是空的，先 show 就是闪一块透明矩形
    fn frame(&mut self) -> bool {
        let now = self.started.elapsed().as_millis() as u32;
        if !GONE.load(Ordering::Acquire) && now >= MAX_ALIVE_MS {
            call_reason(Reason::Timeout.code());
        }
        if GONE.load(Ordering::Acquire) && self.fading.is_none() {
            self.fading = Some(Instant::now());
            if !self.logged {
                self.logged = true;
                log::info(
                    "splash",
                    &format!("退场：{}", Reason::text(REASON.load(Ordering::Acquire))),
                );
            }
        }
        let fade = match self.fading {
            Some(t) => fade_at(t.elapsed().as_millis() as u32, self.reduce),
            None => 1.0,
        };
        if fade <= 0.0 {
            return false; // 淡完了（或 reduce 档直接不淡）：收窗
        }
        self.painter.paint(
            self.bits,
            sweep_at(now, self.reduce),
            icon_alpha_at(now, self.reduce),
            fade,
        );
        let size = self.painter.size as i32;
        let dst = POINT {
            x: self.left,
            y: self.top,
        };
        let src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let submitted = unsafe {
            UpdateLayeredWindow(
                self.hwnd,
                Some(self.screen_dc),
                Some(&dst as *const POINT),
                Some(&SIZE { cx: size, cy: size } as *const SIZE),
                Some(self.mem_dc),
                Some(&src as *const POINT),
                COLORREF(0),
                Some(&blend as *const BLENDFUNCTION),
                ULW_ALPHA,
            )
        };
        if let Err(e) = submitted {
            log::warn("splash", &format!("交帧失败，收场：{e}"));
            return false;
        }
        if !self.shown {
            self.shown = true;
            unsafe {
                let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
            }
        }
        true
    }

    /// 线程退出后收 GDI 的账。顺序：先把位图从 DC 上换下去再删
    fn teardown(self) {
        unsafe {
            if !self.bitmap.is_invalid() {
                let _ = SelectObject(self.mem_dc, self.old_obj);
                let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            }
            if !self.mem_dc.is_invalid() {
                let _ = DeleteDC(self.mem_dc);
            }
            if !self.screen_dc.is_invalid() {
                let _ = ReleaseDC(None, self.screen_dc);
            }
        }
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TIMER => {
            let keep = SESSION.with(|cell| {
                match cell.borrow_mut().as_mut() {
                    Some(s) if s.hwnd == hwnd => s.frame(),
                    _ => false,
                }
            });
            if keep {
                LRESULT(0)
            } else {
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
                LRESULT(0)
            }
        }
        m if m == WM_APP_DISMISS => {
            // 退场交给下一帧：淡出要有帧，而帧只能由这个线程自己发
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe {
                let _ = KillTimer(Some(hwnd), TIMER_ID);
            }
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 建窗 → 摆位 → 帧循环。失败一律返回 Err 由 `spawn` 记一行日志，绝不 panic
fn attempt(icon: Option<(Vec<u8>, u32, u32)>) -> Result<(), String> {
    // 缩放只能问主屏 DC：`GetDpiForWindow` 那档在 `Win32_UI_HiDpi` 里，
    // 为一个 200 见方的画面不值得多开 feature
    let scale = {
        let dc = unsafe { GetDC(None) };
        let dpi = unsafe { GetDeviceCaps(Some(dc), LOGPIXELSX) };
        unsafe {
            let _ = ReleaseDC(None, dc);
        }
        if dpi > 0 {
            (dpi as f64 / 96.0).max(0.5)
        } else {
            1.0
        }
    };
    // 主屏工作区中心（原点最近那块屏就是主屏）。用整块屏中心会压到任务栏那 48 上
    let area = monitor::at((0, 0)).ok_or("拿不到主屏工作区")?;
    let size = (BOX_LOGICAL * scale).max(24.0) as i32;
    // 工作区那份是 i64 的物理像素，窗位置要 i32：先在 i64 里算完再窄化
    let left = (area.x + (area.width - i64::from(size)) / 2) as i32;
    let top = (area.y + (area.height - i64::from(size)) / 2) as i32;
    let reduce = motion_reduced();
    let painter = Painter::new(scale, apps_dark_theme(), icon);

    let module = unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?;
    // HMODULE 与 HINSTANCE 也是各自独立的指针 newtype（窗类与建窗都要后者）
    let instance = HINSTANCE(module.0);
    let class = wide(CLASS_NAME);
    let title = wide("开场");
    // 光标要显式给：分层窗的 hCursor 留空 = 指针移过去直接看不见
    let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }
        .unwrap_or(HCURSOR(std::ptr::null_mut()));
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wndproc),
        hInstance: instance,
        lpszClassName: PCWSTR(class.as_ptr()),
        hCursor: cursor,
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&wc) } == 0 {
        return Err(format!("注册窗类失败：{}", std::io::Error::last_os_error()));
    }
    // GDI 表面先备好再建窗：这样失败的那几条路径上还没有窗要销毁，账不容易漏
    //
    // 32bpp top-down DIB：负高度 = 行序自上而下，省掉一次上下翻转
    let mem_dc = unsafe { CreateCompatibleDC(None) };
    if mem_dc.is_invalid() {
        return Err("建不了兼容 DC".to_string());
    }
    let mut bits: *mut c_void = std::ptr::null_mut();
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            biHeight: -size,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let bitmap = match unsafe {
        CreateDIBSection(Some(mem_dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
    } {
        Ok(handle) if !bits.is_null() => handle,
        Ok(_) => {
            unsafe {
                let _ = DeleteDC(mem_dc);
            }
            return Err("DIB 给了空指针".to_string());
        }
        Err(e) => {
            unsafe {
                let _ = DeleteDC(mem_dc);
            }
            return Err(format!("建不了 32bpp DIB：{e}"));
        }
    };
    let hwnd = match unsafe {
        CreateWindowExW(
            // 不吃输入 + 永不激活 + 不进 Alt+Tab + 置顶。全程不叫 SetForegroundWindow
            WS_EX_LAYERED
                | WS_EX_TRANSPARENT
                | WS_EX_NOACTIVATE
                | WS_EX_TOOLWINDOW
                | WS_EX_TOPMOST,
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_POPUP,
            left,
            top,
            size,
            size,
            None,
            None,
            Some(instance),
            None,
        )
    } {
        Ok(handle) => handle,
        Err(e) => {
            // 窗建不出来 = 没有东西要收，把 GDI 那两条还回去就行
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(mem_dc);
            }
            return Err(format!("建开场窗失败：{e}"));
        }
    };
    // SelectObject 只吃 HGDIOBJ：句柄在这版 windows 上是各自独立的指针 newtype，不隐式互转
    let old_obj = unsafe { SelectObject(mem_dc, HGDIOBJ(bitmap.0)) };

    SESSION.with(|cell| {
        *cell.borrow_mut() = Some(Session {
            painter,
            hwnd,
            screen_dc: HDC(std::ptr::null_mut()),
            mem_dc,
            bitmap,
            old_obj,
            bits: bits as *mut u8,
            left,
            top,
            started: Instant::now(),
            fading: None,
            reduce,
            shown: false,
            logged: false,
        });
    });
    // 交帧要一个屏 DC：在会话里存着，别每帧 GetDC 一次
    SESSION.with(|cell| {
        if let Some(s) = cell.borrow_mut().as_mut() {
            s.screen_dc = unsafe { GetDC(None) };
        }
    });

    // 建窗这一刻才允许别人够得到这扇窗；早于此刻到达的退场由 GONE 兜住
    // （不在这儿另记一行：下面第一帧就会按同一个原因记一次退场，两条日志只留一条）
    HWND_ATOM.store(hwnd.0 as usize, Ordering::Release);
    let first = SESSION.with(|cell| cell.borrow_mut().as_mut().map(|s| s.frame()).unwrap_or(false));
    if !first {
        HWND_ATOM.store(0, Ordering::Release);
        let s = SESSION.with(|cell| cell.borrow_mut().take());
        if let Some(s) = s {
            unsafe {
                let _ = DestroyWindow(s.hwnd);
            }
            s.teardown();
            return Ok(());
        }
        return Ok(());
    }
    unsafe {
        let _ = SetTimer(Some(hwnd), TIMER_ID, FRAME_MS, None);
    }
    let mut msg = MSG::default();
    loop {
        // SAFETY：GetMessageW 只往 msg 里写；返回 FALSE 是它递来 WM_QUIT 这一种
        match unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
            false => break,
            true => {
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
    }
    HWND_ATOM.store(0, Ordering::Release);
    let s = SESSION.with(|cell| cell.borrow_mut().take());
    if let Some(s) = s {
        s.teardown();
    }
    Ok(())
}

/// 起开场窗。排在 `support::log::init` 之后、`Db::open` 之前调
pub fn spawn(app: &tauri::AppHandle) {
    if SPAWNED.swap(true, Ordering::AcqRel) {
        return; // 一进程一次
    }
    // 图标读不到也要开场：中心不画东西，环照扫
    let icon = app
        .default_window_icon()
        .map(|image| (image.rgba().to_vec(), image.width(), image.height()));
    let spawned = std::thread::Builder::new()
        .name("splash".to_string())
        .spawn(move || {
            if let Err(e) = attempt(icon) {
                log::warn("splash", &format!("开场没演成（不影响启动）：{e}"));
            }
        });
    if let Err(e) = spawned {
        log::warn("splash", &format!("开场线程起不来（不影响启动）：{e}"));
    }
}

/// 叫开场窗退场。**幂等且廉价**：没开过场就一次原子读返回；开过场也只投递一条消息，
/// 真正的淡出与日志由开场线程自己做
pub fn dismiss(reason: Reason) {
    if !SPAWNED.load(Ordering::Acquire) {
        return;
    }
    call_reason(reason.code());
    let hwnd = HWND_ATOM.load(Ordering::Acquire);
    if hwnd != 0 {
        unsafe {
            // 投给已销毁的窗只会返回 Err，这里本来就当没这回事：退场由 GONE 记过就够了
            let _ = PostMessageW(
                Some(HWND(hwnd as *mut c_void)),
                WM_APP_DISMISS,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 曲线两端不抖且中前段快过后段() {
        assert_eq!(ease(0.0), 0.0);
        assert_eq!(ease(1.0), 1.0);
        // p1y=0.8 是"抢跑"的档位：同一时刻的进度必须比线性大
        assert!(ease(0.5) > 0.5, "实际 {}", ease(0.5));
        assert!(ease(0.25) > 0.25);
    }

    #[test]
    fn 曲线单调不减() {
        let mut last = -1.0;
        for i in 0..=100 {
            let v = ease(i as f64 / 100.0);
            assert!(v >= last - 1e-9, "{i} 处回抖：{v} < {last}");
            last = v;
        }
        assert!((last - 1.0).abs() < 1e-6);
    }

    #[test]
    fn 弧扫满是到点而不是提前() {
        assert!(sweep_at(0, false) < 0.01);
        // `cubic-bezier(0.22, 0.8, 0.28, 1)` 是强缓出：时间过一半已经扫到九成以上，
        // 所以"到点之前还没满"这个想当然的断言不成立。留在这里的是这条弧的脾气：
        // 前半段甩过去、后半段收尾。
        assert!(sweep_at(ARC_MS / 2, false) > std::f32::consts::TAU * 0.9);
        assert!((sweep_at(ARC_MS, false) - std::f32::consts::TAU).abs() < 1e-6);
        // 过了点不许继续涨（停在满环待命，不是循环）
        assert!((sweep_at(ARC_MS + 4000, false) - std::f32::consts::TAU).abs() < 1e-6);
    }

    #[test]
    fn 关掉动画就是满环与满图标() {
        // 停在起点 = 整条弧都不画，长按/开机反而彻底没反馈——那条 reduce 纪律的同一条理由
        assert_eq!(sweep_at(0, true), std::f32::consts::TAU);
        assert_eq!(icon_alpha_at(0, true), 1.0);
        assert_eq!(fade_at(0, true), 0.0);
    }

    #[test]
    fn 图标在起淡入之后才出现并夹到一() {
        assert_eq!(icon_alpha_at(ICON_FROM_MS - 1, false), 0.0);
        assert!((icon_alpha_at(ICON_FROM_MS, false) - 0.0).abs() < 1e-6);
        assert_eq!(icon_alpha_at(ICON_FROM_MS + ICON_SPAN_MS, false), 1.0);
        assert_eq!(icon_alpha_at(ICON_FROM_MS + ICON_SPAN_MS * 3, false), 1.0);
    }

    #[test]
    fn 淡出到点归零() {
        assert_eq!(fade_at(0, false), 1.0);
        assert!((fade_at(FADE_MS / 2, false) - 0.5).abs() < 0.02);
        assert_eq!(fade_at(FADE_MS, false), 0.0);
        assert_eq!(fade_at(FADE_MS * 9, false), 0.0);
    }

    #[test]
    fn 环带覆盖率在内外沿线性过渡() {
        assert_eq!(band_coverage(10.0, 62.0, 70.0), 0.0);
        assert_eq!(band_coverage(62.0, 62.0, 70.0), 0.0);
        assert_eq!(band_coverage(63.0, 62.0, 70.0), 1.0);
        assert_eq!(band_coverage(66.0, 62.0, 70.0), 1.0);
        assert_eq!(band_coverage(70.0, 62.0, 70.0), 0.0);
        // 内外各 1 像素的过渡带，两边对称（f32 算出来的，别按字面量精确相等去要）
        assert!((band_coverage(62.4, 62.0, 70.0) - 0.4).abs() < 1e-5);
        assert!((band_coverage(69.6, 62.0, 70.0) - 0.4).abs() < 1e-5);
        // 退化带宽不许 panic（夹不出来就当没这条带）
        assert_eq!(band_coverage(64.0, 70.0, 62.0), 0.0);
    }

    #[test]
    fn 时钟角从十二点起顺时针增() {
        // 与 Painter 里同一式子：atan2(dx, -dy)
        let ang = |dx: f32, dy: f32| dx.atan2(-dy).rem_euclid(std::f32::consts::TAU);
        assert!(ang(0.0, -10.0).abs() < 1e-6, "12 点应当是 0");
        assert!((ang(10.0, 0.0) - std::f32::consts::FRAC_PI_2).abs() < 1e-6, "3 点是 π/2");
        assert!((ang(0.0, 10.0) - std::f32::consts::PI).abs() < 1e-6, "6 点是 π");
        assert!((ang(-10.0, 0.0) - 3.0 * std::f32::consts::FRAC_PI_2).abs() < 1e-6, "9 点是 3π/2");
    }

    #[test]
    fn 预乘等于颜色乘alpha除255() {
        // 上一版写的是 `(c*a*257)>>8` —— 那是 c*a*1.004，大出 256 倍，截成 u8 就是一团脏色
        assert_eq!(premultiply(200, 255), 200, "全不透明必须原样留着");
        assert_eq!(premultiply(200, 0), 0, "全透明必须归零");
        assert_eq!(premultiply(255, 128), 128);
        assert_eq!(premultiply(0, 128), 0);
        // 预乘的结果不许大过 alpha 本身：超了就是合成出并不存在的亮度
        for a in 0..=255u32 {
            assert!(premultiply(255, a) as u32 <= a, "a={a} 处超了");
        }
    }

    #[test]
    fn 图标覆盖层把rgba换成预乘bgra() {
        let rgba = vec![
            255, 0, 0, 255, // 纯红不透明
            0, 255, 0, 0, // 纯绿全透明
            0, 0, 255, 128, // 纯蓝半透明
            10, 20, 30, 255, // 三色同值不透明
        ];
        let out = icon_overlay(&rgba, 2);
        assert_eq!(out.len(), 16);
        assert_eq!(&out[0..4], &[0, 0, 255, 255], "换序：R 要落到第三字节");
        assert_eq!(&out[4..8], &[0, 0, 0, 0], "全透明的预乘必须是全 0，不能留颜色");
        assert_eq!(&out[8..12], &[128, 0, 0, 128]);
        assert_eq!(&out[12..16], &[30, 20, 10, 255]);
    }

    #[test]
    fn 源缓冲不够长就当没图标而不是越界() {
        // 只有 1 像素的字节却要点 2×2：给空覆盖层（Painter 那边会把边长一起归零）
        assert!(icon_overlay(&[0, 0, 0, 0], 2).is_empty());
        // 刚好够的那一份要正常出图
        assert_eq!(icon_overlay(&[0, 0, 255, 255], 1).as_slice(), &[255, 0, 0, 255]);
    }

    #[test]
    fn 退场原因只记最初那一声() {
        REASON.store(REASON_NONE, Ordering::Release);
        GONE.store(false, Ordering::Release);
        call_reason(Reason::Revealed.code());
        call_reason(Reason::Timeout.code());
        assert_eq!(REASON.load(Ordering::Acquire), Reason::Revealed.code());
        assert!(GONE.load(Ordering::Acquire));
        assert!(Reason::text(Reason::Timeout.code()).contains("上限"));
        // 没人叫过时不许编一个原因出来（那是"未知"，不是某个真原因）
        assert_eq!(Reason::text(REASON_NONE), "未知原因");
        REASON.store(REASON_NONE, Ordering::Release);
        GONE.store(false, Ordering::Release);
    }
}
