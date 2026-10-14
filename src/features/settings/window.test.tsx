// 设置窗的用例。这一窗都是"界面说的"与"实际生效的"容易分叉的地方，钉进用例：
//  · 开机启动的回显是**实际生效值**：注册表说没写进去就退回不勾（假勾比没勾糟）；
//    写失败要说原因（role=alert），不许静默。
//  · 备份成功后快照清单立刻重读（刚打的那份必须马上出现）。
//  · 快照恢复两段确认：第一击只武装，第二击才真恢复（与回收站同一节奏）。
//  · 快照标签的人话格式：`20261012-094703[-2]` → `2026-10-12 09:47:03`，同秒尾巴不显示。

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsWindow } from "@/features/settings/window";
import type { Snapshot } from "@/platform/contracts";

const autostartGet = vi.fn((): Promise<boolean> => Promise.resolve(true));
const autostartSet = vi.fn((checked: boolean): Promise<boolean> =>
  Promise.resolve(checked),
);
const dataBackup = vi.fn((): Promise<string> =>
  Promise.resolve("E:\\data\\backups\\mini-1.db"),
);
const settingsSet = vi.fn((): Promise<void> => Promise.resolve());
const openGuideWindow = vi.fn((): Promise<void> => Promise.resolve());
const snapshotList = vi.fn((): Promise<Snapshot[]> => Promise.resolve([]));
const snapshotRestore = vi.fn((..._args: unknown[]) =>
  Promise.resolve({
    restored: "20261014-150000",
    safetyLabel: "20261014-150001",
    envelopeRestored: true,
    warning: null,
  }),
);
const changeScheme = vi.fn((..._args: unknown[]): void => {});
let snapshots: Snapshot[] = [];

vi.mock("@/data/scheme", () => ({
  changeScheme: (...args: unknown[]) => changeScheme(...args),
  useScheme: () => ({ setting: "light", resolved: "light" }),
}));
vi.mock("@/data/group-presentation", () => ({
  changeGroupPresentation: vi.fn(),
  useGroupPresentation: () => "pages",
}));
vi.mock("@/data/auto-size-default", () => ({
  setAutoSizeDefault: vi.fn(),
  useAutoSizeDefault: () => true,
}));
vi.mock("@/data/lock-after-mark", () => ({
  setLockAfterMark: vi.fn(),
  useLockAfterMark: () => "ask",
}));
vi.mock("@/platform/bridge", () => ({
  listen: (_event: string, _handler: unknown) => Promise.resolve(() => {}),
}));
vi.mock("@/platform/logger", () => ({
  logger: { caught: (_scope: string, _message: string, _error: unknown) => {} },
}));
vi.mock("@/platform/commands", () => ({
  getSetting: (key: string) => Promise.resolve(key === "restore_on_boot" ? "1" : "15"),
  autostartGet: () => autostartGet(),
  autostartSet: (checked: boolean) => autostartSet(checked),
  dataBackup: () => dataBackup(),
  settingsSet: () => settingsSet(),
  openGuideWindow: () => openGuideWindow(),
  snapshotList: () => snapshotList(),
  snapshotRestore: (...args: unknown[]) => snapshotRestore(...args),
  // 关窗走动态 import，mock 里也要有这一条
  closeSettingsWindow: () => Promise.resolve(),
}));
// 两节自己拉 IO 的子区块整个替身掉：设置窗的用例只管设置窗自己的行为
vi.mock("@/features/settings/hotkey-section", () => ({ HotkeySection: () => null }));
vi.mock("@/features/settings/hook-section", () => ({ HookSection: () => null }));

beforeEach(() => {
  // mockReset 而不是 mockClear：上个用例 mockImplementation 换掉的行为要还原成 vi.fn 的原始实现
  for (const fn of [
    autostartGet,
    autostartSet,
    dataBackup,
    settingsSet,
    openGuideWindow,
    snapshotList,
    snapshotRestore,
    changeScheme,
  ]) {
    fn.mockReset();
  }
  snapshots = [];
  snapshotList.mockImplementation(() => Promise.resolve(snapshots));
});

const snaps: Snapshot[] = [
  { label: "20261012-094703", bytes: 512, createdAt: 0, hasEnvelope: true },
  { label: "20261012-094703-2", bytes: 3_400_000, createdAt: 0, hasEnvelope: false },
];

describe("设置窗", () => {
  it("快照清单：标签格式化成人话、大小分档、无封套要说；主题选中跟着 store", async () => {
    snapshotList.mockImplementation(() => Promise.resolve(snaps));
    render(<SettingsWindow />);
    // 两条的格式化结果同文（-2 的同秒尾巴不显示）——查"都有两处"而不是撞 getByText 的唯一性
    expect((await screen.findAllByText("2026-10-12 09:47:03")).length).toBe(2);
    expect(screen.getByText(/3\.2 MB/)).toBeTruthy();
    expect(screen.getByText(/无封套副本/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "浅色" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    cleanup();
  });

  it("点深色 → changeScheme('dark')，不自己改本地状态", async () => {
    render(<SettingsWindow />);
    fireEvent.click(await screen.findByRole("radio", { name: "深色" }));
    expect(changeScheme).toHaveBeenCalledWith("dark");
    cleanup();
  });

  it("开机启动：回显的是实际生效值——注册表说没写进去，勾就退回来", async () => {
    autostartGet.mockImplementation(() => Promise.resolve(false)); // 起点是没勾
    autostartSet.mockImplementation(() => Promise.resolve(false)); // 勾了也写不进去
    render(<SettingsWindow />);
    const box = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /开机启动（登录后自动运行本应用）/,
    });
    await waitFor(() => expect(box.checked).toBe(false));
    fireEvent.click(box); // 界面先勾上（乐观回显）
    expect(box.checked).toBe(true);
    await waitFor(() => expect(box.checked).toBe(false)); // 实际值回来，假勾退掉
    expect(autostartSet).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
  });

  it("开机启动写失败：报原因（role=alert），勾退回原样", async () => {
    autostartSet.mockImplementation(() => Promise.reject(new Error("注册表被拦")));
    render(<SettingsWindow />);
    const box = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /开机启动（登录后自动运行本应用）/,
    });
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(box.checked).toBe(true)); // 退回原样
    cleanup();
  });

  it("备份：成功消息带路径，快照清单立刻重读", async () => {
    render(<SettingsWindow />);
    await screen.findByRole("button", { name: "立即备份" });
    snapshots = [snaps[0]];
    fireEvent.click(screen.getByRole("button", { name: "立即备份" }));
    expect(
      await screen.findByText(/已备份到 E:\\data\\backups\\mini-1\.db/),
    ).toBeTruthy();
    await waitFor(() => expect(snapshotList.mock.calls.length).toBe(2)); // 初读 + 备份后重读
    cleanup();
  });

  it("备份失败：失败要说出来", async () => {
    dataBackup.mockImplementation(() => Promise.reject(new Error("盘满了")));
    render(<SettingsWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "立即备份" }));
    expect(await screen.findByText(/备份失败：/)).toBeTruthy();
    cleanup();
  });

  it("快照恢复两段确认：第一击只武装，第二击才真恢复并说清封套跟着换", async () => {
    snapshotList.mockImplementation(() => Promise.resolve(snaps));
    render(<SettingsWindow />);
    const restore = await screen.findByRole("button", { name: "恢复到 20261012-094703" });
    fireEvent.click(restore);
    expect(snapshotRestore).not.toHaveBeenCalled(); // 第一击只武装
    expect(
      screen.getByRole("button", {
        name: /确认恢复到 20261012-094703（当前数据先自动存一份）/,
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /确认恢复到 20261012-094703/ }));
    await waitFor(() => expect(snapshotRestore).toHaveBeenCalledWith("20261012-094703"));
    expect(await screen.findByText(/私密封套一起换回了/)).toBeTruthy();
    expect(await screen.findByText(/恢复前的状态存为 2026-10-14 15:00:01/)).toBeTruthy();
    cleanup();
  });
});
