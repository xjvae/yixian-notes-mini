// 便签浮窗 — 一张便签一扇 OS 窗口。骨架版能力：标题/正文编辑、六色切换、
// 置顶/关闭、关窗前冲刷在途写。清单/提醒/时间轴、贴边、收起栏随 ROADMAP 加入。

import { useCallback, useEffect } from "react";
import { StickyLeading, WindowChrome } from "@/ui/window-chrome";
import { themeOf, THEME_KEYS } from "@/data/theme";
import { useNote } from "@/store/hooks";
import { flushNow, updateNote } from "@/store/notes-store";
import { closeFloatingSticky } from "@/platform/commands";
import { currentWindow } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { getStickyId } from "@/window/identity";

const SCOPE = "sticky";

export function StickyWindow() {
  const id = getStickyId();
  const note = useNote(id);

  // 关窗/卸载前冲刷：store 的去抖窗口里可能还压着最后一笔编辑
  useEffect(() => {
    const flush = () => {
      void flushNow();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      void flushNow();
    };
  }, []);

  const handleTogglePin = useCallback(() => {
    if (!id || !note) return;
    const next = !note.pinned;
    updateNote(id, { pinned: next });
    void currentWindow()
      .setAlwaysOnTop(next)
      .catch((error: unknown) => logger.caught(SCOPE, "切换置顶失败", error));
  }, [id, note]);

  const handleClose = useCallback(() => {
    if (!id) return;
    void (async () => {
      await flushNow();
      await closeFloatingSticky(id);
    })();
  }, [id]);

  if (!id) {
    return (
      <div className="flex h-screen items-center justify-center bg-red-50 text-sm text-red-700">
        这扇窗口缺少便签 id（应由 Rust 注入）
      </div>
    );
  }
  if (!note) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-100 text-sm text-neutral-500">
        便签不存在，可能已被删除
      </div>
    );
  }

  const theme = themeOf(note.theme);

  return (
    <WindowChrome
      background={theme.paper}
      accent={theme.accent}
      pinned={note.pinned}
      onTogglePin={handleTogglePin}
      onClose={handleClose}
      leading={<StickyLeading accent={theme.accent} />}
    >
      <div className="flex h-full flex-col gap-1 p-3">
        <input
          aria-label="便签标题"
          value={note.title}
          placeholder="标题"
          onChange={(event) => updateNote(id, { title: event.target.value })}
          className="shrink-0 bg-transparent text-sm font-semibold"
          style={{ color: theme.ink }}
        />
        <textarea
          aria-label="便签正文"
          value={note.body}
          placeholder="写点什么…"
          onChange={(event) => updateNote(id, { body: event.target.value })}
          className="min-h-0 w-full flex-1 resize-none bg-transparent text-[13px] leading-relaxed"
          style={{ color: theme.ink }}
        />
        <div
          className="flex shrink-0 items-center gap-1.5"
          role="group"
          aria-label="便签颜色"
        >
          {THEME_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              aria-label={`换成${themeOf(key).name}`}
              aria-pressed={key === note.theme}
              onClick={() => updateNote(id, { theme: key })}
              className="h-4 w-4 rounded-full border transition-transform hover:scale-110"
              style={{
                backgroundColor: themeOf(key).paper,
                borderColor:
                  key === note.theme ? themeOf(key).accent : "rgba(0,0,0,0.15)",
                boxShadow:
                  key === note.theme ? `0 0 0 2px ${themeOf(key).accent}55` : "none",
              }}
            />
          ))}
        </div>
      </div>
    </WindowChrome>
  );
}
