// IconPicker — 页脚那个"给这张便签挑个签上记号"的小弹层。
//
// 为什么值得单独一个文件：NoteContent 已经把四类正文、标签、私密开关、字数条都排在一行
// 里了，再塞一个 16 格的选板进去就没人能读懂那段 JSX。
//
// 按钮上画的就是**当前会用到的那个图标**（没设过就是类型默认的那个，遮罩态是锁）——
// 按下去之前先看得到现状，选板里再点一下就换。选板没有"这一个"的高亮就别高亮：
// 高亮的是结果，不是操作。
//
// 收场照组菜单那套：点外面或 Esc。窗内浮层拿不到系统级焦点，只能自己听。

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { noteTypeLabel } from "@/data/note-types";
import { chipIconOf, NOTE_ICON_CHOICES } from "@/features/sticky/note-icons";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { updateNote } from "@/store/notes-store";
import type { StickyNote } from "@/platform/contracts";

export interface IconPickerProps {
  id: string;
  note: StickyNote;
  /** 私密且没解锁：那时签上画锁，选板也不该展示真身（与标题遮罩同一条边界） */
  masked: boolean;
}

export function IconPicker({ id, note, masked }: IconPickerProps) {
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
        title="签上画哪个记号（侧边色块签就是这一个）"
        onClick={() => setOpen((prev) => !prev)}
        className="rounded p-1 transition-colors hover:bg-black/10"
        style={{ color: theme.accent }}
      >
        {/* 图标组件是注册表在渲染时给的，用 createElement 直接落：<X /> 那种写法要把组件
            值存进变量，React Compiler 不让（它要静态可辨的标签） */}
        {createElement(chipIconOf(note, masked), { size: 14, "aria-hidden": true })}
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
