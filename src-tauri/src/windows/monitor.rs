// monitor — 显示器工作区的唯一一份 Win32 取值。
//
// 工作区 = 屏幕减掉任务栏的那块。贴边细丝要贴它（任务栏底下不留东西），
// 星环要落在光标处也得靠它把自己整块夹回屏内。两处都要读同一个事实，
// 所以 SAFETY 块只留这一份，别处调它。

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
    /// 把 (w, h) 尺寸的块整块夹进本工作区，返回左上角。块比工作区还大时贴左上角
    /// （clamp 的 min>max 会直接 panic，所以先取 max）
    pub fn clamp_block(&self, point: (i64, i64), width: i64, height: i64) -> (i64, i64) {
        let max_x = (self.x + self.width - width).max(self.x);
        let max_y = (self.y + self.height - height).max(self.y);
        (point.0.clamp(self.x, max_x), point.1.clamp(self.y, max_y))
    }
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
    use super::WorkArea;

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
}
