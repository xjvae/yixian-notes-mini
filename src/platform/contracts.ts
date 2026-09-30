// 跨语言契约 — 前端唯一镜像。Rust 侧的 serde 字段名必须与这里逐字一致，
// 改任何一边都要同时改另一边并跑 `npm run test`（契约用例钉着）。
//
// 设计决定：**Row 与 Entity 是同一个类型**（StickyNote）——旧架构里"线上形状"与
// "运行时形状"分离是 localStorage 字符串键时代的遗产；新数据核里 store 直接持有
// 线上类型，省掉一整层双向映射。时间戳由 Rust 权威生成，写入侧（StickyInput）不携带。

export type StickyContentType = "text" | "todo" | "reminder" | "timeline";

export type ReminderRepeat = "none" | "daily" | "weekly";

/** 贴边侧。细丝贴的是工作区边缘（不压任务栏），不是屏幕边缘 */
export type DockEdge = "left" | "right" | "top" | "bottom";

export const DOCK_EDGES: readonly DockEdge[] = ["left", "right", "top", "bottom"];

export function isDockEdge(value: unknown): value is DockEdge {
  return value === "left" || value === "right" || value === "top" || value === "bottom";
}

/** 清单条目。id 稳定：React key / 删中间行时焦点不跳行 */
export interface StickyItem {
  id: string;
  text: string;
  done: boolean;
}

/** 时间轴条目：这一类便签的正文（带时刻）。id 稳定供 React key */
export interface TimelineEntry {
  id: string;
  /** 时刻，epoch ms */
  at: number;
  text: string;
}

/** 便签完整形状（读返回 / store 内存态共用这一份） */
export interface StickyNote {
  id: string;
  title: string;
  body: string;
  contentType: StickyContentType;
  items: StickyItem[];
  /** 时间轴条目（timeline 类的正文）；其它类型恒为 [] */
  timeline: TimelineEntry[];
  tags: string[];
  theme: string;
  /** 窗口置顶（老用户口中"钉住"） */
  pinned: boolean;
  /** 是否作为浮窗常驻；deleted=1 时无意义 */
  floating: boolean;
  /** 收起成 62px 标题栏形态 */
  collapsed: boolean;
  /** 私密标记：标题/正文/条目进私密封套（私密层落地后生效） */
  private: boolean;
  groupId: string | null;
  /** 窗口几何，逻辑像素；null = 未摆过位（由开窗路径级联落点） */
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  /** 提醒（reminder 类）到期时刻，epoch ms */
  dueAt: number | null;
  doneAt: number | null;
  repeat: ReminderRepeat;
  /** 软删除标记；真删除在回收站"彻底删除" */
  deleted: boolean;
  deletedAt: number | null;
  /** 贴边吸附态：true 时窗体以 20px 细丝贴在 dockEdge 一侧 */
  docked: boolean;
  dockEdge: DockEdge | null;
  /** 由 Rust 写入侧权威生成（epoch ms），前端只读 */
  createdAt: number;
  updatedAt: number;
}

/** 写入侧：时间戳与删除时钟归 Rust，前端不许伪造 */
export type StickyInput = Omit<StickyNote, "createdAt" | "updatedAt" | "deletedAt">;

/** 首屏引导：一次 IPC 拿齐挂载前的全部数据 */
export interface Bootstrap {
  stickies: StickyNote[];
}

/** 主库变更广播。writer = 写者窗口 label，本窗据此跳过回灌 */
export interface DbChangedEvent {
  writer: string;
  kind: "sticky" | "group";
}

/** 检索命中。正文供摘要展示，私密便签不进检索（见 Rust 侧 search.rs） */
export interface SearchHit {
  id: string;
  title: string;
  body: string;
  contentType: StickyContentType;
  theme: string;
}

/** 当前显示器工作区（物理像素；前端按自身缩放系数转逻辑像素） */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 事件名常量：拼错是编译错误 */
export const DB_CHANGED = "db:changed";

/** 窗口注入的全局名（factory.rs 的初始化脚本写入）——跨语言契约 */
export const STICKY_ID_GLOBAL = "__STICKY_ID__";
