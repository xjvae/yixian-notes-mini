// 口令门 — "删一张私密便签"必须先证明你知道口令。
//
// 口径（2026-10-12 作者拍的）：扔进回收站（软删）和回收站里彻底删 / 一键清空（硬删）
// 都要过这道门；私密层**已经解锁就不再重复问**——口令是那层锁的钥匙，不是每个动作
// 的一次性码。所以本模块只在锁着的时候介入。
//
// 为什么是"挂起这一次动作"而不是"弹个窗就算了"：那样他输完口令还得回到便签再点一次
// 删除，而解锁那一刻他手上正握着口令，最该顺手把刚才那一下做完。
//
// 收口有两条路，缺一不可：
//  · 状态变"已解锁" → 执行（正常成功路径）；
//  · 口令窗被关掉 → 重新读一次权威状态，解锁了就执行，没解锁就**作废**。
// 第二条是安全阀：不作废的话，他后来为别的事解锁会把这一下补上，等于凭空删掉一张便签。

import { isPrivateUnlocked, subscribe, syncPrivateState } from "@/data/private-state";
import { openUnlockWindow } from "@/platform/commands";
import { UNLOCK_DISMISSED } from "@/platform/contracts";
import { listen } from "@/platform/bridge";
import { logger } from "@/platform/logger";

const SCOPE = "private-gate";

type Action = () => Promise<void>;

/** 一次只挂一件：连点两张的删除以最后一次为准，前一次静默作废（宁可少删不多删） */
let pending: Action | null = null;
let armed = false;

async function settle(): Promise<void> {
  const act = pending;
  if (act === null || !isPrivateUnlocked()) return;
  pending = null;
  try {
    await act();
  } catch (error) {
    logger.caught(SCOPE, "解锁后补做删除失败", error);
  }
}

/** 只装一次：监听器活到进程结束，靠 pending 是否为空决定要不要动手 */
async function arm(): Promise<void> {
  if (armed) return;
  armed = true;
  subscribe(() => void settle());
  await listen(UNLOCK_DISMISSED, () => {
    void (async () => {
      // 谁关的窗不算数（解锁成功也是窗自己关的），读一次权威状态再决定
      await syncPrivateState();
      await settle();
      pending = null;
    })().catch((error: unknown) => logger.caught(SCOPE, "口令窗收尾失败", error));
  });
}

/** 已解锁就当场办；锁着就把这一次挂上，去弹口令窗 */
export async function requirePrivateUnlock(action: Action): Promise<void> {
  if (isPrivateUnlocked()) {
    await action();
    return;
  }
  pending = action;
  await arm();
  await openUnlockWindow();
}

/** 测试复位用：作废挂起的动作并允许重新装监听 */
export function resetPrivateGateForTests(): void {
  pending = null;
  armed = false;
}
