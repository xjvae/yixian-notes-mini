// 提醒卡的用例。三条都是"错了就看不见/看见不该看的"那一类：
//  · 文案只从 payload 拿 —— 这条用例**没有装 store**（没有任何 hydrate），
//    所以它一旦去 store 里查那张便签就直接崩：能画出来就是没查，这比断言"没调用"更硬。
//    查了就是把私密的标题正文画到一张不锁的卡上（Rust 那边已经洗过一遍，这里不许再绕）。
//  · 点卡片那颗钮要带着**这张卡的** stickyId 走（连着两条提醒时点第二张不许打开第一张）。
//  · 已经有一张卡时 Rust 不重建窗、只广播新内容，所以 `reminder:show` 必须真能换掉文案。

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReminderCard } from "@/window/reminder-card";
import type { ReminderCardPayload } from "@/platform/contracts";

const open = vi.fn();
const dismiss = vi.fn();
let emit: ((payload: unknown) => void) | null = null;

vi.mock("@/platform/commands", () => ({
  // 组件对这两条都接了 `.catch(...)`，所以替身必须回一个 Promise（回 undefined
  // 就是"点一下就炸"，而那正是这条用例要排掉的东西）
  reminderOpen: (id: string) => {
    open(id);
    return Promise.resolve();
  },
  reminderDismiss: () => {
    dismiss();
    return Promise.resolve();
  },
}));
vi.mock("@/platform/bridge", () => ({
  // 这里不写泛型 `<T>`：.tsx 里箭头函数的泛型参数会被当成 JSX 标签（真炸过一次）。
  // 进来的 handler 先当未知，转一次就够——用例只关心"广播一份负载时卡怎么画"。
  listen: (_event: string, handler: unknown) => {
    emit = handler as (payload: unknown) => void;
    return Promise.resolve(() => {
      emit = null;
    });
  },
}));
vi.mock("@/platform/logger", () => ({
  logger: { caught: (_scope: string, _message: string, _error: unknown) => {} },
}));

const first: ReminderCardPayload = {
  title: "买菜",
  text: "这条提醒到点了 · 勾掉或改时间就不再提醒",
  stickyId: "s1",
  groupId: null,
  theme: "yellow",
};
const second: ReminderCardPayload = {
  title: "一闲笔记 · 私密提醒",
  text: "有一条提醒到点了（内容要解锁才看得到）",
  stickyId: "s2",
  groupId: "g1",
  theme: "purple",
};

beforeEach(() => {
  open.mockClear();
  dismiss.mockClear();
  emit = null;
});

describe("提醒卡", () => {
  it("标题、那句说明、两颗钮都画出来，且不碰主数据", () => {
    render(<ReminderCard initial={first} />);
    // 这套用例没有 jest-dom（工程里没装），getBy* 找不到就直接抛，取到就是画出来了
    expect(screen.getByText("买菜").textContent).toBe("买菜");
    expect(screen.getByText(/勾掉或改时间就不再提醒/).textContent).toContain("到点了");
    expect(screen.getByRole("button", { name: "去看这张便签" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关掉这条提醒" })).toBeTruthy();
    cleanup();
  });

  it("点「去看这张便签」带的是这张卡的 id", () => {
    render(<ReminderCard initial={first} />);
    fireEvent.click(screen.getByRole("button", { name: "去看这张便签" }));
    expect(open).toHaveBeenCalledWith("s1");
    cleanup();
  });

  it("点 × 只收卡", () => {
    render(<ReminderCard initial={first} />);
    fireEvent.click(screen.getByRole("button", { name: "关掉这条提醒" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    cleanup();
  });

  it("reminder:show 来了就换成新那条（点它要打开新的那张）", () => {
    render(<ReminderCard initial={first} />);
    expect(emit).not.toBeNull();
    // 广播来的负载不是事件，React 不会替我们批这一次更新 → 必须包在 act 里
    act(() => {
      emit?.(second);
    });
    expect(screen.getByText(/私密提醒/).textContent).toBe("一闲笔记 · 私密提醒");
    expect(screen.queryByText("买菜")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "去看这张便签" }));
    expect(open).toHaveBeenCalledWith("s2");
    cleanup();
  });

  it("缺 stickyId 的广播不改文案（不许把卡点成 undefined）", () => {
    render(<ReminderCard initial={first} />);
    act(() => {
      emit?.({ title: "半份", text: "", stickyId: undefined, groupId: null });
    });
    expect(screen.getByText("买菜").textContent).toBe("买菜");
    cleanup();
  });
});
