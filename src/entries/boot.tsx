// 入口共用装配 — 每个入口只做「选组件 + 注入 Backend + hydrate」，其余在这里。
//
// 数据流：先注入 Backend → 先订阅、后 hydrate（次序铁律在 notes-store）→ 挂载。
// hydrate 失败渲染明确的错误界面——没有 localStorage 退路，主库不可用就是不可用。
// 不需要主数据的面板窗（回收站等）用 hydrate:false，自己取数。

import { type ReactNode, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/ui/error-boundary";
import {
  hasRevealed,
  initPrivateState,
  onPrivateLayerChange,
} from "@/data/private-state";
import { initGroupPresentation } from "@/data/group-presentation";
import { initAutoSizeDefault } from "@/data/auto-size-default";
import { initLockAfterMark } from "@/data/lock-after-mark";
import { initScheme } from "@/data/scheme";
import { describeError } from "@/platform/errors";
import { floatReveal } from "@/platform/commands";
import { logger } from "@/platform/logger";
import { createTauriBackend } from "@/store/backend";
import { flushNow, refreshStore, hydrateStore, initStore } from "@/store/notes-store";
import "@/index.css";

/**
 * 整棵树提交到 DOM 之后喊一声"可以亮了"。便签窗建的时候是隐藏的：透明窗一出生就 show，
 * 先亮的是 WebView2 默认白（"打开软件白屏一阵"），必须等 hydrate + 首帧画完。挂在这层而不是
 * mount() 里：createRoot().render() 的初次提交是异步的。幂等，StrictMode 跑两遍没事；
 * 喊失败也有兜底（那边 2s 到点自己 show）。
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
  if (!root) return;
  const box = document.createElement("div");
  box.style.cssText =
    "display:flex;height:100vh;align-items:center;justify-content:center;background:#FEF2F2;color:#B91C1C;font-size:13px;padding:24px;text-align:center";
  // textContent 而不是 innerHTML：error 消息是动态串，拼进 innerHTML 就是全库唯一一处注入面
  box.textContent = `${label}启动失败：${describeError(error)}`;
  root.replaceChildren(box);
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
      // 主题在挂载前应用：晚了就先闪一帧浅色。四条互不依赖，串起来就是把首帧推后四趟往返
      await Promise.all([
        initScheme(),
        initGroupPresentation(),
        initAutoSizeDefault(),
        initLockAfterMark(),
      ]);
      mount();
    })();
    return;
  }
  try {
    // 私密层的读合并/写拆分全在 Rust（`db/query/private_note.rs`）：store 拿到的
    // 就已经是合并好的行，锁着时是空占位。这一层不需要任何包装
    initStore(createTauriBackend());
    // 设置项四条 + 私密状态 + 首屏数据**并行**发。原来是一串 await 下来才轮到最贵的那发
    // `get_bootstrap`（全库列表含正文），于是首帧时间约等于"六趟往返之和"。
    // 次序铁律仍在 `hydrateStore` 自己身上（先订阅后读），这里并行不打断它
    await Promise.all([
      initScheme(),
      initGroupPresentation(),
      initAutoSizeDefault(),
      initLockAfterMark(),
      initPrivateState(),
    ]);
    // 揭开/收回/改密后重拉：Rust 按新的私密状态合并或隐去内容
    onPrivateLayerChange(
      () =>
        void (async () => {
          // 有张刚被揭开，先补做"这张没开着时写不下去"的那几条（守卫在 `sticky::upsert`：
          // 没揭开的当一拍打的字会被退回在途队列，不补就要等下一次编辑才落）。
          // 逐张模型里 flushNow 会照旧把还开着的张送去落库，解不开的留在队列里
          if (hasRevealed()) await flushNow();
          await refreshStore();
        })(),
    );
    await hydrateStore();
    mount();
  } catch (error) {
    renderFatal(label, error);
  }
}
