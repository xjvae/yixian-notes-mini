// monitor — 显示器几何的唯一住址。两份数据分开取，因为用途不一样：
//  · **工作区**（屏幕减掉任务栏）走 Win32 GetMonitorInfoW：贴边细丝要贴它；这份 unsafe 只留这里，别处调它。
//  · **整块屏**矩形 + 那块屏自己的缩放走 tauri available_monitors 并**缓存**：这条查询要过主线程，
//    由采样线程按拍刷进来，不在开窗那一刻现查。

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
    /// 把 (w, h) 尺寸的块整块夹进本矩形，返回左上角。块比矩形大时贴左上角——clamp 的 min>max 会 panic，所以先取 max
    pub fn clamp_block(&self, point: (i64, i64), width: i64, height: i64) -> (i64, i64) {
        let max_x = (self.x + self.width - width).max(self.x);
        let max_y = (self.y + self.height - height).max(self.y);
        (point.0.clamp(self.x, max_x), point.1.clamp(self.y, max_y))
    }

    /// 一块 `width × height`（物理像素）在本矩形里**居中**的左上角。
    /// 奇数尺寸差的那一像素归右下（整数除法向下取整），只要稳定就行。
    pub fn center_block(&self, width: i64, height: i64) -> (i64, i64) {
        self.clamp_block(
            (
                self.x + (self.width - width) / 2,
                self.y + (self.height - height) / 2,
            ),
            width,
            height,
        )
    }
}

/// 一块屏的**整块**物理矩形与它自己的缩放。
/// 整块而不是工作区：星环贴着屏幕底部长按时夹工作区会被顶起一整个任务栏高度，而盘心还自称在光标上。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
    pub scale: f64,
}

impl Screen {
    /// 物理点是否落在这块屏上。含左上、不含右下：相邻屏共享的边界不许双算，否则落点随遍历顺序漂。
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

/// 屏表缓存。读侧在消费线程（开窗那一刻），可以拿锁——钩子回调不许锁的规矩不在这条路上。
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
    let mut guard = SCREENS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = list;
}

/// 按下点真正落在的那块屏；命不中给 `None`。
/// "在哪块屏"必须在**物理空间**问：不同缩放的屏逻辑矩形会互相盖住，只有物理坐标有唯一答案。
/// 命不中（刚拔屏那一瞬）调用方宁可"以点为中心不夹取"，也不许退化成夹主屏——那是"星环自己跳回主屏"的形状。
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
    // SAFETY：MONITORINFO 的 cbSize 按约定填好；GetMonitorInfoW 只读显示器信息，不持有跨调用指针
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

/// 当前光标位置（物理像素）。失败返回 None，由调用方退回默认摆位
pub fn cursor() -> Option<(i64, i64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY：GetCursorPos 只往 &mut point 写两个 LONG；返回值判 BOOL，FALSE 时不读 point 的内容
    let ok = unsafe { GetCursorPos(&mut point) }.is_ok();
    ok.then_some((point.x as i64, point.y as i64))
}

/// 一扇窗的**出生位置**：光标所在那块屏的**工作区**正中，再按 `offset_logical`（逻辑像素）
/// 向右下错开。尺寸同样按逻辑像素给，内部按那块屏自己的缩放换算。
/// 按工作区不按整块屏居中，否则窗下沿被任务栏吃掉；按光标所在屏，手在哪块窗就出现在哪块。
/// 问不到（屏表还没刷出、或没有显示器）给 `None` 交回系统摆——宁可位置普通也不要跳到别的屏。
pub fn spawn_centered(
    size_logical: (f64, f64),
    offset_logical: (f64, f64),
) -> Option<(f64, f64)> {
    let point = cursor()?;
    let work = at(point)?;
    let scale = at_physical(point.0, point.1)?.scale;
    let width = (size_logical.0 * scale).round() as i64;
    let height = (size_logical.1 * scale).round() as i64;
    let (x, y) = work.center_block(width, height);
    Some((
        x as f64 / scale + offset_logical.0,
        y as f64 / scale + offset_logical.1,
    ))
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
        assert_eq!(area().clamp_block((100, 1030), 420, 420), (100, 620));
        // 块比工作区还大时不许 panic，也不许负到看不见的地方
        assert_eq!(area().clamp_block((500, 500), 4000, 4000), (0, 0));
    }

    #[test]
    fn 居中落点算的是工作区不是整块屏() {
        // 2560×1440、任务栏占 48 → 工作区 2560×1392；默认便签 320×300、口令窗 420×470
        let wide = WorkArea {
            x: 0,
            y: 0,
            width: 2560,
            height: 1392,
        };
        assert_eq!(wide.center_block(320, 300), (1120, 546));
        assert_eq!(wide.center_block(420, 470), (1070, 461));
        // 按整块屏（1440）算的落点就是被任务栏吃掉的那一截
        assert_ne!(wide.center_block(320, 300).1, (1440 - 300) / 2);
    }

    #[test]
    fn 副屏上的居中落点留在那块屏里() {
        // 副屏挂在右边，物理工作区从 x=2560 起
        let right = WorkArea {
            x: 2560,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(right.center_block(320, 300), (3360, 370));
        // 挂在左边的副屏：原点是负的，居中落点也必须是负的
        let left = WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(left.center_block(320, 300), (-1120, 370));
    }

    #[test]
    fn 窗比工作区还大时贴左上不许负到看不见() {
        assert_eq!(area().center_block(4000, 4000), (0, 0));
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

    /// 边界口径：含左上、不含右下——共享缝双算的话，同一个按点落在哪块屏取决于遍历顺序，盘会在两屏间跳。
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

    /// 副屏（150%）贴右缘长按：盘必须留在**那块屏**里。
    /// 拿窗自己的缩放或只认主屏矩形来算都会跳回主屏（主屏那支给出上界 1556——正是用户看到"星环跑掉"的数）。
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
