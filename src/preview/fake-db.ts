// 预览台的假数据核 — 命令语义**逐条照抄 Rust**（commands/*.rs + db/query/*.rs），抄的是行为不是代码。
// 语义改了这边没跟上、预览台就在骗人，所以每条都标了出处：改 Rust 侧对应行为时这里必须一起改。
// 假核不承担窗口系统的真实动作：窗口类命令产出一条 WindowAction，由宿主落成 iframe。

import type {
  FloatFrame,
  SearchOutcome,
  StickyGroup,
  StickyInput,
  StickyNote,
} from "@/platform/contracts";

/** 与 db/query/search.rs 的 SEARCH_LIMIT 同值 */
const SEARCH_LIMIT = 50;
/** 与 db/query/reminder.rs 的 SNOOZE_MS 同值（卡上那颗「稍后再响」推多久） */
const SNOOZE_MS = 10 * 60 * 1000;
/** 与 data/crypto.rs 的 MIN/MAX_PASSWORD_CHARS 同口径（8..=1024 字符） */
const PASSWORD_MIN_CHARS = 8;
const PASSWORD_MAX_CHARS = 1024;

export class PreviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
  }
  /** Rust 的 AppError 折到前端就是这个形状（{code,message} 的裸对象，不是 Error） */
  toWire(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

export type WindowAction =
  | { kind: "open-sticky"; id: string }
  | { kind: "close-sticky"; id: string }
  /** focus = 该落在哪一张（点结果/归组带来的那一张）；开机恢复那类没有目标就是 null */
  | { kind: "open-stack"; gid: string; focus: string | null }
  | { kind: "close-stack"; gid: string }
  | { kind: "open-panel"; label: string }
  | { kind: "close-panel"; label: string }
  | { kind: "note"; text: string };

/** 后端广播：逐条对着 Rust 的 emit 抄 */
export type Broadcast =
  | {
      event: "db:changed";
      payload: {
        writer: string;
        kind: "sticky" | "group" | "setting";
        note?: StickyNote;
      };
    }
  | { event: "store:private-changed"; payload: string }
  /** `unlock.rs::close` 那一声：口令窗没了。挂起的删除动作靠它收口，见 private-gate.ts */
  | { event: "unlock:dismissed"; payload: string }
  /** unlock.rs::VERIFIED_EVENT：口令过了，负载是当时意图（哪张、干什么）；删除只验身份不开张，所以"窗关了"与"口令过了"分两条信号。 */
  | {
      event: "unlock:verified";
      payload: { noteId: string; purpose: "reveal" | "delete" };
    }
  /** `unlock.rs::open` 复用已存在的窗时那一声：意图变了，窗要重读 */
  | { event: "unlock:intent"; payload: null }
  /** `ring.rs::reveal` 那一声。引导第一步就听它：他真把盘按出来了才翻页 */
  | { event: "ring:open"; payload: null };

export interface PreviewArgs extends Record<string, unknown> {
  id?: string;
  gid?: string;
  sourceId?: string;
  targetId?: string;
  hard?: boolean;
  includeDeleted?: boolean;
  input?: StickyInput;
  groupId?: string | null;
  query?: string;
  key?: string;
  value?: string;
  /** snapshot_restore 的目标快照名 */
  label?: string;
  /** sticky_revert 的目标版本号 */
  seq?: number;
  password?: string;
  /** private_rekey 的第二道：新口令（旧的要验身份才重裹得了那些键行） */
  newPassword?: string;
  /** private_reveal / private_verify 之外的窗口意图：为哪张、干什么 */
  purpose?: "reveal" | "delete";
  data?: string;
  edge?: string;
  action?: string;
  paused?: boolean;
  holdMs?: number;
  charging?: boolean;
  whitelist?: string[];
  /** media_set_private 用（media_save 的参数嵌在 input 里，见那个 case 的注释） */
  noteId?: string;
  private?: boolean;
}

/** 与 input/mod.rs 同值：默认 450ms，150..=2000 夹取 */
const HOLD_MS_DEFAULT = 450;
const HOLD_MS_MIN = 150;
const HOLD_MS_MAX = 2000;
/** 与 input/allowlist.rs 同值：单条 64 字符、整表 32 条 */
const WHITELIST_MAX_LEN = 64;
const WHITELIST_MAX_ENTRIES = 32;
/** 与 hotkeys.rs DEFAULT_BINDINGS 同表同序（改一边同步另一边）；这条由 hotkey-table.test.ts 直接读 src-tauri/src/hotkeys.rs 比对钉着，漂了就测试红——编译期围栏。 */
const DEFAULT_BINDINGS: readonly [string, string][] = [
  ["sticky", "Alt+1"],
  ["search", "Alt+2"],
  ["trash", "Alt+3"],
  ["settings", "Alt+4"],
  ["ring", "Alt+Space"],
  ["hide-all", "Alt+6"],
  ["show-all", "Alt+7"],
];
/** 设置表里存改键覆盖的键（与 hotkeys.rs::HOTKEYS_SETTING_KEY 同名） */
const HOTKEYS_SETTING_KEY = "hotkeys";
/** 预览台里"被别的程序占着"的键位（Alt+Space，照本机实况）；留着它，"没绑上"的告警在预览台才看得见——预览台没有 RegisterHotKey，不模拟就永远绿的。 */
const EXTERNALLY_HELD = new Set(["Alt+Space"]);
const HOLD_MS_SETTING_KEY = "ring.trigger.hold_ms";
const WHITELIST_SETTING_KEY = "hook.whitelist";
const CHARGING_SETTING_KEY = "ring.charging";
/** 与 `windows/guide.rs` 的 GUIDE_SEEN_KEY 同值：引导教程看过没有 */
const GUIDE_SEEN_KEY = "guide.seen";
/** 与 `windows/guide.rs` 的 GUIDE_DEMO_NOTE_KEY 同值：引导自己造的那张演示便签 */
const GUIDE_DEMO_NOTE_KEY = "guide.demo_note";
/** 浮窗 label 的前缀，与 `float.rs` 的 FLOAT_PREFIX 同值（引导拿它当摆位的认据） */
const STICKY_LABEL_PREFIX = "sticky-";

/** 与 db/query/media.rs 同值（改一边要同步另一边）：单张 5 MB、一张便签 20 张 */
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_MAX_PER_NOTE = 20;
const MEDIA_ALLOWED_MIME: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
];

/** media 表的一行。字节在预览台里就是 base64 字符串（Rust 那边是 BLOB 列） */
interface MediaRecord {
  id: string;
  noteId: string;
  mime: string;
  dataBase64: string;
  /** 预览台不做密码学，这个标记只用来演"解不开"那一屏：私密图 = 锁着就读不到 */
  enc: boolean;
  width: number;
  height: number;
  createdAt: number;
}

/** 一版历史的内容字段——同 Rust revision.rs::Content：**只有内容，没有摆位**（回滚历史不该把便签搬走）。 */
type RevisionContent = Pick<
  StickyNote,
  | "title"
  | "body"
  | "contentType"
  | "items"
  | "timeline"
  | "tags"
  | "theme"
  | "icon"
  | "dueAt"
  | "doneAt"
  | "repeat"
>;

interface RevisionRow {
  seq: number;
  createdAt: number;
  content: RevisionContent;
}

/** 私密便签那六个敏感字段（private_note.rs::SealedContent）；其余字段（主题/摆位/到期…）留在 stickies 行明文，类型也照留——蒙版得知道窗是什么形状。 */
type SealedFields = Pick<
  StickyNote,
  "title" | "body" | "contentType" | "items" | "timeline" | "tags"
>;

/** 那两条密文表的内存形状：`private_content` 一张一条 + `private_revision` 一版一条 */
interface SealedEntry {
  content: SealedFields;
  revisions: { seq: number; createdAt: number; content: SealedFields }[];
}

/** 三个阈值与 Rust 同值（冷却 60 秒/每张 50 条/留 7 天）；明文与私密切文表共用（revision.rs 唯一出处）。 */
const REVISION_COALESCE_MS = 60_000;
const REVISION_KEEP = 50;
const REVISION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const REVISION_PREVIEW_CHARS = 60;

function contentOf(row: StickyNote): RevisionContent {
  return {
    title: row.title,
    body: row.body,
    contentType: row.contentType,
    items: row.items,
    timeline: row.timeline,
    tags: row.tags,
    theme: row.theme,
    icon: row.icon,
    dueAt: row.dueAt,
    doneAt: row.doneAt,
    repeat: row.repeat,
  };
}

/** 列表行摘要：正文按类型分岔（同 Rust）；参数收到那四个字段，明文与密文表共用（revision::preview_of_parts）。 */
function previewOf(
  content: Pick<RevisionContent, "contentType" | "body" | "items" | "timeline">,
): string {
  const source =
    content.contentType === "todo"
      ? (content.items[0]?.text ?? "")
      : content.contentType === "timeline"
        ? (content.timeline[0]?.text ?? "")
        : content.body;
  const flat = source.replace(/\n/g, " ").trim();
  return flat.length <= REVISION_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, REVISION_PREVIEW_CHARS)}…`;
}

/** 与 input/allowlist.rs::normalize 同规则：取路径末段（`\` 与 `/` 都算分隔）、转小写、去结尾 `.exe`；空/超 64/带控制字符→不进名单。`*` 只在结尾当通配，照存原文（比对在钩子侧）。 */
function normalizeWhitelistEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || [...trimmed].length > WHITELIST_MAX_LEN) return null;
  if ([...trimmed].some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const stripped = base
    .trim()
    .toLocaleLowerCase()
    .replace(/\.exe$/, "")
    .trim();
  return stripped === "" ? null : stripped;
}

function parseWhitelist(raws: readonly string[]): string[] {
  const seen: string[] = [];
  for (const raw of raws) {
    if (seen.length >= WHITELIST_MAX_ENTRIES) break;
    const name = normalizeWhitelistEntry(raw);
    if (name !== null && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

const MODIFIERS = new Set([
  "ctrl",
  "control",
  "alt",
  "shift",
  "super",
  "meta",
  "cmd",
  "win",
]);

/** 形状判据（近似）：至少一个修饰键打头，末尾恰好一个主键，之间用 + 连接 */
function looksLikeAccelerator(key: string): boolean {
  const tokens = key.split("+").map((token) => token.trim());
  if (tokens.length < 2 || tokens.some((token) => token === "")) return false;
  const main = tokens[tokens.length - 1];
  const modifiers = tokens.slice(0, -1);
  return (
    modifiers.every((token) => MODIFIERS.has(token.toLowerCase())) &&
    !MODIFIERS.has(main.toLowerCase())
  );
}

function nowMs(): number {
  return Date.now();
}

function seedGroup(id: string, name: string, createdAt: number): StickyGroup {
  return {
    id,
    name,
    color: null,
    collapsed: false,
    docked: false,
    dockEdge: null,
    x: null,
    y: null,
    width: null,
    height: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/** 种子数据：四类各一张 + 空正文 + 在组 + 私密(占位) + 回收站一张 + 一叠三张，刻意把边界铺满省得手点。 */
/** 与 Rust group::normalize_name 同口径：去首尾空白、空→「未命名组合」、按字符截到 40（不一致则预览改出的名字到真机会变样）。 */
function normalizeGroupName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "未命名组合";
  return [...trimmed].slice(0, 40).join("");
}

function seed(): { stickies: Map<string, StickyNote>; groups: Map<string, StickyGroup> } {
  const base = Date.now();
  const blank = {
    title: "",
    body: "",
    contentType: "text" as const,
    items: [],
    timeline: [],
    tags: [],
    theme: "yellow",
    icon: null,
    pinned: true,
    floating: true,
    collapsed: false,
    private: false,
    groupId: null,
    x: null,
    y: null,
    width: null,
    height: null,
    dueAt: null,
    doneAt: null,
    repeat: "none" as const,
    deleted: false,
    deletedAt: null,
    docked: false,
    dockEdge: null,
    autoSize: null,
    createdAt: base,
    updatedAt: base - 1000,
  };
  const make = (id: string, patch: Partial<StickyNote>): StickyNote => ({
    ...blank,
    id,
    ...patch,
  });
  const stickies = [
    make("s-text", {
      title: "普通便签",
      body: "改动会去抖 250ms 落库；关掉这扇窗前先 flush。",
      tags: ["样例"],
      theme: "yellow",
      x: 40,
      y: 40,
      width: 320,
      height: 300,
    }),
    make("s-todo", {
      title: "清单",
      contentType: "todo",
      theme: "green",
      items: [
        { id: "i1", text: "勾选框", done: true },
        { id: "i2", text: "增删行", done: false },
        { id: "i3", text: "条目 id 稳定", done: false },
      ],
      tags: ["M1"],
      x: 400,
      y: 40,
      width: 320,
      height: 300,
    }),
    make("s-reminder", {
      title: "提醒（已过期）",
      contentType: "reminder",
      theme: "red",
      body: "到期分档角标走 due.ts：过期/今天用强调色。",
      dueAt: base - 86_400_000,
      x: 760,
      y: 40,
      width: 320,
      height: 300,
    }),
    make("s-timeline", {
      title: "时间轴",
      contentType: "timeline",
      theme: "blue",
      timeline: [
        { id: "t1", at: base - 7_200_000, text: "9:40 到工位" },
        { id: "t2", at: base - 1_800_000, text: "11:10 交评审" },
      ],
      x: 40,
      y: 380,
      width: 320,
      height: 300,
    }),
    make("s-bar", { title: "收起态", collapsed: true, theme: "purple", x: 400, y: 380 }),
    make("s-long", {
      title: "顶到字数上限的正文",
      body: "一二三四五六七八九〇".repeat(40),
      theme: "orange",
      x: 760,
      y: 380,
      width: 320,
      height: 300,
    }),
    make("s-private", {
      title: "",
      body: "",
      private: true,
      theme: "pink",
      tags: [],
      x: 40,
      y: 720,
      width: 320,
      height: 300,
    }),
    make("s-trashed", {
      title: "回收站里的",
      deleted: true,
      deletedAt: base - 3_600_000,
      floating: false,
      theme: "gray",
    }),
    // 一叠三张在叠窗（一叠一窗）这一组上验；成员序 updated_at DESC，这里排个确定序：g3 在最前（一进叠窗看到它）
    make("s-g1", {
      title: "叠里的第一张",
      groupId: "g-demo",
      theme: "yellow",
      floating: true,
      updatedAt: base - 3,
    }),
    make("s-g2", {
      title: "叠里的第二张",
      groupId: "g-demo",
      theme: "green",
      // 种子给一张带自定义图标的：预览台一开就能看见色块签上"自定义优先"生效了
      icon: "coffee",
      floating: true,
      updatedAt: base - 2,
    }),
    make("s-g3", {
      title: "叠里的第三张",
      groupId: "g-demo",
      theme: "blue",
      contentType: "todo",
      items: [{ id: "i1", text: "翻页认 id 不认下标", done: false }],
      floating: true,
      updatedAt: base - 1,
    }),
  ];
  const map = new Map<string, StickyNote>();
  for (const row of stickies) map.set(row.id, row);
  return {
    stickies: map,
    groups: new Map([["g-demo", seedGroup("g-demo", "演示组合", base - 5000)]]),
  };
}

export class FakeDb {
  private stickies = new Map<string, StickyNote>();
  private groups = new Map<string, StickyGroup>();
  private settings = new Map<string, string>();
  /** 那两条密文表的内存形状：noteId → 真身 + 版本串。真机是 private_content/private_revision 两张表，预览台只做行为不做密码学，存明文形状（占位与合并判据照 Rust）；播种只有 reset() 一处，不留会漂移的第二份。 */
  private sealedRows = new Map<string, SealedEntry>();
  private password: string | null = null;
  /** **已揭开的那几张**（迁移 0012 private_keys + 内存里那张的钥匙）；逐张模型没有 `unlocked` 这一格，一次口令只放一张进来、收回是一次全清。 */
  private revealed = new Set<string>();
  /** 旧形状那批：还停在"整层钥匙"下、没自己键行的张；预览台只用这格记"还没搬进自己的钥匙"，搬的时机是它第一次被揭开（与 Rust 同判据）。 */
  private legacyShelf = new Set<string>();
  /** 口令窗这一次的意图（照 unlock::IntentState）：为哪张、干什么。住状态不住 URL——那扇窗复用，点了另一张的蒙版意图会变而窗不会重建。 */
  private unlockIntent: { noteId: string; purpose: "reveal" | "delete" } | null = null;
  private dockEdges: Record<string, string> = {};
  private dockOrder: string[] = [];
  /** 右键劫持运行态（真机住 input/mod.rs 原子量）：paused **刻意不落库**（重启即恢复劫持），阈值与白名单落库。 */
  private hookPaused = false;
  private hookHoldMs = HOLD_MS_DEFAULT;
  /** 与 input/mod.rs 同默认：开。关掉是"长按过程零反馈" */
  private hookCharging = true;
  private hookWhitelist: string[] = [];
  /** 开机启动。真机住注册表 Run 键（库里没这项），预览台没注册表就存内存：默认关，同真机"键不在=没开"。 */
  private autostartOn = false;
  /** media 表（0005_media.sql）。id 形状照 support/id.rs::media()：m + 十六进制 */
  private media = new Map<string, MediaRecord>();
  private mediaSeq = 0;
  /** 假快照清单。真正换表在 Rust（snapshot.rs::swap_tables），假库不换内容——只够走设置窗那套「清单+两段确认+回显」；
   * 故意留一份 hasEnvelope:false，让"老快照没配套封套"那一支在预览台看得见。
   * Rust 那侧恢复前会验快照的表齐不齐（缺私密层那三张就整趟拒绝），这里**不模拟**——假快照没有真的 sqlite 文件可验。 */
  private snapshots: {
    label: string;
    bytes: number;
    createdAt: number;
    hasEnvelope: boolean;
  }[] = [];
  /** 假历史（内存版）。判据照 revision.rs 抄，见 recordRevision；真表在 SQLite（迁移 v9），这里要能点开看列表长什么样。 */
  private revisions = new Map<string, RevisionRow[]>();
  readonly actions: WindowAction[] = [];
  readonly log: string[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    const fresh = seed();
    this.stickies = fresh.stickies;
    this.groups = fresh.groups;
    this.settings = new Map([["scheme", "system"]]);
    this.sealedRows = new Map([
      [
        "s-private",
        {
          content: {
            title: "私密便签",
            body: "主库里这张只留占位：标题/正文/标签都在密文表里。",
            contentType: "text",
            items: [],
            timeline: [],
            tags: ["密"],
          },
          revisions: [],
        },
      ],
    ]);
    this.password = null;
    this.revealed = new Set();
    // 播种那几张是"已存进密文表"的形状，按旧形状算（没有键行），等各自第一次被揭开时当场搬进自己的钥匙
    this.legacyShelf = new Set(this.sealedRows.keys());
    this.media = new Map();
    this.mediaSeq = 0;
    this.revisions = new Map();
    this.snapshots = [
      {
        label: this.snapshotLabel(3600),
        bytes: 139264,
        createdAt: Date.now() - 3600_000,
        hasEnvelope: true,
      },
      {
        label: this.snapshotLabel(86400),
        bytes: 122880,
        createdAt: Date.now() - 86400_000,
        hasEnvelope: false,
      },
    ];
    // 种子图：正文里那句 media:// 引用得有真字节对着它。用 canvas 画而不是塞 base64 字面量——常量没人改得动，也演不出缩放重编码后长什么样
    this.seedMedia("s-text", "便签里的种子图", "#2f7d32");
    this.actions.length = 0;
    this.broadcasts.length = 0;
    this.log.length = 0;
  }

  /** 与 Rust `clock::timestamp_label` 同形状的本地时间戳（快照名就是它，恢复只认这个形状） */
  private snapshotLabel(offsetSec: number): string {
    const d = new Date(Date.now() - offsetSec * 1000);
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** 与 Rust revision::record 同判据：没变不占格、同一张 60 秒最多一档、每张留最新 50 条与 7 天、私密不记（那张表明文落盘）。 */
  private recordRevision(id: string, before: StickyNote, force: boolean): void {
    if (before.private) return;
    const list = this.revisions.get(id) ?? [];
    const newest = list[list.length - 1];
    const content = contentOf(before);
    const now = nowMs();
    if (newest !== undefined) {
      if (JSON.stringify(newest.content) === JSON.stringify(content)) return;
      if (!force && now - newest.createdAt < REVISION_COALESCE_MS) return;
    }
    list.push({ seq: (newest?.seq ?? 0) + 1, createdAt: now, content });
    const cutoff = now - REVISION_KEEP_MS;
    this.revisions.set(
      id,
      list.filter((row) => row.createdAt >= cutoff).slice(-REVISION_KEEP),
    );
  }

  private nextMediaId(): string {
    this.mediaSeq += 1;
    return `m${Date.now().toString(16)}${this.mediaSeq.toString(16)}`;
  }

  // ——— 私密层：占位与合并的判据，逐条照 `db/query/private_note.rs` 抄 ———

  /** 读侧合并（`private_note::merge`）：只并**揭开的那几张**，其余原样就是占位 */
  private mergeOf(row: StickyNote): StickyNote {
    if (!this.privateActive || !this.isOpen(row.id) || !row.private) return row;
    const entry = this.sealedRows.get(row.id);
    if (entry === undefined) return row;
    return { ...row, ...entry.content };
  }

  /** 这一张此刻开着吗 = 揭开了 **且** 已搬进自己的钥匙（有键行）。两条件在 Rust 是一件事（reveal 同时建键行+入内存），预览台分开记只为让"旧形状还停在整层钥匙下"在流水里看得见。 */
  private isOpen(id: string): boolean {
    return this.revealed.has(id) && !this.legacyShelf.has(id);
  }

  /** 这一拍手上那六个字段 */
  private sealedOf(row: StickyInput): SealedFields {
    return {
      title: row.title,
      body: row.body,
      contentType: row.contentType,
      items: row.items,
      timeline: row.timeline,
      tags: row.tags,
    };
  }

  /** 摊着字吗（`SealedContent::is_blank` 的反面） */
  private hasPlain(content: SealedFields): boolean {
    return (
      content.title !== "" ||
      content.body !== "" ||
      content.items.length > 0 ||
      content.timeline.length > 0 ||
      content.tags.length > 0
    );
  }

  /** 占位形状：六个字段里只留类型（`RowFields::blank`） */
  private blanked(content: SealedFields): SealedFields {
    return { ...content, title: "", body: "", items: [], timeline: [], tags: [] };
  }

  /** `private_note::plan` 那张表——判据解释在那侧注释，这里是同一份决定（直通/封/占位不动/拒/公布 五岔）；关键：问的是**这一张**开没开，不是"整层开没开"。 */
  private planFor(
    input: StickyInput,
    content: SealedFields,
  ):
    | { kind: "plain" }
    | { kind: "seal" }
    | { kind: "placeholders" }
    | { kind: "publish"; restore: SealedFields | null }
    | { kind: "refuse"; code: string; message: string } {
    if (!this.privateActive) return { kind: "plain" };
    const sealed = this.sealedRows.get(input.id);
    const hasPlain = this.hasPlain(content);
    const open = this.isOpen(input.id);
    if (input.private) {
      if (!open) {
        return hasPlain
          ? {
              kind: "refuse",
              code: "PRIVATE_LOCKED",
              message: "这张便签还没揭开：这一拍的改动留在在途里，等揭开之后落库",
            }
          : { kind: "placeholders" };
      }
      return hasPlain ? { kind: "seal" } : { kind: "placeholders" };
    }
    if (sealed === undefined) return { kind: "plain" };
    if (!open) {
      return {
        kind: "refuse",
        code: "PRIVATE_LOCKED",
        message: "这张便签还没揭开：真身读不出来，不能翻成公开",
      };
    }
    // 手上没字而表里有真身 → 那份得回进行里，空壳不算"翻回公开"
    const restore = !hasPlain && this.hasPlain(sealed.content) ? sealed.content : null;
    return { kind: "publish", restore };
  }

  /** 私密那一版进 sealedRows.revisions，判据同 recordRevision（一条不差），只是落在密文侧。空壳不配留版。 */
  private recordSealedRevision(id: string, before: SealedFields, force: boolean): void {
    if (!this.hasPlain(before)) return;
    const entry = this.sealedRows.get(id);
    if (entry === undefined) return;
    const list = entry.revisions;
    const newest = list[list.length - 1];
    const now = nowMs();
    if (newest !== undefined) {
      if (JSON.stringify(newest.content) === JSON.stringify(before)) return;
      if (!force && now - newest.createdAt < REVISION_COALESCE_MS) return;
    }
    list.push({ seq: (newest?.seq ?? 0) + 1, createdAt: now, content: before });
    const cutoff = now - REVISION_KEEP_MS;
    entry.revisions = list.filter((row) => row.createdAt >= cutoff).slice(-REVISION_KEEP);
  }

  /** 这一张的历史住在哪（revision.rs::shelf）：明文表、密文表，或哪儿都没有（私密层当时没启用、一版没记）。 */
  private revisionShelf(id: string): "plain" | "sealed" | "empty" {
    const row = this.stickies.get(id);
    if (row === undefined || !row.private) return "plain";
    return this.privateActive ? "sealed" : "empty";
  }

  /** 把一张的真身落进表里（被换掉之前那份先记成一版） */
  private sealNow(id: string, content: SealedFields): void {
    const previous = this.sealedRows.get(id);
    if (previous !== undefined) this.recordSealedRevision(id, previous.content, false);
    this.sealedRows.set(id, {
      content,
      revisions: previous?.revisions ?? [],
    });
  }

  /** `private_note::adopt`：行上还摊着字的私密便签封进表、行抹成占位（表里已有这张就以表里为准，行上的字是残骸照样抹）；定向改字段、**不续写 updatedAt**。收进来的算**旧形状**进 legacyShelf（Rust 那边封在整层 contentKey 下没键行），等每张第一次被揭开才搬进自己的钥匙——时机同 Rust，是"第一次有人输口令"那刻而非"整层解锁"（逐张模型没这说法）。 */
  private adoptSealed(): number {
    if (!this.privateActive) return 0;
    let sealed = 0;
    for (const row of this.stickies.values()) {
      if (!row.private) continue;
      const content = this.sealedOf(row);
      if (!this.hasPlain(content)) continue;
      const existing = this.sealedRows.get(row.id);
      if (existing === undefined) {
        this.sealedRows.set(row.id, { content, revisions: [] });
        this.legacyShelf.add(row.id);
        sealed += 1;
      }
      this.stickies.set(row.id, { ...row, ...this.blanked(content) });
    }
    return sealed;
  }

  /** 画一张 240×120 的色块图，并把引用挂到那张便签正文末尾 */
  private seedMedia(noteId: string, label: string, color: string): void {
    if (typeof document === "undefined") return; // node 里没有 canvas：整个跳过
    const row = this.stickies.get(noteId);
    if (row === undefined) return;
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect(14, 14, 212, 22);
    ctx.fillRect(14, 50, 96, 56);
    ctx.fillRect(124, 50, 102, 56);
    const dataBase64 = (canvas.toDataURL("image/png").split(",")[1] ?? "").trim();
    if (dataBase64 === "") return;
    const id = this.nextMediaId();
    this.media.set(id, {
      id,
      noteId,
      mime: "image/png",
      dataBase64,
      // 种子这刻私密层还没配置，按"直通"口径留明文（翻了私密标记才会变密文）
      enc: false,
      width: canvas.width,
      height: canvas.height,
      createdAt: nowMs(),
    });
    this.stickies.set(noteId, {
      ...row,
      body: `${row.body}\n![${label}](media://${id})`,
    });
  }

  /** 私密层是否"启用过"：没配置过时私密便签走明文直通（与 Rust `private_note::plan` 同口径） */
  get privateActive(): boolean {
    return this.password !== null;
  }

  /** 同 commands/entity.rs：单实体那条路（sticky_upsert）把刚落地的行一起带出去，
   *  别的窗据此只合那一张；说不清单个实体的改动不带 `note` */
  private emit(
    kind: "sticky" | "group" | "setting",
    writer: string,
    note?: StickyNote,
  ): void {
    this.broadcasts.push({ event: "db:changed", payload: { writer, kind, note } });
  }
  /** commands/private.rs 的 emit_changed：每条私密写命令后广播（private_lock 没有，照抄） */
  private emitPrivate(writer: string): void {
    this.broadcasts.push({ event: "store:private-changed", payload: writer });
  }
  /** windows::unlock::VERIFIED_EVENT：这一发口令过了，挂起的那一下由它落地 */
  private verified(noteId: string, purpose: "reveal" | "delete"): void {
    this.broadcasts.push({ event: "unlock:verified", payload: { noteId, purpose } });
  }
  readonly broadcasts: Broadcast[] = [];

  private note(text: string): void {
    this.log.unshift(text);
    this.log.length = Math.min(this.log.length, 80);
  }

  /** 库里记号里那些**还在**的演示便签 id（他自己删过就会留死记号，与 Rust 同一条对账） */
  private liveDemoIds(): string[] {
    const stored = this.settings.get(GUIDE_DEMO_NOTE_KEY) ?? "";
    return stored
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && this.stickies.has(s));
  }

  /** 把引导自己造的那几张硬删（连带它的图），并抹掉记号 */
  private dropDemoNotes(): void {
    const ids = this.liveDemoIds();
    for (const id of ids) {
      for (const [mediaId, record] of [...this.media.entries()]) {
        if (record.noteId === id) this.media.delete(mediaId);
      }
      this.stickies.delete(id);
      this.actions.push({ kind: "close-sticky", id });
    }
    if (ids.length > 0) {
      this.settings.set(GUIDE_DEMO_NOTE_KEY, "");
      this.note(`引导收尾：销毁 ${ids.length} 张演示便签（不进回收站）`);
      this.emit("sticky", "guide");
    }
  }

  /** 一张新便签的行（同 float.rs::default_input/demo_input 形状）：建它有两个入口（新建便签 + 引导演示），行形状只该有一份。 */
  private putStickyRow(id: string, title: string): void {
    const now = nowMs();
    this.stickies.set(id, {
      id,
      title,
      body: "",
      contentType: "text",
      items: [],
      timeline: [],
      tags: [],
      theme: "yellow",
      icon: null,
      pinned: true,
      floating: true,
      collapsed: false,
      private: false,
      groupId: null,
      x: null,
      y: null,
      width: null,
      height: null,
      dueAt: null,
      doneAt: null,
      repeat: "none",
      deleted: false,
      deletedAt: null,
      docked: false,
      dockEdge: null,
      autoSize: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** 与 db/query/sticky.rs::list 同序：updated_at DESC */
  private ordered(includeDeleted: boolean): StickyNote[] {
    const rows = [...this.stickies.values()];
    if (!includeDeleted)
      return rows.filter((row) => !row.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 与 query/group.rs::peek 的 `deleted = 0` 同口径：软删的行在并组这条路上算"已经不在了" */
  private liveRow(id: string): StickyNote | undefined {
    const row = this.stickies.get(id);
    return row === undefined || row.deleted ? undefined : row;
  }

  /** 与 query/group.rs::prune_empty 同义：没有任何未删成员的组行删掉 */
  private pruneEmptyGroups(): void {
    const live = new Set(
      [...this.stickies.values()]
        .filter((row) => !row.deleted && row.groupId !== null)
        .map((row) => row.groupId as string),
    );
    for (const gid of [...this.groups.keys()]) {
      if (!live.has(gid)) this.groups.delete(gid);
    }
  }

  /** 改键覆盖表（settings 的 hotkeys 键）。坏 JSON 或非字符串值按没配过算，与 Rust 同口径 */
  private hotkeyOverrides(): Record<string, string> {
    const raw = this.settings.get(HOTKEYS_SETTING_KEY);
    if (raw === undefined || raw === "") return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return {};
      const out: Record<string, string> = {};
      for (const [action, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[action] = value.trim();
      }
      return out;
    } catch {
      return {};
    }
  }

  /** 某个动作当前生效的键：覆盖表里有条目（含空串 = 显式停用）就用它，否则用默认 */
  private effectiveKey(action: string, overrides = this.hotkeyOverrides()): string {
    if (action in overrides) return overrides[action];
    return DEFAULT_BINDINGS.find(([name]) => name === action)?.[1] ?? "";
  }

  /** 同 db/query/search.rs：只在未删非私密行里找子串，标题优先、其余 updated_at DESC、截到 SEARCH_LIMIT；
   * 空查询给最近 SEARCH_LIMIT 张（那边靠 `?1 = ''` 让匹配整段短路，标题优先随之失效）。
   * 顺带报有几张锁着没参与（那边是 `SELECT COUNT(*) … private = 1`）。
   * SQL 的 %/_ 转义这里用不上（JS 用 includes），"%折扣%" 两处都按字面命中——口径一致，形状不同。 */
  private search(query: string): SearchOutcome {
    const trimmed = (query ?? "").trim();
    const needle = trimmed.toLocaleLowerCase();
    const rows = this.ordered(false);
    const hits = rows
      .filter((row) => !row.private)
      .filter((row) => {
        if (trimmed === "") return true;
        const haystack = [
          row.title,
          row.body,
          JSON.stringify(row.items),
          JSON.stringify(row.timeline),
          JSON.stringify(row.tags),
        ]
          .join("\n")
          .toLocaleLowerCase();
        return haystack.includes(needle);
      });
    // 标题命中优先，其余按 updated_at DESC（SQL 的 CASE 排序）；空查询时人人都算标题命中，
    // 于是退化成纯 updated_at DESC——与那边同一条退路
    hits.sort((a, b) => {
      const titleA = a.title.toLocaleLowerCase().includes(needle) ? 0 : 1;
      const titleB = b.title.toLocaleLowerCase().includes(needle) ? 0 : 1;
      return titleA - titleB || b.updatedAt - a.updatedAt;
    });
    return {
      hits: hits.slice(0, SEARCH_LIMIT).map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        contentType: row.contentType,
        theme: row.theme,
        items: row.items,
        timeline: row.timeline,
      })),
      privateSkipped: rows.filter((row) => row.private).length,
    };
  }

  private checkPassword(password: string | undefined): string {
    const chars = [...(password ?? "")].length;
    if (chars < PASSWORD_MIN_CHARS || chars > PASSWORD_MAX_CHARS) {
      throw new PreviewError(
        "PASSWORD_LENGTH",
        `口令长度要 ${PASSWORD_MIN_CHARS}..=${PASSWORD_MAX_CHARS} 个字符`,
      );
    }
    return password as string;
  }

  /** 命令入口。writer = 发起窗的 label（db:changed 的合流判定靠它） */
  handle(cmd: string, args: PreviewArgs, writer: string): unknown {
    this.note(`${cmd}${args.id ? ` ${args.id}` : ""}${args.gid ? ` ${args.gid}` : ""}`);
    switch (cmd) {
      // —— 引导与设置（commands/db.rs）——
      case "get_bootstrap":
        return { stickies: this.ordered(false).map((row) => this.mergeOf(row)) };
      case "sticky_list":
        return this.ordered(args.includeDeleted === true).map((row) => this.mergeOf(row));
      case "settings_get":
        return this.settings.get(args.key as string) ?? null;
      case "settings_set": {
        this.settings.set(args.key as string, args.value as string);
        this.emit("setting", writer);
        return null;
      }
      case "data_backup":
        this.snapshots.unshift({
          label: this.snapshotLabel(0),
          bytes: 139264,
          createdAt: Date.now(),
          hasEnvelope: this.password !== null,
        });
        return `预览台没有真备份文件（假库）· ${new Date().toISOString()}`;
      case "snapshot_list":
        return this.snapshots;
      case "snapshot_restore": {
        const label = args.label ?? "";
        const target = this.snapshots.find((row) => row.label === label);
        if (target === undefined) {
          throw new PreviewError("SNAPSHOT_MISSING", `没有这份快照：${label}`);
        }
        // 次序同 Rust：先给"现在"存安全网再换；换表本身不演（要真 ATTACH SQLite 文件，归 snapshot.rs 测试管）。上锁是真的：封套换了内存里那把钥匙就该作废
        const safety = {
          label: this.snapshotLabel(0),
          bytes: 139264,
          createdAt: Date.now(),
          hasEnvelope: true,
        };
        this.snapshots.unshift(safety);
        // 封套换了，内存里那些钥匙全部作废：揭开的那几张一起收回来（Rust 同一条）
        this.revealed.clear();
        this.emitPrivate(writer);
        this.note(`预览台不换库，只演清单与上锁：恢复 ${label}`);
        return {
          restored: label,
          safetyLabel: safety.label,
          envelopeRestored: target.hasEnvelope,
          warning: target.hasEnvelope
            ? null
            : "这份快照没有配套的私密封套（那条规则之前产的老快照）：私密便签的真身仍是当前这一份，可能与恢复回来的行对不上。",
        };
      }

      // —— 开机启动（autostart.rs：真机读写注册表的 Run 键，这里只有内存）——
      case "autostart_get":
        return this.autostartOn;
      case "autostart_set": {
        // 返回**实际生效**那份而非调用方的愿望；这里写内存必然成功——真机"注册表被拦"那条失败演不出来，别当"失败回显已在预览台验过"
        this.autostartOn = args.enabled === true;
        this.note(`开机启动：${String(this.autostartOn)}`);
        return this.autostartOn;
      }

      // —— 便签与回收站（commands/entity.rs + db/query/sticky.rs）——
      case "sticky_upsert": {
        const input = args.input as StickyInput;
        const existing = this.stickies.get(input.id);
        const now = nowMs();
        const content = this.sealedOf(input);
        const plan = this.planFor(input, content);
        if (plan.kind === "refuse") {
          throw new PreviewError(plan.code, plan.message);
        }
        // 进 `stickies` 那六个字段：封与占位都写占位，直通与公布写真身
        const fields =
          plan.kind === "seal" || plan.kind === "placeholders"
            ? this.blanked(content)
            : plan.kind === "publish"
              ? (plan.restore ?? content)
              : content;
        // created_at 只在插入时生成；deleted_at 走 SQL 那段 CASE
        const deletedAt =
          input.deleted && (existing?.deletedAt ?? null) === null
            ? now
            : !input.deleted
              ? null
              : (existing?.deletedAt ?? null);
        const row: StickyNote = {
          ...input,
          ...fields,
          deletedAt,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        // 私密那一版跟着密文走；明文那一版跟着行走，两条路互不串（同 Rust）
        if (plan.kind === "seal") this.sealNow(input.id, content);
        if (plan.kind === "publish") this.sealedRows.delete(input.id);
        if (input.private) {
          // 这一拍翻成私密：不记明文新版，并把以前（还不私密时）留在明文表里的那些清掉——同一份真身，留着等于"刚被保护就抄进一份没加密的历史"
          if (existing !== undefined && !existing.private)
            this.revisions.delete(input.id);
        } else if (existing !== undefined) {
          this.recordRevision(input.id, existing, false);
        }
        this.stickies.set(input.id, row);
        this.emit("sticky", writer, row);
        // 返回**合并过**那一行：调用方 flushNow 拿它整份换内存，给占位就是把这张标题正文从内存抹掉
        return this.mergeOf(row);
      }
      case "sticky_revisions": {
        const id = args.id as string;
        const shelf = this.revisionShelf(id);
        if (shelf === "sealed") {
          // 锁着读不出：私密的版本与私密的正文共用同一道口令门
          if (!this.isOpen(id))
            throw new PreviewError("PRIVATE_LOCKED", "这张便签还没揭开：历史读不出来");
          const list = this.sealedRows.get(id)?.revisions ?? [];
          return [...list].reverse().map((rev) => ({
            seq: rev.seq,
            createdAt: rev.createdAt,
            title: rev.content.title,
            contentType: rev.content.contentType,
            preview: previewOf(rev.content),
          }));
        }
        if (shelf === "empty") return [];
        const list = this.revisions.get(id) ?? [];
        return [...list].reverse().map((row) => ({
          seq: row.seq,
          createdAt: row.createdAt,
          title: row.content.title,
          contentType: row.content.contentType,
          preview: previewOf(row.content),
        }));
      }
      case "sticky_revert": {
        const id = args.id as string;
        const row = this.stickies.get(id);
        const seq = args.seq as number;
        const shelf = this.revisionShelf(id);
        if (shelf === "sealed") {
          if (!this.isOpen(id))
            throw new PreviewError("PRIVATE_LOCKED", "这张便签还没揭开：历史读不出来");
          if (row === undefined) {
            throw new PreviewError("STICKY_MISSING", "这张便签不存在或已被删除");
          }
          const entry = this.sealedRows.get(id);
          const target = entry?.revisions.find((rev) => rev.seq === seq);
          if (entry === undefined || target === undefined) {
            throw new PreviewError("REVISION_MISSING", `私密便签没有第 ${seq} 版`);
          }
          // 与明文那条路同一条：回滚前把当前这份强记成一版（force 绕过冷却）
          this.recordSealedRevision(id, entry.content, true);
          this.sealedRows.set(id, {
            content: target.content,
            revisions: entry.revisions,
          });
          // 行上是空占位，没有内容可换，也不续写它的时钟；还回去的是合并过的行
          this.emit("sticky", writer);
          return this.mergeOf(row);
        }
        if (shelf === "empty") {
          throw new PreviewError(
            "REVISION_MISSING",
            "这张便签标着私密，可私密层当时还没启用——那阵子一版都没记",
          );
        }
        const target = (this.revisions.get(id) ?? []).find((rev) => rev.seq === seq);
        if (row === undefined || target === undefined) {
          throw new PreviewError("REVISION_MISSING", `没有第 ${seq} 版`);
        }
        // 与 Rust 同：回滚前把当前内容**强记**一版（绕过冷却），所以回滚错了还能回来
        this.recordRevision(id, row, true);
        const reverted: StickyNote = { ...row, ...target.content, updatedAt: nowMs() };
        this.stickies.set(id, reverted);
        this.emit("sticky", writer);
        return reverted;
      }
      case "sticky_delete": {
        const row = this.stickies.get(args.id as string);
        if (row === undefined) return false;
        let changed = false;
        if (args.hard === true) {
          changed = true;
          // 与 sticky.rs 同一条：真删要顺手带走这张的图（软删不带走，恢复回来还在）
          for (const [id, record] of [...this.media.entries()]) {
            if (record.noteId === row.id) this.media.delete(id);
          }
          // 历史版本一并带走：这张都不在了，留着就是谁也读不到的孤儿行。
          // 私密切文那一条也当场删得掉——删不需要密钥，所以锁着也清得干净
          this.revisions.delete(row.id);
          this.sealedRows.delete(row.id);
          this.stickies.delete(row.id);
        } else if (!row.deleted) {
          // 软删：盖一次删除时钟，同时不再作为浮窗常驻（SQL：floating = 0）
          this.stickies.set(row.id, {
            ...row,
            deleted: true,
            deletedAt: row.deletedAt ?? nowMs(),
            floating: false,
          });
          changed = true;
        }
        this.pruneEmptyGroups();
        this.emit("sticky", writer);
        if (changed) this.actions.push({ kind: "close-sticky", id: row.id });
        return changed;
      }
      case "trash_restore": {
        const row = this.stickies.get(args.id as string);
        if (row === undefined || !row.deleted) return false;
        this.stickies.set(row.id, {
          ...row,
          deleted: false,
          deletedAt: null,
          floating: true,
          collapsed: false,
        });
        this.emit("sticky", writer);
        // Rust 侧恢复后 open_sticky：组员会被路由到它所在叠窗
        this.openStickyRouted(row.id);
        return true;
      }
      case "trash_clear_all": {
        // trash.rs::clear：所有软删行连图、连版本一起走，不看删除时钟
        const doomed = [...this.stickies.values()].filter((row) => row.deleted);
        for (const row of doomed) {
          for (const [id, record] of [...this.media.entries()]) {
            if (record.noteId === row.id) this.media.delete(id);
          }
          this.revisions.delete(row.id);
          this.sealedRows.delete(row.id);
          this.stickies.delete(row.id);
        }
        this.pruneEmptyGroups();
        this.emit("sticky", writer);
        return doomed.length;
      }
      case "sticky_set_group": {
        const id = args.id as string;
        const groupId = args.groupId ?? null;
        const row = this.stickies.get(id);
        if (row === undefined) return false;
        // 移进必须指向存在的组（query/group.rs::set_member 的幽灵组拒绝）
        if (groupId !== null && !this.groups.has(groupId)) {
          throw new PreviewError("GROUP_MISSING", `组合 ${groupId} 不存在`);
        }
        if (row.deleted) return false;
        this.stickies.set(id, { ...row, groupId, updatedAt: nowMs() });
        this.pruneEmptyGroups();
        this.emit("sticky", writer);
        if (groupId !== null) {
          this.actions.push({ kind: "close-sticky", id });
          this.actions.push({ kind: "open-stack", gid: groupId, focus: id });
        } else {
          this.actions.push({ kind: "open-sticky", id });
        }
        return true;
      }
      // —— 拖拽进组：逐条照 group.rs::merge_into + entity.rs::sticky_merge_into 抄（自并/缺席含软删/幽灵组/就地立叠判据见下）——
      // 广播 writer 硬编码 "merge" 而不是窗 label：发起方就是要销毁的那一扇，用它的 label 会让所有窗（含它自己）都跳过这一轮。
      case "sticky_merge_into": {
        const sourceId = args.sourceId as string;
        const targetId = args.targetId as string;
        if (sourceId === targetId) {
          throw new PreviewError("MERGE_INTO_SELF", "不能把一张便签并进它自己");
        }
        const target = this.liveRow(targetId);
        const source = this.liveRow(sourceId);
        if (target === undefined) {
          throw new PreviewError("STICKY_MISSING", "要并入的那张便签已经不在了");
        }
        if (source === undefined) {
          throw new PreviewError("STICKY_MISSING", "被拖的那张便签已经不在了");
        }
        const now = nowMs();
        const existing = target.groupId;
        const created = existing === null;
        const gid = created ? `g-${now.toString(36)}` : existing;
        if (created) {
          this.groups.set(gid, {
            id: gid,
            name: normalizeGroupName(target.title),
            color: null,
            collapsed: false,
            docked: false,
            dockEdge: null,
            x: target.x,
            y: target.y,
            width: target.width,
            height: target.height,
            createdAt: now,
            updatedAt: now,
          });
          // target 原本散着，它自己也要跟着变成组员
          this.stickies.set(targetId, { ...target, groupId: gid, updatedAt: now });
        }
        this.stickies.set(sourceId, { ...source, groupId: gid, updatedAt: now });
        // 源张原来若在某一叠里，那一叠可能因此空掉
        this.pruneEmptyGroups();
        this.emit("sticky", "merge");
        this.actions.push({ kind: "close-sticky", id: sourceId });
        this.actions.push({ kind: "open-stack", gid, focus: sourceId });
        return gid;
      }
      case "group_rename": {
        const gid = args.gid as string;
        const row = this.groups.get(gid);
        if (row === undefined) {
          throw new PreviewError("GROUP_NOT_FOUND", "这个组合已经不在了");
        }
        this.groups.set(gid, {
          ...row,
          name: normalizeGroupName(args.name as string),
          updatedAt: nowMs(),
        });
        return null;
      }
      case "group_set_dock": {
        const gid = args.gid as string;
        const row = this.groups.get(gid);
        if (row === undefined) {
          throw new PreviewError("GROUP_NOT_FOUND", "这个组合已经不在了");
        }
        const docked = args.docked as boolean;
        const edge = args.edge as string | null;
        // 与 Rust `group::set_dock` 同一条：认不出的边一律按"没贴"算，
        // 不留 docked=1 + 一条不认识的边（开机摆出一块不在任何边上的细丝）
        const known = ["left", "right", "top", "bottom"].includes(edge ?? "");
        this.groups.set(gid, {
          ...row,
          docked: docked && known,
          dockEdge: docked && known ? (edge as StickyGroup["dockEdge"]) : null,
          updatedAt: nowMs(),
        });
        return null;
      }
      case "group_set_collapsed": {
        const gid = args.gid as string;
        const row = this.groups.get(gid);
        if (row === undefined) {
          throw new PreviewError("GROUP_NOT_FOUND", "这个组合已经不在了");
        }
        this.groups.set(gid, {
          ...row,
          collapsed: args.collapsed as boolean,
          // 收起那一刻报来的展开尺寸留在行里（恢复成多大看它），没报就原样留着
          width: (args.expandW as number | null) ?? row.width,
          height: (args.expandH as number | null) ?? row.height,
          updatedAt: nowMs(),
        });
        return null;
      }
      case "group_list":
        return [...this.groups.values()].sort((a, b) => a.createdAt - b.createdAt);

      // —— 检索（db/query/search.rs）——
      case "search_query":
        return this.search(args.query as string);

      // —— 私密层（data/private.rs + commands/private.rs：只抄错误码与守卫，密码学不做）——
      case "private_status":
        // 逐张模型：交回的是**已揭开的那几张**，没有 `unlocked` 这一格。
        // damaged 恒 false：假核没有文件，也就没有"读不出来"那种坏法
        return {
          configured: this.password !== null,
          damaged: false,
          revealed: [...this.revealed].sort(),
        };
      case "private_setup": {
        if (this.password !== null) {
          throw new PreviewError(
            "ALREADY_CONFIGURED",
            "私密层已经设置过，请直接输入密码打开你要看的那张",
          );
        }
        this.password = this.checkPassword(args.password);
        // 设完口令这一刻**不**收编：那步要 master 现造钥匙，而 master 只在"输口令揭开某张"那拍活着；第一张被揭开时顺带做（见 private_reveal）
        this.emitPrivate(writer);
        return null;
      }
      case "private_reveal": {
        const noteId = args.noteId as string;
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        if (args.password !== this.password) {
          throw new PreviewError("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）");
        }
        // 同 Rust reveal 两步：先做只有拿 master 才做得到的全局活（收编明文残骸），再把**这张**从旧形状搬进它自己的钥匙
        this.adoptSealed();
        this.legacyShelf.delete(noteId);
        this.revealed.add(noteId);
        this.emitPrivate(writer);
        this.verified(noteId, "reveal");
        this.note(`揭开 ${noteId}：只开这一张，别的张照旧是密文`);
        return null;
      }
      case "private_verify": {
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        if (args.password !== this.password) {
          throw new PreviewError("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）");
        }
        // 只验身份：一张都不开（删除那道门要的就是这个——开着一张再删它，
        // 等于用一道门换来一次泄露）。所以这里不广播私密层状态：什么都没变
        this.verified(
          this.unlockIntent?.noteId ?? "*",
          this.unlockIntent?.purpose ?? "delete",
        );
        return null;
      }
      case "private_lock":
        // 同 Rust：lock 之后广播——前端 privateLock() 现有人调（标记完问"立即锁回去"），不广播的话动手那扇窗自己还停在揭开态
        this.revealed.clear();
        this.emitPrivate(writer);
        return null;
      case "private_note_activity":
        // 自动上锁时钟与循环整个住在 Rust（autolock.rs），预览台没可模拟的对钟，这里只咽掉上报别刷屏。「无操作到点蒙回」这条**预览台验不出来**，只有真机能看。
        return null;
      case "private_rekey": {
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        // 逐张钥匙之后改密要**两道**：旧口令验身份（重裹键行要用旧 master）、新口令立新的；只交一份接不上 Rust 的 private_rekey(password, newPassword)
        const password = this.checkPassword(args.password);
        const newPassword = this.checkPassword(args.newPassword);
        if (password !== this.password) {
          throw new PreviewError("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）");
        }
        this.password = newPassword;
        // 新旧 master 不是一把：原来开着的那几张当场不再算数
        this.revealed.clear();
        this.legacyShelf = new Set(this.sealedRows.keys());
        this.emitPrivate(writer);
        this.note("改密：那些逐张钥匙按新口令重裹了一遍，内容字节一个都没动");
        return null;
      }
      case "private_reset": {
        if (this.revealed.size > 0) {
          throw new PreviewError(
            "RESET_WHEN_UNLOCKED",
            "有便签正开着，重置会清空全部私密内容：先收回再改",
          );
        }
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        this.password = this.checkPassword(args.password);
        // 重置换的是**新的** master：旧键行/正文行/版本行/私密图从此再也解不开，一并清掉（Rust 侧 private_reset 里那两条 purge）
        this.sealedRows.clear();
        this.legacyShelf.clear();
        for (const [id, record] of [...this.media.entries()]) {
          if (record.enc) this.media.delete(id);
        }
        // 重置完**不是**开着哪一张：与 Rust 同（reset 之后一张都没揭开）
        this.emitPrivate(writer);
        this.note("私密层重置：私密正文、版本、逐张钥匙与私密图全部清除");
        return null;
      }

      // —— 窗口（commands/window.rs：产出动作，由宿主落成 iframe）——
      case "create_floating_sticky": {
        const id = `s-${nowMs().toString(36)}`;
        this.putStickyRow(id, "");
        this.emit("sticky", writer);
        this.actions.push({ kind: "open-sticky", id });
        return id;
      }
      case "open_floating_sticky":
        this.openStickyRouted(args.id as string);
        return null;
      /** commands/window.rs::reminder_open —— 卡上的"去看"：收卡（预览台没有卡窗，没什么可收）
       *  再把那张拉到眼前，组员并进叠窗翻到它。与 open_floating_sticky 同一条落点 */
      case "reminder_open":
        this.note(`提醒卡：要打开 ${args.id as string}`);
        this.openStickyRouted(args.id as string);
        return null;
      case "reminder_dismiss":
        this.note("提醒卡：收了");
        return null;
      /** commands/window.rs::reminder_snooze —— 推后 10 分钟再响。假库没有 reminded_at 那一列
       *  （它不住在契约里），所以只动 dueAt；便签上那句"还有几分钟"跟着这次广播重算 */
      case "reminder_snooze": {
        const row = this.stickies.get(args.id as string);
        if (row !== undefined && row.dueAt !== null) {
          this.stickies.set(row.id, { ...row, dueAt: nowMs() + SNOOZE_MS });
          this.emit("sticky", writer);
        }
        this.note(`提醒卡：稍后再响（推后 ${SNOOZE_MS / 60_000} 分钟）`);
        return null;
      }
      /** commands/log.rs::log_write —— 前端那一行落到这份流水里，面板上看得见 */
      case "log_write":
        this.note(
          `[${args.level as string}] ${args.scope as string}: ${args.message as string}`,
        );
        return null;
      case "close_floating_sticky":
        this.actions.push({ kind: "close-sticky", id: args.id as string });
        return null;
      case "close_group_stack":
        this.actions.push({ kind: "close-stack", gid: args.gid as string });
        return null;
      case "float_frames":
        // 浮窗矩形只有宿主知道（iframe 的 rect 归 host 管），所以这里转调宿主挂进来的取值函数。
        // 与 Rust 同口径：只给可见的浮窗/叠窗，面板窗和隐藏的星环不在表里。
        return this.floatsProvider();
      case "open_trash_window":
        this.actions.push({ kind: "open-panel", label: "trash" });
        return null;
      case "close_trash_window":
        this.actions.push({ kind: "close-panel", label: "trash" });
        return null;
      case "open_search_window":
        this.actions.push({ kind: "open-panel", label: "search" });
        return null;
      case "close_search_window":
        this.actions.push({ kind: "close-panel", label: "search" });
        return null;
      case "open_settings_window":
        this.actions.push({ kind: "open-panel", label: "settings" });
        return null;
      case "close_settings_window":
        this.actions.push({ kind: "close-panel", label: "settings" });
        return null;
      case "open_unlock_window": {
        // 与 unlock.rs::open 同一条顺序：先记意图，再开窗（窗一挂载就发 unlock_intent 读）
        const noteId = args.noteId;
        this.unlockIntent =
          noteId === undefined
            ? null
            : { noteId, purpose: args.purpose === "delete" ? "delete" : "reveal" };
        this.actions.push({ kind: "open-panel", label: "unlock" });
        // 预览台不判"这扇窗是不是复用的"，两条都发：新窗挂载时那次读也认这一声
        this.broadcasts.push({ event: "unlock:intent", payload: null });
        return null;
      }
      case "unlock_intent":
        return this.unlockIntent;
      case "close_unlock_window":
        this.actions.push({ kind: "close-panel", label: "unlock" });
        // 与 unlock.rs::close 同一条：destroy 之后广播"窗没了"。挂起的删除动作靠它收口
        // （解锁成功也是这扇窗自己关的，所以收到之后还要读一次权威状态）
        this.broadcasts.push({ event: "unlock:dismissed", payload: "unlock" });
        return null;
      case "open_ring_window":
        // 真机每次开在光标处（place_at_cursor 走 GetCursorPos+工作区夹回），预览台没 OS 光标语义就摆左上——环本身行为照样能验
        this.note("星环：预览台摆左上，真机落光标处（这条差异不看成 bug）");
        this.actions.push({ kind: "open-panel", label: "ring" });
        // ring.rs::reveal 每次出盘都广播这一声（环窗拿它重放入场，引导第一步拿它翻页）
        this.broadcasts.push({ event: "ring:open", payload: null });
        return null;
      case "close_ring_window":
        // 与 Rust 同口径：关 = 隐藏（星环要秒开，销毁再建 WebView 的代价落在按键到看见之间）
        this.actions.push({ kind: "close-panel", label: "ring" });
        return null;

      // —— 引导窗（windows/guide.rs）——
      case "open_guide_window":
        this.actions.push({ kind: "open-panel", label: "guide" });
        return null;
      case "guide_show_ring": {
        // 同 guide.rs::show_ring：开出环 + 报回**那只环的真实外框**（预览台环被 host 摆在 (60,60) 边长 360，故环心 240,240 半径 180——改 host 那处要改这里）。
        // **不**广播 ring:open：真机走到这多半"环已在手上"（第一步就是等那一声），只有兜底开环才 emit；预览台一律不报，免得和第一步翻页撞成连翻两页
        this.actions.push({ kind: "open-panel", label: "ring" });
        this.note("引导：把星环真的开出来（环心 240,240，半径 180）");
        return { cx: 240, cy: 240, half: 180 };
      }
      case "guide_release_ring":
        // 与 Rust 同口径：闸门放下，环还开着就收掉
        this.actions.push({ kind: "close-panel", label: "ring" });
        this.note("引导：放开星环");
        return null;
      case "tray_rect":
        // 真机走 UIA 问 Explorer（tray.rs::icon_rect，托盘图标没句柄 Win32 拿不到矩形）。预览台没任务栏/图标，
        // 给个摆画布右下角的**替身**——验的是"贴到那格头上、箭头朝下"那条算术，不是 UIA 本身
        this.note("托盘那一格：预览台给替身矩形（真机问 UIA，问不到就退右下角那一档）");
        return { x: 1384, y: 852, width: 32, height: 40 };
      case "close_guide_window": {
        // 同真机：销账写在 close 里——前端有两条关法（× 与 Esc），摆窗内就得写两处，摆这条命令上只有一处
        this.settings.set(GUIDE_SEEN_KEY, "1");
        // 引导自己造的那几张演示便签跟着走：硬删、不进回收站（与 commands/window.rs 同一条）
        this.dropDemoNotes();
        this.note("引导教程：销账 guide.seen=1");
        this.actions.push({ kind: "close-panel", label: "guide" });
        return null;
      }
      case "guide_demo_note": {
        // 同 window.rs::guide_demo_note：**凑够** want 张，已有的不动，死记号（自删过/上趟没走到收尾）先抹；返回最后那张的窗 label
        const want = Math.min(Math.max((args.want as number) ?? 1, 1), 4);
        const ids = this.liveDemoIds();
        while (ids.length < want) {
          // 只有一张时不带编号，补出来的才编号（与 Rust 同一条口径）
          const title = ids.length === 0 ? "引导演示" : `引导演示 ${ids.length + 1}`;
          const id = `s-${nowMs().toString(36)}-${ids.length}`;
          this.putStickyRow(id, title);
          ids.push(id);
          this.actions.push({ kind: "open-sticky", id });
          this.note(`引导：放出「${title}」，共 ${ids.length} 张`);
        }
        this.settings.set(GUIDE_DEMO_NOTE_KEY, ids.join(","));
        this.emit("sticky", "guide");
        return `${STICKY_LABEL_PREFIX}${ids[ids.length - 1]}`;
      }

      // —— 贴边（windows/dock.rs 的槽位注册表：同边重复登记必须幂等）——
      case "float_dock_register": {
        const id = args.id as string;
        const edge = args.edge as string;
        if (this.dockEdges[id] !== edge) {
          // 新登记或换边：排到队尾
          this.dockOrder = [...this.dockOrder.filter((entry) => entry !== id), id];
        }
        this.dockEdges[id] = edge;
        // 槽位 = 队列里排在前面且同边的张数
        return this.dockOrder.findIndex((entry) => entry === id);
      }
      case "float_dock_unregister": {
        const id = args.id as string;
        delete this.dockEdges[id];
        this.dockOrder = this.dockOrder.filter((entry) => entry !== id);
        return null;
      }
      // 预览台每扇 iframe 窗本来就一直在显示，没有"建隐窗再亮"这一步；这条必须是 no-op 而不是"未知命令"，否则便签入口每次挂载都红一条
      case "float_reveal":
        return null;
      case "monitor_work_area":
        return { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height };

      // —— 快捷键（hotkeys.rs：校验 + 热重绑 + 落库；被占用则还原旧键）——
      case "hotkey_list": {
        // 事实来源是"注册表里实际生效的那份"，不是用户上次的愿望
        const effective = this.hotkeyOverrides();
        return DEFAULT_BINDINGS.map(([action]) => {
          const key = this.effectiveKey(action, effective);
          // 空串 = 显式停用，那是用户要的结果，算生效；撞上不放的键位就是没绑上
          return { action, key, bound: key === "" || !EXTERNALLY_HELD.has(key) };
        });
      }
      case "app_set_hotkey": {
        const action = args.action as string;
        const key = (args.key ?? "").trim();
        const overrides = this.hotkeyOverrides();
        if (!DEFAULT_BINDINGS.some(([name]) => name === action)) {
          throw new PreviewError("BAD_ACTION", `未知动作 ${action}`);
        }
        // 空串=停用合法。非空的形状判据只是**近似**（真侧是 global-hotkey 的 parse，这里只查"修饰键+恰好一主键"），
        // 所以"形状对但解析器不认"（如 Ctrl+Plus 写法差异）预览台验不出来——别当改键已验。
        if (key !== "" && !looksLikeAccelerator(key)) {
          throw new PreviewError("BAD_SHORTCUT", `键位 ${JSON.stringify(key)} 不合法`);
        }
        if (key !== "") {
          if (EXTERNALLY_HELD.has(key)) {
            // 真侧：bind() 拿到 ERROR_HOTKEY_ALREADY_REGISTERED，把默认键绑回去再回错
            throw new PreviewError("SHORTCUT_BUSY", `${key} 已被其它程序或本应用占用`);
          }
          const holder = DEFAULT_BINDINGS.map(([name]) => name).find(
            (name) => name !== action && this.effectiveKey(name, overrides) === key,
          );
          if (holder !== undefined) {
            // 真侧这里会先把旧键绑回去再报错；注册表不动，等于"还原"
            throw new PreviewError("SHORTCUT_BUSY", `${key} 已被其它程序或本应用占用`);
          }
        }
        overrides[action] = key;
        this.settings.set(HOTKEYS_SETTING_KEY, JSON.stringify(overrides));
        this.note(`改键：${action} → ${key === "" ? "（停用）" : key}`);
        return null;
      }

      // —— 图片（db/query/media.rs + commands/media.rs：常量同值、错误码同名，密码学不做）——
      case "media_save": {
        // 参数嵌在 `input` 里（Rust 签名 input: MediaInput，前端 invoke({ input })）；PreviewArgs.input 的类型位被 StickyInput 占了，只能过 unknown 折开
        const input = args.input as unknown as Partial<{
          noteId: string;
          mime: string;
          dataBase64: string;
          width: number;
          height: number;
          private: boolean;
        }>;
        const noteId = input?.noteId ?? "";
        const mime = input?.mime ?? "";
        const dataBase64 = input?.dataBase64 ?? "";
        const width = input?.width ?? 0;
        const height = input?.height ?? 0;
        if (width < 1 || width > 40_000 || height < 1 || height > 40_000) {
          throw new PreviewError("MEDIA_SHAPE", `图片尺寸 ${width}x${height} 不合理`);
        }
        if (!MEDIA_ALLOWED_MIME.includes(mime)) {
          throw new PreviewError(
            "MEDIA_MIME",
            `不支持的图片类型 ${mime === "" ? "（未知）" : mime}`,
          );
        }
        // base64 → 字节数的近似（Rust 那边是真解码；这里只为让 5 MB 那条限在预览台也拦得住）
        const bytes = Math.floor((dataBase64.length * 3) / 4);
        if (bytes === 0) throw new PreviewError("MEDIA_EMPTY", "图片字节是空的");
        if (bytes > MEDIA_MAX_BYTES) {
          throw new PreviewError("MEDIA_TOO_BIG", "超过单张 5 MB 上限");
        }
        const mine = [...this.media.values()].filter((item) => item.noteId === noteId);
        if (mine.length >= MEDIA_MAX_PER_NOTE) {
          throw new PreviewError(
            "MEDIA_TOO_MANY",
            `这张便签已经有 ${mine.length} 张图，上限 ${MEDIA_MAX_PER_NOTE} 张`,
          );
        }
        const enc = (args.private ?? false) && this.privateActive;
        if (enc && !this.isOpen(noteId)) {
          // 与 Rust 同一条：这张没揭开就宁可不存，也不把私密图写成明文
          throw new PreviewError("PRIVATE_LOCKED", "这张便签还没揭开：图不许写成明文");
        }
        const id = this.nextMediaId();
        this.media.set(id, {
          id,
          noteId,
          mime,
          dataBase64,
          enc,
          width,
          height,
          createdAt: nowMs(),
        });
        this.note(`存图 ${id}（${mime} ${width}x${height}${enc ? "，密文" : ""}）`);
        return { id, noteId, mime, width, height, enc };
      }
      case "media_get": {
        const record = this.media.get(args.id as string);
        if (record === undefined) return null;
        if (record.enc && !this.isOpen(record.noteId)) {
          // 图跟正文同一条钥匙：所属那张没揭开就读不出这张图
          throw new PreviewError("PRIVATE_LOCKED", "这张便签还没揭开：图读不出来");
        }
        return { mime: record.mime, dataBase64: record.dataBase64 };
      }
      case "media_delete": {
        const gone = this.media.delete(args.id as string);
        if (gone) this.note(`删图 ${args.id as string}`);
        return gone;
      }
      case "media_set_private": {
        const noteId = args.noteId as string;
        const target = (args.private ?? false) && this.privateActive;
        // 两个方向都要这一张开着：加密用它的钥匙，解密也是它的钥匙
        if (this.privateActive && !this.isOpen(noteId)) {
          throw new PreviewError("PRIVATE_LOCKED", "这张便签还没揭开：图翻不了面");
        }
        let changed = 0;
        for (const [id, record] of [...this.media.entries()]) {
          if (record.noteId !== noteId || record.enc === target) continue;
          this.media.set(id, { ...record, enc: target });
          changed += 1;
        }
        if (changed > 0) this.note(`私密翻转：${noteId} 名下 ${changed} 张图`);
        return changed;
      }

      // —— 右键劫持配置（commands/hook.rs + input/*）——
      case "hook_status":
        return {
          paused: this.hookPaused,
          holdMs: this.hookHoldMs,
          charging: this.hookCharging,
          whitelist: [...this.hookWhitelist],
          // 预览台没有前台进程采样线程：真侧读不到也是 null，界面那条说明同一条
          foreground: null,
        };
      case "hook_set_config": {
        if (typeof args.paused === "boolean") {
          // 与真侧同：暂停只改运行态，不落库（重启即恢复劫持）
          this.hookPaused = args.paused;
          this.note(`劫持暂停：${String(this.hookPaused)}（不落库）`);
        }
        if (typeof args.charging === "boolean") {
          // 与真侧同：充电弧开关**落库**（关掉了就一直是关的）
          this.hookCharging = args.charging;
          this.settings.set(CHARGING_SETTING_KEY, args.charging ? "1" : "0");
          this.note(`充电弧：${String(this.hookCharging)}`);
        }
        if (typeof args.holdMs === "number") {
          const effective = Math.min(Math.max(args.holdMs, HOLD_MS_MIN), HOLD_MS_MAX);
          this.hookHoldMs = effective;
          this.settings.set(HOLD_MS_SETTING_KEY, String(effective));
          // 次序照 Rust：先夹取落库，再告诉界面"被夹了"——界面显示的是实际跑的值
          if (effective !== args.holdMs) {
            throw new PreviewError("HOLD_MS_CLAMPED", `阈值已被夹到 ${effective} 毫秒`);
          }
        }
        if (Array.isArray(args.whitelist)) {
          this.hookWhitelist = parseWhitelist(args.whitelist);
          this.settings.set(WHITELIST_SETTING_KEY, JSON.stringify(this.hookWhitelist));
          this.note(`白名单生效 ${this.hookWhitelist.length} 条`);
        }
        return null;
      }

      default:
        throw new PreviewError("PREVIEW_UNIMPLEMENTED", `预览台没实现命令：${cmd}`);
    }
  }

  viewport = { width: 1440, height: 900 };

  /** 桌面浮窗矩形由宿主挂进来（假核不摆 iframe，rect 全在 host 手里）；默认空表=桌面上一扇浮窗都没有，前端最多判不出命中、不会误并。 */
  floatsProvider: () => FloatFrame[] = () => [];

  /** open_sticky 的路由口径：组员不单开一扇，改开它所在叠窗；悬空成员按散着算 */
  private openStickyRouted(id: string): void {
    const row = this.stickies.get(id);
    const gid = row?.groupId ?? null;
    if (row !== undefined && gid !== null && this.groups.has(gid)) {
      this.actions.push({ kind: "open-stack", gid, focus: id });
      return;
    }
    this.actions.push({ kind: "open-sticky", id });
  }

  /** 给宿主的调试视图。私密那张在这里**只报状态不报内容**——正文与版本住 sealedRows（真机那两张密文表），这份快照会渲染进调试面板，把真身摊在那里等于在验收界面上自己拆掉私密层。 */
  snapshot(): {
    stickies: StickyNote[];
    groups: StickyGroup[];
    settings: Array<[string, string]>;
    private: {
      configured: boolean;
      /** **已揭开的那几张**（逐张模型里没有"整层开着"这一格） */
      revealed: string[];
      /** 已封进"表"里的张数（内容不报） */
      sealedRows: number;
    };
    log: string[];
  } {
    return {
      stickies: this.ordered(true),
      groups: [...this.groups.values()],
      settings: [...this.settings.entries()],
      private: {
        configured: this.password !== null,
        revealed: [...this.revealed].sort(),
        sealedRows: this.sealedRows.size,
      },
      log: [...this.log],
    };
  }

  /** 泄出本轮的窗口动作与广播（宿主每次 dispatch 后取空） */
  drain(): { actions: WindowAction[]; broadcasts: Broadcast[] } {
    const actions = [...this.actions];
    this.actions.length = 0;
    const broadcasts = [...this.broadcasts];
    this.broadcasts.length = 0;
    return { actions, broadcasts };
  }
}
