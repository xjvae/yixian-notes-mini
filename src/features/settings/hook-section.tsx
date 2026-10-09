// 右键劫持节 — 长按阈值 / 充电弧 / 白名单 / 暂停开关 + 前台进程回显。
//
// 口径（与 Rust 侧 input 模块一致）：
//  · 阈值滑条松手才提交，Rust 夹回区间后**按实际生效值回显**——界面上显示的
//    永远是实际跑的值；
//  · 白名单一行一条，保存即归一化，重拉后显示的是 Rust 归一后的生效名单；
//  · 充电弧开关落库（`ring.charging`）：关掉后长按过程零反馈，松手直接出盘；
//  · 暂停是"直到下次启动"的临时开关，重启即恢复（刻意不落库）；
//  · 「上一个前台程序」读不到时（提权程序等）如实说明：按不在名单算。

import { useCallback, useEffect, useRef, useState } from "react";
import { hookSetConfig, hookStatus } from "@/platform/commands";
import type { HookStatus } from "@/platform/contracts";

const MIN_HOLD = 150;
const MAX_HOLD = 2000;
const HOLD_STEP = 50;

export function HookSection() {
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [localHold, setLocalHold] = useState<number>(450);
  const [whitelistDraft, setWhitelistDraft] = useState<string>("");
  const [editingWhitelist, setEditingWhitelist] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<HookStatus | null>(null);

  const reload = useCallback((): void => {
    void hookStatus()
      .then((next) => {
        setStatus(next);
        statusRef.current = next;
        setLocalHold(next.holdMs);
        if (!editingWhitelist) {
          setWhitelistDraft(next.whitelist.join("\n"));
        }
      })
      .catch((err: unknown) => setError(String(err)));
  }, [editingWhitelist]);

  useEffect(() => {
    reload();
  }, [reload]);

  const commitPaused = useCallback(
    (paused: boolean): void => {
      void hookSetConfig({ paused })
        .then(reload)
        .catch((err: unknown) => setError(String(err)));
    },
    [reload],
  );

  const commitHold = useCallback(
    (ms: number): void => {
      void hookSetConfig({ holdMs: ms })
        .then(reload)
        .catch((err: unknown) => setError(String(err)));
    },
    [reload],
  );

  const commitCharging = useCallback(
    (charging: boolean): void => {
      void hookSetConfig({ charging })
        .then(reload)
        .catch((err: unknown) => setError(String(err)));
    },
    [reload],
  );

  const commitWhitelist = useCallback((): void => {
    const lines = whitelistDraft
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    setEditingWhitelist(false);
    void hookSetConfig({ whitelist: lines })
      .then(reload)
      .catch((err: unknown) => setError(String(err)));
  }, [whitelistDraft, reload]);

  return (
    <div className="flex flex-col gap-2 text-xs text-[var(--panel-ink)]">
      <label className="flex flex-col gap-1">
        长按阈值：{localHold} 毫秒
        <input
          type="range"
          min={MIN_HOLD}
          max={MAX_HOLD}
          step={HOLD_STEP}
          value={localHold}
          aria-label="长按右键的触发阈值"
          onChange={(event) => setLocalHold(Number(event.target.value))}
          onPointerUp={() => commitHold(localHold)}
          onKeyUp={() => commitHold(localHold)}
          className="accent-[var(--panel-ink)]"
        />
      </label>

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={status?.charging ?? true}
          onChange={(event) => commitCharging(event.target.checked)}
        />
        长按时先亮充电弧（快到位那一小段在手上转一圈；关掉则松手直接出盘）
      </label>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span>白名单（这些程序里右键完全归系统，一行一条）</span>
          {editingWhitelist ? (
            <button
              type="button"
              onClick={commitWhitelist}
              className="rounded border border-[var(--panel-border)] px-2 py-0.5 text-[11px] hover:bg-[var(--panel-hover)]"
            >
              保存
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditingWhitelist(true);
                setWhitelistDraft(status?.whitelist.join("\n") ?? "");
              }}
              className="rounded border border-[var(--panel-border)] px-2 py-0.5 text-[11px] hover:bg-[var(--panel-hover)]"
            >
              编辑
            </button>
          )}
        </div>
        {editingWhitelist ? (
          <textarea
            aria-label="白名单编辑（一行一条程序名，支持结尾 * 通配）"
            value={whitelistDraft}
            onChange={(event) => setWhitelistDraft(event.target.value)}
            rows={4}
            placeholder={"code.exe\nidea*\nwezterm"}
            className="rounded border border-[var(--panel-border)] bg-[var(--panel-card)] p-2 font-mono text-[11px] text-[var(--panel-ink)]"
          />
        ) : (
          <div className="rounded border border-[var(--panel-border)] bg-[var(--panel-card)] p-2 font-mono text-[11px] text-[var(--panel-muted)]">
            {status === null
              ? "…"
              : status.whitelist.length === 0
                ? "（空名单：所有程序的右键长按都会唤起星环）"
                : status.whitelist.join("\n")}
          </div>
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={status?.paused ?? false}
          onChange={(event) => commitPaused(event.target.checked)}
        />
        暂停劫持（重启后自动恢复——刻意不记住）
      </label>

      <p className="text-[11px] text-[var(--panel-muted)]">
        上一个前台程序：
        {status?.foreground ??
          "读不到（提权或受保护进程）——这类程序按不在名单算，长按仍会唤起星环"}
      </p>

      {error !== null && (
        <p role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
