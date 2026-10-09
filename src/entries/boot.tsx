// 入口共用装配 — 每个入口只做「选组件 + 注入 Backend + hydrate」，其余在这里。
//
// 数据流：先注入 Backend → 先订阅、后 hydrate（次序铁律在 notes-store）→ 挂载。
// hydrate 失败渲染明确的错误界面——没有 localStorage 退路，主库不可用就是不可用。
// 不需要主数据的面板窗（回收站等）用 hydrate:false，自己取数。

import { type ReactNode, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/ui/error-boundary";
import { initPrivateState, onPrivateLayerChange } from "@/data/private-state";
import { initGroupPresentation } from "@/data/group-presentation";
import { initAutoSizeDefault } from "@/data/auto-size-default";
import { initScheme } from "@/data/scheme";
import { describeError } from "@/platform/errors";
import { floatReveal } from "@/platform/commands";
import { logger } from "@/platform/logger";
import { createTauriBackend } from "@/store/backend";
import { refreshStore, hydrateStore, initStore } from "@/store/notes-store";
import { withPrivateLayer } from "@/store/private-backend";
import "@/index.css";

/**
 * 整棵树提交到 DOM 之后喊一声"可以亮了"。
 *
 * 便签窗是**建的时候隐藏**的（`windows/factory.rs` 的 `reveal_timeout_ms`）：透明窗一出生
 * 就显示的话，先亮的是 WebView2 那块默认白，要等 hydrate + 首帧画完才出便签——作者报的
 * "打开软件时白屏一阵"。挂在这层而不是 `mount()` 里，是因为 `createRoot().render()`
 * 的初次提交是异步的：在 mount() 后面直接喊会在画面还是空的时候就把窗亮出来。
 * StrictMode 下 effect 跑两遍也没事（reveal 就是 show + focus，幂等）。
 * 喊失败（或整棵树崩在这儿之前）也不会看不见便签：那边 2s 到点自己 show。
 */
function RevealWhenCommitted({ focus }: { focus: boolean }): null {
  useEffect(() => {
    void floatReveal(focus).catch((error: unknown) =>
      logger.caught("boot", "报就绪失败（窗会由超时兜底显示）", error),
    );
  }, [focus]);
  return null;
}

function clearBootStatus(): void {
  document.getElementById("boot-status")?.remove();
}

export interface BootOptions {
  /** ErrorBoundary 的窗口名 */
  label: string;
  /** 默认 true：渲染前先把主数据载入 store */
  hydrate?: boolean;
  /** 隐藏建的窗（便签单窗与叠窗）画完第一帧后要不要亮出来。默认 false：面板窗出生就可见 */
  reveal?: boolean;
  /** 亮出来时顺带拿不拿焦点。默认 true；提醒卡给 false（到点的提醒不许抢走打字的光标） */
  revealFocus?: boolean;
  render: () => ReactNode;
}

function renderFatal(label: string, error: unknown): void {
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `
      <div style="display:flex;height:100vh;align-items:center;justify-content:center;background:#FEF2F2;color:#B91C1C;font-size:13px;padding:24px;text-align:center">
        ${label}启动失败：${describeError(error)}
      </div>`;
  }
}

export async function boot({
  label,
  hydrate = true,
  reveal = false,
  revealFocus = true,
  render,
}: BootOptions): Promise<void> {
  if (import.meta.env.DEV) {
    // 预览台（http://localhost:5174/preview.html）里每一扇 iframe 窗都先装替身桥再装配。
    // 生产构建里这段整个被折掉：DEV=false → 动态 chunk 不被引用，桥恒为真 Tauri。
    const { installPreviewBridge } = await import("@/preview/bridge-client");
    installPreviewBridge();
  }
  const mount = () => {
    const root = document.getElementById("root");
    if (!root) return;
    createRoot(root).render(
      <StrictMode>
        <ErrorBoundary label={label}>{render()}</ErrorBoundary>
        {/* 放在 ErrorBoundary **外面**：真崩了也要把窗亮出来（里面是明确的错误界面），
            隐藏着的崩溃窗比错误界面更糟 */}
        {reveal && <RevealWhenCommitted focus={revealFocus} />}
      </StrictMode>,
    );
    clearBootStatus();
  };

  if (!hydrate) {
    void (async () => {
      // 主题在挂载前应用：晚了就先闪一帧浅色
      await initScheme();
      await initGroupPresentation();
      await initAutoSizeDefault();
      mount();
    })();
    return;
  }
  try {
    // 私密层包装在 Backend 上：读写拆合对 store 与视图透明
    initStore(withPrivateLayer(createTauriBackend()));
    await initScheme();
    await initGroupPresentation();
    await initAutoSizeDefault();
    await initPrivateState();
    // 解锁/锁定/改密后重拉：包装层按新的私密状态重新合并或隐去内容
    onPrivateLayerChange(() => void refreshStore());
    await hydrateStore();
    mount();
  } catch (error) {
    renderFatal(label, error);
  }
}
