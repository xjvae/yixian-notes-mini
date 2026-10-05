// GroupMenu — 页脚左侧的组动作槽。
//
// 降级口径（ROADMAP 架构基线）：没有"新建组合"入口，组合只来自旧版导入，
// 所以这里能做的只有"移进某个已有组"和"移出当前的组"。一个组都没有时给明态，
// 不放一个点了没结果的按钮。
//
// 落库走 sticky_set_group（单窗的销毁与叠窗的拉起都在那一侧），但内存必须跟着回填：
// store 的 flush 是整行 upsert，groupId 不回填就会被下一次落库覆回原组（用例钉住）。
// 移进还要先 flushNow——发起窗自己可能就是被销毁的那一扇。

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, SquareStack } from "lucide-react";
import { themeColors } from "@/data/theme";
import { useScheme } from "@/data/scheme";
import { useNote } from "@/store/hooks";
import { flushNow, updateNote } from "@/store/notes-store";
import { groupList, stickySetGroup } from "@/platform/commands";
import { logger } from "@/platform/logger";
import type { StickyGroup } from "@/platform/contracts";

const SCOPE = "group";

export interface GroupMenuProps {
  id: string;
  /** 这张便签当前所在的组；null = 没组 */
  groupId: string | null;
}

export function GroupMenu({ id, groupId }: GroupMenuProps) {
  const note = useNote(id);
  const { resolved } = useScheme();
  const [open, setOpen] = useState(false);
  /** null = 这一轮还没取到清单：点开才去取，不给每张便签窗加一次开机 IPC */
  const [options, setOptions] = useState<StickyGroup[] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const moveTo = useCallback(
    (target: string | null): void => {
      setOpen(false);
      void (async () => {
        try {
          await flushNow();
          if (await stickySetGroup(id, target)) updateNote(id, { groupId: target });
        } catch (error) {
          logger.caught(SCOPE, target === null ? "移出组合失败" : "移进组合失败", error);
        }
      })();
    },
    [id],
  );

  const toggle = useCallback((): void => {
    const next = !open;
    setOpen(next);
    if (next) {
      void groupList()
        .then(setOptions)
        .catch((error: unknown) => logger.caught(SCOPE, "取组合清单失败", error));
    }
  }, [open]);

  // 弹层的收场：点外面或 Esc。窗内浮层拿不到系统级焦点，只能自己听
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

  if (note === null) return null;
  const theme = themeColors(note.theme, resolved);
  const currentName =
    groupId === null ? null : (options?.find((row) => row.id === groupId)?.name ?? null);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        aria-label={
          groupId === null ? "移进组合" : `所在组合：${currentName ?? "未命名"}`
        }
        aria-expanded={open}
        title={groupId === null ? "移进组合" : "所在组合，点开可移出"}
        onClick={toggle}
        className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] transition-colors hover:bg-black/10"
        style={{
          color: theme.accent,
          backgroundColor: groupId === null ? "transparent" : `${theme.accent}1a`,
        }}
      >
        <SquareStack size={12} aria-hidden />
        {groupId === null ? "组" : (currentName ?? "组")}
        <ChevronDown size={10} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="组合"
          className="absolute bottom-full left-0 z-20 mb-1 max-h-40 min-w-40 overflow-y-auto rounded-md border border-black/10 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
          style={{ backgroundColor: theme.paper }}
        >
          {options === null ? (
            <p className="px-2 py-1 text-[11px] opacity-50" style={{ color: theme.ink }}>
              正在取组合清单…
            </p>
          ) : options.length === 0 && groupId === null ? (
            <p className="px-2 py-1 text-[11px]" style={{ color: theme.ink }}>
              还没有组合。旧版导入才会带进组合，这里不能新建。
            </p>
          ) : (
            <>
              {options
                .filter((row) => row.id !== groupId)
                .map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    role="menuitem"
                    onClick={() => moveTo(row.id)}
                    className="block w-full truncate rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-black/10"
                    style={{ color: theme.ink }}
                  >
                    {row.name.trim() === "" ? "未命名组合" : row.name}
                  </button>
                ))}
              {groupId !== null && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => moveTo(null)}
                  className="mt-1 block w-full rounded border-t border-black/10 px-2 py-1 text-left text-[11px] transition-colors hover:bg-black/10"
                  style={{ color: theme.accent }}
                >
                  移出组合（弹回桌面单独一扇）
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
