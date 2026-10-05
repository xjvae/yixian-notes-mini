// input.state — 右键手势状态机的**纯**转移函数。
//
// 为什么单独一个文件：真实的转移函数跑在 WH_MOUSE_LL 回调里，那里禁止加锁、
// 禁止日志、禁止跨进程调用（任何能向别的线程发消息的 Win32 调用都会把全系统
// 输入链卡住），而且必须 ≤1ms。要测它就得插上鼠标、按住 450ms——没法测。
// 把判定抽成 `(状态, 事件) → (新状态, 动作表)` 之后，用例就能穷尽所有分支。
// 时间不在机器里：阈值到了由钩子层 SetTimer 发 `TimerFired`，机器只认事件。
//
// 语义：
//   · 按下即刻吞掉 WM_RBUTTONDOWN（目标应用还没进入"右键按下"态，后面才有
//     干净的补偿空间；"放行 down + 吞 up"会让应用的按钮态卡死）；
//   · 按住到阈值只置 `Armed`，不出盘——星环是松手那一瞬间出现的；
//   · 松手：Armed → 出盘并吞掉 up（不弹系统菜单）；未 armed（短按）→ 吞掉 up
//     并注入一对完整的 right down/up，目标应用的上下文菜单照常弹，用户零感知；
//   · 按住期间位移 > 6px（资源管理器框选等）→ 补发一个 right down 让应用进入
//     按下态，然后整体转成透传，后续事件原样放行；
//   · 自己注入的事件带 LLMHF_INJECTED，钩子层直接放行，防自反馈死循环。

/// 判定为"拖拽"的位移阈值。钩子坐标是物理像素，6px 在 200% 屏上只有 3 个逻辑
/// 像素，仍然远小于一次有意的框选拖拽。
pub const DRAG_THRESHOLD_PX: f64 = 6.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    /// 什么都没发生
    Idle = 0,
    /// 右键按下、还没到阈值
    Pressed = 1,
    /// 按住已到阈值，等松手
    Armed = 2,
    /// 判定为拖拽，整体透传（等按钮起来回 Idle）
    Passing = 3,
}

pub enum Event {
    RightDown { x: i32, y: i32 },
    RightUp,
    Move { x: i32, y: i32 },
    /// 钩子层 SetTimer 到点（hold_ms 阈值）
    TimerFired,
}

pub enum Action {
    StartTimer,
    KillTimer,
    /// 短按补偿：注入一对完整的 right down/up，系统菜单照常弹
    InjectFullClick,
    /// 拖拽转透传：补发一个 right down，让应用进入它错过的按下态
    InjectPress,
    /// 到阈值：星环窗先在按下点亮起，前端画充电弧（§5.4）
    EmitCharging,
    /// 长按松手：弧 90ms 淡出，随后在这一点开出整盘
    EmitUp,
    EmitOpen { x: i32, y: i32 },
}

#[derive(Debug, Clone, Copy)]
pub struct Machine {
    pub phase: Phase,
    /// 按下点（判定拖拽位移的基准）
    press: (i32, i32),
    /// 最新点（出盘位置：Armed 期间跟着鼠标走，松手在哪就出在哪）
    point: (i32, i32),
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            press: (0, 0),
            point: (0, 0),
        }
    }
}

fn distance(a: (i32, i32), b: (i32, i32)) -> f64 {
    let dx = (a.0 - b.0) as f64;
    let dy = (a.1 - b.1) as f64;
    (dx * dx + dy * dy).sqrt()
}

impl Machine {
    /// 常量构造（win_hook 的静态互斥体在 const 语境初始化）
    pub const fn new() -> Self {
        Self {
            phase: Phase::Idle,
            press: (0, 0),
            point: (0, 0),
        }
    }

    /// 步进一步：返回动作表由钩子层执行（SetTimer/KillTimer/SendInput/开盘）。
    pub fn step(&mut self, event: Event) -> Vec<Action> {
        match (self.phase, event) {
            (Phase::Idle, Event::RightDown { x, y }) => {
                self.phase = Phase::Pressed;
                self.press = (x, y);
                self.point = (x, y);
                vec![Action::StartTimer]
            }
            (Phase::Pressed, Event::TimerFired) => {
                self.phase = Phase::Armed;
                vec![Action::EmitCharging]
            }
            (Phase::Pressed, Event::Move { x, y }) => {
                self.point = (x, y);
                if distance(self.press, (x, y)) > DRAG_THRESHOLD_PX {
                    self.phase = Phase::Passing;
                    vec![Action::KillTimer, Action::InjectPress]
                } else {
                    vec![]
                }
            }
            (Phase::Pressed, Event::RightUp) => {
                self.phase = Phase::Idle;
                vec![Action::KillTimer, Action::InjectFullClick]
            }
            (Phase::Armed, Event::Move { x, y }) => {
                self.point = (x, y);
                vec![]
            }
            (Phase::Armed, Event::RightUp) => {
                self.phase = Phase::Idle;
                vec![Action::EmitUp, Action::EmitOpen {
                    x: self.point.0,
                    y: self.point.1,
                }]
            }
            (Phase::Armed, Event::TimerFired) => vec![],
            (Phase::Passing, Event::RightUp) => {
                self.phase = Phase::Idle;
                vec![]
            }
            // 其余组合都是"不该来的事件"：原地不动、不产动作（防御性口径）
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down_at(x: i32, y: i32) -> Vec<Action> {
        Machine::default().step(Event::RightDown { x, y })
    }

    #[test]
    fn 按下吞事件并起计时() {
        let actions = down_at(100, 90);
        assert!(matches!(actions.as_slice(), &[Action::StartTimer]));
    }

    #[test]
    fn 短按补偿完整点击() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 0, y: 0 });
        let actions = machine.step(Event::RightUp);
        assert!(matches!(
            actions.as_slice(),
            &[Action::KillTimer, Action::InjectFullClick]
        ));
        assert_eq!(machine.phase, Phase::Idle);
    }

    #[test]
    fn 到阈值先亮充电弧_松手先淡出再出盘() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 10, y: 10 });
        let actions = machine.step(Event::TimerFired);
        assert!(matches!(actions.as_slice(), &[Action::EmitCharging]));
        assert_eq!(machine.phase, Phase::Armed);
        machine.step(Event::Move { x: 30, y: 40 });
        let actions = machine.step(Event::RightUp);
        assert!(matches!(
            actions.as_slice(),
            &[Action::EmitUp, Action::EmitOpen { x: 30, y: 40 }]
        ));
    }

    #[test]
    fn 拖拽超阈值转透传并补发按下() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 0, y: 0 });
        let actions = machine.step(Event::Move { x: 40, y: 0 });
        assert!(matches!(
            actions.as_slice(),
            &[Action::KillTimer, Action::InjectPress]
        ));
        assert_eq!(machine.phase, Phase::Passing);
        // 透传期间的后续事件（包括 up）不再产生任何动作
        assert!(machine.step(Event::Move { x: 80, y: 0 }).is_empty());
        assert!(machine.step(Event::RightUp).is_empty());
        assert_eq!(machine.phase, Phase::Idle);
    }

    #[test]
    fn 阈值内的小位移不算拖拽() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 0, y: 0 });
        assert!(machine.step(Event::Move { x: 4, y: 3 }).is_empty()); // 恰 5px
        assert_eq!(machine.phase, Phase::Pressed);
    }

    #[test]
    fn idle_时收到杂事件原地不动() {
        let mut machine = Machine::default();
        assert!(machine.step(Event::RightUp).is_empty());
        assert!(machine.step(Event::TimerFired).is_empty());
        assert!(machine.step(Event::Move { x: 1, y: 1 }).is_empty());
        assert_eq!(machine.phase, Phase::Idle);
    }
}
