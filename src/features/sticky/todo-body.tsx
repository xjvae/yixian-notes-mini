// 清单正文 — 条目增删改勾。条目 id 稳定：删中间行不打断其它行的焦点与勾选态。
// Enter 在当前行下方插入新行并聚焦；空行失焦即自行消失（不给列表留垃圾）。

import { useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import type { StickyItem } from "@/platform/contracts";
import { genItemId } from "@/data/entities";
import { ITEM_MAX } from "@/data/limit";

interface Props {
  items: StickyItem[];
  ink: string;
  accent: string;
  onChange: (items: StickyItem[]) => void;
}

export function TodoBody({ items, ink, accent, onChange }: Props) {
  const lastAdded = useRef<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    if (lastAdded.current === null) return;
    inputs.current.get(lastAdded.current)?.focus();
    lastAdded.current = null;
  });

  const replace = (id: string, patch: Partial<StickyItem>): void => {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const addAfter = (afterId: string | null): void => {
    const item: StickyItem = { id: genItemId(), text: "", done: false };
    lastAdded.current = item.id;
    if (afterId === null) {
      onChange([...items, item]);
      return;
    }
    const index = items.findIndex((entry) => entry.id === afterId);
    const next = [...items];
    next.splice(index + 1, 0, item);
    onChange(next);
  };

  const remove = (id: string): void => {
    onChange(items.filter((item) => item.id !== id));
  };

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto">
      {items.map((item) => (
        <div key={item.id} className="group flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            role="checkbox"
            aria-checked={item.done}
            aria-label={item.done ? `取消完成「${item.text}」` : `完成「${item.text}」`}
            onClick={() => replace(item.id, { done: !item.done })}
            className="h-4 w-4 shrink-0 rounded border transition-colors"
            style={{
              borderColor: accent,
              backgroundColor: item.done ? accent : "transparent",
            }}
          >
            {item.done && (
              <svg viewBox="0 0 16 16" className="h-3 w-3 text-white" aria-hidden>
                <path
                  d="M3 8.5 6.5 12 13 4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
          <input
            ref={(node) => {
              if (node === null) inputs.current.delete(item.id);
              else inputs.current.set(item.id, node);
            }}
            value={item.text}
            maxLength={ITEM_MAX}
            placeholder="条目"
            aria-label="清单条目"
            onChange={(event) => replace(item.id, { text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addAfter(item.id);
              }
            }}
            onBlur={() => {
              // 空行离开焦点即自删（除非它还是最后一行刚加的）
              if (item.text.trim() === "" && lastAdded.current !== item.id) {
                remove(item.id);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px]"
            style={{
              color: ink,
              textDecoration: item.done ? "line-through" : "none",
              opacity: item.done ? 0.55 : 1,
            }}
          />
          <button
            type="button"
            aria-label={`删除条目「${item.text}」`}
            onClick={() => remove(item.id)}
            className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
            style={{ color: ink }}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => addAfter(null)}
        className="flex shrink-0 items-center gap-1 self-start rounded px-1 py-0.5 text-xs opacity-60 transition-opacity hover:opacity-100"
        style={{ color: accent }}
      >
        <Plus size={12} aria-hidden />
        添加条目
      </button>
    </div>
  );
}
