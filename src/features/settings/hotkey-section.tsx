// 热键节 — 五条全局快捷键的展示与改键（键盘捕获）。
//
// 捕获口径：点击「更改」进入捕获态，下一个按键组合即成为新键位（Esc 取消）。
// 两条硬规则：
//  · **必须带 Ctrl/Alt/Super 修饰**——光秃秃一个字母当全局热键，用户打字就触发了；
//    Shift 不算修饰（Shift+X 是打大写的正常动作）。
//  · 交给 Rust 的键名用 event.code（KeyA/Digit1/Space），与 global-hotkey 的解析器
//    同一口径；展示时剥掉 Key/Digit 前缀。
// 改键失败（被占用）Rust 会自动还原旧键并回错——这里如实显示错误，清单重拉。

import { useCallback, useEffect, useRef, useState } from "react";
import { appSetHotkey, hotkeyList } from "@/platform/commands";
import type { HotkeyBinding } from "@/platform/contracts";

const ACTION_LABELS: Record<string, string> = {
  ring: "唤起星环",
  sticky: "新建便签",
  search: "搜索",
  trash: "回收站",
  settings: "设置",
};

function prettyKey(accel: string): string {
  if (accel === "") return "已停用";
  return accel
    .split("+")
    .map((part) =>
      part
        .replace(/^Key/, "")
        .replace(/^Digit/, "")
        .replace(/^Space$/, "空格"),
    )
    .join(" + ");
}

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

  // 进入捕获态的输入框自己拿焦点（autoFocus 被 a11y 规则禁用，语义等价地手动来）
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
        bindings.map((binding) => (
          <div
            key={binding.action}
            className="flex items-center justify-between rounded px-1 py-0.5"
          >
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
                aria-label={`更改${ACTION_LABELS[binding.action] ?? binding.action}的快捷键（当前 ${prettyKey(binding.key)}）`}
                onClick={() => {
                  setError(null);
                  setCapturing(binding.action);
                }}
                className="rounded border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--panel-ink)] transition-colors hover:bg-[var(--panel-hover)]"
              >
                {prettyKey(binding.key)}
              </button>
            )}
          </div>
        ))
      )}
      {error !== null && (
        <p role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      )}
      <p className="mt-1 text-[11px] text-[var(--panel-muted)]">
        新键位必须带 Ctrl 或 Alt；被其它程序占用的键位设置不上，旧键会自动还原。
      </p>
    </div>
  );
}
