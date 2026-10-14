// input.state — 右键手势状态机的**纯**转移函数：(状态, 事件) → (新状态, 动作表)。
// 单独成文件：真转移跑在 WH_MOUSE_LL 回调里（禁锁/禁日志/≤1ms，没法直接测），抽纯后用例能穷尽分支；
// 时间不在机器里——阈值到点由钩子层发 TimerFired，机器只认事件。
// 按下即吞 down（应用还没进按下态，后面才有干净的补偿空间；放 down 吞 up 会卡死按钮态），同时起 Hold+Charge 两计时；
// 到阈值只置 Armed 不出盘，星环在松手那一瞬于**按下点快照**出现；短按松手补注入完整点击并让弧淡出；
// 位移超阈转透传（停表、补发 down、后续放行）；长按松手只发 EmitOpen——那是盘接手，不是取消。

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    RightDown { x: i32, y: i32 },
    RightUp,
    Move { x: i32, y: i32 },
    /// 引导期到点（`charge_lead_ms`）：该亮充电弧了
    ChargeFired,
    /// 阈值到点（hold_ms）：手势成立，等松手
    TimerFired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 起 Hold 计时（阈值）
    StartHoldTimer,
    /// 起 Charge 计时（引导期，早于 Hold）
    StartChargeTimer,
    /// 两个计时一起停（松手 / 转透传）
    StopTimers,
    /// 短按补偿：注入一对完整的 right down/up，系统菜单照常弹
    InjectFullClick,
    /// 拖拽转透传：补发一个 right down，让应用进入它错过的按下态
    InjectPress,
    /// 引导期走完：星环窗**在按下点**亮起，前端画充电弧。坐标随事件一起给——
    /// 晚一步读可能已是被框选拖走的位置。
    EmitCharging { x: i32, y: i32 },
    /// 弧淡出：短按松手 / 拖拽逃逸。**长按松手不发这条**（那条是盘接手，不是取消）
    EmitUp,
    /// 在按下点开出整盘（物理像素）
    EmitOpen { x: i32, y: i32 },
    /// 仅作定长数组的填充位，**不会**出现在 as_slice() 的前缀里
    Nop,
}

/// 动作表：定长内联，不带堆分配——`step()` 跑在 WH_MOUSE_LL 回调里，那一段坐在**全系统**
/// 输入链上（超时预算 300ms），一次 malloc 就是一次数不够用的卡顿。
#[derive(Clone, Copy)]
pub struct Actions {
    items: [Action; Self::MAX],
    len: usize,
}

impl Actions {
    const MAX: usize = 4;

    fn new() -> Self {
        Self {
            items: [Action::Nop; Self::MAX],
            len: 0,
        }
    }

    fn push(&mut self, action: Action) {
        if self.len < Self::MAX {
            self.items[self.len] = action;
            self.len += 1;
        }
    }

    /// 已填入的前缀。钩子层与用例都只认这个视图
    pub fn as_slice(&self) -> &[Action] {
        &self.items[..self.len]
    }
}

impl FromIterator<Action> for Actions {
    fn from_iter<I: IntoIterator<Item = Action>>(iter: I) -> Self {
        let mut out = Self::new();
        for action in iter {
            out.push(action);
        }
        out
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Machine {
    pub phase: Phase,
    /// 按下点：判拖拽位移的基准，也是出盘的唯一坐标
    press: (i32, i32),
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            press: (0, 0),
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
        }
    }

    /// 步进一步：返回动作表由钩子层执行（SetTimer/KillTimer/SendInput/开盘）。
    pub fn step(&mut self, event: Event) -> Actions {
        let mut actions = Actions::new();
        match (self.phase, event) {
            (Phase::Idle, Event::RightDown { x, y }) => {
                self.phase = Phase::Pressed;
                self.press = (x, y);
                actions.push(Action::StartHoldTimer);
                actions.push(Action::StartChargeTimer);
            }
            // 引导期走完、还没到阈值：亮弧，手势状态不变（弧是"再按一会就出盘"的预告）
            (Phase::Pressed, Event::ChargeFired) => {
                let (x, y) = self.press;
                actions.push(Action::EmitCharging { x, y });
            }
            // 阈值到点：只是"手势成立了"。弧早在引导期就亮了，这里再发一次等于让前端重扫
            (Phase::Pressed, Event::TimerFired) => self.phase = Phase::Armed,
            (Phase::Pressed, Event::Move { x, y })
            | (Phase::Armed, Event::Move { x, y })
                if distance(self.press, (x, y)) > DRAG_THRESHOLD_PX =>
            {
                self.phase = Phase::Passing;
                actions.push(Action::StopTimers);
                actions.push(Action::InjectPress);
                actions.push(Action::EmitUp);
            }
            (Phase::Pressed, Event::RightUp) => {
                self.phase = Phase::Idle;
                actions.push(Action::StopTimers);
                actions.push(Action::InjectFullClick);
                // 弧可能已经亮了（阈值前 150ms 松手）：让它淡出。没亮过时前端自己忽略
                actions.push(Action::EmitUp);
            }
            // 透传期间的抬手：状态必须回 Idle，否则下一次手势从头就废在 Passing 里
            (Phase::Passing, Event::RightUp) => self.phase = Phase::Idle,
            (Phase::Armed, Event::RightUp) => {
                self.phase = Phase::Idle;
                let (x, y) = self.press;
                // 只发 EmitOpen：补一条 EmitUp 等于给刚绽开的盘挂上 90ms 后收窗的定时器
                actions.push(Action::EmitOpen { x, y });
            }
            // 其余组合都是"不该来的事件"：原地不动、不产动作（防御性口径）
            _ => {}
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down_at(x: i32, y: i32) -> Actions {
        Machine::default().step(Event::RightDown { x, y })
    }

    #[test]
    fn 按下吞事件并起两个计时() {
        let actions = down_at(100, 90);
        assert!(matches!(
            actions.as_slice(),
            &[Action::StartHoldTimer, Action::StartChargeTimer]
        ));
    }

    #[test]
    fn 短按补偿完整点击_停表并让弧淡出() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 0, y: 0 });
        let actions = machine.step(Event::RightUp);
        assert!(matches!(
            actions.as_slice(),
            &[
                Action::StopTimers,
                Action::InjectFullClick,
                Action::EmitUp
            ]
        ));
        assert_eq!(machine.phase, Phase::Idle);
    }

    #[test]
    fn 引导期亮弧_阈值静置_松手只在按下点出盘() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 10, y: 10 });
        // 亮弧必须带着按下点：窗要在那里亮
        assert!(matches!(
            machine.step(Event::ChargeFired).as_slice(),
            &[Action::EmitCharging { x: 10, y: 10 }]
        ));
        assert_eq!(machine.phase, Phase::Pressed);
        assert!(machine.step(Event::TimerFired).as_slice().is_empty());
        assert_eq!(machine.phase, Phase::Armed);
        let actions = machine.step(Event::RightUp);
        assert!(matches!(
            actions.as_slice(),
            &[Action::EmitOpen { x: 10, y: 10 }]
        ));
        assert!(!actions.as_slice().contains(&Action::EmitUp));
        assert_eq!(machine.phase, Phase::Idle);
    }

    #[test]
    fn 出盘用按下点而不是最新点() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 100, y: 200 });
        machine.step(Event::TimerFired);
        // 阈值内的小抖动（手抖）不改出盘位置
        assert!(machine.step(Event::Move { x: 103, y: 204 }).as_slice().is_empty());
        assert!(matches!(
            machine.step(Event::RightUp).as_slice(),
            &[Action::EmitOpen { x: 100, y: 200 }]
        ));
    }

    #[test]
    fn 拖拽超阈值转透传_补发按下并让弧淡出() {
        // Pressed 与 Armed 拖出去都算框选——少了 Armed 那条，按住后拖框会出一张错位的盘
        for start in [Phase::Pressed, Phase::Armed] {
            let mut machine = Machine::default();
            machine.step(Event::RightDown { x: 0, y: 0 });
            if start == Phase::Armed {
                machine.step(Event::TimerFired);
            }
            let actions = machine.step(Event::Move { x: 40, y: 0 });
            assert!(
                matches!(
                    actions.as_slice(),
                    &[Action::StopTimers, Action::InjectPress, Action::EmitUp]
                ),
                "{start:?} 拖出去的分支动作不对：{:?}",
                actions.as_slice()
            );
            assert_eq!(machine.phase, Phase::Passing);
            // 透传期间的后续事件（包括 up）不再产生任何动作
            assert!(machine.step(Event::Move { x: 80, y: 0 }).as_slice().is_empty());
            assert!(machine.step(Event::RightUp).as_slice().is_empty());
            assert_eq!(machine.phase, Phase::Idle);
        }
    }

    #[test]
    fn 阈值内的小位移不算拖拽() {
        for start in [Phase::Pressed, Phase::Armed] {
            let mut machine = Machine::default();
            machine.step(Event::RightDown { x: 0, y: 0 });
            if start == Phase::Armed {
                machine.step(Event::TimerFired);
            }
            assert!(machine.step(Event::Move { x: 4, y: 3 }).as_slice().is_empty()); // 恰 5px
            assert_eq!(machine.phase, start, "5px 是手抖，不该把手势判丢");
        }
    }

    #[test]
    fn idle_时收到杂事件原地不动() {
        let mut machine = Machine::default();
        assert!(machine.step(Event::RightUp).as_slice().is_empty());
        assert!(machine.step(Event::TimerFired).as_slice().is_empty());
        assert!(machine.step(Event::ChargeFired).as_slice().is_empty());
        assert!(machine.step(Event::Move { x: 1, y: 1 }).as_slice().is_empty());
        assert_eq!(machine.phase, Phase::Idle);
    }

    #[test]
    fn 已亮过弧就不再重复亮() {
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 0, y: 0 });
        machine.step(Event::ChargeFired);
        machine.step(Event::TimerFired);
        // Armed 之后再收到 ChargeFired（理论不该来）必须静默，否则前端重播扫弧
        assert!(machine.step(Event::ChargeFired).as_slice().is_empty());
    }

    #[test]
    fn 最长分支也不超定长表() {
        // 定长 4 的余量：目前最长的一步是"短按松手"三条
        assert_eq!(down_at(0, 0).as_slice().len(), 2);
        let mut machine = Machine::default();
        machine.step(Event::RightDown { x: 5, y: 5 });
        machine.step(Event::ChargeFired);
        assert_eq!(machine.step(Event::RightUp).as_slice().len(), 3);
        let mut armed = Machine::default();
        armed.step(Event::RightDown { x: 5, y: 5 });
        armed.step(Event::TimerFired);
        assert_eq!(armed.step(Event::RightUp).as_slice().len(), 1);
    }
}
