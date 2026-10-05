// 预览台页面本体（只在 dev 存在：vite.config.ts 里 preview 入口仅在 serve 模式加入）。
//
// 用法：npm run dev 后开 http://localhost:5174/preview.html
// 每一扇框是一个真 iframe，跑的是真入口（index.html?…&preview=1），
// 于是 h-screen/w-screen 的排版量的是真窗尺寸，不是页面里的一块 div。
//
// 框顶那条是宿主自己的（iframe 里的 data-tauri-drag-region 在浏览器里不生效）：
// 拖它 = 给窗内推 moved 事件，改宽高输入 = 推 resized，
// 从而把 store 的 180ms 几何合流与最小尺寸纠偏跑出来。

import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { PreviewHost } from "@/preview/host";
import "@/index.css";

const host = new PreviewHost();

const TOOLBAR: readonly { label: string; run: () => unknown }[] = [
  { label: "新建便签", run: () => host.run("create_floating_sticky") },
  { label: "搜索窗", run: () => host.run("open_search_window") },
  { label: "回收站", run: () => host.run("open_trash_window") },
  { label: "设置窗", run: () => host.run("open_settings_window") },
  { label: "口令窗", run: () => host.run("open_unlock_window") },
  { label: "星环", run: () => host.run("open_ring_window") },
  { label: "模拟托盘锁定", run: () => host.trayLock() },
];

export function PreviewStudio() {
  useSyncExternalStore(
    (listener) => host.subscribe(listener),
    () => host.snap,
  );
  const frames = host.frameList();
  const [dragging, setDragging] = useState<{
    label: string;
    dx: number;
    dy: number;
  } | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (data && typeof data === "object" && (data as { t?: string }).t === "winop") {
        host.handleWindowOp(data);
        return;
      }
      host.handleRequest(event.source, data);
    };
    window.addEventListener("message", onMessage);
    host.seedOpen();
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (dragging === null) return;
    const onMove = (event: PointerEvent): void => {
      const rect = layerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      host.pushGeometry(dragging.label, {
        x: Math.round(event.clientX - rect.left - dragging.dx),
        y: Math.round(event.clientY - rect.top - dragging.dy),
      });
    };
    const onUp = (): void => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  const snap = host.db.snapshot();

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-200 text-[13px] text-neutral-800">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-black/10 bg-neutral-100 px-3 py-2">
        <strong className="mr-1">预览台</strong>
        {TOOLBAR.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => {
              // 宿主自己发的命令也可能带窗口动作（新建便签要落一扇框），
              // 忽略返回值就等于把动作丢在半路
              item.run();
            }}
            className="rounded border border-black/15 bg-white px-2 py-1 hover:bg-neutral-50"
          >
            {item.label}
          </button>
        ))}
        <select
          aria-label="主题档位"
          value={snap.settings.find(([key]) => key === "scheme")?.[1] ?? "system"}
          onChange={(event) =>
            host.run("settings_set", { key: "scheme", value: event.currentTarget.value })
          }
          className="rounded border border-black/15 bg-white px-1 py-1"
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
        <span className="flex-1" />
        <span className="text-[11px] text-neutral-500">
          便签 {snap.stickies.filter((row) => !row.deleted).length} · 组{" "}
          {snap.groups.length} · 私密{" "}
          {snap.private.configured
            ? snap.private.unlocked
              ? "已解锁"
              : "已锁"
            : "未配置"}{" "}
          · 命令 {snap.log.length}
        </span>
        <button
          type="button"
          onClick={() => host.reset()}
          className="rounded border border-black/15 bg-white px-2 py-1 hover:bg-neutral-50"
        >
          重置数据
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div ref={layerRef} className="relative min-w-0 flex-1 overflow-hidden">
          {frames.map((frame) => (
            <section
              key={frame.label}
              className="absolute overflow-hidden rounded-md border border-black/25 bg-white shadow-[0_6px_18px_rgba(0,0,0,0.15)]"
              style={{
                left: frame.rect.x,
                top: frame.rect.y,
                width: frame.rect.width,
                height: frame.rect.height + 22,
                // 关 = 隐藏的窗：DOM 留着（iframe 不卸载，WebView 实例与窗内状态都在），
                // 与 Rust 的 show/hide 同一档语义
                display: frame.hidden ? "none" : "block",
              }}
            >
              <div
                onPointerDown={(event) => {
                  const own = event.currentTarget.getBoundingClientRect();
                  setDragging({
                    label: frame.label,
                    dx: event.clientX - own.left,
                    dy: event.clientY - own.top,
                  });
                }}
                className="flex h-[22px] cursor-grab items-center gap-1 border-b border-black/10 bg-neutral-800 px-1.5 text-[10px] text-neutral-100"
              >
                <span className="truncate font-medium">{frame.title}</span>
                <span className="truncate opacity-60">{frame.label}</span>
                <span className="flex-1" />
                <label className="flex items-center gap-0.5 opacity-80">
                  宽
                  <input
                    type="number"
                    value={Math.round(frame.rect.width)}
                    min={frame.min.width || undefined}
                    onChange={(event) =>
                      host.pushGeometry(frame.label, {
                        width: Number(event.currentTarget.value),
                      })
                    }
                    className="w-12 rounded bg-neutral-700 px-1 text-[10px] text-white"
                  />
                </label>
                <label className="flex items-center gap-0.5 opacity-80">
                  高
                  <input
                    type="number"
                    value={Math.round(frame.rect.height)}
                    min={frame.min.height || undefined}
                    onChange={(event) =>
                      host.pushGeometry(frame.label, {
                        height: Number(event.currentTarget.value),
                      })
                    }
                    className="w-12 rounded bg-neutral-700 px-1 text-[10px] text-white"
                  />
                </label>
                <button
                  type="button"
                  aria-label="卸掉这扇（预览台自己的，不走窗的关＝隐藏）"
                  title="卸掉这扇 iframe"
                  onClick={() => host.destroyFrame(frame.label)}
                  className="rounded px-1 hover:bg-white/20"
                >
                  ×
                </button>
              </div>
              <iframe
                ref={(element) => host.attach(element, frame.label)}
                title={`${frame.title} ${frame.label}`}
                src={frame.src}
                className="block h-[calc(100%-22px)] w-full border-0 bg-white"
              />
            </section>
          ))}
          {frames.length === 0 && (
            <p className="p-6 text-neutral-500">
              一扇都没开。上面「新建便签」，或「重置数据」把样例铺回来。
            </p>
          )}
        </div>

        <aside className="w-64 shrink-0 overflow-y-auto border-l border-black/10 bg-neutral-100 p-2 text-[11px]">
          <h2 className="mb-1 font-semibold">
            数据核快照（这列表 = 主库里真实躺着的东西）
          </h2>
          <ul className="space-y-0.5">
            {snap.stickies.map((row) => (
              <li key={row.id} className="truncate">
                <span className={row.deleted ? "line-through opacity-50" : ""}>
                  {row.id}
                </span>{" "}
                {row.groupId !== null ? (
                  <span className="opacity-60">{row.groupId}</span>
                ) : null}
                {row.private ? <span className="text-violet-600"> 密</span> : null}
                {row.collapsed ? <span className="opacity-60"> 收</span> : null}
                {row.docked ? <span className="opacity-60"> 贴</span> : null}
                {/* 私密便签这一格该是空占位：主库只留形状，真身在封套里（写拆分） */}
                <span className="opacity-45">「{row.title || "…"}」</span>
              </li>
            ))}
          </ul>
          <h2 className="mt-3 mb-1 font-semibold">命令流水</h2>
          <ol className="space-y-0.5 opacity-70">
            {snap.log.slice(0, 24).map((line, index) => (
              <li key={`${index}-${line}`} className="truncate">
                {line}
              </li>
            ))}
          </ol>
          <h2 className="mt-3 mb-1 font-semibold">没覆盖的</h2>
          <p className="opacity-70">
            真拖动（拖的是宿主框顶，不是 OS 边框）、贴边细丝与 20px 收纳、多显示器/DPI、
            全局快捷键、长按右键钩子、文件日志与崩溃转储；星环的"落在光标处"也只能真机看
            （预览台把它摆在画布左上）。这些只能真机过。
          </p>
        </aside>
      </div>
    </div>
  );
}

const mounted = document.getElementById("root");
if (mounted) {
  createRoot(mounted).render(
    <StrictMode>
      <PreviewStudio />
    </StrictMode>,
  );
}
