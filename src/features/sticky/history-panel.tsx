// 历史版本面板 — 一张便签自己的版本列表与一键回滚。
//
// 为什么是窗内一层覆盖而不是新扇窗：回滚要看的就是"这一张现在长什么样 vs 那一版"，
// 另起一扇就得隔着两扇窗对内容。覆盖层跟着 NoteContent 走，单窗与叠窗都白拿这一份
// （叠窗里翻页翻到哪一张，历史就是哪一张的）。
//
// 口径：一版 = 这张**被换掉之前**的内容；打字流每分钟最多留一档；每张最新 50 条、7 天。
// 普通便签的版本住主库明文表，私密便签的版本住密文表——**分岔在 Rust 那一侧**
// （`commands/revision.rs` 按行上的密级走），这一层只发同一条命令。
//
// "私密的历史必须输口令才看得到"也不需要这一层再做一道门：锁着的私密便签整面正文就是
// 遮罩（`isMasked`），页脚连这颗钮都不在，压根走不到这里；真走到了，Rust 那边锁着会直接
// 抛 `PRIVATE_LOCKED`（私密的版本与私密的正文共用同一道门，没有第二条读路径）。

import { useCallback, useEffect, useRef, useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import { stickyRevisions, stickyRevert } from "@/platform/commands";
import type { RevisionMeta } from "@/platform/contracts";
import { noteTypeLabel } from "@/data/note-types";
import { logger } from "@/platform/logger";
import { refreshStore } from "@/store/notes-store";

/** 与回收站那两处同一个节奏：第一击变确认键，3 秒不点自动退回 */
const CONFIRM_RESET_MS = 3000;

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${clock}` : `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

export function HistoryPanel({
  noteId,
  ink,
  accent,
  onClose,
}: {
  noteId: string;
  ink: string;
  accent: string;
  onClose: () => void;
}): React.ReactElement {
  const [rows, setRows] = useState<RevisionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armedSeq, setArmedSeq] = useState<number | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback((): void => {
    void stickyRevisions(noteId)
      .then((list) => {
        setRows(list);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [noteId]);

  useEffect(() => {
    load();
    return () => {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    };
  }, [load]);

  /** 真的换回去。私密与否由 Rust 按行上的密级分岔，这一层只发同一条命令 */
  const applyRevert = useCallback(
    async (seq: number): Promise<void> => {
      // 这条绕过 store 直接写库（与 `sticky_set_group` 同一条路），而 store 跳过
      // 自己发起的广播——不主动重读，这扇窗会一直停在回滚前那份内容上
      await stickyRevert(noteId, seq);
      await refreshStore();
      // 回滚本身被记成一版，所以重读列表：刚被换掉的那一份必须出现在这里，
      // 否则"回滚回滚错了"就没有路了
      load();
    },
    [noteId, load],
  );

  /** 两段确认：第一击只把这一行变成"确认恢复"，再击才真换 */
  const handleRevert = useCallback(
    (seq: number) => {
      if (armedSeq !== seq) {
        setArmedSeq(seq);
        if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setArmedSeq(null), CONFIRM_RESET_MS);
        return;
      }
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      setArmedSeq(null);
      void applyRevert(seq).catch((err: unknown) => {
        setError(String(err));
        logger.caught("history", "回滚失败", err);
      });
    },
    [armedSeq, applyRevert],
  );

  return (
    <div
      role="dialog"
      aria-label="历史版本"
      className="fixed inset-0 z-40 flex flex-col gap-1.5 p-3"
      style={{ backgroundColor: "color-mix(in srgb, var(--nb-ink) 6%, transparent)" }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
        style={{
          backgroundColor: "var(--panel-card)",
          borderColor: "color-mix(in srgb, var(--nb-ink) 14%, transparent)",
        }}
      >
        <div
          className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2"
          style={{ borderColor: "color-mix(in srgb, var(--nb-ink) 10%, transparent)" }}
        >
          <History size={14} aria-hidden style={{ color: accent }} />
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-semibold"
            style={{ color: ink }}
          >
            历史版本
            {rows !== null && (
              <span className="ml-1.5 text-[11px]" style={{ color: ink }}>
                · {rows.length} 版
              </span>
            )}
          </span>
          <button
            type="button"
            aria-label="关掉历史版本"
            title="关掉"
            onClick={onClose}
            className="rounded p-1 transition-colors hover:bg-black/10"
            style={{ color: ink }}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {error !== null && (
            <p role="alert" className="mb-1.5 break-all text-[11px] text-red-700">
              {error}
            </p>
          )}
          {rows === null && error === null && (
            <p className="text-[11px]" style={{ color: ink }}>
              正在翻这一张的旧版本…
            </p>
          )}
          {rows !== null && rows.length === 0 && error === null && (
            <div className="text-[11px] leading-relaxed" style={{ color: ink }}>
              <p>还没有可回的版本。</p>
              <p className="mt-1.5 opacity-70">
                一版记的是这张<b>被换掉之前</b>的内容；打字时每分钟最多留一档， 每张留最新
                50 条、7 天。刚改完这一张还什么都没有——改第二次就有了。
              </p>
            </div>
          )}
          {rows !== null && rows.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {rows.map((row) => {
                const armed = armedSeq === row.seq;
                return (
                  <li
                    key={row.seq}
                    className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                    style={{
                      borderColor: "color-mix(in srgb, var(--nb-ink) 10%, transparent)",
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[12px] font-medium"
                        style={{ color: ink }}
                      >
                        {formatWhen(row.createdAt)}
                        <span className="ml-1.5 text-[10px] opacity-60">
                          {noteTypeLabel(row.contentType)}
                        </span>
                      </div>
                      <div
                        className="truncate text-[11px] opacity-70"
                        style={{ color: ink }}
                      >
                        {row.title.trim() === "" ? "未命名便签" : row.title}
                        {row.preview !== "" && ` · ${row.preview}`}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={
                        armed
                          ? `确认回到 ${formatWhen(row.createdAt)} 那一版（现在这份会先存成一版）`
                          : `回到 ${formatWhen(row.createdAt)} 那一版`
                      }
                      onClick={() => handleRevert(row.seq)}
                      className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors hover:bg-black/5"
                      style={{ color: armed ? "#B91C1C" : accent }}
                    >
                      {armed ? (
                        <X size={11} aria-hidden />
                      ) : (
                        <RotateCcw size={11} aria-hidden />
                      )}
                      {armed ? "确认恢复" : "回到这一版"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p
          className="shrink-0 border-t px-3 py-1.5 text-[10px]"
          style={{
            color: ink,
            borderColor: "color-mix(in srgb, var(--nb-ink) 10%, transparent)",
          }}
        >
          回滚只换内容：摆位、置顶、贴边、归组都跟着现在走。现在这一份会先被存成一版，回错了还能回来。
        </p>
      </div>
    </div>
  );
}
