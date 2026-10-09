// 时间轴正文 — 一串带时刻的条目。「记录此刻」追加当前时刻的空条目；
// 时刻可改（补记早前发生的事），显示按数组顺序（记录顺序）而非时刻排序——
// 时间轴的价值在"我记录的脉络"，补记时用户自己决定插在哪条附近改哪条的时刻。
//
// 文字部分与清单一样是**两态**：读态走 RichText（链接可点、media:// 出缩略图），
// 点进去才是 input。以前每条是一个纯 input，粘进来的图与打的链接只能当字看。

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { TimelineEntry } from "@/platform/contracts";
import { genItemId } from "@/data/entities";
import { ITEM_MAX } from "@/data/limit";
import { plainPreview } from "@/data/body-parse";
import { fromLocalInputValue, toLocalInputValue } from "@/data/due";
import { isAcceptedMime } from "@/data/image-input";
import { RichText } from "@/features/sticky/rich-text";
import type { AttachResult } from "@/features/sticky/use-note-image";

interface Props {
  entries: TimelineEntry[];
  ink: string;
  accent: string;
  attach: (
    files: File[],
    options: { room: number; isPrivate: boolean },
  ) => Promise<AttachResult>;
  isPrivate: boolean;
  onChange: (entries: TimelineEntry[]) => void;
}

export function TimelineBody({
  entries,
  ink,
  accent,
  attach,
  isPrivate,
  onChange,
}: Props) {
  const textInputs = useRef(new Map<string, HTMLInputElement>());
  const [editingId, setEditingId] = useState<string | null>(null);
  // 粘图回来时 entries 可能已经变了：读最新那一份再写
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const replace = (id: string, patch: Partial<TimelineEntry>): void => {
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  };

  const add = (): void => {
    const entry: TimelineEntry = { id: genItemId(), at: Date.now(), text: "" };
    onChange([...entries, entry]);
    setEditingId(entry.id);
    // 追加后聚焦这一行的文本框（框是编辑态才挂载的，等一帧）
    requestAnimationFrame(() => textInputs.current.get(entry.id)?.focus());
  };

  const attachTo = async (id: string, files: File[]): Promise<void> => {
    const current = entriesRef.current.find((entry) => entry.id === id);
    if (current === undefined) return;
    const { refs } = await attach(files, {
      room: ITEM_MAX - current.text.length - 1,
      isPrivate,
    });
    if (refs.length === 0) return;
    const block = refs.join("\n");
    onChange(
      entriesRef.current.map((entry) =>
        // 空条目别垫前导换行（与清单同一条理由）
        entry.id === id
          ? { ...entry, text: entry.text === "" ? block : `${entry.text}\n${block}` }
          : entry,
      ),
    );
  };

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto pr-0.5">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="group flex shrink-0 items-start gap-1.5"
          onDragOver={(event) => {
            if ([...event.dataTransfer.files].some((file) => isAcceptedMime(file.type))) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (!files.some((file) => isAcceptedMime(file.type))) return;
            event.preventDefault();
            void attachTo(entry.id, files);
          }}
        >
          <span
            aria-hidden
            className="mt-2.5 h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: accent }}
          />
          <input
            type="datetime-local"
            value={toLocalInputValue(entry.at)}
            aria-label="条目时刻"
            onChange={(event) => {
              const at = fromLocalInputValue(event.target.value);
              if (at !== null) replace(entry.id, { at });
            }}
            className="mt-0.5 w-[142px] shrink-0 rounded bg-black/5 px-1 py-0.5 text-[11px]"
            style={{ color: ink }}
          />
          {editingId === entry.id ? (
            <input
              ref={(node) => {
                if (node === null) textInputs.current.delete(entry.id);
                else textInputs.current.set(entry.id, node);
              }}
              value={entry.text}
              maxLength={ITEM_MAX}
              placeholder="发生了什么"
              aria-label="时间轴条目"
              onChange={(event) => replace(entry.id, { text: event.target.value })}
              onBlur={() => setEditingId(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (!files.some((file) => isAcceptedMime(file.type))) return;
                event.preventDefault();
                void attachTo(entry.id, files);
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px]"
              style={{ color: ink }}
            />
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label={`编辑这条记录「${plainPreview(entry.text) || "空"}」`}
              // 与清单条目同一套：右键菜单靠这两个属性认目标（见 row-target.ts）
              data-row-kind="timeline"
              data-row-id={entry.id}
              onClick={() => {
                // 拖出来的选区不能被这一下抹掉（与正文同一道闸门）
                const selection = window.getSelection();
                if (
                  selection !== null &&
                  selection.rangeCount > 0 &&
                  !selection.isCollapsed
                ) {
                  return;
                }
                setEditingId(entry.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setEditingId(entry.id);
                }
              }}
              className="min-w-0 flex-1 cursor-text break-words text-[13px] leading-relaxed select-text"
              style={{ color: ink }}
            >
              {entry.text === "" ? (
                <span className="italic opacity-45">发生了什么</span>
              ) : (
                <RichText body={entry.text} ink={ink} accent={accent} />
              )}
            </div>
          )}
          <button
            type="button"
            aria-label="删除这条记录"
            onClick={() => onChange(entries.filter((item) => item.id !== entry.id))}
            className="mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
            style={{ color: ink }}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex shrink-0 items-center gap-1 self-start rounded px-1 py-0.5 text-xs opacity-60 transition-opacity hover:opacity-100"
        style={{ color: accent }}
      >
        <Plus size={12} aria-hidden />
        记录此刻
      </button>
    </div>
  );
}
