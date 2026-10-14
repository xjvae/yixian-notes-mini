// 预览台的私密层行为契约 — 这一份是把 `db/query/private_note.rs` 与 `commands/revision.rs`
// 的判据在 TS 侧钉住：假核（`preview/fake-db.ts`）必须与真机同一套形状，
// 否则预览台看到的就是假数据，而他验收 UI 走的就是这一台。
//
// 真机上那三条表是密文（`private_content` / `private_revision` / `private_keys`，
// 一行一张、一张一把钥匙），假核存的是明文 map——差的是密码学，不差的是
// **谁在什么时候看得见什么**：一次口令只开那一张。

import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb, PreviewError } from "@/preview/fake-db";
import type { PreviewArgs } from "@/preview/fake-db";
import type { StickyInput, StickyNote } from "@/platform/contracts";
import { createDefaultSticky } from "@/data/entities";

const WINDOW = "sticky-test";
const PASSWORD = "口令至少八个字符";

function seedInput(id: string, overrides: Partial<StickyInput> = {}): StickyInput {
  const {
    createdAt: _c,
    updatedAt: _u,
    deletedAt: _d,
    ...rest
  } = createDefaultSticky(id, 1_700_000_000_000);
  return { ...rest, ...overrides };
}

function rows(db: FakeDb, includeDeleted = false): StickyNote[] {
  return db.handle("sticky_list", { includeDeleted }, WINDOW) as StickyNote[];
}

function upsert(db: FakeDb, input: StickyInput): StickyNote {
  return db.handle("sticky_upsert", { input }, WINDOW) as StickyNote;
}

/** 口令、删除那些条：结果要么是布尔/数字，要么就抛 */
function call(db: FakeDb, cmd: string, args: PreviewArgs): unknown {
  return db.handle(cmd, args, WINDOW);
}

/** 抛出来的错误码。测的就是"错在哪一格"，所以不吞 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof PreviewError
      ? error.code
      : `不是 PreviewError：${String(error)}`;
  }
  return "没抛错";
}

/** 揭开那几张：一道口令只开一张，所以每张各输一次 */
function open(db: FakeDb, ...ids: string[]): void {
  for (const id of ids) call(db, "private_reveal", { noteId: id, password: PASSWORD });
}

function sealedCount(db: FakeDb): number {
  return db.snapshot().private.sealedRows;
}

/** 现在开着哪几张（这一格就是逐张模型的全部真相） */
function opened(db: FakeDb): string[] {
  return db.snapshot().private.revealed;
}

function rowOf(db: FakeDb, id: string): StickyNote {
  return rows(db, true).find((row) => row.id === id) as StickyNote;
}

describe("私密层：没配置、揭开与收回", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("私密层没配置时私密便签照旧明文直通", () => {
    // 造一张"标了私密但层还没启用"的：内容就该落在行上
    const created = upsert(
      db,
      seedInput("p-plain", { private: true, body: "摊着的真身" }),
    );
    expect(created.body).toBe("摊着的真身");
    // 没启用就没有封这一说：表里只有播种那一张
    expect(sealedCount(db)).toBe(1);
    call(db, "private_lock", {});
    expect(rowOf(db, "p-plain").body).toBe("摊着的真身");
  });

  /** 设口令 ≠ 揭开某张。Rust 那边 master 只在输口令开某一张那一拍活着，收编就在那一拍 */
  it("设置口令这一刻不收编，也不揭开任何一张", () => {
    upsert(db, seedInput("p-adopt", { private: true, body: "从没被保护过的字" }));
    call(db, "private_setup", { password: PASSWORD });
    expect(opened(db)).toEqual([]);
    expect(sealedCount(db), "还没有一次口令，所以一个字都还没搬").toBe(1);
    // 而这一张此刻没进套，界面上它就该蒙着（真身还摊在行上，是旧账，见下面那条）
    expect(rowOf(db, "p-adopt").private).toBe(true);
  });

  /** 第一次有人输口令：全局那两件旧活顺手做完（收编明文残骸） */
  it("第一次揭开把还摊着的明文收进套，行改成占位", () => {
    upsert(db, seedInput("p-adopt", { private: true, body: "从没被保护过的字" }));
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p-adopt");
    // 收编 + 搬进这张自己的钥匙：读侧因为这张开着又把它合并回来，所以两边都要看
    expect(sealedCount(db)).toBe(2);
    expect(rowOf(db, "p-adopt").body).toBe("从没被保护过的字");
    call(db, "private_lock", {});
    expect(rowOf(db, "p-adopt").body, "收回就是占位").toBe("");
  });

  /** 这一条是整场重构的靶心：开了一张不等于开了整层 */
  it("揭开一张不会把另一张一起开", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1", "p2");
    upsert(db, seedInput("p1", { private: true, body: "第一张的真身" }));
    upsert(db, seedInput("p2", { private: true, body: "第二张的真身" }));
    call(db, "private_lock", {});
    open(db, "p1");

    expect(opened(db)).toEqual(["p1"]);
    const list = rows(db);
    expect(list.find((row) => row.id === "p1")?.body).toBe("第一张的真身");
    expect(list.find((row) => row.id === "p2")?.body, "没揭开的那张不许被顺手合并").toBe(
      "",
    );
  });

  it("没揭开时改一笔：抛回 PRIVATE_LOCKED，行与表都不动", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "旧的那份" }));
    call(db, "private_lock", {});

    const code = codeOf(() =>
      upsert(db, seedInput("p1", { private: true, body: "刚打的字" })),
    );
    expect(code).toBe("PRIVATE_LOCKED");
    open(db, "p1");
    expect(rowOf(db, "p1").body, "被拒的这一拍不许把真身降成占位").toBe("旧的那份");
  });

  it("错口令开不了这一张：一张都不许多开", () => {
    call(db, "private_setup", { password: PASSWORD });
    const code = codeOf(() =>
      call(db, "private_reveal", { noteId: "p1", password: "错口令八个字" }),
    );
    expect(code).toBe("CRYPTO_OPEN");
    expect(opened(db)).toEqual([]);
  });

  it("没揭开时递上占位：照写，表里那份原样留着", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "真身" }));
    call(db, "private_lock", {});

    const flipped = upsert(db, seedInput("p1", { private: true, pinned: false }));
    expect(flipped.pinned, "置顶翻过去了").toBe(false);
    expect(flipped.body, "没揭开读不到真身，这一拍还它就是占位").toBe("");

    open(db, "p1");
    expect(rowOf(db, "p1").body, "没揭开的一拍不许碰表里那一条").toBe("真身");
    expect(rowOf(db, "p1").pinned).toBe(false);
  });

  it("揭开着递上一份空：不许用它覆盖真身", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "不能丢" }));
    upsert(db, seedInput("p1", { private: true, body: "" }));
    expect(rowOf(db, "p1").body).toBe("不能丢");
  });

  it("没揭开不许把读不出真身的那张翻成公开", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "表里有真身" }));
    call(db, "private_lock", {});
    const code = codeOf(() =>
      upsert(db, seedInput("p1", { private: false, body: "外面递来的" })),
    );
    expect(code).toBe("PRIVATE_LOCKED");
    expect(sealedCount(db), "被拒这一拍不许摘掉表里那条").toBe(2);
  });

  it("收回是一次全收：托盘与自动上锁没有「只蒙回几张」这半动作", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1", "p2", "p3");
    expect(opened(db)).toEqual(["p1", "p2", "p3"]);
    call(db, "private_lock", {});
    expect(opened(db)).toEqual([]);
  });

  it("改密要两道口令，之后一张都不开着", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "改密之前的正文" }));
    const next = "换个长一点的口令";
    // 只交一道（旧的那条命令的形状）就是接不上 Rust
    expect(codeOf(() => call(db, "private_rekey", { password: PASSWORD }))).toBe(
      "PASSWORD_LENGTH",
    );
    call(db, "private_rekey", { password: PASSWORD, newPassword: next });
    expect(opened(db), "新旧 master 不是一把：开着的那几张当场不算数").toEqual([]);
    // 旧口令从此开不了任何东西
    expect(
      codeOf(() => call(db, "private_reveal", { noteId: "p1", password: PASSWORD })),
    ).toBe("CRYPTO_OPEN");
    call(db, "private_reveal", { noteId: "p1", password: next });
    expect(rowOf(db, "p1").body, "重裹的是钥匙，内容字节一个都没动").toBe(
      "改密之前的正文",
    );
  });

  it("重置只允许在一张都没开着时走", () => {
    call(db, "private_setup", { password: PASSWORD });
    open(db, "p1");
    expect(
      codeOf(() => call(db, "private_reset", { password: "重置后使用的新口令" })),
    ).toBe("RESET_WHEN_UNLOCKED");
    call(db, "private_lock", {});
    call(db, "private_reset", { password: "重置后使用的新口令" });
    expect(opened(db), "重置完不是「开着哪一张」").toEqual([]);
    expect(sealedCount(db), "旧钥匙解不开的那些行整批清掉").toBe(0);
  });
});

describe("私密层：历史版本与删除", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    call(db, "private_setup", { password: PASSWORD });
  });

  function revisions(id: string): { seq: number; preview: string }[] {
    return call(db, "sticky_revisions", { id }) as { seq: number; preview: string }[];
  }

  it("私密便签的版本走同一条命令，没揭开读不出", () => {
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "第一版" }));
    upsert(db, seedInput("p1", { private: true, body: "第二版" }));
    expect(revisions("p1").map((row) => row.preview)).toEqual(["第一版"]);
    call(db, "private_lock", {});
    expect(codeOf(() => revisions("p1"))).toBe("PRIVATE_LOCKED");
  });

  it("回滚私密便签的一版：内容回去，回滚前那份强记成一版", () => {
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "第一版" }));
    upsert(db, seedInput("p1", { private: true, body: "第二版" }));
    const target = revisions("p1")[0];
    const reverted = call(db, "sticky_revert", {
      id: "p1",
      seq: target.seq,
    }) as StickyNote;
    expect(reverted.body, "还回来的是合并过的行").toBe("第一版");
    expect(revisions("p1").map((row) => row.preview)).toEqual(["第二版", "第一版"]);
    // 行上不落一个字：私密便签的 stickies 永远是占位
    call(db, "private_lock", {});
    expect(rowOf(db, "p1").body).toBe("");
  });

  it("翻回公开：真身回到行上，表里那条连同版本一起摘掉", () => {
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "私密时的正文" }));
    upsert(db, seedInput("p1", { private: true, body: "改过一版" }));
    upsert(db, seedInput("p1", { private: false, body: "改过一版" }));
    expect(rowOf(db, "p1").body).toBe("改过一版");
    expect(sealedCount(db), "只剩播种那一张").toBe(1);
    call(db, "private_lock", {});
    expect(rowOf(db, "p1").body, "公开了就该收着也读得出").toBe("改过一版");
  });

  it("公开翻成私密那一拍，把它以前的明文版本一并清掉", () => {
    upsert(db, seedInput("s1", { private: false, body: "公开第一版" }));
    upsert(db, seedInput("s1", { private: false, body: "公开第二版" }));
    expect(revisions("s1").length, "公开时正常留了一版").toBe(1);
    open(db, "s1");
    upsert(db, seedInput("s1", { private: true, body: "公开第二版" }));
    expect(revisions("s1"), "勾上私密后明文表里不能再留着它的真身").toEqual([]);
  });

  it("硬删连正文与版本一起带走，没揭开也删得动", () => {
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "第一版" }));
    upsert(db, seedInput("p1", { private: true, body: "第二版" }));
    expect(sealedCount(db)).toBe(2);
    call(db, "private_lock", {});
    expect(call(db, "sticky_delete", { id: "p1", hard: true }), "删不需要密钥").toBe(
      true,
    );
    expect(sealedCount(db), "只剩播种那一张").toBe(1);
  });

  it("软删什么都不带走：恢复回来内容与版本还得在", () => {
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "第一版" }));
    upsert(db, seedInput("p1", { private: true, body: "第二版" }));
    const before = sealedCount(db);
    call(db, "sticky_delete", { id: "p1", hard: false });
    expect(sealedCount(db), "软删不许动密文").toBe(before);
    call(db, "trash_restore", { id: "p1" });
    expect(rowOf(db, "p1").body).toBe("第二版");
    expect(revisions("p1").length).toBe(1);
  });

  it("一键清空回收站把私密那两条一起收掉", () => {
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "进回收站的" }));
    call(db, "sticky_delete", { id: "p1", hard: false });
    const before = sealedCount(db);
    // 种子里本来就有一张躺在回收站，所以清掉的不止我这一张：按"现在有几张软删"来断言
    const doomed = rows(db, true).filter((row) => row.deleted).length;
    expect(call(db, "trash_clear_all", {})).toBe(doomed);
    expect(sealedCount(db)).toBe(before - 1);
  });

  it("重置：正文与版本全清，但不会顺手把哪一张打开", () => {
    open(db, "p1");
    upsert(db, seedInput("p1", { private: true, body: "重置前的内容" }));
    call(db, "private_lock", {});
    call(db, "private_reset", { password: "重置后使用的新口令" });
    expect(sealedCount(db), "旧钥匙解不开的全部清掉").toBe(0);
    expect(opened(db)).toEqual([]);
    // 收编不再有"重置完自动补做"那一步：它等第一次口令
    expect(codeOf(() => revisions("p1"))).toBe("PRIVATE_LOCKED");
  });
});

/** 口令窗那扇窗的输入面：为哪张、干什么（`windows::unlock::IntentState`） */
describe("口令窗的意图", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    call(db, "private_setup", { password: PASSWORD });
  });

  it("开窗带的意图，窗自己读得回来", () => {
    call(db, "open_unlock_window", { noteId: "p1", purpose: "delete" });
    expect(call(db, "unlock_intent", {})).toEqual({ noteId: "p1", purpose: "delete" });
  });

  it("不带意图开（托盘「立即锁定」那条路）：读回来是空，窗只给设置与重置", () => {
    call(db, "open_unlock_window", {});
    expect(call(db, "unlock_intent", {})).toBeNull();
  });

  it("揭开那一张会广播「口令过了」，删除那条也一样", () => {
    db.broadcasts.length = 0;
    call(db, "private_reveal", { noteId: "p1", password: PASSWORD });
    const reveal = db.broadcasts.filter((row) => row.event === "unlock:verified");
    expect(reveal).toHaveLength(1);
    if (reveal[0]?.event !== "unlock:verified") throw new Error("形状不对");
    expect(reveal[0].payload).toEqual({ noteId: "p1", purpose: "reveal" });

    call(db, "open_unlock_window", { noteId: "p1", purpose: "delete" });
    db.broadcasts.length = 0;
    call(db, "private_verify", { password: PASSWORD });
    const verify = db.broadcasts.filter((row) => row.event === "unlock:verified");
    expect(verify).toHaveLength(1);
    if (verify[0]?.event !== "unlock:verified") throw new Error("形状不对");
    expect(verify[0].payload).toEqual({ noteId: "p1", purpose: "delete" });
    // 只验身份的删除不许改变任何状态：没有整层广播，也没多开一张
    expect(
      db.broadcasts.filter((row) => row.event === "store:private-changed"),
    ).toHaveLength(0);
    // 上面那次 private_reveal 开的还在，verify 自己没有开任何一张
    expect(opened(db)).toEqual(["p1"]);
  });
});
