// 搜索窗 — 输入即查（150ms 防抖），点结果拉起浮窗，Esc 关窗。空查询 = 最近 50 张。
// 检索语义在后端（query/search.rs）：子串匹配、标题命中优先、私密与已删不进结果。

import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { noteTypeLabel } from "@/data/note-types";
import { themeOf } from "@/data/theme";
import { displayTitle } from "@/data/note-types";
import { plainPreview } from "@/data/body-parse";
import { closeSearchWindow, openFloatingSticky, searchQuery } from "@/platform/commands";
import type { SearchHit, SearchOutcome } from "@/platform/contracts";

const PANEL_BG = "var(--panel-bg)";
const PANEL_ACCENT = "var(--panel-ink)";
const DEBOUNCE_MS = 150;
const SNIPPET_MAX = 60;

/** 摘要的料：正文有空就退到条目文本上——清单类和时间轴类的正文本来就住在那 */
function snippet(hit: SearchHit): string {
  if (hit.body.trim() !== "") return plainPreview(hit.body, SNIPPET_MAX);
  const lines = [
    ...hit.items.map((item) => item.text),
    ...hit.timeline.map((entry) => entry.text),
  ];
  return plainPreview(lines.join("、"), SNIPPET_MAX) || "（还没写东西）";
}

export function SearchWindow() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback((value: string): void => {
    void searchQuery(value)
      .then((outcome) => {
        setResult(outcome);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  // 专用搜索窗打开即聚焦输入框（autoFocus 属性被 a11y 规则禁用，语义等价地手动来）
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const open = useCallback((id: string): void => {
    void (async () => {
      await openFloatingSticky(id);
      await closeSearchWindow().catch(() => {});
    })();
  }, []);

  // Esc 关窗
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        void closeSearchWindow().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** null = 第一跳还没回来，先空着而不是报"还没有便签" */
  const rows = result?.hits ?? null;
  const locked = result?.privateSkipped ?? 0;

  return (
    <WindowChrome
      background={PANEL_BG}
      accent={PANEL_ACCENT}
      pinned={false}
      onTogglePin={() => {}}
      onClose={() => {
        void closeSearchWindow().catch(() => {});
      }}
    >
      <div className="flex h-full flex-col gap-2 p-4">
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-card)] px-3 py-2">
          <Search size={14} className="shrink-0 text-[var(--panel-muted)]" aria-hidden />
          <input
            ref={inputRef}
            aria-label="搜索便签"
            placeholder="搜标题、正文、清单、标签…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--panel-ink)] placeholder:text-[var(--panel-muted)]"
          />
        </div>
        {error !== null && (
          <div role="alert" className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {rows === null ? null : rows.length === 0 ? (
            <div className="mt-8 text-center text-xs text-[var(--panel-muted)]">
              {query.trim() === "" ? "还没有便签。" : "没有命中的便签。"}
            </div>
          ) : (
            rows.map((hit) => {
              const ink = themeOf(hit.theme);
              return (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => open(hit.id)}
                  className="flex flex-col items-start gap-0.5 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-card)] px-3 py-2 text-left transition-colors hover:bg-[var(--panel-hover)]"
                  style={{ borderLeft: `3px solid ${ink.accent}` }}
                >
                  <span className="max-w-full truncate text-[13px] font-medium text-[var(--panel-ink)]">
                    {displayTitle(hit.title, false)}
                  </span>
                  <span className="max-w-full truncate text-[11px] text-[var(--panel-muted)]">
                    {snippet(hit)}
                  </span>
                  <span className="text-[10px] text-[var(--panel-muted)]">
                    {noteTypeLabel(hit.contentType)}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {/* 锁着的没参与这件事要说出来：只报"没有命中"，人会觉得那张便签丢了 */}
        {rows !== null && locked > 0 && (
          <p className="shrink-0 text-center text-[11px] text-[var(--panel-muted)]">
            另有 {locked} 张私密便签没参与
          </p>
        )}
      </div>
    </WindowChrome>
  );
}
