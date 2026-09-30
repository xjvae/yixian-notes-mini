// 入口共用装配 — 每个入口只做「选组件 + 注入 Backend + hydrate」，其余在这里。
//
// 数据流：先注入 Backend → 先订阅、后 hydrate（次序铁律在 notes-store）→ 挂载。
// hydrate 失败渲染明确的错误界面——没有 localStorage 退路，主库不可用就是不可用。

import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describeError } from "@/platform/errors";
import { createTauriBackend } from "@/store/backend";
import { hydrateStore, initStore } from "@/store/notes-store";
import "@/index.css";

function clearBootStatus(): void {
  document.getElementById("boot-status")?.remove();
}

export interface BootOptions {
  /** ErrorBoundary 的窗口名 */
  label: string;
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

export async function boot({ label, render }: BootOptions): Promise<void> {
  const mount = () => {
    const root = document.getElementById("root");
    if (!root) return;
    createRoot(root).render(
      <StrictMode>
        {/* ErrorBoundary 随错误界面专项一起加（M2），骨架期先直接渲染 */}
        {render()}
      </StrictMode>,
    );
    clearBootStatus();
  };

  try {
    initStore(createTauriBackend());
    await hydrateStore();
    mount();
  } catch (error) {
    renderFatal(label, error);
  }
}
