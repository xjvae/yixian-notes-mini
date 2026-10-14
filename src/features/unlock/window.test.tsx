// 口令窗的用例。七相位共用一份骨架，最容易改分叉的两件事都钉进用例：
//  · 相位路由（phaseOf）：封套坏了只剩 reset 一个相位（此刻摆"设置口令"等于覆盖唯一那份
//    材料）；没配过口令是 setup；无意图是 locked；意图分 reveal/verify。
//  · 每个相位按下去真正调了哪条命令：setup 完按意图补那一发、reveal 带 noteId、
//    rekey 带（当前口令， 新口令）、reset/rekey 两次不一致一个命令都不许发。
//  · 收尾次序：提交成功先 syncPrivateState 再关窗；这张已开着时窗"没事可做"直接关。

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UnlockWindow } from "@/features/unlock/window";
import type { UnlockIntent } from "@/platform/contracts";

// 替身一律收 rest 参数：被调时传几个参都接得住（vi.fn 的返回值形态才是用例关心的）
const setupFn = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const revealFn = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const verifyFn = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const rekeyFn = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const resetFn = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const closeFn = vi.fn((): Promise<void> => Promise.resolve());

// 相位路由的输入，每个用例自己摆
let intent: UnlockIntent | null = null;
let privActive = true;
let privDamaged = false;
let revealed: string[] = [];

vi.mock("@/platform/commands", () => ({
  unlockIntent: () => Promise.resolve(intent),
  privateSetup: (...args: unknown[]) => setupFn(...args),
  privateReveal: (...args: unknown[]) => revealFn(...args),
  privateVerify: (...args: unknown[]) => verifyFn(...args),
  privateRekey: (...args: unknown[]) => rekeyFn(...args),
  privateReset: (...args: unknown[]) => resetFn(...args),
  closeUnlockWindow: () => closeFn(),
}));
vi.mock("@/platform/bridge", () => ({
  listen: (_event: string, _handler: unknown) => Promise.resolve(() => {}),
}));
vi.mock("@/data/private-state", () => ({
  getPrivateState: () => ({
    active: privActive,
    damaged: privDamaged,
    revealed: [...revealed],
  }),
  initPrivateState: () => Promise.resolve(),
  isRevealed: (id: string) => revealed.includes(id),
  syncPrivateState: () => Promise.resolve(),
}));

beforeEach(() => {
  for (const fn of [setupFn, revealFn, verifyFn, rekeyFn, resetFn, closeFn])
    fn.mockClear();
  intent = null;
  privActive = true;
  privDamaged = false;
  revealed = [];
});

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("口令窗", () => {
  it("无意图 → locked：只有改密/重置两条出路，不摆输入框", async () => {
    render(<UnlockWindow />);
    expect(await screen.findByText("私密便签已经收回去了")).toBeTruthy();
    expect(screen.getByText("改密码？")).toBeTruthy();
    expect(screen.getByText("忘记密码？")).toBeTruthy();
    expect(screen.queryByLabelText("私密密码")).toBeNull();
    cleanup();
  });

  it("reveal 意图 → 请输入密码；空口令提交键是灰的，提交走 privateReveal 带 noteId，然后关窗", async () => {
    intent = { noteId: "s1", purpose: "reveal" };
    render(<UnlockWindow />);
    expect(await screen.findByText("请输入密码")).toBeTruthy();
    const submit = screen.getByRole<HTMLButtonElement>("button", { name: "确定" });
    expect(submit.disabled).toBe(true);
    type("私密密码", "pw");
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(closeFn).toHaveBeenCalled());
    expect(revealFn).toHaveBeenCalledWith("s1", "pw");
    cleanup();
  });

  it("delete 意图 → 确认删除相：提交走 privateVerify，不走 reveal", async () => {
    intent = { noteId: "s9", purpose: "delete" };
    render(<UnlockWindow />);
    expect(await screen.findByText("输入密码确认删除")).toBeTruthy();
    type("私密密码", "pw");
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(verifyFn).toHaveBeenCalledWith("pw"));
    expect(revealFn).not.toHaveBeenCalled();
    cleanup();
  });

  it("这张已经开着：reveal 意图也不摆输入框，窗直接关（没事可做）", async () => {
    intent = { noteId: "s1", purpose: "reveal" };
    revealed = ["s1"];
    render(<UnlockWindow />);
    await waitFor(() => expect(closeFn).toHaveBeenCalled());
    expect(screen.queryByLabelText("私密密码")).toBeNull();
    expect(revealFn).not.toHaveBeenCalled();
    cleanup();
  });

  it("封套坏了 → 意图被顶掉，只剩 reset：红字说清后果", async () => {
    privDamaged = true;
    intent = { noteId: "s1", purpose: "reveal" };
    render(<UnlockWindow />);
    expect(await screen.findByText("私密封套读不出来")).toBeTruthy();
    expect(screen.getByText(/无法恢复/)).toBeTruthy();
    expect(screen.getByLabelText("新的私密密码")).toBeTruthy();
    expect(screen.getByLabelText("确认私密密码")).toBeTruthy();
    cleanup();
  });

  it("reset 两次不一致：报错，一个命令都不发、窗也不关", async () => {
    privDamaged = true;
    render(<UnlockWindow />);
    await screen.findByText("私密封套读不出来");
    type("新的私密密码", "pw1");
    type("确认私密密码", "pw2");
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    expect(await screen.findByText("两次输入的密码不一致")).toBeTruthy();
    expect(resetFn).not.toHaveBeenCalled();
    expect(closeFn).not.toHaveBeenCalled();
    cleanup();
  });

  it("locked → 改密：当前口令必填；三处对齐走 privateRekey(旧, 新) 并关窗", async () => {
    render(<UnlockWindow />);
    fireEvent.click(await screen.findByText("改密码？"));
    expect(await screen.findByText("改私密密码")).toBeTruthy();
    const submit = screen.getByRole<HTMLButtonElement>("button", { name: "确认改密" });
    // 当前口令没填，就算新口令两处一致也按不下去
    type("新的私密密码", "new1");
    type("确认私密密码", "new1");
    expect(submit.disabled).toBe(true);
    type("当前私密密码", "old");
    expect(submit.disabled).toBe(false);
    // 先错一次：不一致的报错要在提交前拦住
    type("确认私密密码", "nope");
    fireEvent.click(submit);
    expect(await screen.findByText("两次输入的密码不一致")).toBeTruthy();
    type("确认私密密码", "new1");
    fireEvent.click(submit);
    await waitFor(() => expect(closeFn).toHaveBeenCalled());
    expect(rekeyFn).toHaveBeenCalledWith("old", "new1");
    cleanup();
  });

  it("没配过口令 → setup：立完口令按 reveal 意图补揭那一发", async () => {
    privActive = false;
    intent = { noteId: "s3", purpose: "reveal" };
    render(<UnlockWindow />);
    expect(await screen.findByText("设置私密密码")).toBeTruthy();
    expect(screen.getByText(/明文不落盘/)).toBeTruthy();
    type("私密密码", "pw");
    type("确认私密密码", "pw");
    fireEvent.click(screen.getByRole("button", { name: "启用私密层" }));
    await waitFor(() => expect(closeFn).toHaveBeenCalled());
    expect(setupFn).toHaveBeenCalledWith("pw");
    expect(revealFn).toHaveBeenCalledWith("s3", "pw");
    cleanup();
  });
});
