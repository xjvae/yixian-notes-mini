// 预览台的假数据核 — 命令语义逐条对着 Rust 抄（ commands/*.rs + db/query/*.rs ）。
//
// 抄的是**行为**不是代码：排序、时间戳归属、deleted_at 的 CASE、软删置 floating=0、
// 幽灵组拒绝、检索转义与标题优先、私密层错误码。语义改了这边没跟上，预览台就在骗人——
// 所以每条都标了出处。改 Rust 侧对应行为时，这里必须一起改。
//
// 假核不承担窗口系统的真实动作：窗口类命令产出一条 WindowAction，由宿主落成 iframe。

import type {
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
  shortcut?: string;
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
  private dockSlots = 0;
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
    this.actions.length = 0;
    this.broadcasts.length = 0;
    this.log.length = 0;
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

      // —— 贴边与工作区 ——
      case "float_dock_register":
        this.dockSlots += 1;
        return this.dockSlots;
      case "float_dock_unregister":
        return null;
      case "monitor_work_area":
        return { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height };

      // —— 快捷键（真侧校验键位并热重绑，预览台只记账）——
      case "app_set_hotkey": {
        const key = args.shortcut ?? "";
        if (key.trim() !== "" && !/^(Alt\+|Ctrl\+|Shift\+|Super\+)/.test(key)) {
          throw new PreviewError("BAD_SHORTCUT", `键位 ${JSON.stringify(key)} 不合法`);
        }
        this.settings.set("hotkeys", JSON.stringify({ [args.action as string]: key }));
        this.note(`快捷键记账（不真重绑）：${String(args.action)} → ${key || "（关）"}`);
        return null;
      }

      default:
        throw new PreviewError("PREVIEW_UNIMPLEMENTED", `预览台没实现命令：${cmd}`);
    }
  }

  viewport = { width: 1440, height: 900 };

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
