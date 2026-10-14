// IconPicker — 页脚"挑签上记号"的小弹层（单拆文件：NoteContent 已排满，再塞 16 格选板没人读得懂）。
// 触发钮画的是图章不是当前记号：签上已画着现状，再抄一份会跟类型转换排撞成同一字形；
// 选板里"这一个"该高亮就高亮（那是结果不是操作）。收场照组菜单那套：点外面或 Esc。

import { useCallback, useEffect, useRef, useState } from "react";
import { Stamp } from "lucide-react";
import { noteTypeLabel } from "@/data/note-types";
import { NOTE_ICON_CHOICES } from "@/features/sticky/note-icons";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { updateNote } from "@/store/notes-store";
import type { StickyNote } from "@/platform/contracts";

export interface IconPickerProps {
  id: string;
  note: StickyNote;
}

export function IconPicker({ id, note }: IconPickerProps) {
  const { resolved } = useScheme();
  const theme = themeColors(note.theme, resolved);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const pick = useCallback(
    (key: string | null): void => {
      setOpen(false);
      updateNote(id, { icon: key });
    },
    [id],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        aria-label={
          note.icon === null
            ? `换图标（现在跟类型走：${noteTypeLabel(note.contentType)}）`
            : "换图标"
        }
        aria-expanded={open}
        title="换图标"
        onClick={() => setOpen((prev) => !prev)}
        className="rounded p-1 transition-colors hover:bg-black/10"
        style={{ color: theme.accent }}
      >
        <Stamp size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="选一个图标"
          className="absolute bottom-full right-0 z-20 mb-1 w-[136px] rounded-md border border-black/10 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
          style={{ backgroundColor: theme.paper }}
        >
          <div className="grid grid-cols-4 gap-0.5">
            {NOTE_ICON_CHOICES.map((choice) => {
              const active = choice.key === note.icon;
              return (
                <button
                  key={choice.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  title={choice.label}
                  aria-label={choice.label}
                  onClick={() => pick(choice.key)}
                  className="flex h-7 w-full items-center justify-center rounded transition-colors hover:bg-black/10"
                  style={{
                    color: active ? theme.paper : theme.accent,
                    backgroundColor: active ? theme.accent : "transparent",
                  }}
                >
                  <choice.Icon size={13} aria-hidden />
                </button>
              );
            })}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(null)}
            className="mt-1 block w-full rounded border-t border-black/10 px-2 py-1 text-left text-[10px] transition-colors hover:bg-black/10"
            style={{ color: theme.ink }}
          >
            跟类型走（{noteTypeLabel(note.contentType)}）
          </button>
        </div>
      )}
    </div>
  );
}
