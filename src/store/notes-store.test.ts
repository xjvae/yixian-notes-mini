// notes-store 行为契约 — 数据核的保险绳。这三组用例钉住的是重构方案里
// 点名的三条语义：实体粒度写、远端合流不覆盖在途编辑、落库失败保留重试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbChangedEvent, StickyInput, StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";
import type { NotesBackend } from "@/store/backend";
import {
  flushNow,
  getNote,
  getTitlesSnapshot,
  hydrateStore,
  initStore,
  removeNote,
  resetStoreForTests,
  updateNote,
} from "@/store/notes-store";

// 桥是 store 的接缝：label 固定 "self-window"，listen 的处理器被捕获供用例派发
const changeHandlers: Array<(payload: DbChangedEvent) => void> = [];

vi.mock("@/platform/bridge", () => ({
  currentWindowLabel: () => "self-window",
  listen: vi.fn((_event: string, handler: (payload: DbChangedEvent) => void) => {
    changeHandlers.push(handler);
    return Promise.resolve(() => {});
  }),
  // 失败路径会走 `logger.warn` → `log_write` → `invoke`。这一格不补，
  // "坏行被丢弃但不拖垮整屏"那条就在 mock 缺口上崩，测不到它真正要测的东西
  invoke: vi.fn(() => Promise.resolve(null)),
}));

function note(id: string, overrides: Partial<StickyNote> = {}): StickyNote {
  return { ...createDefaultSticky(id, 1_700_000_000_000), ...overrides };
}

class MemoryBackend implements NotesBackend {
  rows = new Map<string, StickyNote>();
  upserts: StickyInput[] = [];
  removals: Array<{ id: string; hard: boolean }> = [];
  failNextUpserts = 0;
  /** 整库重拉有几发：带实体的广播不该再多加一发 */
  listCalls = 0;

  bootstrap(): Promise<StickyNote[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  list(): Promise<StickyNote[]> {
    this.listCalls += 1;
    return Promise.resolve([...this.rows.values()]);
  }
  upsert(input: StickyInput): Promise<StickyNote> {
    if (this.failNextUpserts > 0) {
      this.failNextUpserts -= 1;
      return Promise.reject(new Error("磁盘写失败（假体注入）"));
    }
    this.upserts.push(input);
    const saved = { ...input, deletedAt: null, createdAt: 1, updatedAt: 2 };
    this.rows.set(input.id, saved);
    return Promise.resolve(saved);
  }
  remove(id: string, hard: boolean): Promise<void> {
    this.removals.push({ id, hard });
    if (hard) this.rows.delete(id);
    return Promise.resolve();
  }
}

let backend: MemoryBackend;

beforeEach(() => {
  changeHandlers.length = 0;
  backend = new MemoryBackend();
  backend.rows.set("a", note("a", { title: "甲" }));
  backend.rows.set("b", note("b", { title: "乙" }));
  initStore(backend);
});

afterEach(() => {
  resetStoreForTests();
  vi.useRealTimers();
});

describe("hydrateStore", () => {
  it("先订阅后读：hydrate 返回时变更监听已就位", async () => {
    await hydrateStore();
    expect(changeHandlers.length).toBe(1);
    expect(getNote("a")?.title).toBe("甲");
  });

  it("坏行被丢弃但不拖垮整屏", async () => {
    backend.rows.set("bad", note("bad", { id: "" }));
    await hydrateStore();
    expect(getNote("bad")).toBeNull();
    expect(getNote("a")).not.toBeNull();
  });
});

describe("updateNote 实体粒度写", () => {
  it("乐观生效；去抖后只落改动过的那一实体", async () => {
    vi.useFakeTimers();
    await hydrateStore();
    expect(updateNote("a", { title: "甲二" })).toBe(true);
    expect(getNote("a")?.title).toBe("甲二");
    expect(backend.upserts.length).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(backend.upserts.length).toBe(1);
    expect(backend.upserts[0].id).toBe("a");
    expect(backend.upserts[0].title).toBe("甲二");
    // 时间戳由 Rust 权威回填
    expect(getNote("a")?.updatedAt).toBe(2);
  });

  it("失败保留在途并重试成功", async () => {
    vi.useFakeTimers();
    await hydrateStore();
    backend.failNextUpserts = 1;
    updateNote("a", { title: "甲三" });
    await vi.advanceTimersByTimeAsync(250);
    expect(backend.upserts.length).toBe(0);
    // 下一次编辑（或下面那条例子演的自动退避）把没落成的再送一遍
    updateNote("b", { title: "乙二" });
    await vi.advanceTimersByTimeAsync(250);
    const sent = backend.upserts.map((input) => input.id).sort();
    expect(sent).toEqual(["a", "b"]);
  });

  /**
   * 界面上那句"会自己退避重试"以前是假的：失败只把 id 放回 pending，没有定时器，
   * 得等用户再改一笔或别的东西触发 flush。现在失败自己排下一次，且间隔翻倍封顶 10 秒
   * （不设上限就是拿一个坏数据库每 250ms 撞一次 IPC）。
   */
  it("落库失败之后自己退避重试，不用再敲一笔", async () => {
    vi.useFakeTimers();
    await hydrateStore();
    backend.failNextUpserts = 1;
    updateNote("a", { title: "甲四" });
    await vi.advanceTimersByTimeAsync(250);
    expect(backend.upserts.length, "那一次失败了").toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(backend.upserts.map((input) => input.title)).toEqual(["甲四"]);
  });

  /** 锁着那一发重试也不会成：不空转，等解锁时 boot 那条订阅主动补做 */
  it("私密层锁着的失败不空转重试", async () => {
    vi.useFakeTimers();
    await hydrateStore();
    let calls = 0;
    backend.upsert = () => {
      calls += 1;
      // 真机上是 Tauri 把 AppError 折成 {code,message} 抛回来；`isAppError` 认的是字段，
      // 所以挂在一个 Error 上模拟（裸对象当 rejection 理由会被 eslint 拦）
      const error = new Error("私密层已锁上") as Error & { code: string };
      error.code = "PRIVATE_LOCKED";
      return Promise.reject(error);
    };
    updateNote("a", { body: "刚打的字" });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls, "只送最初那一次，之后不自己撞").toBe(1);
    expect(getNote("a")?.body, "改动仍在内存里，等解锁补做").toBe("刚打的字");
  });

  /**
   * 正在飞的那一条必须一路算"在途"。以前 `flushNow` 一进门就 `pending.clear()`，
   * 于是请求已上路、内存还是旧的一份，此时另一扇窗的 `db:changed` 到了 →
   * `refreshFromRemote`（只保护 pending 里的 id）会把这条刚敲的字当旧数据盖掉。
   */
  it("落库在途期间来的远端刷新，不许吃掉这一笔", async () => {
    await hydrateStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.upsert = (input) =>
      gate.then(() => ({ ...input, deletedAt: null, createdAt: 1, updatedAt: 2 }));

    updateNote("a", { body: "这窗刚敲的" });
    const inflight = flushNow();
    // 另一扇窗改了这张并广播过来：远端那份是旧的（它还没收到这一笔）
    backend.rows.set("a", { ...note("a"), body: "另一窗那份旧的" });
    changeHandlers[0]({ writer: "other-window", kind: "sticky" });
    await Promise.resolve();
    await Promise.resolve();
    release();
    await inflight;

    expect(getNote("a")?.body, "在途的那一条以本地为准").toBe("这窗刚敲的");
  });

  it("组由后端直改：回填内存后整行 upsert 不许覆回原组", async () => {
    vi.useFakeTimers();
    await hydrateStore();
    updateNote("a", { groupId: "g1" });
    await vi.advanceTimersByTimeAsync(250);
    // sticky_set_group 走的是 SQLite 直 UPDATE，不过 store：内存不回填，
    // 下一次整行 upsert 就把便签悄悄塞回原组（移出错觉成功，其实是没移走）
    updateNote("a", { groupId: null });
    updateNote("a", { title: "移出之后又改了标题" });
    await vi.advanceTimersByTimeAsync(250);
    const last = backend.upserts.at(-1);
    expect(last?.title).toBe("移出之后又改了标题");
    expect(last?.groupId).toBeNull();
  });

  /**
   * 上一那条用例要的是"整行换成后端那份权威的"，这一条要的是"往返期间新敲的不能没"——
   * 两者不冲突，分界线是**内存里这一份还是不是发出时那一份**（`updateNote` 每次换新对象，
   * 所以引用相等就是"这一路没再改过"）。丢进去判据就没了。
   *
   * 私密便签以前在这条路上最宽（`privateStatus` + 解密整个封套 + 重加密写文件 +
   * `sticky_upsert`，还捎带让所有窗重读一遍），所以真机上第一个撞上的是它：作者报的
   * "内容输入有问题"。现在拆分与合并都进了 Rust 的一次 `sticky_upsert`，往返宽度与
   * 公开便签一样——判据没变，只是不再是那条最容易撞的路径了。
   */
  it("落库往返期间又敲的字，不许被返回的旧快照整行盖回去", async () => {
    await hydrateStore();
    const sent: StickyInput[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.upsert = (input) => {
      sent.push(input);
      return gate.then(() => ({ ...input, deletedAt: null, createdAt: 1, updatedAt: 2 }));
    };

    updateNote("a", { body: "第一段" });
    const inflight = flushNow();
    // 上面那次落库还在路上，接着敲第二个字组
    updateNote("a", { body: "第一段第二段" });
    release();
    await inflight;

    expect(getNote("a")?.body).toBe("第一段第二段");
    expect(sent).toHaveLength(1);
    // 新的那一份没被吃掉：还在在途集合里，下一次 flush 照常送出去
    updateNote("a", { title: "顺带改个标题" });
    await flushNow();
    expect(sent.at(-1)?.body).toBe("第一段第二段");
    expect(sent.at(-1)?.title).toBe("顺带改个标题");
  });

  it("往返期间没再改过：仍然整行换成后端那份权威的（后端直改的字段要拉回来）", async () => {
    await hydrateStore();
    updateNote("a", { title: "甲二" });
    await flushNow();
    // 时间戳由后端权威回填（上一批用例已经钉过，这里当"整行换了"的可见记号）
    expect(getNote("a")?.updatedAt).toBe(2);
    expect(getNote("a")?.createdAt).toBe(1);
  });
});

describe("远端合流", () => {
  it("本窗写入不回灌；远端变更不覆盖在途编辑", async () => {
    await hydrateStore();
    vi.useFakeTimers();
    updateNote("a", { title: "本地在途" });
    // 远端此刻广播了 b 的改动 + a 的旧值（写者不是本窗）
    backend.rows.set("a", note("a", { title: "远端旧值" }));
    backend.rows.set("b", note("b", { title: "远端新乙" }));
    for (const handler of changeHandlers) {
      handler({ writer: "other-window", kind: "sticky" });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(getNote("a")?.title).toBe("本地在途");
    expect(getNote("b")?.title).toBe("远端新乙");
    // 本窗自己的写入（flush）不触发回灌：writer = self-window 的广播被跳过
    for (const handler of changeHandlers) {
      handler({ writer: "self-window", kind: "sticky" });
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(backend.upserts.map((input) => input.id)).toContain("a");
  });

  it("flush 后在途集合清空，此后远端值生效", async () => {
    await hydrateStore();
    vi.useFakeTimers();
    updateNote("a", { title: "本地" });
    await vi.advanceTimersByTimeAsync(250);
    backend.rows.set("a", note("a", { title: "更新的远端值" }));
    for (const handler of changeHandlers) {
      handler({ writer: "other-window", kind: "sticky" });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(getNote("a")?.title).toBe("更新的远端值");
  });

  it("带实体的广播只合那一张：不多发一发整库重拉", async () => {
    await hydrateStore();
    const before = backend.listCalls;
    for (const handler of changeHandlers) {
      handler({
        writer: "other-window",
        kind: "sticky",
        note: note("b", { title: "远端新乙" }),
      });
    }
    expect(getNote("b")?.title).toBe("远端新乙");
    // 没被点到的那张原样留着
    expect(getNote("a")?.title).toBe("甲");
    // 带实体那一发不必重拉全量
    expect(backend.listCalls).toBe(before);
  });

  it("带实体的广播撞上在途那一张：本地那份说了算", async () => {
    await hydrateStore();
    vi.useFakeTimers();
    updateNote("a", { title: "本地在途" });
    for (const handler of changeHandlers) {
      handler({
        writer: "other-window",
        kind: "sticky",
        note: note("a", { title: "远端旧值" }),
      });
    }
    expect(getNote("a")?.title).toBe("本地在途");
    await vi.advanceTimersByTimeAsync(250);
    // 落完库回填的也是本地那句（后端权威行就是它）
    expect(getNote("a")?.title).toBe("本地在途");
  });

  it("没带实体的广播（删除、并组那条路）照旧整库重拉", async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const before = backend.listCalls;
    backend.rows.set("b", note("b", { title: "远端新乙" }));
    for (const handler of changeHandlers) {
      handler({ writer: "other-window", kind: "sticky" });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.listCalls).toBeGreaterThan(before);
    expect(getNote("b")?.title).toBe("远端新乙");
  });
});

describe("getTitlesSnapshot 的引用稳定性", () => {
  it("敲正文不带重渲：标题没变就还是同一个 Map", async () => {
    await hydrateStore();
    const before = getTitlesSnapshot();
    updateNote("a", { body: "刚敲的一个字" });
    expect(getTitlesSnapshot()).toBe(before);
  });

  it("改标题要换引用，值得跟着变", async () => {
    await hydrateStore();
    const before = getTitlesSnapshot();
    updateNote("a", { title: "改过的名" });
    const after = getTitlesSnapshot();
    expect(after).not.toBe(before);
    expect(after.get("a")).toBe("改过的名");
    expect(after.get("b")).toBe("乙");
  });

  it("删掉一张也算变（胶囊的名字不能停在已经不存在的哪一张上）", async () => {
    await hydrateStore();
    const before = getTitlesSnapshot();
    vi.useFakeTimers();
    await removeNote("b", true);
    expect(getTitlesSnapshot()).not.toBe(before);
    expect(getTitlesSnapshot().has("b")).toBe(false);
  });
});
