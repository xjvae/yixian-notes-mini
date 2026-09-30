// 回收站窗 — 软删便签的列表、恢复与彻底删除。
// 取数不走主 store（那里只有未删数据）：直接 list(includeDeleted) + 听 db:changed 刷新。
// 「彻底删除」真删，不可恢复——两段确认（第一击变确认键，3 秒不点自动退回）。

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import { WindowChrome } from "@/ui/window-chrome";
import { displayTitle, noteTypeLabel } from "@/data/note-types";
import { themeOf } from "@/data/theme";
import {
  closeTrashWindow,
  stickyDelete,
  stickyList,
  trashRestore,
} from "@/platform/commands";
import { listen } from "@/platform/bridge";
import { DB_CHANGED } from "@/platform/contracts";
import type { DbChangedEvent, StickyNote } from "@/platform/contracts";

const PANEL_BACKGROUND = "#F7F6F3";
const PANEL_ACCENT = "#5B6470";
const CONFIRM_RESET_MS = 3000;

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TrashWindow() {
  const [rows, setRows] = useState<StickyNote[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const all = await stickyList(true);
      setRows(all.filter((row) => row.deleted));
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error));
    }
  }, []);

  useEffect(() => {
    // 首刷 + 订阅广播。reload 的 setState 都在 await 之后（异步取数），
    // 不是 set-state-in-effect 防的同步重渲染循环，规则在此误报、豁免一行。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    let off: (() => void) | null = null;
    let cancelled = false;
    void listen<DbChangedEvent>(DB_CHANGED, (payload) => {
      if (payload.kind !== "sticky") return;
      void reload();
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [reload]);

  const handleRestore = useCallback((id: string) => {
    void trashRestore(id).catch((error: unknown) => {
      setLoadError(String(error));
    });
  }, []);

  const handleHardDelete = useCallback(
    (id: string) => {
      if (confirmingId !== id) {
        setConfirmingId(id);
        if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmingId(null), CONFIRM_RESET_MS);
        return;
      }
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      setConfirmingId(null);
      void stickyDelete(id, true).catch((error: unknown) => {
        setLoadError(String(error));
      });
    },
    [confirmingId],
  );

  const deleted = rows ?? [];
  const deletedCount = deleted.length;

  return (
    <WindowChrome
      background={PANEL_BACKGROUND}
      accent={PANEL_ACCENT}
      pinned={false}
      onTogglePin={() => {}}
      onClose={() => {
        void closeTrashWindow().catch(() => {});
      }}
    >
      <div className="flex h-full flex-col gap-2 p-4">
        <div className="flex shrink-0 items-baseline gap-2">
          <h1 className="text-sm font-semibold text-neutral-800">回收站</h1>
          <span className="text-xs text-neutral-400">
            {rows === null ? "载入中…" : `${deletedCount} 张，30 天后自动清理`}
          </span>
        </div>
        {loadError !== null && (
          <div role="alert" className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
            {loadError}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {rows !== null && deletedCount === 0 && (
            <div className="mt-8 text-center text-xs text-neutral-400">
              回收站是空的。删掉的便签会在这里躺 30 天。
            </div>
          )}
          {deleted.map((row) => {
            const ink = themeOf(row.theme);
            const confirming = confirmingId === row.id;
            return (
              <div
                key={row.id}
                className="flex items-center gap-2 rounded-lg border border-black/5 bg-white px-3 py-2"
                style={{ borderLeft: `3px solid ${ink.accent}` }}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-neutral-800">
                    {displayTitle(row.title, row.private)}
                  </div>
                  <div className="text-[11px] text-neutral-400">
                    {noteTypeLabel(row.contentType)} · 删于{" "}
                    {formatDateTime(row.deletedAt ?? 0)}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`恢复「${displayTitle(row.title, row.private)}」`}
                  onClick={() => handleRestore(row.id)}
                  className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-black/5"
                >
                  <RotateCcw size={12} aria-hidden />
                  恢复
                </button>
                <button
                  type="button"
                  aria-label={
                    confirming
                      ? `确认彻底删除「${displayTitle(row.title, row.private)}」`
                      : `彻底删除「${displayTitle(row.title, row.private)}」`
                  }
                  onClick={() => handleHardDelete(row.id)}
                  className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs transition-colors hover:bg-red-50"
                  style={{ color: confirming ? "#B91C1C" : "#9CA3AF" }}
                >
                  {confirming ? (
                    <X size={12} aria-hidden />
                  ) : (
                    <Trash2 size={12} aria-hidden />
                  )}
                  {confirming ? "确认删除" : "彻底删除"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </WindowChrome>
  );
}
