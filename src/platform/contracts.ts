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
  /** 侧边色块签上的自定义图标 key（注册表在 data/note-icons.ts）；null = 用类型推出来的那个 */
  icon: string | null;
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
  /**
   * 随内容自动长高，**三态**：null = 没表过态，跟全局那个开关（settings 的
   * `sticky.auto_size`）走；true / false = 这张强制自动 / 强制固定。
   * 压成布尔就分不开"跟全局走"与"我就是要固定"——那是这个模式唯一的全局出口。
   * 开着自动时**不往 width/height 写**，手拉的固定值原样躺在行里，关掉那一刻回得去。
   */
  autoSize: boolean | null;
  /** 由 Rust 写入侧权威生成（epoch ms），前端只读 */
  createdAt: number;
  updatedAt: number;
}

/** 写入侧：时间戳与删除时钟归 Rust，前端不许伪造 */
export type StickyInput = Omit<StickyNote, "createdAt" | "updatedAt" | "deletedAt">;

/**
 * 组合行（GroupRow 的镜像）。成员关系不住这里——`StickyNote.groupId` 是唯一住址，
 * 张数与"空组"全是算出来的。这行只有叫什么、什么色、开合、叠窗几何。
 */
export interface StickyGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
  /** 这一叠贴在边上（20px 细丝）。与单窗那两列同意义（迁移 0003 / 0008） */
  docked: boolean;
  dockEdge: DockEdge | null;
  /** 叠窗几何，逻辑像素；null = 未摆过位（开窗路径级联落点） */
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 首屏引导：一次 IPC 拿齐挂载前的全部数据 */
export interface Bootstrap {
  stickies: StickyNote[];
}

/** 主库变更广播。writer = 写者窗口 label，本窗据此跳过回灌；
 * kind: "setting" = 设置项变了（scheme 等各自监听重读），payload 不带值 */
export interface DbChangedEvent {
  writer: string;
  kind: "sticky" | "group" | "setting";
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

/** 私密便签锁在 private.json 里的真身。其余字段（几何/主题/标记）留在主库明文 */
export interface SealedText {
  title: string;
  body: string;
  items: StickyItem[];
  timeline: TimelineEntry[];
  tags: string[];
}

/** 私密层状态：configured = 盘上有封套；unlocked = 会话密钥在内存里 */
export interface PrivateStatus {
  configured: boolean;
  unlocked: boolean;
}

/**
 * 全局快捷键当前生效绑定。key 空串 = 显式停用。
 * `bound` = 系统有没有真的收下这个键；false 表示**按下去什么都不发生**
 * （被别的程序占着），界面要把它和"已停用"分开说。
 */
export interface HotkeyBinding {
  action: string;
  key: string;
  bound: boolean;
}

/**
 * 一张图存进去之后的元数据（media_save 的返回）。
 * 正文里那句 `![…](media://id)` 只用到 id，宽高是给渲染层按比例占位的。
 */
export interface MediaMeta {
  id: string;
  noteId: string;
  mime: string;
  width: number;
  height: number;
  /** true = 库里这一行是密文（私密便签的图，未解锁读不出来） */
  enc: boolean;
}

/** 一张图的字节（media_get 的返回；命令本身可以是 null = 库里没这行） */
export interface MediaBytes {
  mime: string;
  dataBase64: string;
}

/**
 * 桌面上一扇浮窗的矩形（**物理**像素，与 moved 事件同一套坐标，拿来就能比）。
 * 拖拽进组的命中判定用：系统拖着窗走的时候前端收不到 pointermove，
 * "我压在谁身上"只能自己算，别人那份矩形就得一次拿全。
 */
export interface FloatFrame {
  label: string;
  kind: "sticky" | "stack";
  /** 单窗 = 便签 id，叠窗 = 组 id */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 右键劫持运行态。foreground = 最近采样的前台进程基名；null = 读不到（提权程序等） */
export interface HookStatus {
  paused: boolean;
  holdMs: number;
  whitelist: string[];
  /** 长按引导期的充电弧。关掉 = 长按过程中零反馈，松手直接出盘 */
  charging: boolean;
  foreground: string | null;
}

/** 事件名常量：拼错是编译错误 */
export const DB_CHANGED = "db:changed";
export const PRIVATE_CHANGED = "store:private-changed";
/**
 * 开机启动翻了（托盘那一条勾也会发它）。负载就是新的实际状态。
 * 事实来源是 Windows 注册表，不是库：这条只是"去重读一遍"的通知。
 */
export const AUTOSTART_CHANGED = "app:autostart-changed";
/** 让某扇叠窗翻到指定那张（点搜索结果 / 归组 / 回收站恢复；窗已在了才用得上） */
export const STICKY_REVEAL = "sticky:reveal";

/** "就是这一张"：纸边闪一圈（提醒卡点开来用的，窗本来就开着时唯一的可见回应） */
export const STICKY_PING = "sticky:ping";

/** 闪光落点。广播给所有窗，握着这张便签的那扇自己认领 */
export interface StickyPingEvent {
  stickyId: string;
}

/** 叠窗落点。广播给所有窗，叠窗按 groupId 认领（与 db:changed 同一口径） */
export interface StickyRevealEvent {
  groupId: string;
  stickyId: string;
}

/** 到点提醒换内容的事件名（提醒卡已经在那儿了，第二条来了就把它换成新的） */
export const REMINDER_SHOW = "reminder:show";

/**
 * 提醒卡上要写的东西（`windows/card.rs` 的 Card 镜像）。
 * `title`/`text` 在 Rust 那边已经按私密口径洗过——私密的换成中性文案，
 * 所以这里**不许**再拿它去查那张便签（一查就把私密内容画到了一张不锁的卡上）。
 */
export interface ReminderCardPayload {
  title: string;
  text: string;
  stickyId: string;
  groupId: string | null;
  /** 那张便签的纸色键（`data/theme.ts` 里那一个）。卡跟着它画 */
  theme: string;
}

/** 窗口注入的全局名（factory.rs 的初始化脚本写入）——跨语言契约 */
export const STICKY_ID_GLOBAL = "__STICKY_ID__";
