// withPrivateLayer 行为契约 — 读写拆合的四条语义：
// 未启用直通 / 启用未解锁只写占位 / 启用已解锁读合并写拆分 / 硬删带走真身。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StickyInput, StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";
import { withPrivateLayer } from "@/store/private-backend";
import type { NotesBackend } from "@/store/backend";

const state = { active: false, unlocked: false };
const savedMaps: string[] = [];

vi.mock("@/data/private-state", () => ({
  isPrivateLayerActive: () => state.active,
  isPrivateUnlocked: () => state.unlocked,
}));
vi.mock("@/platform/commands", () => ({
  privateLoad: vi.fn(() => Promise.resolve(JSON.stringify(sealedOnDisk))),
  privateSave: vi.fn((data: string) => {
    savedMaps.push(data);
    return Promise.resolve();
  }),
}));

// 私密封套在"盘上"的形状（privateLoad 的假体数据源）
const sealedOnDisk: Record<string, { title: string; body: string }> = {
  s1: { title: "加密的真身标题", body: "加密的真身正文" },
};

function note(id: string, overrides: Partial<StickyNote> = {}): StickyNote {
  return { ...createDefaultSticky(id, 1_700_000_000_000), ...overrides };
}

class FakeBackend implements NotesBackend {
  rows = new Map<string, StickyNote>();
  upserts: StickyInput[] = [];
  removals: Array<{ id: string; hard: boolean }> = [];

  bootstrap(): Promise<StickyNote[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  list(): Promise<StickyNote[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  upsert(input: StickyInput): Promise<StickyNote> {
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

let inner: FakeBackend;

beforeEach(() => {
  state.active = false;
  state.unlocked = false;
  savedMaps.length = 0;
  sealedOnDisk["s1"] = { title: "加密的真身标题", body: "加密的真身正文" };
  inner = new FakeBackend();
  // 主库里私密便签只有空占位（Rust 侧写拆分的结果）
  inner.rows.set("s1", note("s1", { private: true, title: "", body: "" }));
  inner.rows.set("s2", note("s2", { title: "普通便签" }));
});

describe("读合并", () => {
  it("未启用：私密行按主库占位原样读出（内容本来就在主库）", async () => {
    const backend = withPrivateLayer(inner);
    const rows = await backend.bootstrap();
    expect(rows.find((row) => row.id === "s1")?.title).toBe("");
  });

  it("启用且已解锁：私密行合并回真身，普通行不动", async () => {
    state.active = true;
    state.unlocked = true;
    const backend = withPrivateLayer(inner);
    const rows = await backend.bootstrap();
    expect(rows.find((row) => row.id === "s1")?.title).toBe("加密的真身标题");
    expect(rows.find((row) => row.id === "s1")?.body).toBe("加密的真身正文");
    expect(rows.find((row) => row.id === "s2")?.title).toBe("普通便签");
  });

  it("启用但未解锁：保持占位（锁定态显示遮罩，不泄露真身）", async () => {
    state.active = true;
    state.unlocked = false;
    const backend = withPrivateLayer(inner);
    const rows = await backend.bootstrap();
    expect(rows.find((row) => row.id === "s1")?.title).toBe("");
  });
});

describe("写拆分", () => {
  it("未启用：私密标记只是标记，内容明文进主库", async () => {
    state.active = false;
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "明文标题" }));
    expect(inner.upserts[0].title).toBe("明文标题");
    expect(savedMaps.length).toBe(0);
  });

  it("启用且已解锁：真身进密封套，主库只落占位", async () => {
    state.active = true;
    state.unlocked = true;
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "新真身", body: "新正文" }));
    expect(savedMaps.length).toBe(1);
    const savedMap = JSON.parse(savedMaps[0]) as Record<string, { title: string }>;
    expect(savedMap.s1.title).toBe("新真身");
    const row = inner.upserts[0];
    expect(row.title).toBe("");
    expect(row.body).toBe("");
    expect(row.private).toBe(true);
    expect(row.theme).toBe("yellow"); // 非敏感字段照常落库
  });

  it("启用但未解锁：只写占位，不碰密封套", async () => {
    state.active = true;
    state.unlocked = false;
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "" }));
    expect(savedMaps.length).toBe(0);
    expect(inner.upserts[0].title).toBe("");
  });
});

describe("硬删", () => {
  it("真删私密便签：密封套里的真身一并带走", async () => {
    state.active = true;
    state.unlocked = true;
    const backend = withPrivateLayer(inner);
    await backend.bootstrap(); // 真实流程里 sealed 先随读入同步
    await backend.remove("s1", true);
    expect(savedMaps.length).toBe(1);
    const savedMap = JSON.parse(savedMaps[0]) as Record<string, unknown>;
    expect(savedMap.s1).toBeUndefined();
  });

  it("软删不动密封套（恢复后内容还在）", async () => {
    state.active = true;
    state.unlocked = true;
    const backend = withPrivateLayer(inner);
    await backend.remove("s1", false);
    expect(savedMaps.length).toBe(0);
  });
});
