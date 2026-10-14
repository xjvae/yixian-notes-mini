// 口令门 — "动手之前先证明你知道口令"，一张一张问：揭开一张不替另一张付；删除一律再问一次，
// 且那一发只验身份（private_verify），不把要删的那张摊开。
// 一次只挂一件：连点两张的删除以最后一次为准，前一次静默作废（宁可少删不多删）。
// 补做的信号必须是 `unlock:verified`（Rust 在口令验过那一刻发）：删除那条路验完不改变状态，
// "窗关了"分辨不出成功还是放弃。反过来"窗关了"即作废，否则日后为别的揭开会误补这一发。
// reveal 那条路另认"这张已开着"为完成条件：状态在后端，不算绕过口令。

import { isRevealed, subscribe, syncPrivateState } from "@/data/private-state";
import { openUnlockWindow } from "@/platform/commands";
import { UNLOCK_DISMISSED, UNLOCK_VERIFIED } from "@/platform/contracts";
import type { UnlockIntent } from "@/platform/contracts";
import { listen } from "@/platform/bridge";
import { logger } from "@/platform/logger";

const SCOPE = "private-gate";

type Action = () => Promise<void>;
export type GatePurpose = "reveal" | "delete";

interface Pending {
  noteId: string;
  purpose: GatePurpose;
  action: Action;
  /** 只在**真的走过口令窗**这条路才做的事（比如标记私密完之后问他要不要立即锁回去） */
  after: Action | null;
  /** 给日志用：挂起的那一下作废时要说得清是哪一下 */
  what: string;
}

let pending: Pending | null = null;
let armed = false;

function matches(held: Pending, intent: UnlockIntent): boolean {
  return held.noteId === intent.noteId && held.purpose === intent.purpose;
}

/** 口令验过（或这一张已经开着了）→ 把挂起的那一下做完 */
async function complete(held: Pending, why: string): Promise<void> {
  if (pending !== held) return;
  pending = null;
  // 他说"输完口令没反应"时，这一行是"补做到底跑没跑"的唯一凭据
  logger.info(SCOPE, `${why}后补做：${held.what}`);
  try {
    await held.action();
    await held.after?.();
  } catch (error) {
    logger.caught(SCOPE, `补做失败：${held.what}`, error);
  }
}

async function onVerified(intent: UnlockIntent): Promise<void> {
  const held = pending;
  if (held === null || !matches(held, intent)) return;
  await complete(held, "口令验过");
}

async function onStateChange(): Promise<void> {
  const held = pending;
  if (held === null || held.purpose !== "reveal") return;
  if (isRevealed(held.noteId)) await complete(held, "这张已揭开");
}

/** 只装一次：监听器活到进程结束，靠 pending 是否为空决定要不要动手 */
async function arm(): Promise<void> {
  if (armed) return;
  armed = true;
  await listen<UnlockIntent>(UNLOCK_VERIFIED, (intent) => {
    void onVerified(intent).catch((error: unknown) =>
      logger.caught(SCOPE, "口令门收尾失败", error),
    );
  });
  subscribe(() => {
    void onStateChange();
  });
  await listen(UNLOCK_DISMISSED, () => {
    void (async () => {
      // 先重读一次状态再判作废：万一他是从别的窗把这张揭开的，这一下该补做
      await syncPrivateState();
      await onStateChange();
      if (pending !== null) {
        logger.warn(SCOPE, `口令窗关了而口令没过，这一发作废：${pending.what}`);
        pending = null;
      }
    })().catch((error: unknown) => logger.caught(SCOPE, "口令窗收尾失败", error));
  });
}

/**
 * 该问就问，问完把这一件挂上再去开口令窗。
 * reveal 而这一张已开着 → 当场办完（不该被打断）；delete → 一律问。
 */
export async function requirePrivateUnlock(request: {
  noteId: string;
  purpose: GatePurpose;
  action: Action;
  after?: Action;
  what?: string;
}): Promise<void> {
  const { noteId, purpose, action, after, what = "那一下" } = request;
  if (purpose === "reveal" && isRevealed(noteId)) {
    await action();
    return;
  }
  pending = { noteId, purpose, action, after: after ?? null, what };
  logger.warn(SCOPE, `要口令，挂起并开口令窗（${purpose}）：${what}`);
  await arm();
  await openUnlockWindow(noteId, purpose);
}

/** 测试复位用：作废挂起的动作并允许重新装监听 */
export function resetPrivateGateForTests(): void {
  pending = null;
  armed = false;
}
