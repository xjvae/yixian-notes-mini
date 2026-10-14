// 口令窗 — 逐张模型的相位：这一次是为哪张。setup（第一次立口令）/ reveal（只开那一张）/
// verify（删除前只验身份，不摊开要删的那张）/ locked（无意图：引导回到那张上输口令 + 改密/重置两条出路）。
// 封套读不出来时只剩 reset 一个相位：解不开就是解不开，此刻摆"设置口令"等于覆盖唯一那份材料。
// 意图不能住 URL：窗是复用的，点另一张的蒙版意图就变，真值要回后端 unlockIntent 拿。
// 重置的红字是实情（private_reset 真清掉密文与逐张钥匙），不是装饰文案。
// 提交成功后先 syncPrivateState() 再关窗，不等广播往返。

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { describeError } from "@/platform/errors";
import { listen } from "@/platform/bridge";
import { UNLOCK_INTENT } from "@/platform/contracts";
import type { UnlockIntent } from "@/platform/contracts";
import {
  closeUnlockWindow,
  privateRekey,
  privateReset,
  privateReveal,
  privateSetup,
  privateVerify,
  unlockIntent,
} from "@/platform/commands";
import {
  getPrivateState,
  initPrivateState,
  isRevealed,
  syncPrivateState,
} from "@/data/private-state";
import type { PrivateLayerState } from "@/data/private-state";

const PANEL_BG = "var(--panel-bg)";
const PANEL_ACCENT = "var(--panel-ink)";
const LINK_CLASS =
  "self-center text-[11px] text-[var(--panel-muted)] underline-offset-2 hover:underline";

type Phase = "loading" | "setup" | "reveal" | "verify" | "locked" | "reset" | "rekey";

/** 相位 → 标题与按钮上那句。reveal/verify 只说动作，不解释——标题已经说完了 */
const HEADINGS: Record<Phase, string> = {
  loading: "输入私密密码",
  setup: "设置私密密码",
  reveal: "请输入密码",
  verify: "输入密码确认删除",
  locked: "私密便签已经收回去了",
  reset: "重置私密密码",
  rekey: "改私密密码",
};

const SUBMIT_LABELS: Record<Phase, string> = {
  loading: "好",
  setup: "启用私密层",
  reveal: "确定",
  verify: "确认删除",
  locked: "好",
  reset: "确认重置",
  rekey: "确认改密",
};

/** 只有会动到整个私密层的三相位需要多说一句，而且要说在按下去之前：
 *  setup 得讲这道口令干什么，reset 得讲它会清掉什么（红字那句是实情，不是装饰），
 *  rekey 得讲正开着的那几张会一起收回去 */
const HINTS: Record<Phase, string | null> = {
  loading: null,
  setup: "私密便签的标题与内容会用这个密码加密，明文不落盘。",
  reveal: null,
  verify: null,
  locked: null,
  reset: "重置会清空所有私密便签的内容，且无法恢复。",
  rekey: "改完，正开着的那几张一起收回去，内容一个不动。",
};

/** 封套读不出来时顶掉 reset 那句：先说病和唯一那条修得回来的路，再说重置会清掉什么 */
const DAMAGED_HINT =
  "那份封套坏了或版本不认识。重置会清空所有私密便签的内容，且无法恢复；不想丢就先修回那份文件——快照里带着配套封套。";

function finish(): void {
  void (async () => {
    await syncPrivateState();
    await closeUnlockWindow().catch(() => {});
  })();
}

/** 意图 → 该走哪个相位。没配置时意图不算数（口令还没立起来）；
 *  封套读不出来时意图也不算数——解不开就是解不开，唯一给得出手的动作是重置 */
function phaseOf(intent: UnlockIntent | null, status: PrivateLayerState): Phase {
  if (status.damaged) return "reset";
  if (!status.active) return "setup";
  if (intent === null) return "locked";
  return intent.purpose === "delete" ? "verify" : "reveal";
}

export function UnlockWindow() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [intent, setIntent] = useState<UnlockIntent | null>(null);
  const [damaged, setDamaged] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: UnlockIntent | null): void => {
    const priv = getPrivateState();
    setIntent(next);
    setDamaged(priv.damaged);
    setError(null);
    setCurrent("");
    setPassword("");
    setPassword2("");
    // 揭开那条路如果这张已经开着（别的窗刚输过），这扇窗没有事可做
    if (next !== null && next.purpose === "reveal" && isRevealed(next.noteId)) {
      finish();
      return;
    }
    setPhase(phaseOf(next, priv));
  }, []);

  useEffect(() => {
    void (async () => {
      await initPrivateState();
      apply(await unlockIntent().catch(() => null));
      // 窗复用：点了另一张，意图变了而挂载那次读不会重跑；事件负载只是通知，真值回后端拿
      await listen(UNLOCK_INTENT, () => {
        void unlockIntent()
          .then(apply)
          .catch((err: unknown) => setError(describeError(err)));
      });
    })();
  }, [apply]);

  const submit = useCallback(async () => {
    if (busy) return;
    if ((phase === "reset" || phase === "rekey") && password !== password2) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (phase === "setup") {
        await privateSetup(password);
        // 立口令这一发通常是被某个意图叫起来的：刚选的这句就是那道口令，按意图补做那一发
        if (intent !== null) {
          if (intent.purpose === "reveal") await privateReveal(intent.noteId, password);
          else await privateVerify(password);
        }
      } else if (phase === "reveal" && intent !== null)
        await privateReveal(intent.noteId, password);
      else if (phase === "verify") await privateVerify(password);
      else if (phase === "rekey") await privateRekey(current, password);
      else await privateReset(password);
      finish();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [busy, current, intent, password, password2, phase]);

  const heading = phase === "reset" && damaged ? "私密封套读不出来" : HEADINGS[phase];
  const hint = phase === "reset" && damaged ? DAMAGED_HINT : HINTS[phase];
  const submitLabel = SUBMIT_LABELS[phase];

  const isPasswordless = phase === "loading" || phase === "locked";

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

        {isPasswordless ? (
          <div className="flex w-full max-w-[280px] flex-col items-center gap-3">
            <h1 className="text-center text-sm font-semibold text-[var(--panel-ink)]">
              {heading}
            </h1>
            {phase === "locked" && (
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setPhase("rekey");
                    setCurrent("");
                    setPassword("");
                    setPassword2("");
                  }}
                  className={LINK_CLASS}
                >
                  改密码？
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setPhase("reset");
                    setPassword("");
                    setPassword2("");
                  }}
                  className={LINK_CLASS}
                >
                  忘记密码？
                </button>
              </div>
            )}
          </div>
        ) : (
          <form
            className="flex w-full max-w-[280px] flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <h1 className="text-center text-sm font-semibold text-[var(--panel-ink)]">
              {heading}
            </h1>

            {hint !== null && (
              <p
                className={
                  phase === "reset"
                    ? "rounded bg-red-50 px-2 py-1.5 text-center text-[11px] text-red-700"
                    : "text-center text-[11px] text-[var(--panel-muted)]"
                }
              >
                {hint}
              </p>
            )}

            {phase === "rekey" && (
              <input
                type="password"
                aria-label="当前私密密码"
                placeholder="当前私密密码"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-card)] px-3 py-2 text-sm text-[var(--panel-ink)]"
              />
            )}

            <input
              type="password"
              aria-label={
                phase === "reset" || phase === "rekey" ? "新的私密密码" : "私密密码"
              }
              placeholder={
                phase === "reset" || phase === "rekey" ? "新的私密密码" : "私密密码"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-card)] px-3 py-2 text-sm text-[var(--panel-ink)]"
            />
            {(phase === "setup" || phase === "reset" || phase === "rekey") && (
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
              disabled={busy || password === "" || (phase === "rekey" && current === "")}
              className="w-full rounded-md bg-[var(--panel-ink)] py-2 text-sm text-[var(--panel-bg)] transition-opacity disabled:opacity-40"
            >
              {busy ? "…" : submitLabel}
            </button>

            {(phase === "reset" && !damaged) || phase === "rekey" ? (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  apply(intent);
                }}
                className={LINK_CLASS}
              >
                返回
              </button>
            ) : null}
          </form>
        )}
      </div>
    </WindowChrome>
  );
}
