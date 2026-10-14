// 钩子回调的策略 — "这一发输入管不管、管完吞不吞"的判定，全是纯函数（不 unsafe、不读全局、不分配）。
//
// 为什么单独一个文件：这些早退条件的**顺序就是行为**——把任务栏那一格挪到状态机后面，
// 任务栏右键就被吞掉、上下文菜单弹不出来；把 move 也算进吞，按住拖动时指针冻在原地。
// 而这类错在真机上只表现为"有时候怪"，在 unsafe 那一层测不出来。
// `win_hook.rs` 从此只负责读 Win32 的事实与执行判定结果，不再判任何东西。


use windows::Win32::UI::WindowsAndMessaging::{
    LLMHF_INJECTED, WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP,
};

use super::state::{Event, Phase};

/// 判定要看的事实，全部由 unsafe 那一层读好再传进来：policy 自己不读全局，
/// 于是"钩子读到的世界"与"策略看到的世界"是同一份，不会各读一次读出两个结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    /// 回调链的 ncode < 0：系统要求原样交给下一个钩子
    pub chained: bool,
    /// 正在退出
    pub shutting_down: bool,
    /// 这一发是**我们自己**注入出去的，再管就是自反馈
    pub injected: bool,
    /// 落点在任务栏/托盘那一片
    pub over_taskbar: bool,
    /// 星环此刻在屏上（只有这时盘外左键才谈得上"收环"）
    pub ring_present: bool,
    /// 落点在盘里（点格子那一下不该收环）
    pub in_ring: bool,
    /// 引导教程正指着盘讲（期间盘外左键也不收环）
    pub guide_holds_ring: bool,
    /// 设置里那条暂停
    pub paused: bool,
    /// 前台程序在白名单里：右键整个归它
    pub whitelisted: bool,
}

/// 交还给系统的理由。分这么细是因为那排计数器要按原因分账，也为了用例里能说出**为什么**放行
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    /// 与本功能无关的消息
    NotOurs,
    Chained,
    ShuttingDown,
    /// 自己注入的补偿事件
    Injected,
    /// 任务栏/托盘：那上面的右键归系统
    Taskbar,
    /// 暂停或白名单：整个手势这条不接
    NotTakingOver,
    /// 盘外那一下左键：环收了，输入本身交还系统
    Dismissed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass(Pass),
    /// 喂给状态机（吞不吞由 `swallows` 说）
    Feed(Event),
}

/// 这一发是不是我们自己注入出去的
pub fn is_injected(flags: u32) -> bool {
    flags & LLMHF_INJECTED != 0
}

/// 消息号 + 落点 + 事实 → 该怎么办。消息号取法与原来一致：`wparam.0 as u32`
pub fn classify(msg: u32, x: i32, y: i32, f: &Facts) -> Verdict {
    if f.chained {
        return Verdict::Pass(Pass::Chained);
    }
    if f.shutting_down {
        return Verdict::Pass(Pass::ShuttingDown);
    }
    if f.injected {
        return Verdict::Pass(Pass::Injected);
    }
    let is_down = msg == WM_RBUTTONDOWN;
    let is_up = msg == WM_RBUTTONUP;
    let is_move = msg == WM_MOUSEMOVE;
    // 盘驻留期间的左键也要进来，否则 Dismissed 那一支永远走不到（只有盘外那一下才收环）
    let may_dismiss = msg == WM_LBUTTONDOWN && f.ring_present;
    if !is_down && !is_up && !is_move && !may_dismiss {
        return Verdict::Pass(Pass::NotOurs);
    }
    // 任务栏那一整片豁免排在状态机**之前**：不豁免就得走"吞 down + 注入一对"那条贵路
    if is_down && f.over_taskbar {
        return Verdict::Pass(Pass::Taskbar);
    }
    if may_dismiss {
        return if !f.in_ring && !f.guide_holds_ring {
            Verdict::Pass(Pass::Dismissed)
        } else {
            Verdict::Pass(Pass::NotOurs)
        };
    }
    // 新手势的准入只在 down 那一刻判（采样线程的结论已经是算好的原子量）
    if is_down && (f.paused || f.whitelisted) {
        return Verdict::Pass(Pass::NotTakingOver);
    }
    Verdict::Feed(if is_down {
        Event::RightDown { x, y }
    } else if is_up {
        Event::RightUp
    } else {
        Event::Move { x, y }
    })
}

/// 这一发要不要吞掉。**move 一条都不吞**：吞移动 = 按住时指针冻住，而转透传那一下应用正等
/// 位移跟上。down 只在真起手（→Pressed）时吞；up 在 Pressed/Armed 里吞——短按要换成注入的
/// 补偿、长按要出盘，两种都不该让应用收到抬手。
pub fn swallows(pre: Phase, post: Phase, event: &Event) -> bool {
    match event {
        Event::RightDown { .. } => post == Phase::Pressed,
        Event::RightUp => matches!(pre, Phase::Pressed | Phase::Armed),
        _ => false,
    }
}

/// 尖刺分账用的消息种类：0 移动 / 1 右键按下 / 2 右键抬手 / 3 其它。
/// 它是 `CB_SPIKE` 那排计数器的下标，所以**必须永远落在 0..=3**
pub fn spike_kind(msg: u32) -> usize {
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

#[cfg(test)]
mod tests {
    use super::Pass::*;
    use super::Verdict::Feed;
    use super::*;
    use windows::Win32::Foundation::WPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_LBUTTONUP, WM_RBUTTONUP};

    /// 一整套"什么都不豁免"的事实，用例只改它关心的那一格
    fn facts() -> Facts {
        Facts {
            chained: false,
            shutting_down: false,
            injected: false,
            over_taskbar: false,
            ring_present: false,
            in_ring: false,
            guide_holds_ring: false,
            paused: false,
            whitelisted: false,
        }
    }

    fn verdict(msg: u32, f: &Facts) -> Verdict {
        classify(msg, 100, 200, f)
    }

    #[test]
    fn 三类前置事实先于一切判定() {
        let mut f = facts();
        f.chained = true;
        assert_eq!(verdict(WM_RBUTTONDOWN, &f), Verdict::Pass(Chained));
        f.chained = false;
        f.shutting_down = true;
        assert_eq!(verdict(WM_RBUTTONDOWN, &f), Verdict::Pass(ShuttingDown));
        f.shutting_down = false;
        f.injected = true;
        // 自己注入的那一对必须原样还给系统，否则一次注入能把自己喂回状态机转圈
        assert_eq!(verdict(WM_RBUTTONUP, &f), Verdict::Pass(Injected));
    }

    #[test]
    fn 只认那四种消息其余一律不管() {
        let f = facts();
        assert_eq!(verdict(WM_KEYDOWN, &f), Verdict::Pass(NotOurs));
        assert_eq!(verdict(WM_LBUTTONUP, &f), Verdict::Pass(NotOurs));
        assert_eq!(
            verdict(WM_MOUSEMOVE, &f),
            Feed(Event::Move { x: 100, y: 200 })
        );
        assert_eq!(
            verdict(WM_RBUTTONUP, &f),
            Feed(Event::RightUp),
            "抬手与按下同一条路，吞不吞由 `swallows` 说"
        );
    }

    /// 钉住顺序：任务栏那一格一旦被挪到状态机后面，任务栏右键就会被吞、上下文菜单弹不出来
    #[test]
    fn 任务栏右键整个让给系统() {
        let mut f = facts();
        f.over_taskbar = true;
        assert_eq!(verdict(WM_RBUTTONDOWN, &f), Verdict::Pass(Taskbar));
        assert_eq!(
            verdict(WM_RBUTTONUP, &f),
            Feed(Event::RightUp),
            "豁免只判按下那一下：抬手还得让状态机收尾，不然手势永远挂在半路"
        );
        // 落点在任务栏而消息是移动：本来就不该进豁免那一格
        assert!(matches!(verdict(WM_MOUSEMOVE, &f), Feed(Event::Move { .. })));
    }

    #[test]
    fn 盘外左键收环_盘内与引导期都不收() {
        let mut f = facts();
        // 盘不在屏上：左键与本功能无关
        assert_eq!(verdict(WM_LBUTTONDOWN, &f), Verdict::Pass(NotOurs));
        f.ring_present = true;
        assert_eq!(verdict(WM_LBUTTONDOWN, &f), Verdict::Pass(Dismissed), "盘外那一下收环");
        f.in_ring = true;
        assert_eq!(
            verdict(WM_LBUTTONDOWN, &f),
            Verdict::Pass(NotOurs),
            "点盘里那一下归前端，钩子不许收环"
        );
        f.in_ring = false;
        f.guide_holds_ring = true;
        assert_eq!(
            verdict(WM_LBUTTONDOWN, &f),
            Verdict::Pass(NotOurs),
            "引导教程指着盘讲时，点「下一步」不该把盘收掉"
        );
    }

    #[test]
    fn 暂停与白名单只挡新手势() {
        for mut f in [
            {
                let mut f = facts();
                f.paused = true;
                f
            },
            {
                let mut f = facts();
                f.whitelisted = true;
                f
            },
        ] {
            assert_eq!(verdict(WM_RBUTTONDOWN, &f), Verdict::Pass(NotTakingOver));
            assert_eq!(
                verdict(WM_RBUTTONUP, &f),
                Feed(Event::RightUp),
                "已经在打的那一手必须收得干净：{f:?}"
            );
            assert!(matches!(verdict(WM_MOUSEMOVE, &f), Feed(Event::Move { .. })));
            f.ring_present = true;
            assert_eq!(
                verdict(WM_LBUTTONDOWN, &f),
                Verdict::Pass(Dismissed),
                "暂停不该顺手把『点盘外收环』也停掉"
            );
        }
    }

    #[test]
    fn 吞只吞右键那条移动一条不吞() {
        use super::Phase::{Armed, Idle, Passing, Pressed};
        let down = Event::RightDown { x: 1, y: 2 };
        // 真起手才吞：Idle→Pressed 吞，Idle→Idle（白名单之类）不吞
        assert!(swallows(Idle, Pressed, &down));
        assert!(!swallows(Idle, Idle, &down));
        // 抬手：按下态与待出盘都吞（短按换补偿、长按出盘，两种都不该让应用收到抬手）
        assert!(swallows(Pressed, Idle, &Event::RightUp));
        assert!(swallows(Armed, Idle, &Event::RightUp));
        assert!(!swallows(Idle, Idle, &Event::RightUp), "没起手过的抬手归应用");
        // 拖拽转透传之后的那一发抬手：pre 是 Passing → 不吞，让应用收到完整的一次右键
        assert!(!swallows(Passing, Idle, &Event::RightUp));
        // 移动永远不吞：吞了按住拖动时指针就冻住
        for pre in [Idle, Pressed, Armed, Passing] {
            for post in [Idle, Pressed, Armed, Passing] {
                assert!(!swallows(pre, post, &Event::Move { x: 5, y: 5 }));
            }
        }
    }

    #[test]
    fn 尖刺分账的下标永远落在四格内() {
        for msg in [
            WM_MOUSEMOVE,
            WM_RBUTTONDOWN,
            WM_RBUTTONUP,
            WM_KEYDOWN,
            WM_LBUTTONDOWN,
            0xFFFF_FFFF,
        ] {
            assert!((0..=3).contains(&spike_kind(msg)), "{msg} 会越界");
        }
        assert_eq!(spike_kind(WM_MOUSEMOVE), 0);
        assert_eq!(spike_kind(WM_RBUTTONDOWN), 1);
        assert_eq!(spike_kind(WM_RBUTTONUP), 2);
        assert_eq!(spike_kind(WM_KEYDOWN), 3);
    }

    #[test]
    fn 注入标记认那一位() {
        assert!(is_injected(LLMHF_INJECTED));
        assert!(!is_injected(0));
        assert!(!is_injected(LLMHF_INJECTED - 1), "差一位不算");
    }

    fn _unused(_: WPARAM) {}
}
