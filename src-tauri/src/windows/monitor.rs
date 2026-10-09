// monitor — 显示器几何的唯一住址。
//
// 两份数据分开取，因为用途不一样：
//  · **工作区**（屏幕减掉任务栏那块）走 Win32 `GetMonitorInfoW`：贴边细丝要贴它，
//    任务栏底下不留东西。这份 unsafe 只留这里，别处调它。
//  · **整块屏**的矩形 + 那块屏自己的缩放走 tauri `available_monitors`，并且**缓存**：
//    星环要按"按下点真正落在哪块屏"摆位。这条查询要过主线程，所以由采样线程按拍
//    刷进来，不在开窗那一刻现查（旧实现同样缓存）。

use std::sync::RwLock;

use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MonitorFromPoint, MONITORINFO,
};

/// 物理像素矩形
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl WorkArea {
    /// 把 (w, h) 尺寸的块整块夹进本矩形，返回左上角。块比矩形还大时贴左上角
    /// （clamp 的 min>max 会直接 panic，所以先取 max）
    pub fn clamp_block(&self, point: (i64, i64), width: i64, height: i64) -> (i64, i64) {
        let max_x = (self.x + self.width - width).max(self.x);
        let max_y = (self.y + self.height - height).max(self.y);
        (point.0.clamp(self.x, max_x), point.1.clamp(self.y, max_y))
    }
}

/// 一块屏的**整块**物理矩形与它自己的缩放。
///
/// 整块而不是工作区：星环是浮在桌面上的盘，任务栏那一条也算地方——夹工作区的话，
/// 贴着屏幕底部长按出来的盘会被往上顶起一整个任务栏的高度，而盘心还自称在光标上。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
    pub scale: f64,
}

impl Screen {
    /// 物理点是否落在这块屏上。含左上、不含右下：相邻屏共享的那条边界不许双算，
    /// 否则"落在两块屏上"的按点随机取决于遍历顺序。
    pub fn contains(&self, x: i64, y: i64) -> bool {
        x >= self.left
            && x < self.left + self.width
            && y >= self.top
            && y < self.top + self.height
    }

    /// 以 (cx, cy) 为中心摆一块 `size_phys` 见方的块，夹在本屏矩形内（四边各留 margin_phys）。
    pub fn place_centered(
        &self,
        cx: i64,
        cy: i64,
        size_phys: i64,
        margin_phys: i64,
    ) -> (i64, i64) {
        let inset = WorkArea {
            x: self.left + margin_phys,
            y: self.top + margin_phys,
            width: (self.width - margin_phys * 2).max(1),
            height: (self.height - margin_phys * 2).max(1),
        };
        inset.clamp_block((cx - size_phys / 2, cy - size_phys / 2), size_phys, size_phys)
    }
}

/// 屏表缓存。读侧在消费线程（开窗那一刻），那里可以拿锁——钩子回调不许的规矩
/// 不在这条路上（回调只往通道里投编号，见 `input::win_hook`）。
static SCREENS: RwLock<Vec<Screen>> = RwLock::new(Vec::new());

fn screen_of(monitor: &tauri::Monitor) -> Screen {
    let position = monitor.position();
    let size = monitor.size();
    Screen {
        left: position.x as i64,
        top: position.y as i64,
        width: size.width as i64,
        height: size.height as i64,
        // 缩放为 0 会让后面的除法变成 inf：按 1:1 处理，最坏是盘偏一点，不值得 panic
        scale: monitor.scale_factor().max(0.01),
    }
}

/// 刷新屏表。**主屏排最前**（tauri 不标谁是主屏，沿用 Win32 惯例：主屏原点恒 (0,0)）。
/// 问不到显示器信息就不动旧表——旧值比空表更接近真相。
pub fn refresh(app: &tauri::AppHandle) {
    let Ok(monitors) = app.available_monitors() else {
        return;
    };
    let mut list: Vec<Screen> = monitors.iter().map(screen_of).collect();
    list.sort_by_key(|s| i64::from(s.left != 0) + i64::from(s.top != 0));
    if let Ok(mut guard) = SCREENS.write() {
        *guard = list;
    }
}

/// 按下点真正落在的那块屏；命不中给 `None`。
///
/// 为什么"在哪块屏"必须在**物理空间**里问：不同缩放的屏，逻辑矩形会互相盖住
/// （主屏 100% + 副屏 150% 时，副屏的逻辑区间就压进主屏那一段），只有物理坐标
/// 有唯一答案。命不中（刚拔掉屏那一瞬）就返回 None，调用方宁可"以点为中心不夹取"，
/// 也不许退化成夹到主屏——那正是"星环自己跳回主屏"的形状。
pub fn at_physical(x: i64, y: i64) -> Option<Screen> {
    let guard = SCREENS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.iter().copied().find(|s| s.contains(x, y))
}

/// 缓存里已知的屏数（诊断日志用；0 = 还没刷过）
pub fn count() -> usize {
    SCREENS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .len()
}

/// 给定点（物理像素）所在显示器的工作区。取不到返回 None（无显示器的怪会话）
pub fn at(point: (i64, i64)) -> Option<WorkArea> {
    let win_point = POINT {
        x: point.0 as i32,
        y: point.1 as i32,
    };
    // SAFETY：MONITORINFO 的 cbSize 按约定填好；GetMonitorInfoW 只读显示器信息，
    // 不持有任何跨调用指针。WindowsAndMessaging/Gdi 的这两个调用不涉及其它线程。
    let area = unsafe {
        let monitor = MonitorFromPoint(win_point, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        WorkArea {
            x: info.rcWork.left as i64,
            y: info.rcWork.top as i64,
            width: (info.rcWork.right - info.rcWork.left) as i64,
            height: (info.rcWork.bottom - info.rcWork.top) as i64,
        }
    };
    Some(area)
}

#[cfg(test)]
mod tests {
    use super::{Screen, WorkArea};

    fn area() -> WorkArea {
        WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        }
    }

    #[test]
    fn 块整块夹回工作区() {
        // 光标贴右缘：环的左上角要退到"右边刚好不出界"
        assert_eq!(area().clamp_block((1900, 300), 420, 420), (1500, 300));
        // 贴下缘同理
        assert_eq!(area().clamp_block((100, 1030), 420, 420), (100, 620));
        // 块比工作区还大时不许 panic，也不许负到看不见的地方
        assert_eq!(area().clamp_block((500, 500), 4000, 4000), (0, 0));
    }

    #[test]
    fn 多显示器负坐标区域也认() {
        // 副屏在主屏左侧：工作区 x 是负的，夹回来的左上角也得是负的
        let left = WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        // -1900 起的一块整个落在 -1920..0 里，不该被推走
        assert_eq!(left.clamp_block((-1900, 100), 420, 420), (-1900, 100));
        // 贴两屏接缝那块要退到右缘刚好齐工作区右界（-420 + 420 = 0）
        assert_eq!(left.clamp_block((-100, 100), 420, 420), (-420, 100));
    }

    /// 主屏 1920×1080 @100%，副屏挂在右侧、物理 1920..4800、@150%。
    const PRIMARY: Screen = Screen {
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        scale: 1.0,
    };
    const RIGHT_SECOND: Screen = Screen {
        left: 1920,
        top: 0,
        width: 2880,
        height: 1600,
        scale: 1.5,
    };
    const LEFT_SECOND: Screen = Screen {
        left: -1920,
        top: 0,
        width: 1920,
        height: 1080,
        scale: 1.0,
    };
    const DISC_100: i64 = 360; // 360 逻辑 × 1.0
    const DISC_150: i64 = 540; // 360 逻辑 × 1.5
    const MARGIN_100: i64 = 4;
    const MARGIN_150: i64 = 6;

    /// 边界口径：含左上、不含右下。相邻屏共享的那条缝不许双算，
    /// 否则同一个按点落在哪块屏取决于遍历顺序（盘就会在两块屏之间跳）。
    #[test]
    fn 屏命中含左上不含右下() {
        assert!(PRIMARY.contains(0, 0));
        assert!(PRIMARY.contains(1919, 1079));
        assert!(!PRIMARY.contains(1920, 0), "那条缝归右边那块屏");
        assert!(RIGHT_SECOND.contains(1920, 0));
        assert!(LEFT_SECOND.contains(-1920, 500), "负坐标那侧同理");
        assert!(!LEFT_SECOND.contains(0, 500));
        assert!(!PRIMARY.contains(999_999, 0), "哪块都不在就给 None 的原料");
    }

    /// 副屏（150%）贴右缘的一下长按：盘必须留在**那块屏**里。
    ///
    /// 拿"窗自己的缩放"或"只认主屏的矩形"来算都会跳回主屏——主屏那支给出的
    /// 上界是 1920-360-4=1556，正好是用户报"星环自己跑掉"时看到的那个数。
    #[test]
    fn 副屏贴右缘的盘夹在副屏内() {
        let (left, top) =
            RIGHT_SECOND.place_centered(4700, 1550, DISC_150, MARGIN_150);
        assert!(left > 1920, "不许退化成夹到主屏（那会给出 ≤1556）");
        assert_eq!(left, 4794 - DISC_150, "右边刚好齐副屏内缩边界");
        assert!(left >= RIGHT_SECOND.left + MARGIN_150);
        assert!(left + DISC_150 <= RIGHT_SECOND.left + RIGHT_SECOND.width - MARGIN_150 + 1);
        assert_eq!(top, 1600 - MARGIN_150 - DISC_150);
    }

    /// 负坐标那块屏：中心在副屏里就不许被抬回 0 以上。
    #[test]
    fn 负坐标屏上的盘留在负坐标里() {
        let (left, _) = LEFT_SECOND.place_centered(-1000, 500, DISC_100, MARGIN_100);
        assert!(left < 0, "盘要在那块屏上，不是被抬回 {left}");
        assert!(left >= LEFT_SECOND.left + MARGIN_100);
    }

    /// 贴屏幕底部：夹的是**整块屏**，所以盘只退到屏边，不会被任务栏顶起一截。
    /// 夹工作区的那支（细丝用的才是它）在这里会给出 644 = 1008-360-4。
    #[test]
    fn 贴底的盘按整块屏夹而不是工作区() {
        let (left, top) = PRIMARY.place_centered(960, 1070, DISC_100, MARGIN_100);
        assert_eq!((left, top), (780, 716), "1080-360-4=716；换工作区就成了 644");
        // 屏中央那一下不该被动过：中心就是按下点
        assert_eq!(PRIMARY.place_centered(960, 500, DISC_100, MARGIN_100), (780, 320));
    }

    /// 屏比盘还小（极小的虚拟屏 / 缩放到 100% 的 800×600）：贴内缩左上角，不许 panic
    #[test]
    fn 盘比屏大时贴内缩角() {
        let tiny = Screen {
            left: 0,
            top: 0,
            width: 300,
            height: 300,
            scale: 1.0,
        };
        assert_eq!(tiny.place_centered(150, 150, DISC_100, MARGIN_100), (4, 4));
    }
}
