// input — 全局"长按右键唤星环"的手势链：状态机（纯）→ 低级钩子（接线）→ 星环。
//
// 本模块对外只暴露配置与生命周期；判定逻辑在 state.rs（纯，可穷举单测），
// 白名单口径在 allowlist.rs（纯），Win32 机器房在 win_hook.rs。
//
// 配置语义：
//  · `hold_ms`：长按阈值，落库（`ring.trigger.hold_ms`），跨启动生效；
//  · `charging`：充电弧总开关，落库（`ring.charging`）——关掉它引导期那张定时器
//    表根本不建，长按过程零反馈；
//  · `paused`：暂停劫持是"直到下次启动"的临时开关，**刻意不落库**——落库会让
//    用户以为右键坏了（重启都救不回来），重启即恢复是刻意的；
//  · 白名单：落库（`hook.whitelist`），跨启动生效。
//
// 另外这里放着星环盘的**驻留账本**（`ring_shown` / `ring_hidden` / `ring_contains`）：
// 窗那边写，回调这边读，全程原子量——盘在不在、点击在不在盘内，是钩子的判定输入。

pub mod allowlist;
mod state;
mod win_hook;

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU8, Ordering};
use std::sync::RwLock;

/// 长按阈值默认值（毫秒）
pub const DEFAULT_HOLD_MS: u32 = 450;
pub const MIN_HOLD_MS: u32 = 150;
pub const MAX_HOLD_MS: u32 = 2000;

static HOLD_MS: AtomicU32 = AtomicU32::new(DEFAULT_HOLD_MS);
static PAUSED: AtomicBool = AtomicBool::new(false);
static WHITELIST: RwLock<Vec<String>> = RwLock::new(Vec::new());

/// 任务栏矩形缓存的槽位数：主任务栏一条 + 每块副屏一条（`Shell_SecondaryTrayWnd`）。
/// 4 槽够到三屏；多的直接丢——丢的那块屏上的任务栏只是回到"被劫持"的默认行为。
pub(crate) const TASKBAR_SLOTS: usize = 4;

/// 任务栏（含托盘）的**物理**矩形，每条 4 个值：left / top / right / bottom。
///
/// 用定长原子量数组而不是 `RwLock<Vec<_>>`：读它的是钩子回调，那里不许拿任何锁
/// （见 `win_hook` 文件头铁律 1）。写侧是采样线程，一格一格 store 就行——
/// 最坏情况是读到一个"半新半旧"的矩形，那一枚按钮上这一次按下没被豁免而已。
static TASKBARS: [AtomicI32; TASKBAR_SLOTS * 4] =
    [const { AtomicI32::new(0) }; TASKBAR_SLOTS * 4];
static TASKBAR_COUNT: AtomicU8 = AtomicU8::new(0);

/// 采样线程写入：一条都没查到就传空切片，等价于"没有豁免区"。
pub(crate) fn set_taskbar_rects(rects: &[(i32, i32, i32, i32)]) {
    let n = rects.len().min(TASKBAR_SLOTS);
    for (i, rect) in rects.iter().take(n).enumerate() {
        for (k, value) in [rect.0, rect.1, rect.2, rect.3].iter().enumerate() {
            TASKBARS[i * 4 + k].store(*value, Ordering::Relaxed);
        }
    }
    // 数量最后写：读侧只看它，就不会看到"已经记了但还没写完"的矩形
    TASKBAR_COUNT.store(n as u8, Ordering::Relaxed);
}

/// 物理坐标是否落在任务栏（含托盘）里。回调里调用，无锁。
///
/// **一条都没缓存到就返回 false**，与白名单"读不到进程名就算没命中"是同一条规矩：
/// 反过来做等于"查不到矩形"时把整块屏幕的右键全豁免掉，那是把主入口悄悄关掉。
pub(crate) fn over_taskbar(x: i32, y: i32) -> bool {
    let count = (TASKBAR_COUNT.load(Ordering::Relaxed) as usize).min(TASKBAR_SLOTS);
    for i in 0..count {
        let (left, top, right, bottom) = (
            TASKBARS[i * 4].load(Ordering::Relaxed),
            TASKBARS[i * 4 + 1].load(Ordering::Relaxed),
            TASKBARS[i * 4 + 2].load(Ordering::Relaxed),
            TASKBARS[i * 4 + 3].load(Ordering::Relaxed),
        );
        if x >= left && x <= right && y >= top && y <= bottom {
            return true;
        }
    }
    false
}

pub fn spawn(app: tauri::AppHandle) {
    win_hook::spawn(app);
}

pub fn shutdown() {
    win_hook::shutdown();
}

pub fn hold_ms() -> u32 {
    HOLD_MS.load(Ordering::Relaxed)
}

pub fn set_hold_ms(ms: u32) {
    HOLD_MS.store(ms.clamp(MIN_HOLD_MS, MAX_HOLD_MS), Ordering::Relaxed);
}

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::Relaxed)
}

pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

/// 写白名单：过 allowlist::parse_list 归一（基名/去重/截断），采样线程下一轮生效
pub fn set_whitelist(raws: &[String]) {
    let list = allowlist::parse_list(raws);
    if let Ok(mut guard) = WHITELIST.write() {
        *guard = list;
    }
}

pub fn whitelist() -> Vec<String> {
    WHITELIST.read().map(|guard| guard.clone()).unwrap_or_default()
}

/// 最近采样到的前台进程基名（设置界面的「上一个前台程序」）
pub fn foreground_name() -> Option<String> {
    win_hook::foreground_name()
}

/// 星环盘驻留账本：盘的**物理**矩形 + "此刻在不在桌面上"。
///
/// 用原子量而不是锁：读它的是钩子回调（铁律：回调里不许拿任何锁）。盘外左键要能
/// 判成"取消"，盘内左键必须**不**判成取消——只有布尔就做不出这个区分：盘驻留时
/// 任何一次左键（包括点格子那一下）都会先被当成盘外，症状是"点节点没反应，环却收了"。
static RING_PRESENT: AtomicBool = AtomicBool::new(false);
/// 引导教程正指着盘讲（第二、三步）——那期间**盘外左键不收环**。
///
/// 为什么要这一道：气泡是盘外的一扇小窗，点它上面的「下一步」就是一次数标外的左键，
/// 按平时的规则那一下会把环收掉。症状是作者报的"第二步闪星环盘"：环刚出来，
/// 他点一下推进，环没了，下一步的气泡又指着空气。
/// 盘内那一下照常收环（点格子本来就该收），所以闸门只加在盘外那一条上。
static GUIDE_HOLDS_RING: AtomicBool = AtomicBool::new(false);
static RING_LEFT: AtomicI32 = AtomicI32::new(0);
static RING_TOP: AtomicI32 = AtomicI32::new(0);
static RING_RIGHT: AtomicI32 = AtomicI32::new(0);
static RING_BOTTOM: AtomicI32 = AtomicI32::new(0);

/// 盘绽开后公告它的**外框**（物理像素）。
///
/// 充电弧那条路**刻意不调**这里：弧没有盘，公告了矩形就会把这段时间里的左键
/// 全判成"盘外"，用户正好在长按，手就在那 360×360 里。
pub fn ring_shown(left: i32, top: i32, width: i32, height: i32) {
    RING_LEFT.store(left, Ordering::Relaxed);
    RING_TOP.store(top, Ordering::Relaxed);
    RING_RIGHT.store(left + width, Ordering::Relaxed);
    RING_BOTTOM.store(top + height, Ordering::Relaxed);
    RING_PRESENT.store(true, Ordering::Relaxed);
}

/// 盘收起（隐藏）：清账。漏了这一步，之后每一次盘外左键都会被当成"收环"。
pub fn ring_hidden() {
    RING_PRESENT.store(false, Ordering::Relaxed);
}

/// 盘此刻在不在屏幕上。充电弧用它做闸门：盘还驻留时再按一次右键，充电态要把
/// **同一个窗**改成鼠标穿透，那会把用户正在看的盘点掉。
pub(crate) fn ring_present() -> bool {
    RING_PRESENT.load(Ordering::Relaxed)
}

/// 引导期间要不要放过"盘外左键收环"那一条。
pub fn set_guide_holds_ring(on: bool) {
    GUIDE_HOLDS_RING.store(on, Ordering::Relaxed);
}

pub(crate) fn guide_holds_ring() -> bool {
    GUIDE_HOLDS_RING.load(Ordering::Relaxed)
}

/// 物理屏幕坐标是否落在盘内。**无锁**：回调里调用。
pub(crate) fn ring_contains(x: i32, y: i32) -> bool {
    if !RING_PRESENT.load(Ordering::Relaxed) {
        return true; // 位置还没公告：不判盘外，宁可不取消
    }
    x >= RING_LEFT.load(Ordering::Relaxed)
        && x <= RING_RIGHT.load(Ordering::Relaxed)
        && y >= RING_TOP.load(Ordering::Relaxed)
        && y <= RING_BOTTOM.load(Ordering::Relaxed)
}

/// 充电弧总开关（`ring.charging`，落库）。关掉就不建引导期定时器——
/// 那条路每次都要碰一扇 360×360 的顶层窗，有人就是不要这个反馈。
static CHARGING: AtomicBool = AtomicBool::new(true);

pub fn charging() -> bool {
    CHARGING.load(Ordering::Relaxed)
}

pub fn set_charging(on: bool) {
    CHARGING.store(on, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::{
        hold_ms, over_taskbar, ring_contains, ring_hidden, ring_shown, set_hold_ms,
        set_taskbar_rects, MAX_HOLD_MS, MIN_HOLD_MS,
    };

    /// 任务栏豁免的三条判据：命中含边界、**空表算没命中**、负坐标副屏的任务栏也认。
    /// 空表那条最关键：反过来做等于"查不到矩形"时把整屏右键全豁免掉，主入口就没了。
    #[test]
    fn 空表算没命中() {
        set_taskbar_rects(&[]);
        assert!(!over_taskbar(0, 0));
        assert!(!over_taskbar(9999, 9999));
    }

    #[test]
    fn 命中含边界() {
        set_taskbar_rects(&[(0, 1400, 2559, 1439)]);
        assert!(over_taskbar(0, 1400), "左上角含边界");
        assert!(over_taskbar(2559, 1439), "右下角含边界");
        assert!(over_taskbar(1280, 1420), "条带中间");
        assert!(!over_taskbar(1280, 1399), "条带上方一格不算");
        assert!(!over_taskbar(1280, 1440), "条带下方一格不算");
    }

    #[test]
    fn 副屏负坐标与多条并存() {
        set_taskbar_rects(&[
            (-1920, 1040, -80, 1079), // 副屏在左侧，任务栏在副屏底部
            (0, 1400, 2559, 1439),    // 主屏
        ]);
        assert!(over_taskbar(-1000, 1060), "副屏任务栏内");
        assert!(!over_taskbar(-1000, 900), "副屏桌面上");
        assert!(over_taskbar(2000, 1420), "主屏任务栏内");
    }

    #[test]
    fn 超过槽位数的任务栏被丢弃而不是溢出() {
        let many = vec![(0, 0, 10, 10); 9];
        set_taskbar_rects(&many);
        assert!(over_taskbar(5, 5), "前四条还在");
        set_taskbar_rects(&[]);
    }

    #[test]
    fn 阈值夹取区间() {
        assert_eq!(MIN_HOLD_MS, 150);
        assert_eq!(MAX_HOLD_MS, 2000);
    }

    /// 写进去的值就是实际跑的值（界面上不许显示一个、钩子里跑另一个）
    #[test]
    fn 阈值写入被夹回区间() {
        set_hold_ms(10);
        assert_eq!(hold_ms(), MIN_HOLD_MS, "太短会抢走普通点按");
        set_hold_ms(9_999);
        assert_eq!(hold_ms(), MAX_HOLD_MS);
        set_hold_ms(450);
        assert_eq!(hold_ms(), 450);
    }

    /// 盘内/盘外判定的三条方向，合成一条用例：这几格是全局原子量，
    /// 拆成两条会并行互踩（flaky）。
    /// 第一条最关键：**未公告矩形时一律算盘内**。反过来做就是"摆位还没落地的那
    /// 一瞬间用户已经按下左键"被判成盘外，盘刚绽开就被自己收掉。
    #[test]
    fn 盘矩形判定_未公告算盘内_含边界_负坐标() {
        ring_hidden();
        assert!(ring_contains(0, 0));
        assert!(ring_contains(-99_999, 99_999));

        ring_shown(100, 200, 360, 360);
        assert!(ring_contains(280, 380), "盘内");
        assert!(ring_contains(100, 200), "左上角含边界");
        assert!(ring_contains(460, 560), "右下角含边界");
        assert!(!ring_contains(99, 200), "左边外一格");
        assert!(!ring_contains(461, 560), "右边外一格");

        ring_shown(-3000, 200, 540, 540);
        assert!(ring_contains(-2900, 300), "副屏负坐标也能判");
        assert!(!ring_contains(-3400, 300), "负坐标外侧");
        // 150% 屏上那块盘宽是 540 不是 360：-3000..-2460，越界一格就算盘外
        assert!(ring_contains(-2500, 300), "540 宽度的内侧");
        assert!(!ring_contains(-2459, 300), "540 宽度的外侧一格");

        ring_hidden();
        assert!(ring_contains(-3400, 300), "收起来之后一律算盘内（不拦左键）");
    }

    /// 充电弧默认开着：关掉它得由用户在设置里明确做（见 commands/hook.rs）
    #[test]
    fn 充电弧开关默认开() {
        assert!(super::charging(), "默认关就等于这条功能没移植");
        super::set_charging(false);
        assert!(!super::charging());
        super::set_charging(true);
    }
}
