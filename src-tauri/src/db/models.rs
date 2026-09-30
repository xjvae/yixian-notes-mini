// 模型 — 前端 contracts.ts 的 Rust 镜像。字段名逐字对齐（serde rename_all camelCase），
// 改任何一边必须同时改另一边：前端契约用例 + 这边的单测共同钉住。
//
// 读返回（StickyRow）与写入侧（StickyInput）是两个类型：时间戳与删除时钟由
// Rust 权威生成，前端写路径不携带、也不许伪造。

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StickyItem {
    pub id: String,
    pub text: String,
    pub done: bool,
}

/// 时间轴条目：这一类便签的正文（带时刻）。id 稳定供 React key。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TimelineEntry {
    pub id: String,
    /// 时刻，epoch ms
    pub at: i64,
    pub text: String,
}

/// 读返回：完整行
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StickyRow {
    pub id: String,
    pub title: String,
    pub body: String,
    pub content_type: String,
    pub items: Vec<StickyItem>,
    pub timeline: Vec<TimelineEntry>,
    pub tags: Vec<String>,
    pub theme: String,
    pub pinned: bool,
    pub floating: bool,
    pub collapsed: bool,
    #[serde(rename = "private")]
    pub is_private: bool,
    pub group_id: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub due_at: Option<i64>,
    pub done_at: Option<i64>,
    pub repeat: String,
    pub deleted: bool,
    pub deleted_at: Option<i64>,
    pub docked: bool,
    pub dock_edge: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 写入侧：无 created_at / updated_at / deleted_at（Rust 盖时钟）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StickyInput {
    pub id: String,
    pub title: String,
    pub body: String,
    pub content_type: String,
    pub items: Vec<StickyItem>,
    pub timeline: Vec<TimelineEntry>,
    pub tags: Vec<String>,
    pub theme: String,
    pub pinned: bool,
    pub floating: bool,
    pub collapsed: bool,
    #[serde(rename = "private")]
    pub is_private: bool,
    pub group_id: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub due_at: Option<i64>,
    pub done_at: Option<i64>,
    pub repeat: String,
    pub deleted: bool,
    pub docked: bool,
    pub dock_edge: Option<String>,
}
