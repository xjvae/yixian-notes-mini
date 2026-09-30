// 时间轴正文 — 一串带时刻的条目。「记录此刻」追加当前时刻的空条目；
// 时刻可改（补记早前发生的事），显示按数组顺序（记录顺序）而非时刻排序——
// 时间轴的价值在"我记录的脉络"，补记时用户自己决定插在哪条附近改哪条的时刻。

import { useRef } from "react";
import { Plus, X } from "lucide-react";
import type { TimelineEntry } from "@/platform/contracts";
import { genItemId } from "@/data/entities";
import { fromLocalInputValue, toLocalInputValue } from "@/data/due";

interface Props {
  entries: TimelineEntry[];
  ink: string;
  accent: string;
  onChange: (entries: TimelineEntry[]) => void;
}

export function TimelineBody({ entries, ink, accent, onChange }: Props) {
  const textInputs = useRef(new Map<string, HTMLInputElement>());

  const replace = (id: string, patch: Partial<TimelineEntry>): void => {
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  };

  const add = (): void => {
    onChange([...entries, { id: genItemId(), at: Date.now(), text: "" }]);
    // 追加后聚焦最后一行的文本框
    requestAnimationFrame(() => {
      const last = entries.length;
      const node = [...textInputs.current.values()][last];
      node?.focus();
    });
  };

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto pr-0.5">
      {entries.map((entry) => (
        <div key={entry.id} className="group flex shrink-0 items-start gap-1.5">
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
            className="w-[142px] shrink-0 rounded bg-black/5 px-1 py-0.5 text-[11px]"
            style={{ color: ink }}
          />
          <input
            ref={(node) => {
              if (node === null) textInputs.current.delete(entry.id);
              else textInputs.current.set(entry.id, node);
            }}
            value={entry.text}
            placeholder="发生了什么"
            aria-label="时间轴条目"
            onChange={(event) => replace(entry.id, { text: event.target.value })}
            className="min-w-0 flex-1 bg-transparent text-[13px]"
            style={{ color: ink }}
          />
          <button
            type="button"
            aria-label="删除这条记录"
            onClick={() => onChange(entries.filter((item) => item.id !== entry.id))}
            className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
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
