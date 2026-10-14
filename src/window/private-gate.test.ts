// 口令门的行为契约（2026-10-13 作者拍的逐张口径）：
//  · **每张都要输一次口令**：这一张已经开着 → 正事当场办，不多问（reveal 那条路）
//  · **删除一律再问一次**：哪怕这一张正开着，删除也要再过一道口令（delete 那条路）
//  · 没开着 → 挂起这一次动作并弹口令窗；验过口令 → 自动补做（不用他再点一次）
//  · 口令窗被关掉而口令没过 → **作废**。不作废就是"他后来为别的事揭开某张，
//    凭空删掉一张便签"
//  · 补做的凭据是 `unlock:verified`（带是哪张、干什么），不是"窗关了"：
//    删除那条路只验身份、不开任何一张，所以窗关没关与口令过没过是两件事
//  · 连点两次 → 只认最后一次
//  · 意图对不上（他为另一张开的窗）→ 这一件不许被那一声放行

import { beforeEach, describe, expect, it, vi } from "vitest";

import { UNLOCK_DISMISSED, UNLOCK_VERIFIED } from "@/platform/contracts";
import type { UnlockIntent } from "@/platform/contracts";

/** 逐张模型里的状态位：**哪几张开着**（真身在 private-state.ts） */
const state = { revealed: [] as string[] };
/** private-state 的订阅者（状态变化时由测试手动叫醒） */
const stateListeners = new Set<() => void>();
/** 事件名 → 处理器（`unlock:verified` / `unlock:dismissed` 分开记，别混成一格） */
const handlers = new Map<string, Set<(payload: unknown) => void>>();
/** 每一次口令窗调用：开的是哪张、干什么 */
const openCalls: UnlockIntent[] = [];
const done: string[] = [];

vi.mock("@/data/private-state", () => ({
  isRevealed: (id: string) => state.revealed.includes(id),
  subscribe: (fn: () => void) => {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },
  syncPrivateState: () => Promise.resolve(),
}));
vi.mock("@/platform/commands", () => ({
  openUnlockWindow: (noteId: string, purpose: "reveal" | "delete") => {
    openCalls.push({ noteId, purpose });
    return Promise.resolve();
  },
}));
vi.mock("@/platform/bridge", () => ({
  listen: (event: string, fn: (payload: unknown) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(fn);
    handlers.set(event, set);
    return Promise.resolve(() => set.delete(fn));
  },
}));
vi.mock("@/platform/logger", () => ({
  // caught / info / warn 三个都在用（挂起与失败那两条各走一格），少一个就是
  // "logger.warn is not a function" 这种把门本身测不到的假崩溃
  logger: { caught: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function act(tag: string): () => Promise<void> {
  return () => {
    done.push(tag);
    return Promise.resolve();
  };
}

function fire(event: string, payload?: unknown): void {
  for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
}

/** 排空挂起的微任务：门里的收尾是 async 链，不用 waitFor 数不到它跑完 */
async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  state.revealed = [];
  stateListeners.clear();
  handlers.clear();
  openCalls.length = 0;
  done.length = 0;
  // 门里挂着一次没做完的动作（作废路径留下的），下一条用例不该继承
  void import("@/window/private-gate").then((m) => m.resetPrivateGateForTests());
});

/** 挂一次"这一张没开着"的删除 */
async function pendDelete(tag = "删这张", noteId = "a"): Promise<void> {
  const { requirePrivateUnlock } = await import("@/window/private-gate");
  await requirePrivateUnlock({ noteId, purpose: "delete", action: act(tag) });
}

describe("口令门", () => {
  it("揭开正事：这一张已经开着就当场办，不开窗", async () => {
    state.revealed = ["a"];
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({
      noteId: "a",
      purpose: "reveal",
      action: act("标记成私密"),
    });
    expect(done).toEqual(["标记成私密"]);
    expect(openCalls).toHaveLength(0);
  });

  it("揭开正事：别的张开着不算，这一张还是要问", async () => {
    state.revealed = ["b", "c"];
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({ noteId: "a", purpose: "reveal", action: act("标记") });
    expect(done).toEqual([]);
    expect(openCalls).toEqual([{ noteId: "a", purpose: "reveal" }]);
  });

  /** 这一条是"删除一律再问一次"那句的落点：开着 ≠ 批准删 */
  it("删除：这一张正开着也照样要口令", async () => {
    state.revealed = ["a"];
    await pendDelete();
    expect(done).toEqual([]);
    expect(openCalls).toEqual([{ noteId: "a", purpose: "delete" }]);
  });

  it("没开着：先开窗，此刻不办", async () => {
    await pendDelete();
    expect(done).toEqual([]);
    expect(openCalls).toHaveLength(1);
  });

  it("口令验过：自动补做那一次", async () => {
    await pendDelete();
    fire(UNLOCK_VERIFIED, { noteId: "a", purpose: "delete" });
    await tick();
    expect(done).toEqual(["删这张"]);
  });

  it("意图对不上（他为另一张开的窗）：这一件不放行", async () => {
    await pendDelete();
    fire(UNLOCK_VERIFIED, { noteId: "b", purpose: "delete" });
    fire(UNLOCK_VERIFIED, { noteId: "a", purpose: "reveal" });
    await tick();
    expect(done).toEqual([]);
  });

  it("揭开那条路：这张被别处揭开了也算完成", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({ noteId: "a", purpose: "reveal", action: act("标记") });
    state.revealed = ["a"];
    for (const fn of [...stateListeners]) fn();
    await tick();
    expect(done).toEqual(["标记"]);
  });

  it("删除那条路：别处揭开这张不算完成（他要的是删，不是看）", async () => {
    await pendDelete();
    state.revealed = ["a"];
    for (const fn of [...stateListeners]) fn();
    await tick();
    // 只验身份的删除不该被一次揭开放行
    expect(done).toEqual([]);
  });

  it("关了窗但口令没过：作废，后来揭开这张也不补做", async () => {
    await pendDelete();
    fire(UNLOCK_DISMISSED);
    await tick();
    expect(done).toEqual([]);
    // 他之后自己揭开了这张（比如从另一扇窗）——那次作废的动作不许被补上
    state.revealed = ["a"];
    for (const fn of [...stateListeners]) fn();
    await tick();
    expect(done).toEqual([]);
  });

  it("挂起期间再点另一张：只认最后一次", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({ noteId: "a", purpose: "delete", action: act("第一张") });
    await requirePrivateUnlock({ noteId: "b", purpose: "delete", action: act("第二张") });
    fire(UNLOCK_VERIFIED, { noteId: "a", purpose: "delete" });
    await tick();
    // 前一次已经被顶掉，那一声不算
    expect(done).toEqual([]);
    fire(UNLOCK_VERIFIED, { noteId: "b", purpose: "delete" });
    await tick();
    expect(done).toEqual(["第二张"]);
  });

  it("动作抛错不外泄（记日志，不打断门本身）", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({
      noteId: "a",
      purpose: "delete",
      action: () => Promise.reject(new Error("落盘失败")),
    });
    fire(UNLOCK_VERIFIED, { noteId: "a", purpose: "delete" });
    await tick();
    expect(done).toEqual([]);
  });
});

/** `after` 是"只有走了挂起这条路才做的事"：标记完问他要不要立即锁回去 */
describe("挂起之后的那一步", () => {
  it("已揭开：只办正事，不跑 after（他没输过密码）", async () => {
    state.revealed = ["a"];
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({
      noteId: "a",
      purpose: "reveal",
      action: act("标记"),
      after: act("问锁"),
    });
    expect(done).toEqual(["标记"]);
  });

  it("挂起 → 口令验过：先办正事，再跑 after，顺序不许倒", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({
      noteId: "a",
      purpose: "reveal",
      action: act("标记"),
      after: act("问锁"),
    });
    expect(done).toEqual([]);
    fire(UNLOCK_VERIFIED, { noteId: "a", purpose: "reveal" });
    await tick();
    expect(done).toEqual(["标记", "问锁"]);
  });

  it("挂起后关窗没解锁：正事和 after 都不许跑", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock({
      noteId: "a",
      purpose: "reveal",
      action: act("标记"),
      after: act("问锁"),
    });
    fire(UNLOCK_DISMISSED);
    await tick();
    expect(done).toEqual([]);
  });

  it("作废之后再挂一件：门还装得上（armed 不许把下一条用例饿死）", async () => {
    await pendDelete("第一次删");
    fire(UNLOCK_DISMISSED);
    await tick();
    expect(done).toEqual([]);
    await pendDelete("第二次删");
    expect(openCalls).toHaveLength(2);
    fire(UNLOCK_VERIFIED, { noteId: "a", purpose: "delete" });
    await tick();
    expect(done).toEqual(["第二次删"]);
  });
});
