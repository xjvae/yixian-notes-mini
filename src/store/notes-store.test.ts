// notes-store 行为契约 — 数据核的保险绳。这三组用例钉住的是重构方案里
// 点名的三条语义：实体粒度写、远端合流不覆盖在途编辑、落库失败保留重试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbChangedEvent, StickyInput, StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";
import type { NotesBackend } from "@/store/backend";
import {
  getNote,
  hydrateStore,
  initStore,
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
}));

function note(id: string, overrides: Partial<StickyNote> = {}): StickyNote {
  return { ...createDefaultSticky(id, 1_700_000_000_000), ...overrides };
}

class MemoryBackend implements NotesBackend {
  rows = new Map<string, StickyNote>();
  upserts: StickyInput[] = [];
  removals: Array<{ id: string; hard: boolean }> = [];
  failNextUpserts = 0;

  bootstrap(): Promise<StickyNote[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  list(): Promise<StickyNote[]> {
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
    // 下一次 flush（下一次编辑触发）把没落成的再送一遍
    updateNote("b", { title: "乙二" });
    await vi.advanceTimersByTimeAsync(250);
    const sent = backend.upserts.map((input) => input.id).sort();
    expect(sent).toEqual(["a", "b"]);
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
});
