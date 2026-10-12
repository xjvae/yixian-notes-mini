// 口令门的行为契约（2026-10-12 作者拍的口径）：
//  · 私密层已解锁 → 当场办，不多问一次口令
//  · 锁着 → 挂起这一次动作并弹口令窗
//  · 解锁成功 → 自动把挂起的那一下补做完（不用他再点一次删除）
//  · 口令窗被关掉而没解锁 → 作废。不作废就是"他后来为别的事解锁，凭空删掉一张便签"
//  · 连点两次 → 只认最后一次

import { beforeEach, describe, expect, it, vi } from "vitest";

/** 私密层的缓存位（真身在 private-state.ts） */
const state = { unlocked: false };
/** private-state 的订阅者（状态变化时由测试手动叫醒） */
const stateListeners = new Set<() => void>();
/** unlock:dismissed 的处理器（口令窗被关掉，由测试手动叫醒） */
const dismissedHandlers = new Set<() => void>();

vi.mock("@/data/private-state", () => ({
  isPrivateUnlocked: () => state.unlocked,
  subscribe: (fn: () => void) => {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },
  syncPrivateState: () => Promise.resolve(),
}));
vi.mock("@/platform/commands", () => ({
  openUnlockWindow: () => {
    openCalls.push(1);
    return Promise.resolve();
  },
}));
vi.mock("@/platform/bridge", () => ({
  listen: (_event: string, fn: () => void) => {
    dismissedHandlers.add(fn);
    return Promise.resolve(() => dismissedHandlers.delete(fn));
  },
}));
vi.mock("@/platform/logger", () => ({
  logger: { caught: vi.fn(), info: vi.fn() },
}));

const openCalls: number[] = [];
const done: string[] = [];

function act(tag: string): () => Promise<void> {
  return () => {
    done.push(tag);
    return Promise.resolve();
  };
}

/** 排空挂起的微任务：门里的收尾是 async 链，不用 waitFor 数不到它跑完 */
async function tick(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  state.unlocked = false;
  stateListeners.clear();
  dismissedHandlers.clear();
  openCalls.length = 0;
  done.length = 0;
  // 门里挂着一次没做完的动作（作废路径留下的），下一条用例不该继承
  void import("@/window/private-gate").then((m) => m.resetPrivateGateForTests());
});

describe("口令门", () => {
  it("已解锁：当场办，不开口令窗", async () => {
    state.unlocked = true;
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock(act("直接删"));
    expect(done).toEqual(["直接删"]);
    expect(openCalls).toHaveLength(0);
  });

  it("锁着：先开窗，此刻不办", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock(act("删这张"));
    expect(done).toEqual([]);
    expect(openCalls).toHaveLength(1);
  });

  it("锁着 → 解锁成功：自动补做那一次", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock(act("删这张"));
    state.unlocked = true;
    for (const fn of [...stateListeners]) fn();
    await tick();
    expect(done).toEqual(["删这张"]);
  });

  it("解锁窗自己收尾（dismissed）也算数：读到已解锁就补做", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock(act("删这张"));
    state.unlocked = true;
    for (const fn of [...dismissedHandlers]) fn();
    await tick();
    expect(done).toEqual(["删这张"]);
  });

  it("关了窗但没解锁：作废，后来为别的事解锁也不补做", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock(act("删这张"));
    for (const fn of [...dismissedHandlers]) fn();
    await tick();
    expect(done).toEqual([]);
    // 他之后自己解锁（比如点开了某张私密便签）——那次作废的动作不许被补上
    state.unlocked = true;
    for (const fn of [...stateListeners]) fn();
    await tick();
    expect(done).toEqual([]);
  });

  it("挂起期间再点另一张：只认最后一次", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock(act("第一张"));
    await requirePrivateUnlock(act("第二张"));
    state.unlocked = true;
    for (const fn of [...stateListeners]) fn();
    await tick();
    expect(done).toEqual(["第二张"]);
  });

  it("动作抛错不外泄（记日志，不打断门本身）", async () => {
    const { requirePrivateUnlock } = await import("@/window/private-gate");
    await requirePrivateUnlock(() => Promise.reject(new Error("落盘失败")));
    state.unlocked = true;
    for (const fn of [...stateListeners]) fn();
    await tick();
    expect(done).toEqual([]);
  });
});
