// dock — 贴边槽位注册表。同一侧贴了几张细丝，每张发一个序号，
// 前端按序号错开摆放（26px 一档），细丝才不会叠成一团。
// 窗口销毁时由 lib.rs 的 Destroyed 事件清账（按 label 剥前缀拿 id）。

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct DockLayout(Mutex<HashMap<String, String>>);

impl DockLayout {
    /// 注册并返回槽位号（同侧第几张，从 0 起）。重复注册同 id = 改边重排
    pub fn register(&self, id: &str, edge: &str) -> i64 {
        let mut slots = self.lock();
        let slot = slots.values().filter(|existing| existing.as_str() == edge).count() as i64;
        slots.insert(id.to_string(), edge.to_string());
        slot
    }

    pub fn unregister(&self, id: &str) {
        self.lock().remove(id);
    }

    pub fn remove(&self, id: &str) {
        self.lock().remove(id);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
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

    #[test]
    fn remove_即清账() {
        let layout = DockLayout::default();
        layout.register("a", "top");
        layout.remove("a");
        assert_eq!(layout.register("b", "top"), 0);
    }
}
