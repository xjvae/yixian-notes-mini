// 提醒卡 — 到点那条提醒自己画的一张卡（窗由 `windows/card.rs` 建，320×88）。
//
// 为什么不能只靠系统 toast：那条链不在我们手里。直跑的那版 exe 不带 AppUserModelID
// （插件自己判的，见 card.rs 顶注），于是那条 toast 归不到这个应用名下，系统那边一挡就
// 什么也没有——作者两次报"提醒没弹"，日志里明明写着"已发系统通知"。卡画在我们自己的
// 窗里，"看得见"这件事不欠任何人。
//
// 长什么样：**从那叠纸上撕下来的一张**，不是一个系统对话框。底色/墨色/那道脊都取自
// 这张便签自己的主题（payload 里的 `theme` 键 → 同一个 `themeColors`）。
// 整张卡就是"去看这张便签"这一个按钮（一扇 320×88 的弹窗，还要人瞄准一颗小钮是跟自己
// 过不去），× 是它旁边唯一的例外：绝对定位的兄弟，不做嵌套 button。
//
// 三条纪律：
//  · 文案**只从 payload 拿**，不许按 stickyId 去 store 里查那张便签：私密的标题和正文
//    都在锁后面，一查就把它们画到了一张不锁的卡上（Rust 那边已经把私密洗成中性文案了）。
//  · 收窗归 Rust（12 秒自己走、点一下就走）。这里不放第二个倒计时：两处计时一定会
//    有一个是错的，而那个错的形状是"卡赖在屏幕上不走"，或者"还没读完就没"。
//  · 不抢焦点（窗 `focused: false`，报就绪带 `focus: false`）。所以不 auto-focus、
//    不弹输入框；代价是卡出现时光标还留在原来的应用里，键盘要走 Tab 才进得来。

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { reminderDismiss, reminderOpen } from "@/platform/commands";
import { REMINDER_SHOW } from "@/platform/contracts";
import type { ReminderCardPayload } from "@/platform/contracts";
import { listen } from "@/platform/bridge";
import { logger } from "@/platform/logger";

const SCOPE = "card";

export function ReminderCard({ initial }: { initial: ReminderCardPayload }) {
  const [card, setCard] = useState(initial);
  const { resolved } = useScheme();
  const theme = themeColors(card.theme, resolved);

  // 已经有一张卡时 Rust 不重建窗（换窗要 destroy + 重建，会撞建窗占位），而是广播新内容
  useEffect(() => {
    let unbind: (() => void) | null = null;
    let cancelled = false;
    void listen<ReminderCardPayload>(REMINDER_SHOW, (payload) => {
      if (typeof payload?.stickyId === "string") setCard(payload);
    })
      .then((off) => {
        if (cancelled) off();
        else unbind = off;
      })
      .catch((error: unknown) => logger.caught(SCOPE, "订阅提醒卡换内容失败", error));
    return () => {
      cancelled = true;
      unbind?.();
    };
  }, []);

  /** 点开那张便签（组员由 Rust 并进叠窗并翻到那一张）；收卡也在那一趟一起做 */
  const open = useCallback((): void => {
    void reminderOpen(card.stickyId).catch((error: unknown) =>
      logger.caught(SCOPE, "点卡打开便签失败", error),
    );
  }, [card.stickyId]);

  const dismiss = useCallback((): void => {
    void reminderDismiss().catch((error: unknown) =>
      logger.caught(SCOPE, "收卡失败", error),
    );
  }, []);

  return (
    <div className="relative h-screen w-screen select-none">
      <button
        type="button"
        aria-label="去看这张便签"
        onClick={open}
        className="flex h-full w-full flex-col items-start gap-1 rounded-xl border px-3 pb-2 pt-2.5 text-left transition-colors"
        style={{
          backgroundColor: theme.paper,
          borderColor: `color-mix(in srgb, ${theme.ink} 14%, transparent)`,
        }}
      >
        <span className="flex w-full items-center gap-2">
          {/* 那道脊就是便签标题条左边那一根：同一张纸的记号，一眼看得出是从哪张纸上撕的 */}
          <span
            className="h-3.5 w-1 shrink-0 rounded-full"
            style={{ backgroundColor: theme.accent }}
          />
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-bold leading-tight"
            title={card.title}
            style={{ color: theme.ink }}
          >
            {card.title}
          </span>
          {/* 右边给 × 留位（它是外面那颗绝对定位的兄弟，不套在这颗钮里） */}
          <span className="w-6 shrink-0" aria-hidden />
        </span>
        <span
          className="text-[11px] leading-snug"
          style={{ color: theme.ink, opacity: 0.66 }}
        >
          {card.text}
        </span>
        <span
          className="mt-auto self-end text-[11px] font-semibold"
          style={{ color: theme.accent }}
        >
          去看这张便签 →
        </span>
      </button>
      <button
        type="button"
        aria-label="关掉这条提醒"
        title="关掉"
        onClick={dismiss}
        className="absolute right-1.5 top-1.5 rounded p-1 opacity-40 transition-opacity hover:opacity-100"
        style={{ color: theme.ink }}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
