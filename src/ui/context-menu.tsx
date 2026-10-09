// ContextMenu — 窗内自己画的右键菜单（便签用；星环是盘、不是菜单，两回事）。
//
// 为什么不用系统菜单：无框透明窗里 `window.requestMenu` 那套在 Windows 上给的是
// 原生菜单的样子，跟这张纸的配色对不上，也带不动"删掉这张图"这种应用内动作。
//
// 三条实现上的口径：
//  · **夹在窗内**：菜单宽/高是定死的估算值（项数 × 行高），右键点在最右下角也不会
//    把菜单甩出窗外——甩出去就是看不见的菜单，比没有菜单更糟；
//  · 关掉的途径一条不少：点了别处、Esc、窗失焦（`window.blur`）。少一条就是留着一块
//    盖住正文的板子；
//  · 键盘可达：打开即聚焦第一项，上下键走，Enter 选，Esc 关。只给鼠标用的菜单
//    在无障碍上等于没有。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuAction, MenuActionId } from "@/features/sticky/note-menu";

const MENU_WIDTH = 172;
const EDGE = 6;

export interface ContextMenuProps {
  /** 右键点中的视口坐标（CSS 像素） */
  x: number;
  y: number;
  actions: MenuAction[];
  ink: string;
  accent: string;
  paper: string;
  onPick: (id: MenuActionId) => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  actions,
  ink,
  accent,
  paper,
  onPick,
  onClose,
}: ContextMenuProps) {
  const box = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState({ left: x, top: y });
  const items = useRef<(HTMLButtonElement | undefined)[]>([]);

  // 位置在画出来之后按真实尺寸夹一次：估算高度只对"甩出窗外"这一件事负责，
  // 真尺寸算错就会留一截看不见的菜单
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    setPlaced({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE)),
    });
  }, [x, y, actions]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const alive = items.current.filter(Boolean);
      if (alive.length === 0) return;
      const at = alive.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "ArrowDown"
          ? (at + 1) % alive.length
          : (at - 1 + alive.length) % alive.length;
      alive[next]?.focus();
    };
    const onPointerDown = (): void => onClose();
    // 捕获阶段听：菜单自己那一下也会被点到，靠 stopPropagation 挡掉
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    items.current = [];
    items.current[0]?.focus();
  }, [actions]);

  return (
    <div
      ref={box}
      role="menu"
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      className="fixed z-50 flex flex-col gap-0.5 rounded-md border border-black/10 p-1 shadow-[0_6px_20px_rgba(0,0,0,0.22)]"
      style={{
        left: placed.left,
        top: placed.top,
        width: MENU_WIDTH,
        backgroundColor: paper,
        borderColor: `${accent}33`,
      }}
    >
      {actions.map((action, position) => {
        if (action.id === "separator") {
          return (
            <span
              key="sep"
              aria-hidden
              className="my-0.5 block border-t"
              style={{ borderColor: `${ink}22` }}
            />
          );
        }
        // 这是第几个可选项 = 前面有几条非分隔线。不维护计数器（渲染期改外部变量是
        // React 明确禁的），一共七来条，重数一遍比留一份状态便宜也不容易错
        const mine = actions
          .slice(0, position)
          .filter((earlier) => earlier.id !== "separator").length;
        return (
          <button
            key={action.id}
            ref={(node) => {
              items.current[mine] = node ?? undefined;
            }}
            type="button"
            role="menuitem"
            onClick={() => onPick(action.id)}
            className="rounded px-2 py-1 text-left text-xs transition-colors hover:bg-black/10"
            style={{ color: action.danger ? "#B91C1C" : ink }}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
