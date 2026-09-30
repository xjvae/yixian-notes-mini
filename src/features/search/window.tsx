// 搜索窗 — 输入即查（150ms 防抖），点结果拉起浮窗，Esc 关窗。
// 检索语义在后端（query/search.rs）：子串匹配、标题命中优先、私密与已删不进结果。

import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { noteTypeLabel } from "@/data/note-types";
import { themeOf } from "@/data/theme";
import { displayTitle } from "@/data/note-types";
import { closeSearchWindow, openFloatingSticky, searchQuery } from "@/platform/commands";
import type { SearchHit } from "@/platform/contracts";

const PANEL_BACKGROUND = "#F7F6F3";
const PANEL_ACCENT = "#5B6470";
const DEBOUNCE_MS = 150;

function snippet(hit: SearchHit): string {
  const source = hit.body.trim() !== "" ? hit.body : "（无正文）";
  return source.length > 60 ? `${source.slice(0, 60)}…` : source;
}

export function SearchWindow() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback((value: string): void => {
    void searchQuery(value)
      .then((results) => {
        setHits(results);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      // 空查询不取数：展示层用 visibleHits 派生空态，这里不用同步 setState
      return;
    }
    const timer = setTimeout(() => runSearch(trimmed), DEBOUNCE_MS);
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

  /** 空查询不展示任何结果（展示层派生，不走同步 setState） */
  const visibleHits = query.trim() === "" ? null : hits;

  return (
    <WindowChrome
      background={PANEL_BACKGROUND}
      accent={PANEL_ACCENT}
      pinned={false}
      onTogglePin={() => {}}
      onClose={() => {
        void closeSearchWindow().catch(() => {});
      }}
    >
      <div className="flex h-full flex-col gap-2 p-4">
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2">
          <Search size={14} className="shrink-0 text-neutral-400" aria-hidden />
          <input
            ref={inputRef}
            aria-label="搜索便签"
            placeholder="搜标题、正文、清单、标签…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-800 placeholder:text-neutral-400"
          />
        </div>
        {error !== null && (
          <div role="alert" className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {visibleHits === null || visibleHits.length === 0 ? (
            <div className="mt-8 text-center text-xs text-neutral-400">
              {query.trim() === ""
                ? "输入两个字就能搜到正文中间的词；私密便签不参与搜索。"
                : "没有命中的便签。"}
            </div>
          ) : (
            visibleHits.map((hit) => {
              const ink = themeOf(hit.theme);
              return (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => open(hit.id)}
                  className="flex flex-col items-start gap-0.5 rounded-lg border border-black/5 bg-white px-3 py-2 text-left transition-colors hover:bg-black/[0.03]"
                  style={{ borderLeft: `3px solid ${ink.accent}` }}
                >
                  <span className="max-w-full truncate text-[13px] font-medium text-neutral-800">
                    {displayTitle(hit.title, false)}
                  </span>
                  <span className="max-w-full truncate text-[11px] text-neutral-500">
                    {snippet(hit)}
                  </span>
                  <span className="text-[10px] text-neutral-400">
                    {noteTypeLabel(hit.contentType)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </WindowChrome>
  );
}
