// 预览台的假数据核 — 命令语义逐条对着 Rust 抄（ commands/*.rs + db/query/*.rs ）。
//
// 抄的是**行为**不是代码：排序、时间戳归属、deleted_at 的 CASE、软删置 floating=0、
// 幽灵组拒绝、检索转义与标题优先、私密层错误码。语义改了这边没跟上，预览台就在骗人——
// 所以每条都标了出处。改 Rust 侧对应行为时，这里必须一起改。
//
// 假核不承担窗口系统的真实动作：窗口类命令产出一条 WindowAction，由宿主落成 iframe。

import type {
  FloatFrame,
  SearchHit,
  SealedText,
  StickyGroup,
  StickyInput,
  StickyNote,
} from "@/platform/contracts";

/** 与 db/query/search.rs 的 SEARCH_LIMIT 同值 */
const SEARCH_LIMIT = 50;
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

/** 后端广播：db:changed 与 store:private-changed 两条，逐条对着 Rust 的 emit 抄 */
export type Broadcast =
  | {
      event: "db:changed";
      payload: { writer: string; kind: "sticky" | "group" | "setting" };
    }
  | { event: "store:private-changed"; payload: string };

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
  password?: string;
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
/**
 * 与 hotkeys.rs 的 DEFAULT_BINDINGS 同表同序（改一边要同步另一边）。
 * 这条同步由用例钉着：`hotkey-table.test.ts` 直接读 `src-tauri/src/hotkeys.rs` 比对，
 * 漂了就是测试红——注释提醒过无数次，还是会漂，所以让它编译不过去。
 */
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
/**
 * 预览台里"被别的程序占着"的键位。**照的是本机实况**：真机日志连续几天都是
 * `ring 的 Alt+Space 注册失败（可能被占用）：HotKey already registered`，同表
 * Alt+1..4 全成功 —— 那条键在作者机器上确实归别的程序。留着它，那条"没绑上"
 * 的告警在预览台里才看得见（预览台没有 RegisterHotKey，不模拟就永远是绿的）。
 */
const EXTERNALLY_HELD = new Set(["Alt+Space"]);
const HOLD_MS_SETTING_KEY = "ring.trigger.hold_ms";
const WHITELIST_SETTING_KEY = "hook.whitelist";
const CHARGING_SETTING_KEY = "ring.charging";

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

/**
 * 与 input/allowlist.rs::normalize 同规则：允许粘贴整条路径（取最后一段，`\` 与 `/`
 * 都算分隔）、转小写、去结尾 `.exe`；空/超 64 字符/带控制字符 → 这条不进名单。
 * `*` 只在结尾当通配，这里照存原文（比对发生在钩子侧，名单本身不改写通配）。
 */
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

/**
 * 种子数据：四类便签各一张 + 一张空正文 + 一张在组里 + 一张私密（主库里只留占位）
 * + 回收站里一张 + 一叠三张的组。刻意把边界情况一次铺满，省得每次手点。
 */
/**
 * 与 Rust 侧 `group::normalize_name` 一字同口径：去首尾空白、空→「未命名组合」、
 * 按字符数截到 40。预览台与真机不一致的话，这里能改出来的名字到真机就变了样。
 */
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
    // 一叠三张：叠窗（一叠一窗）就在这一组上验。成员序是 updated_at DESC，
    // 这里给三张排个确定的序：g3 在最前（一进叠窗看到的是它）
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
  /** 私密集合：明文 map（真身在 Rust 侧是封套；预览台只做行为，不做密码学） */
  private sealed: Record<string, SealedText> = {
    "s-private": {
      title: "私密便签",
      body: "主库里这张只留占位：标题/正文/标签都在封套里。",
      items: [],
      timeline: [],
      tags: ["密"],
    },
  };
  private password: string | null = null;
  private unlocked = false;
  private dockEdges: Record<string, string> = {};
  private dockOrder: string[] = [];
  /**
   * 右键劫持的运行态。真机那份住在 input/mod.rs 的原子量里：
   * paused **刻意不落库**（重启即恢复劫持），阈值与白名单落库。这里照同一套落。
   */
  private hookPaused = false;
  private hookHoldMs = HOLD_MS_DEFAULT;
  /** 与 input/mod.rs 同默认：开。关掉是"长按过程零反馈" */
  private hookCharging = true;
  private hookWhitelist: string[] = [];
  /** media 表（0005_media.sql）。id 形状照 support/id.rs::media()：m + 十六进制 */
  private media = new Map<string, MediaRecord>();
  private mediaSeq = 0;
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
    this.sealed = {
      "s-private": {
        title: "私密便签",
        body: "主库里这张只留占位：标题/正文/标签都在封套里。",
        items: [],
        timeline: [],
        tags: ["密"],
      },
    };
    this.password = null;
    this.unlocked = false;
    this.media = new Map();
    this.mediaSeq = 0;
    // 种子图：正文里那句 media:// 引用得有真字节对着它。用 canvas 画而不是塞一段
    // base64 字面量——那种常量没人改得动，也演不出"缩与重编码之后长什么样"
    this.seedMedia("s-text", "便签里的种子图", "#2f7d32");
    this.actions.length = 0;
    this.broadcasts.length = 0;
    this.log.length = 0;
  }

  private nextMediaId(): string {
    this.mediaSeq += 1;
    return `m${Date.now().toString(16)}${this.mediaSeq.toString(16)}`;
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

  /** 私密层是否"启用过"：没配置过时私密便签走明文直通（与 private-backend.ts 同口径） */
  get privateActive(): boolean {
    return this.password !== null;
  }

  private emit(kind: "sticky" | "group" | "setting", writer: string): void {
    this.broadcasts.push({ event: "db:changed", payload: { writer, kind } });
  }
  /** commands/private.rs 的 emit_changed：每条私密写命令后广播（private_lock 没有，照抄） */
  private emitPrivate(writer: string): void {
    this.broadcasts.push({ event: "store:private-changed", payload: writer });
  }
  readonly broadcasts: Broadcast[] = [];

  private note(text: string): void {
    this.log.unshift(text);
    this.log.length = Math.min(this.log.length, 80);
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

  /**
   * 与 db/query/search.rs 同语义：只在未删、非私密的行里找子串，标题命中优先，
   * 其余按 updated_at DESC，截到 SEARCH_LIMIT。
   * SQL 侧那套 %/_ 转义在这里用不上（JS 是 includes，不是模式匹配），
   * 所以 "%折扣%" 这种查询词在两处都按字面命中——口径一致，形状不同。
   */
  private search(query: string): SearchHit[] {
    const trimmed = (query ?? "").trim();
    if (trimmed === "") return [];
    const needle = trimmed.toLocaleLowerCase();
    const hits = this.ordered(false)
      .filter((row) => !row.private)
      .filter((row) => {
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
    // 标题命中优先，其余按 updated_at DESC（SQL 的 CASE 排序）
    hits.sort((a, b) => {
      const titleA = a.title.toLocaleLowerCase().includes(needle) ? 0 : 1;
      const titleB = b.title.toLocaleLowerCase().includes(needle) ? 0 : 1;
      return titleA - titleB || b.updatedAt - a.updatedAt;
    });
    return hits.slice(0, SEARCH_LIMIT).map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      contentType: row.contentType,
      theme: row.theme,
    }));
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
        return { stickies: this.ordered(false) };
      case "sticky_list":
        return this.ordered(args.includeDeleted === true);
      case "settings_get":
        return this.settings.get(args.key as string) ?? null;
      case "settings_set": {
        this.settings.set(args.key as string, args.value as string);
        this.emit("setting", writer);
        return null;
      }
      case "data_backup":
        return `预览台没有真备份文件（假库）· ${new Date().toISOString()}`;

      // —— 便签与回收站（commands/entity.rs + db/query/sticky.rs）——
      case "sticky_upsert": {
        const input = args.input as StickyInput;
        const existing = this.stickies.get(input.id);
        const now = nowMs();
        // created_at 只在插入时生成；deleted_at 走 SQL 那段 CASE
        const deletedAt =
          input.deleted && (existing?.deletedAt ?? null) === null
            ? now
            : !input.deleted
              ? null
              : (existing?.deletedAt ?? null);
        const row: StickyNote = {
          ...input,
          deletedAt,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.stickies.set(input.id, row);
        this.emit("sticky", writer);
        return row;
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
      // —— 拖拽进组 — 逐条对着 group.rs::merge_into + commands/entity.rs::sticky_merge_into 抄：
      // 自并拒绝、任一张不在（含已软删，peek 的 `deleted = 0`）报 STICKY_MISSING、
      // target 有 groupId 就进那一叠（哪怕那叠是幽灵组，Rust 这边同样不校验），
      // 否则就地立一叠：组名与摆位抄 target。
      // 广播的 writer 是硬编码的 "merge" 而不是窗 label——发起方就是要被销毁的那一扇，
      // 用它的 label 会让所有窗（含它自己）都跳过这一轮。
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

      // —— 私密层（data/private.rs：只抄错误码与守卫，密码学不做）——
      case "private_status":
        return { configured: this.password !== null, unlocked: this.unlocked };
      case "private_setup": {
        if (this.password !== null) {
          throw new PreviewError(
            "ALREADY_CONFIGURED",
            "私密层已经设置过，请直接解锁或修改密码",
          );
        }
        this.password = this.checkPassword(args.password);
        this.unlocked = true;
        this.emitPrivate(writer);
        return null;
      }
      case "private_unlock": {
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        if (args.password !== this.password) {
          throw new PreviewError("CRYPTO_OPEN", "解密失败（口令不正确，或数据已损坏）");
        }
        this.unlocked = true;
        this.emitPrivate(writer);
        return null;
      }
      case "private_lock":
        // 与 Rust 同：private_lock 不广播（托盘「立即锁定」那条路自带收尾）
        this.unlocked = false;
        return null;
      case "private_load": {
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        if (!this.unlocked) throw new PreviewError("PRIVATE_LOCKED", "私密层未解锁");
        return JSON.stringify(this.unlocked ? this.sealed : {});
      }
      case "private_save": {
        if (!this.unlocked) throw new PreviewError("PRIVATE_LOCKED", "私密层未解锁");
        const parsed: unknown = JSON.parse(args.data as string);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new PreviewError("PRIVATE_DATA", "私密内容必须是 JSON 对象");
        }
        this.sealed = parsed as Record<string, SealedText>;
        this.emitPrivate(writer);
        return null;
      }
      case "private_rekey": {
        if (!this.unlocked)
          throw new PreviewError("PRIVATE_LOCKED", "私密层未解锁，无法修改密码");
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        this.password = this.checkPassword(args.password);
        this.emitPrivate(writer);
        return null;
      }
      case "private_reset": {
        if (this.unlocked) {
          throw new PreviewError(
            "RESET_WHEN_UNLOCKED",
            "已解锁的会话请用「修改密码」，重置会清空私密内容",
          );
        }
        if (this.password === null)
          throw new PreviewError("PRIVATE_MISSING", "私密层还没有设置");
        this.password = this.checkPassword(args.password);
        this.sealed = {};
        this.unlocked = true;
        this.emitPrivate(writer);
        this.note("私密层重置：封套内容全部清除");
        return null;
      }

      // —— 窗口（commands/window.rs：产出动作，由宿主落成 iframe）——
      case "create_floating_sticky": {
        const id = `s-${nowMs().toString(36)}`;
        const now = nowMs();
        this.stickies.set(id, {
          id,
          title: "",
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
        this.emit("sticky", writer);
        this.actions.push({ kind: "open-sticky", id });
        return id;
      }
      case "open_floating_sticky":
        this.openStickyRouted(args.id as string);
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
      case "open_unlock_window":
        this.actions.push({ kind: "open-panel", label: "unlock" });
        return null;
      case "close_unlock_window":
        this.actions.push({ kind: "close-panel", label: "unlock" });
        return null;
      case "open_ring_window":
        // 真机每次开在光标处（ring.rs::place_at_cursor 走 GetCursorPos + 工作区夹回），
        // 预览台没有 OS 光标语义，就摆在画布左上——环本身的行为照样能验
        this.note("星环：预览台摆左上，真机落光标处（这条差异不看成 bug）");
        this.actions.push({ kind: "open-panel", label: "ring" });
        return null;
      case "close_ring_window":
        // 与 Rust 同口径：关 = 隐藏（星环要秒开，销毁再建 WebView 的代价落在按键到看见之间）
        this.actions.push({ kind: "close-panel", label: "ring" });
        return null;

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
      // 预览台的每一扇 iframe 窗本来就一直在显示，没有"建隐窗再亮"这一步；
      // 这条必须是 no-op 而不是"未知命令"，否则便签入口每次挂载都会红一条
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
        // 空串 = 显式停用，合法。非空的形状判据只是**近似**：真侧是 global-hotkey 的
        // parse，这里只查"修饰键 + 恰好一个主键"的形状，所以"形状对但解析器不认"
        // （如 Ctrl+Plus 写法差异）这类错在预览台验不出来——别把它当改键已验。
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
        // 参数嵌在 `input` 里（Rust 侧签名是 `input: MediaInput`，前端 invoke({ input })）。
        // PreviewArgs.input 的类型位被 StickyInput 占了，这里只能过 unknown 折开——
        // 曾经在这里按顶层读，宽高一律读到 0，报"图片尺寸 0x0 不合理"
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
        if (enc && !this.unlocked) {
          // 与 Rust 同一条：宁可不存，也不把私密图写成明文
          throw new PreviewError("PRIVATE_LOCKED", "私密层未解锁");
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
        if (record.enc && !this.unlocked) {
          throw new PreviewError("PRIVATE_LOCKED", "私密层未解锁");
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
        if (target && !this.unlocked) {
          throw new PreviewError("PRIVATE_LOCKED", "私密层未解锁");
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

  /**
   * 桌面上开着的浮窗矩形由宿主挂进来（假核不摆 iframe，rect 全在 host 手里）。
   * 默认空表：没挂上就是"桌面上一扇浮窗都没有"，前端最多判不出命中，不会误并。
   */
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

  /** 私密便签在主库里只留占位：读侧合并、写侧拆分发生在前端包装层，这里存的就是盘上形状 */
  snapshot(): {
    stickies: StickyNote[];
    groups: StickyGroup[];
    settings: Array<[string, string]>;
    private: {
      configured: boolean;
      unlocked: boolean;
      sealed: Record<string, SealedText>;
    };
    log: string[];
  } {
    return {
      stickies: this.ordered(true),
      groups: [...this.groups.values()],
      settings: [...this.settings.entries()],
      private: {
        configured: this.password !== null,
        unlocked: this.unlocked,
        sealed: this.sealed,
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
