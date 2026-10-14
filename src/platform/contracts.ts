// 跨语言契约 — 前端唯一镜像。Rust 侧的 serde 字段名必须与这里逐字一致，改任何一边都要同时改另一边。
//
// 设计决定：**Row 与 Entity 是同一个类型**（StickyNote）——数据核里 store 直接持有
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
   * 随内容自动长高，**三态**：null = 跟全局开关（`sticky.auto_size`）走；true/false = 这张强制。
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
 * 张数与"空组"全是算出来的；这行只有名字、颜色、开合、叠窗几何。
 */
export interface StickyGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
  /** 这一叠贴在边上（20px 细丝），与单窗那两列同意义 */
  docked: boolean;
  dockEdge: DockEdge | null;
  /** 叠窗几何，口径同 StickyNote 的 x/y/width/height */
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Bootstrap {
  stickies: StickyNote[];
}

/** 主库变更广播。writer = 写者窗口 label，本窗据此跳过回灌；
 * kind: "setting" = 设置项变了（scheme 等各自监听重读），payload 不带值；
 * note: 写者刚落地的那一张（只有单实体那条路带），收方据此只合那一张、不整库重拉 */
export interface DbChangedEvent {
  writer: string;
  kind: "sticky" | "group" | "setting";
  note?: StickyNote;
}

/** 检索命中。清单类与时间轴类的正文住在 items / timeline 上而不是 body 上，摘要要从它们取；
 * 私密便签不进检索（见 Rust 侧 search.rs） */
export interface SearchHit {
  id: string;
  title: string;
  body: string;
  contentType: StickyContentType;
  theme: string;
  items: StickyItem[];
  timeline: TimelineEntry[];
}

/** 一次检索的结果。`privateSkipped` 是这次**根本没参与**的私密便签张数——
 * 不说这句，空结果会被读成"我那张便签丢了" */
export interface SearchOutcome {
  hits: SearchHit[];
  privateSkipped: number;
}

/** 当前显示器工作区（物理像素；前端按自身缩放系数转逻辑像素） */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 私密层状态。**没有"整层开着"这一格**（迁移 0012）：`revealed` 是此刻已揭开的那几张的
 * id，前端蒙不蒙每一张都问这一份。
 */
export interface PrivateStatus {
  /** 盘上有合法封套 = 设过私密密码 */
  configured: boolean;
  /** 那份读不出来（坏了 / 版本不认识）。与 configured=false 同时出现的意思是"有东西但打不开"，
   *  此刻往私密上写一律停手 */
  damaged: boolean;
  revealed: string[];
}

/** 口令窗这一次的意图：为哪张、干什么。与 Rust `windows::unlock::UnlockIntent` 同形状 */
export interface UnlockIntent {
  noteId: string;
  purpose: "reveal" | "delete";
}

/**
 * 一份整库快照 = `backups\mini-<label>.db` 加同名私密封套副本。`label` 是
 * `20261012-094703` 形态（同秒再加 `-2`）；恢复命令拿它拼文件名，只认这个形状。
 */
export interface Snapshot {
  label: string;
  bytes: number;
  /** 文件改动时间（毫秒） */
  createdAt: number;
  /** 带不带配套封套；不带 = 恢复后私密真身仍是当前那份，界面要说 */
  hasEnvelope: boolean;
}

/** 一键恢复的结果。`safetyLabel` = 恢复**前**那一瞬被存成的那一份（选错了能回这里） */
export interface RestoreReport {
  restored: string;
  safetyLabel: string;
  envelopeRestored: boolean;
  /** 不阻断恢复、但必须让人看见的话 */
  warning: string | null;
}

/**
 * 一张便签的某一版历史。存的是**被换掉之前**的内容形状（见 `migrations/0009_revisions.sql`），
 * 列表那一行读作"回到这一刻之前"。私密便签不记版本，列表恒空。
 */
export interface RevisionMeta {
  seq: number;
  createdAt: number;
  title: string;
  contentType: StickyContentType;
  /** 那一版的头几十个字（清单/时间轴取第一条），给列表当辨认用 */
  preview: string;
}

/**
 * 全局快捷键当前生效绑定。key 空串 = 显式停用。`bound` = 系统真的收下了这个键；
 * false = 按下去什么都不发生（被别的程序占着），界面要把它和"已停用"分开说。
 */
export interface HotkeyBinding {
  action: string;
  key: string;
  bound: boolean;
}

/** media_save 的返回。正文引用只用到 id；宽高给渲染层占位 */
export interface MediaMeta {
  id: string;
  noteId: string;
  mime: string;
  width: number;
  height: number;
  /** true = 库里这一行是密文（私密便签的图，未解锁读不出来） */
  enc: boolean;
}

/** media_get 的返回（命令本身可为 null = 库里没这行） */
export interface MediaBytes {
  mime: string;
  dataBase64: string;
}

/**
 * 桌面浮窗矩形（**物理**像素，与 moved 事件同一套坐标）。拖拽进组命中判定用：
 * 系统拖着窗走时前端收不到 pointermove，只能自己算——别人那份矩形要一次拿全。
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
/** 口令窗被关掉（解锁成功收尾也算），负载是它的 label。挂起的删除动作靠这条收口（`src/window/private-gate.ts`） */
export const UNLOCK_DISMISSED = "unlock:dismissed";
/**
 * 口令窗还开着而**意图变了**（人点了另一张的蒙版）：窗是复用的，挂载时读到的 noteId
 * 已旧，收到这条要重读 `unlock_intent`。
 */
export const UNLOCK_INTENT = "unlock:intent";
/**
 * **这一发口令验过了**，负载是当时的意图。删除那条路只验身份不开卡——"窗关了"≠"口令过了"。
 */
export const UNLOCK_VERIFIED = "unlock:verified";
/** 开机启动翻了（托盘那条勾也会发），负载是新实际状态。只是"去重读一遍"的通知，事实源在注册表 */
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

/** 到点提醒来了新内容（卡已在场就把它换成新的） */
export const REMINDER_SHOW = "reminder:show";

/**
 * 提醒卡内容（`windows/card.rs` 的 Card 镜像）。`title`/`text` 在 Rust 那边已按私密口径
 * 洗成中性文案——**不许**再拿它去查那张便签（一查就把私密内容画到不锁的卡上）。
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
