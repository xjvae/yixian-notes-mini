// LinkPrompt — 右键"把选中变成链接"之后那个就地的小输入框。
//
// 为什么不是 `prompt()`：webview 里没有原生 prompt（Tauri 的 dialog 插件没装，也不该为
// 一个地址引一整份插件）。为什么不是系统菜单里那一层：地址是用户的话，得有光标能改。
//
// 三条口径：
//  · **预填 `https://`**：绝大多数人是想贴一个域名进来，补上协议省一次 typo；
//  · Enter 就是确定、Esc 就是不算，与右键菜单同一套手指；
//  · 位置与菜单同一件事做法：真尺寸算完再夹回窗内（甩出窗外 = 这个功能不存在）。

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const WIDTH = 236;
const EDGE = 6;

export interface LinkPromptProps {
  x: number;
  y: number;
  ink: string;
  accent: string;
  paper: string;
  /** 选中的那几个字，只为让人确认"就是这段" */
  selected: string;
  /** 地址被拒的那句话（不传就是还没试）。给了不关窗：他还没打完，关掉等于清掉他打的字 */
  notice?: string;
  onConfirm: (url: string) => void;
  onCancel: () => void;
}

export function LinkPrompt({
  x,
  y,
  ink,
  accent,
  paper,
  selected,
  notice,
  onConfirm,
  onCancel,
}: LinkPromptProps) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("https://");
  const [placed, setPlaced] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    setPlaced({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE)),
    });
  }, [x, y]);

  useEffect(() => {
    // 打开就落在输入框里：这条路是"选中→右键→粘地址"，中间不该还要先点一下
    input.current?.focus();
    input.current?.select();
  }, []);

  const confirm = (): void => {
    const url = value.trim();
    if (url === "" || url === "https://") return; // 光杆协议不算填了
    onConfirm(url);
  };

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="给选中的字配一个链接"
      className="fixed z-50 flex flex-col gap-1.5 rounded-md border p-2 text-[11px] shadow-lg"
      style={{
        left: placed.left,
        top: placed.top,
        width: WIDTH,
        color: ink,
        borderColor: `${accent}55`,
        backgroundColor: paper,
      }}
    >
      <span className="truncate opacity-60" title={selected}>
        给「{selected.trim() === "" ? "这段" : selected.trim()}」加链接
      </span>
      <input
        ref={input}
        aria-label="链接地址"
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            confirm();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="w-full rounded border bg-white/70 px-1.5 py-1 text-[11px] outline-none"
        style={{ color: ink, borderColor: `${accent}44` }}
      />
      {notice !== undefined && (
        <p role="alert" className="text-[10px] leading-snug" style={{ color: "#B91C1C" }}>
          {notice}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-0.5 transition-colors hover:bg-black/10"
          style={{ color: ink }}
        >
          不算
        </button>
        <button
          type="button"
          onClick={confirm}
          className="rounded px-2 py-0.5 font-semibold transition-opacity hover:opacity-80"
          style={{ backgroundColor: accent, color: paper }}
        >
          加上
        </button>
      </div>
    </div>
  );
}
