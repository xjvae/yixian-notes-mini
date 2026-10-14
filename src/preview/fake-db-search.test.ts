// 预览台的检索契约 — 把 `db/query/search.rs` 的判据在 TS 侧钉住：空查询给最近的便签、
// 清单与时间轴的命中带着条目回来。假核与真机不一致时，预览台上看到的结果列表就是假的。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/preview/fake-db";
import type { SearchHit, SearchOutcome, StickyInput } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";

const WINDOW = "sticky-test";

/** 排序全靠 updatedAt，同一毫秒写完就是平局：让每次 Date.now() 走一格 */
let clock = 1_700_000_000_000;

function inputOf(id: string, overrides: Partial<StickyInput> = {}): StickyInput {
  const {
    createdAt: _c,
    updatedAt: _u,
    deletedAt: _d,
    ...rest
  } = createDefaultSticky(id, 1_700_000_000_000);
  return { ...rest, ...overrides };
}

function seed(db: FakeDb, input: StickyInput): void {
  db.handle("sticky_upsert", { input }, WINDOW);
}

function outcome(db: FakeDb, query: string): SearchOutcome {
  return db.handle("search_query", { query }, WINDOW) as SearchOutcome;
}

function hits(db: FakeDb, query: string): SearchHit[] {
  return outcome(db, query).hits;
}

function idsOf(rows: SearchHit[]): string[] {
  return rows.map((row) => row.id);
}

describe("预览台的检索", () => {
  beforeEach(() => {
    clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("空查询给最近的便签，私密与已删的照旧不进", () => {
    const db = new FakeDb();
    seed(db, inputOf("old", { title: "早写的" }));
    seed(db, inputOf("new", { title: "刚写的" }));
    seed(db, inputOf("secret", { title: "锁着的", private: true }));
    seed(db, inputOf("trash", { title: "已删的" }));
    db.handle("sticky_delete", { id: "trash", hard: false }, WINDOW);

    // 演示数据本来就在库里，这里只看"我造的两张排最前、私密与已删的不出现"
    expect(idsOf(hits(db, "")).slice(0, 2)).toEqual(["new", "old"]);
    const found = idsOf(hits(db, "   ")); // 一串空格也算空查询
    expect(found.slice(0, 2)).toEqual(["new", "old"]);
    expect(found).not.toContain("secret");
    expect(found).not.toContain("trash");
    // 锁着的那几张要作为"没参与"报出来（演示数据里本来就有私密的，所以只断数得着）
    expect(outcome(db, "").privateSkipped).toBeGreaterThanOrEqual(1);
  });

  it("命中带着条目回来：待办与时间轴的正文不住在 body 上", () => {
    const db = new FakeDb();
    seed(
      db,
      inputOf("todo", {
        title: "购物",
        contentType: "todo",
        body: "",
        items: [{ id: "i1", text: "买牛奶", done: false }],
      }),
    );
    seed(
      db,
      inputOf("track", {
        title: "就诊",
        contentType: "timeline",
        body: "",
        timeline: [{ id: "e1", at: 1_700_000_000_000, text: "复查血常规" }],
      }),
    );

    const [byItem] = hits(db, "牛奶");
    expect(byItem?.body).toBe("");
    expect(byItem?.items.map((item) => item.text)).toEqual(["买牛奶"]);

    const [byEntry] = hits(db, "血常规");
    expect(byEntry?.timeline.map((entry) => entry.text)).toEqual(["复查血常规"]);
  });
});
