// withPrivateLayer 行为契约 — 读写拆合的语义：
// 未启用直通 / 启用未解锁只写占位 / 启用已解锁读合并写拆分 / 硬删带走真身 /
// 落盘形状只认 privateStatus 的权威状态——缓存位晚半拍既不许写成明文，
// 也不许在没装填封套的情况下整份重写（那会抹掉别人的真身）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StickyInput, StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";
import { withPrivateLayer } from "@/store/private-backend";
import { sealedRevert, sealedRevisions } from "@/store/private-backend";
import type { NotesBackend } from "@/store/backend";

/** private-state 的缓存位（界面遮罩用它）：用例故意让它与 authority 不一致 */
const cache = { active: false, unlocked: false };
/** Rust 的权威状态，即 privateStatus 的返回值 */
const authority = { configured: false, unlocked: false };
const savedMaps: string[] = [];

/** 缓存与权威一致的摆位（大多数用例用这个） */
function layer(active: boolean, unlocked: boolean): void {
  cache.active = active;
  cache.unlocked = unlocked;
  authority.configured = active;
  authority.unlocked = unlocked;
}

vi.mock("@/data/private-state", () => ({
  isPrivateLayerActive: () => cache.active,
  isPrivateUnlocked: () => cache.unlocked,
}));
vi.mock("@/platform/commands", () => ({
  privateStatus: vi.fn(() =>
    Promise.resolve({ configured: authority.configured, unlocked: authority.unlocked }),
  ),
  privateLoad: vi.fn(() => Promise.resolve(JSON.stringify(sealedOnDisk))),
  privateSave: vi.fn((data: string) => {
    savedMaps.push(data);
    // 真机 privateSave 是整份覆盖，这里也照覆盖：不这么做，"写完再读"那条用例
    // 读到的还是播种时那份，回滚路径就永远测不到自己写进去的东西
    putDisk(JSON.parse(data) as Record<string, unknown>);
    return Promise.resolve();
  }),
}));

// 私密封套在"盘上"的形状（privateLoad 的假体数据源；privateSave 整份换掉它）
const sealedOnDisk: Record<string, unknown> = {};

function putDisk(map: Record<string, unknown>): void {
  for (const key of Object.keys(sealedOnDisk)) delete sealedOnDisk[key];
  Object.assign(sealedOnDisk, map);
}

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
  layer(false, false);
  savedMaps.length = 0;
  putDisk({
    s1: {
      title: "加密的真身标题",
      body: "加密的真身正文",
      contentType: "text",
      items: [],
      timeline: [],
      tags: [],
    },
  });
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
    layer(true, true);
    const backend = withPrivateLayer(inner);
    const rows = await backend.bootstrap();
    expect(rows.find((row) => row.id === "s1")?.title).toBe("加密的真身标题");
    expect(rows.find((row) => row.id === "s1")?.body).toBe("加密的真身正文");
    expect(rows.find((row) => row.id === "s2")?.title).toBe("普通便签");
  });

  it("启用但未解锁：保持占位（锁定态显示遮罩，不泄露真身）", async () => {
    layer(true, false);
    const backend = withPrivateLayer(inner);
    const rows = await backend.bootstrap();
    expect(rows.find((row) => row.id === "s1")?.title).toBe("");
  });
});

describe("写拆分", () => {
  it("未启用：私密标记只是标记，内容明文进主库", async () => {
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "明文标题" }));
    expect(inner.upserts[0].title).toBe("明文标题");
    expect(savedMaps.length).toBe(0);
  });

  it("启用且已解锁：真身进密封套，主库只落占位", async () => {
    layer(true, true);
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
    layer(true, false);
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "" }));
    expect(savedMaps.length).toBe(0);
    expect(inner.upserts[0].title).toBe("");
  });

  /**
   * 返回值这一支单独钉：`notes-store.flushNow` 拿它**整份**换掉内存里那条
   * （`notes.set(id, saved)`，为的是回填 Rust 盖的 updatedAt）。主库那份对私密便签
   * 只有空占位，照原样返回就等于每次落库把这张的标题和正文从内存里抹掉——
   * 真机报的"输入标题后内容丢失"走的正是这条。
   */
  it("启用且已解锁：返回的行要带回真身，不是主库那份占位", async () => {
    layer(true, true);
    const backend = withPrivateLayer(inner);
    const saved = await backend.upsert(
      note("s1", { private: true, title: "新真身", body: "新正文" }),
    );
    expect(saved.title).toBe("新真身");
    expect(saved.body).toBe("新正文");
    expect(saved.private).toBe(true);
    // 时间戳仍取后端那份权威的
    expect(saved.updatedAt).toBe(2);
  });

  it("启用且已解锁：返回的是刚写进密封套的那一份", async () => {
    layer(true, true);
    const backend = withPrivateLayer(inner);
    // 先落一次，让 sealed 里有了这张的真身（sealedOnDisk 里那张是别人的）
    const first = await backend.upsert(
      note("s1", { private: true, title: "第一版", body: "第一版正文" }),
    );
    expect(first.title).toBe("第一版");
    const second = await backend.upsert(
      note("s1", { private: true, title: "第二版", body: "第二版正文" }),
    );
    expect(second.title).toBe("第二版");
    expect(second.body).toBe("第二版正文");
  });

  it("缓存位还停在未配置、后端其实已配好并解锁：不许把明文写进主库", async () => {
    // 刚配完口令的那一窗：store:private-changed 的往返还没落地，本地缓存说"没配置"
    cache.active = false;
    cache.unlocked = false;
    authority.configured = true;
    authority.unlocked = true;
    const backend = withPrivateLayer(inner);
    await backend.upsert(
      note("s3", { private: true, title: "刚标私密的标题", body: "正文" }),
    );
    const row = inner.upserts[0];
    expect(row.title).toBe("");
    expect(row.body).toBe("");
    expect(savedMaps.length, "真身该进封套，不该留在主库").toBe(1);
  });

  it("整份重写封套前先装填：别人的真身不许被抹掉", async () => {
    cache.active = false;
    cache.unlocked = false;
    authority.configured = true;
    authority.unlocked = true;
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s3", { private: true, title: "新加的私密" }));
    const savedMap = JSON.parse(savedMaps[0] ?? "{}") as Record<
      string,
      { title: string }
    >;
    expect(savedMap.s1?.title, "privateSave 是整份重写，必须先读回原有内容").toBe(
      "加密的真身标题",
    );
    expect(savedMap.s3?.title).toBe("新加的私密");
  });
});

describe("硬删", () => {
  it("真删私密便签：密封套里的真身一并带走", async () => {
    layer(true, true);
    const backend = withPrivateLayer(inner);
    await backend.bootstrap(); // 真实流程里 sealed 先随读入同步
    await backend.remove("s1", true);
    expect(savedMaps.length).toBe(1);
    const savedMap = JSON.parse(savedMaps[0]) as Record<string, unknown>;
    expect(savedMap.s1).toBeUndefined();
  });

  it("软删不动密封套（恢复后内容还在）", async () => {
    layer(true, true);
    const backend = withPrivateLayer(inner);
    await backend.remove("s1", false);
    expect(savedMaps.length).toBe(0);
  });
});

/**
 * 私密便签的历史住封套，不住那张明文表（作者拍的：要有历史，但必须输口令才看得到）。
 * 于是"看历史"与"看正文"共用同一道门——读路径没有第二条能绕过它。
 */
describe("私密历史版本住封套", () => {
  type DiskEntry = {
    title: string;
    revisions?: { seq: number; content: { title: string } }[];
  };
  const diskTitles = (): string[] =>
    ((sealedOnDisk.s1 as DiskEntry).revisions ?? []).map((row) => row.content.title);

  it("第一次改动记的是播种那份；同一瞬内再改不重复占格", async () => {
    layer(true, true);
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "第一版", body: "正文一" }));
    expect(diskTitles()).toEqual(["加密的真身标题"]);
    await backend.upsert(note("s1", { private: true, title: "第二版", body: "正文二" }));
    // 冷却内一个字都不多占（vitest 的 toEqual 不收第二参数，说明只能写在这儿）
    expect(diskTitles()).toEqual(["加密的真身标题"]);
    // 主库那份永远是占位：私密内容一个字都不进明文历史表
    expect(inner.upserts.at(-1)?.title).toBe("");
    expect(inner.upserts.at(-1)?.body).toBe("");
  });

  it("冷却之外且内容变了 → 记第二版", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    layer(true, true);
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "第一版" }));
    vi.setSystemTime(new Date(1_700_000_061_000));
    await backend.upsert(note("s1", { private: true, title: "第二版" }));
    expect(diskTitles()).toEqual(["加密的真身标题", "第一版"]);
    vi.useRealTimers();
  });

  it("sealedRevisions 新的在前；回滚换得回去，并把回滚前那份强记成一版", async () => {
    layer(true, true);
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "第一版", body: "正文一" }));
    await backend.upsert(note("s1", { private: true, title: "第二版", body: "正文二" }));
    const rows = await sealedRevisions("s1");
    expect(rows.map((row) => row.title)).toEqual(["加密的真身标题"]);
    expect(rows[0].contentType).toBe("text");

    const applied = await sealedRevert("s1", rows[0].seq);
    expect(applied.title).toBe("加密的真身标题");
    expect((sealedOnDisk.s1 as DiskEntry).title).toBe("加密的真身标题");
    // 回滚绕得过冷却：刚被换掉的"第二版"必须留在列表里，不然回滚回滚错了就没有路
    expect(diskTitles()).toEqual(["加密的真身标题", "第二版"]);
    expect((await sealedRevisions("s1")).map((row) => row.title)).toEqual([
      "第二版",
      "加密的真身标题",
    ]);
  });

  it("硬删私密便签：封套条目连同它那一串版本一起走", async () => {
    layer(true, true);
    const backend = withPrivateLayer(inner);
    await backend.upsert(note("s1", { private: true, title: "第一版" }));
    expect(diskTitles()).toHaveLength(1);
    await backend.remove("s1", true);
    expect(sealedOnDisk.s1).toBeUndefined();
  });
});
