// 口令窗 — 三相位：设置（没配过）/ 解锁（配了没解）/ 重置（忘记密码的唯一出路）。
//
// 文案纪律：重置按钮旁边的红字「清空所有私密便签内容，无法恢复」不是装饰，
// 是重置语义的全部实情——Rust 侧 private_reset 会真的清空 data 块。
// 提交成功后 syncPrivateState()（不等广播往返）再关窗：便签窗收到广播自己合并/隐去。

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { describeError } from "@/platform/errors";
import {
  closeUnlockWindow,
  privateReset,
  privateSetup,
  privateUnlock,
} from "@/platform/commands";
import {
  getPrivateState,
  initPrivateState,
  syncPrivateState,
} from "@/data/private-state";

const PANEL_BG = "var(--panel-bg)";
const PANEL_ACCENT = "var(--panel-ink)";

type Phase = "loading" | "setup" | "unlock" | "reset";

function finish(): void {
  void (async () => {
    await syncPrivateState();
    await closeUnlockWindow().catch(() => {});
  })();
}

export function UnlockWindow() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      await initPrivateState();
      const { active, unlocked } = getPrivateState();
      if (active && unlocked) {
        finish(); // 已经是解锁态（重复唤起）：这扇窗没有事可做
        return;
      }
      setPhase(active ? "unlock" : "setup");
    })();
  }, []);

  const submit = useCallback(
    async (action: "setup" | "unlock" | "reset") => {
      if (busy) return;
      if (action !== "unlock" && password !== password2) {
        setError("两次输入的密码不一致");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        if (action === "setup") await privateSetup(password);
        else if (action === "unlock") await privateUnlock(password);
        else await privateReset(password);
        finish();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, password, password2],
  );

  const heading =
    phase === "setup"
      ? "设置私密密码"
      : phase === "reset"
        ? "重置私密密码"
        : "输入私密密码解锁";

  return (
    <WindowChrome
      background={PANEL_BG}
      accent={PANEL_ACCENT}
      pinned={false}
      onTogglePin={() => {}}
      onClose={() => {
        void closeUnlockWindow().catch(() => {});
      }}
    >
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ backgroundColor: "var(--panel-hover)" }}
        >
          <Lock size={20} aria-hidden className="text-[var(--panel-ink)]" />
        </div>

        {phase === "loading" ? (
          <p className="text-xs text-[var(--panel-muted)]">…</p>
        ) : (
          <form
            className="flex w-full max-w-[280px] flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(
                phase === "setup" ? "setup" : phase === "reset" ? "reset" : "unlock",
              );
            }}
          >
            <h1 className="text-center text-sm font-semibold text-[var(--panel-ink)]">
              {heading}
            </h1>

            {phase === "setup" && (
              <p className="text-center text-[11px] text-[var(--panel-muted)]">
                私密便签的标题与内容会用这个密码加密，明文不落盘。
              </p>
            )}
            {phase === "reset" && (
              <p className="rounded bg-red-50 px-2 py-1.5 text-center text-[11px] text-red-700">
                重置会清空所有私密便签的内容，且无法恢复。
              </p>
            )}

            <input
              type="password"
              aria-label="私密密码"
              placeholder={phase === "unlock" ? "私密密码" : "新的私密密码"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-card)] px-3 py-2 text-sm text-[var(--panel-ink)]"
            />
            {phase !== "unlock" && (
              <input
                type="password"
                aria-label="确认私密密码"
                placeholder="再输一遍"
                value={password2}
                onChange={(event) => setPassword2(event.target.value)}
                className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-card)] px-3 py-2 text-sm text-[var(--panel-ink)]"
              />
            )}

            {error !== null && (
              <p role="alert" className="text-center text-[11px] text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || password === ""}
              className="w-full rounded-md bg-[var(--panel-ink)] py-2 text-sm text-[var(--panel-bg)] transition-opacity disabled:opacity-40"
            >
              {busy
                ? "…"
                : phase === "setup"
                  ? "启用私密层"
                  : phase === "reset"
                    ? "确认重置"
                    : "解锁"}
            </button>

            {phase === "unlock" && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setPhase("reset");
                }}
                className="self-center text-[11px] text-[var(--panel-muted)] underline-offset-2 hover:underline"
              >
                忘记密码？
              </button>
            )}
            {phase === "reset" && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setPhase("unlock");
                }}
                className="self-center text-[11px] text-[var(--panel-muted)] underline-offset-2 hover:underline"
              >
                返回解锁
              </button>
            )}
          </form>
        )}
      </div>
    </WindowChrome>
  );
}
