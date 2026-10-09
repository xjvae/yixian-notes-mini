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
//   · 按下时起**两个**计时：Hold（阈值）与 Charge（引导期 = 阈值 - 留尾）。
//     充电弧在引导期走完才亮，不是到阈值才亮，也不是按下即亮——见下；
//   · 按住到阈值只置 `Armed`，不出盘，也不再发任何东西——星环是松手那一瞬间出现的；
//   · 松手：Armed → 在**按下点**出盘并吞掉 up（不弹系统菜单，也不发 EmitUp——
//     盘接手时前端自己把弧下台，这里再发一条淡出等于让 90ms 定时器去收刚绽开的盘）；
//     未 armed（短按）→ 吞掉 up、注入一对完整的 right down/up、让弧淡出；
//   · 按住期间位移 > 6px（资源管理器框选等，Pressed 与 Armed 都算）→ 停表、补发一个
//     right down 让应用进入按下态、让弧淡出，然后整体转成透传，后续事件原样放行；
//   · 出盘坐标取**按下点快照**，不跟最新点：跟手会让"按住等盘"与"拖出去框选"
//     抢同一个位移信号（旧实现按下点出盘 + 拖出即逃逸，是真机定稿）；
//   · **move 一条都不吞**，只吞右键的 down 与 up：吞掉手势期间的移动 = 按住时指针
//     冻住，而框选那条路又必须让位移抵达应用（它刚收到补发的 down）；
//   · 自己注入的事件带 LLMHF_INJECTED，钩子层直接放行，防自反馈死循环。
//
// 为什么弧不早不晚要"贴阈值亮"：亮弧这条路要给 360×360 的顶层 webview 窗做
// "摆位 + show + 设穿透 + 一次 IPC"。按下即亮（旧项目试过固定 120ms）的结果是
// **整个右键都变慢，浏览器和桌面都一样**——"有意识地右键"的正常时长恰好落在
// 150~250ms 这一带，于是每一次右键都付一次上述开销，还正压在系统上下文菜单要
// 出现的那一瞬间。贴阈值亮之后：只有真在长按才碰窗口，普通右键一次都不碰。

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
    /// 引导期走完：星环窗**在按下点**亮起，前端画充电弧。
    /// 坐标在这里一起给：窗口那条路要在真正的按下点上摆位，晚一步读都可能是
    /// 已经被框选拖走的位置。
    EmitCharging { x: i32, y: i32 },
    /// 弧淡出：短按松手 / 拖拽逃逸。**长按松手不发这条**（那条是盘接手，不是取消）
    EmitUp,
    /// 在按下点开出整盘（物理像素）
    EmitOpen { x: i32, y: i32 },
    /// 仅作定长数组的填充位，**不会**出现在 as_slice() 的前缀里
    Nop,
}

/// 动作表：定长内联，不带堆分配。
///
/// 这里不许用 Vec——`step()` 是在 WH_MOUSE_LL 回调里跑的，那一段坐在**全系统**
/// 输入链上（超时预算默认 300ms），一次 malloc 就是一次数不够用的卡顿。
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
    /// 按下点：判拖拽位移的基准，也是出盘的唯一坐标（见文件头"按下点快照"那条）
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
            // Pressed / Armed 共用同一条逃逸：拖出阈值就是框选，不是长按
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
                // 只有 EmitOpen：弧由 `ring:open` 下台（前端 setCharging("off")），
                // 这里补一条 EmitUp 等于给刚绽开的盘挂上 90ms 后收窗的定时器
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
        // 引导期（早于阈值）就该亮弧，而且带着按下点：窗要在那里亮
        assert!(matches!(
            machine.step(Event::ChargeFired).as_slice(),
            &[Action::EmitCharging { x: 10, y: 10 }]
        ));
        assert_eq!(machine.phase, Phase::Pressed);
        // 阈值到点只置 Armed，不再发任何东西——弧已经在扫了
        assert!(machine.step(Event::TimerFired).as_slice().is_empty());
        assert_eq!(machine.phase, Phase::Armed);
        // 到阈值后松手：只出一条 EmitOpen。不发 EmitUp——那是"取消"，
        // 而这里是弧交棒给盘，发了就等于给刚绽开的盘挂上 90ms 后收窗的定时器
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
        // Pressed 与 Armed 两个阶段拖出去都算框选：旧实现两条都判，
        // 少了 Armed 那条就变成"按住超过阈值再拖出去框选"只能出一张错位的盘
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
