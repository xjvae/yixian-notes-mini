// dock — 贴边槽位注册表。同一侧贴了几张细丝，每张发一个序号，
// 前端按序号错开摆放（26px 一档），细丝才不会叠成一团。
// 窗口销毁时由 lib.rs 的 Destroyed 事件清账（按 label 剥前缀拿 id）。
//
// 槽位必须**幂等**：滑出/收回/开机恢复每一次都会重新 register 一遍。若按"同边有
// 几张"现算，同一条边上的重复登记就会把槽位一路抬高（0→1→2…）并且两张能撞到
// 同一个号——真机表现就是细丝沿着边往上爬、或者两张叠在一起。
// 所以这里另存一份登记顺序：已在册的保持原位，只有换边才排到新边末尾。

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct DockState {
    /// id → 贴的那条边
    edges: HashMap<String, String>,
    /// 登记顺序（同边内的序号由它算）
    order: Vec<String>,
}

#[derive(Default)]
pub struct DockLayout(Mutex<DockState>);

impl DockLayout {
    /// 登记/更新一条细丝并返回同边槽位号（从 0 起）。同边重复登记 = 保留原槽位。
    pub fn register(&self, id: &str, edge: &str) -> i64 {
        let mut state = self.lock();
        if state.edges.get(id).is_none_or(|current| current != edge) {
            // 新登记或换边：排到队尾（换边要先把旧位置腾出来）
            state.order.retain(|existing| existing != id);
            state.order.push(id.to_string());
        }
        state.edges.insert(id.to_string(), edge.to_string());
        Self::slot_of(&state, id, edge)
    }

    pub fn unregister(&self, id: &str) {
        self.remove(id);
    }

    pub fn remove(&self, id: &str) {
        let mut state = self.lock();
        state.edges.remove(id);
        state.order.retain(|existing| existing != id);
    }

    /// 该 id 在这条边上的序号 = 队列里排在它前面、且同边的张数
    fn slot_of(state: &DockState, id: &str, edge: &str) -> i64 {
        let mut slot = 0;
        for entry in &state.order {
            if entry == id {
                break;
            }
            if state.edges.get(entry).is_some_and(|entry_edge| entry_edge == edge) {
                slot += 1;
            }
        }
        slot
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DockState> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同侧槽位递增_异侧互不影响_注销后复用() {
        let layout = DockLayout::default();
        assert_eq!(layout.register("a", "left"), 0);
        assert_eq!(layout.register("b", "left"), 1);
        assert_eq!(layout.register("c", "right"), 0, "异侧从 0 起");
        assert_eq!(layout.register("a", "right"), 1, "a 改边后 right 有两个");
        layout.unregister("b");
        assert_eq!(layout.register("d", "left"), 0, "左边只剩 d");
    }

    /// 真机踩过的：滑出/收回每次都重新登记，槽位必须纹丝不动
    #[test]
    fn 同边重复登记保留原槽位() {
        let layout = DockLayout::default();
        assert_eq!(layout.register("a", "left"), 0);
        assert_eq!(layout.register("b", "left"), 1);
        assert_eq!(layout.register("a", "left"), 0, "a 滑出再收回不许爬到 1");
        assert_eq!(layout.register("a", "left"), 0, "再来一次还是 0");
        assert_eq!(layout.register("b", "left"), 1, "b 的位置也不许被顶下去");
    }

    #[test]
    fn 换边走到队尾_腾出的槽位被前面顶上() {
        let layout = DockLayout::default();
        layout.register("a", "left");
        layout.register("b", "left");
        layout.register("c", "left");
        assert_eq!(layout.register("a", "right"), 0, "a 换边，right 只有它");
        assert_eq!(layout.register("b", "left"), 0, "left 少了 a，b 顶到 0");
        assert_eq!(layout.register("c", "left"), 1);
    }

    #[test]
    fn remove_即清账() {
        let layout = DockLayout::default();
        layout.register("a", "top");
        layout.remove("a");
        assert_eq!(layout.register("b", "top"), 0);
    }
}
