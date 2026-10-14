// 热键节 — 快捷键清单与改键捕获。清单条目由 Rust 表决定（hotkeys.rs::DEFAULT_BINDINGS），这里不写死。
// 改键必须带 Ctrl/Alt/Super（Shift 不算），交给 Rust 的键名走 event.code。
// 设置失败 Rust 自动还原旧键并回错；启动就没绑上的键位（bound=false）在该行下标注"没绑上"。

import { useCallback, useEffect, useRef, useState } from "react";
import { appSetHotkey, hotkeyList } from "@/platform/commands";
import type { HotkeyBinding } from "@/platform/contracts";
// 键位文案与引导教程共用 data/hotkey-labels，别两处各写一套
import { ACTION_LABELS, prettyKey } from "@/data/hotkey-labels";

export function HotkeySection() {
  const [bindings, setBindings] = useState<HotkeyBinding[] | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const captureRef = useRef<HTMLSpanElement>(null);

  const reload = useCallback((): void => {
    void hotkeyList()
      .then(setBindings)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 捕获态输入框手动聚焦（autoFocus 被 a11y 规则禁用）
  useEffect(() => {
    if (capturing !== null) captureRef.current?.focus();
  }, [capturing]);

  const onKeyDown = useCallback(
    (action: string, event: React.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }
      // 纯修饰键按下不结束捕获：等组合完成
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
      if (!(event.ctrlKey || event.altKey || event.metaKey)) {
        setError("全局热键必须带 Ctrl 或 Alt（Shift 不算），Esc 取消");
        return;
      }
      const parts: string[] = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Super");
      parts.push(event.code);
      setCapturing(null);
      void appSetHotkey(action, parts.join("+"))
        .then(() => {
          setError(null);
          reload();
        })
        .catch((err: unknown) => {
          setError(String(err));
          reload(); // Rust 已把旧键还原，拉回事实
        });
    },
    [reload],
  );

  return (
    <div className="flex flex-col gap-1">
      {bindings === null ? (
        <p className="text-[11px] text-[var(--panel-muted)]">载入中…</p>
      ) : (
        bindings.map((binding) => {
          // 停用（空串）那一行不算"没绑上"：那是用户自己要的结果
          const unbound = !binding.bound && binding.key !== "";
          return (
            <div key={binding.action} className="flex flex-col">
              <div className="flex items-center justify-between rounded px-1 py-0.5">
                <span className="text-xs text-[var(--panel-ink)]">
                  {ACTION_LABELS[binding.action] ?? binding.action}
                </span>
                {capturing === binding.action ? (
                  <span
                    ref={captureRef}
                    tabIndex={0}
                    role="button"
                    aria-label={`为${ACTION_LABELS[binding.action]}按下新键位，Esc 取消`}
                    onKeyDown={(event) => onKeyDown(binding.action, event)}
                    className="rounded border border-dashed border-[var(--panel-ink)] px-2 py-0.5 text-[11px] text-[var(--panel-ink)]"
                  >
                    请按下新键位…
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`更改${ACTION_LABELS[binding.action] ?? binding.action}的快捷键（当前 ${prettyKey(binding.key)}${unbound ? "，没绑上" : ""}）`}
                    onClick={() => {
                      setError(null);
                      setCapturing(binding.action);
                    }}
                    className={`rounded border px-2 py-0.5 text-[11px] transition-colors hover:bg-[var(--panel-hover)] ${
                      unbound
                        ? "border-amber-600 text-amber-700"
                        : "border-[var(--panel-border)] text-[var(--panel-ink)]"
                    }`}
                  >
                    {prettyKey(binding.key)}
                  </button>
                )}
              </div>
              {unbound && (
                <p className="px-1 text-[11px] leading-snug text-amber-700">
                  {prettyKey(binding.key)} 被别的程序占用，按了没反应；
                  点上面换个键位，或用长按右键的星环。
                </p>
              )}
            </div>
          );
        })
      )}
      {error !== null && (
        <p role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
