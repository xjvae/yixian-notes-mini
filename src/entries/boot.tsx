// 入口共用装配 — 每个入口只做「选组件 + 注入 Backend + hydrate」，其余在这里。
//
// 数据流：先注入 Backend → 先订阅、后 hydrate（次序铁律在 notes-store）→ 挂载。
// hydrate 失败渲染明确的错误界面——没有 localStorage 退路，主库不可用就是不可用。
// 不需要主数据的面板窗（回收站等）用 hydrate:false，自己取数。

import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/ui/error-boundary";
import { initPrivateState, onPrivateLayerChange } from "@/data/private-state";
import { initScheme } from "@/data/scheme";
import { describeError } from "@/platform/errors";
import { createTauriBackend } from "@/store/backend";
import { refreshStore, hydrateStore, initStore } from "@/store/notes-store";
import { withPrivateLayer } from "@/store/private-backend";
import "@/index.css";

function clearBootStatus(): void {
  document.getElementById("boot-status")?.remove();
}

export interface BootOptions {
  /** ErrorBoundary 的窗口名 */
  label: string;
  /** 默认 true：渲染前先把主数据载入 store */
  hydrate?: boolean;
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
      </StrictMode>,
    );
    clearBootStatus();
  };

  if (!hydrate) {
    void (async () => {
      // 主题在挂载前应用：晚了就先闪一帧浅色
      await initScheme();
      mount();
    })();
    return;
  }
  try {
    // 私密层包装在 Backend 上：读写拆合对 store 与视图透明
    initStore(withPrivateLayer(createTauriBackend()));
    await initScheme();
    await initPrivateState();
    // 解锁/锁定/改密后重拉：包装层按新的私密状态重新合并或隐去内容
    onPrivateLayerChange(() => void refreshStore());
    await hydrateStore();
    mount();
  } catch (error) {
    renderFatal(label, error);
  }
}
