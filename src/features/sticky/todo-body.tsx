// 清单正文 — 条目增删改勾 + 每条自己的识别。条目 id 稳定：删中间行不打断其它行的焦点。
//
// 每条也是**两态**（与正文同一套做法）：默认读态用 RichText 画（链接可点、`code` 等宽、
// media:// 出缩略图），点它或按 Enter 进编辑态（那个 input）。清单条目以前是纯 input，
// 于是粘进去的图与打的链接只能当字看——识别口径明明只有一处，缺的只是这一层的画法。
//
// 空行失焦即自行消失（不给列表留垃圾）；新加的那行直接进编辑态并聚焦。
// 粘图/拖图走 note-content 那个共用的口（use-note-image）：往哪儿插、还剩几个字，
// 是这一层自己的事，所以 room 传的是 `ITEM_MAX - 当前条目长 - 1`（那个 1 是换行）。

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { StickyItem } from "@/platform/contracts";
import { genItemId } from "@/data/entities";
import { ITEM_MAX } from "@/data/limit";
import { plainPreview } from "@/data/body-parse";
import { isAcceptedMime } from "@/data/image-input";
import { RichText } from "@/features/sticky/rich-text";
import type { AttachResult } from "@/features/sticky/use-note-image";

interface Props {
  items: StickyItem[];
  ink: string;
  accent: string;
  /** 压好并存进库，返回引用（不碰文本，插入是这里的事） */
  attach: (
    files: File[],
    options: { room: number; isPrivate: boolean },
  ) => Promise<AttachResult>;
  isPrivate: boolean;
  onChange: (items: StickyItem[]) => void;
}

export function TodoBody({ items, ink, accent, attach, isPrivate, onChange }: Props) {
  const lastAdded = useRef<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  /** 同一时刻只有一条在被改：键盘流就是走一条改一条 */
  const [editingId, setEditingId] = useState<string | null>(null);
  // 粘图是 async 的，回来时 `items` 可能已经不是按 Ctrl+V 那一下的了——读最新那一份
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

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
    setEditingId(item.id);
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

  /** 把图存好并追加到这一条末尾（引用占的字也算进 ITEM_MAX） */
  const attachTo = async (id: string, files: File[]): Promise<void> => {
    const current = itemsRef.current.find((item) => item.id === id);
    if (current === undefined) return;
    const { refs } = await attach(files, {
      room: ITEM_MAX - current.text.length - 1,
      isPrivate,
    });
    if (refs.length === 0) return;
    const block = refs.join("\n");
    onChange(
      itemsRef.current.map((item) =>
        // 空条目别垫前导换行：那会让这一条第一行是空的，读起来像多了个空条
        item.id === id
          ? { ...item, text: item.text === "" ? block : `${item.text}\n${block}` }
          : item,
      ),
    );
  };

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto">
      {items.map((item) => (
        <div
          key={item.id}
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
            void attachTo(item.id, files);
          }}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={item.done}
            aria-label={
              item.done
                ? `取消完成「${plainPreview(item.text) || "空"}」`
                : `完成「${plainPreview(item.text) || "空"}」`
            }
            onClick={() => replace(item.id, { done: !item.done })}
            className="mt-[3px] h-4 w-4 shrink-0 rounded border transition-colors"
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
          {editingId === item.id ? (
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
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              onBlur={() => {
                setEditingId(null);
                // 空行离开焦点即自删（除非它还是最后一行刚加的）
                if (item.text.trim() === "" && lastAdded.current !== item.id) {
                  remove(item.id);
                }
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (!files.some((file) => isAcceptedMime(file.type))) return;
                // 剪贴板里有图就按图办：不拦的话粘进来的是文件名或一串本机路径
                event.preventDefault();
                void attachTo(item.id, files);
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px]"
              style={{
                color: ink,
                textDecoration: item.done ? "line-through" : "none",
                opacity: item.done ? 0.55 : 1,
              }}
            />
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label={`编辑条目「${plainPreview(item.text) || "空"}」`}
              // 给右键菜单认目标用（见 row-target.ts）： kind + id，id 稳、下标不稳
              data-row-kind="todo"
              data-row-id={item.id}
              onClick={() => {
                // 拖出来的选区不能被这一下抹掉（与正文同一道闸门，理由见 body-view.tsx）
                const selection = window.getSelection();
                if (
                  selection !== null &&
                  selection.rangeCount > 0 &&
                  !selection.isCollapsed
                ) {
                  return;
                }
                setEditingId(item.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setEditingId(item.id);
                }
              }}
              className="min-w-0 flex-1 cursor-text break-words text-[13px] leading-relaxed select-text"
              style={{
                color: ink,
                textDecoration: item.done ? "line-through" : "none",
                opacity: item.done ? 0.55 : 1,
              }}
            >
              {item.text === "" ? (
                <span className="italic opacity-45">条目</span>
              ) : (
                <RichText body={item.text} ink={ink} accent={accent} />
              )}
            </div>
          )}
          <button
            type="button"
            aria-label={`删除条目「${plainPreview(item.text) || "空"}」`}
            onClick={() => remove(item.id)}
            className="mt-[1px] shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
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
