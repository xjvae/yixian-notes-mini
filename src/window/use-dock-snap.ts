// 贴边吸附的接线层 — 判定全在 dock-model.ts（纯函数），这里只做四件事：
// 听拖动 → 问纯函数该不该贴 → 动画把窗口写过去 → 管理贴边态的滑出/收回/解除。
//
// 时序纪律（每条都对应"悬停时窗口来回闪"这类事故的防法）：
//  1. **程序性写入会引发原生 moved 事件**：凡自己 setWindowFrame 过，之后 ECHO_MS
//     内的 moved 一律当回声忽略；
//  2. **贴边后几何持久化必须关**：20px 细丝不是用户的展开尺寸，记下它就是毁掉恢复
//     尺寸（suppression 由调用方接进 useWindowGeometry）；
//  3. **贴边后的任何真实拖动 = 解除**（不做迟滞）：解除时把展开尺寸原位还回去，
//     位置取拖动落点；
//  4. 交互口径：**点细丝滑出、点「收纳」收回、拖动即解除**——悬停滑出对手抖的人
//     是灾难，第一版选确定性优先。
//
// 开机恢复：行里 docked=1 的便签，挂载量到工作区后直接摆到细丝位（无动画），
// 槽位从 Rust 注册表现领——同侧多张按 26px 错开。

import { useCallback, useEffect, useRef, useState } from "react";
import type { DockEdge, StickyNote } from "@/platform/contracts";
import {
  floatDockRegister,
  floatDockUnregister,
  monitorWorkArea,
} from "@/platform/commands";
import { currentWindow, setWindowFrame } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { updateNote } from "@/store/notes-store";
import { nearestEdge, revealedRect, sliverRect, type Rect } from "@/window/dock-model";
import { STICKY_DEFAULT_SIZE, STICKY_MIN_SIZE } from "@/features/sticky/window-statics";

const SCOPE = "dock";
/** 贴边动画时长 */
const DOCK_ANIM_MS = 170;
/** 程序性写入后的回声抑制窗口 */
const ECHO_MS = 350;

interface Props {
  id: string;
  /** 挂载后短暂为 null（实体未到）——此时按自由窗处理，所有写路径自行空转 */
  note: StickyNote | null;
  minimized: boolean;
}

export interface DockSnap {
  docked: boolean;
  revealed: boolean;
  /** 接进 useWindowGeometry 的抑制开关：贴边/动画/收起期间几何不许落库 */
  suppressGeometry: boolean;
  /** 点细丝滑出 / 点收纳收回（仅 docked 时有意义） */
  toggleReveal: () => void;
}

export function useDockSnap({ id, note, minimized }: Props): DockSnap {
  const [revealed, setRevealed] = useState(false);
  const [animating, setAnimating] = useState(false);

  const workAreaRef = useRef<Rect | null>(null);
  const factorRef = useRef(1);
  const noteRef = useRef(note);
  const minimizedRef = useRef(minimized);
  const animatingRef = useRef(false);
  const revealedRef = useRef(false);
  const slotRef = useRef(0);
  const ignoreUntilRef = useRef(0);

  useEffect(() => {
    noteRef.current = note;
  }, [note]);
  useEffect(() => {
    minimizedRef.current = minimized;
  }, [minimized]);

  const expandedSize = useCallback((): { width: number; height: number } => {
    const noteNow = noteRef.current;
    return {
      width: Math.max(STICKY_MIN_SIZE.width, noteNow?.width ?? STICKY_DEFAULT_SIZE.width),
      height: Math.max(
        STICKY_MIN_SIZE.height,
        noteNow?.height ?? STICKY_DEFAULT_SIZE.height,
      ),
    };
  }, []);

  // —— 量工作区 + 开机恢复贴边态（挂载一次） ——
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const win = currentWindow();
        factorRef.current = await win.scaleFactor();
        const area = await monitorWorkArea();
        const factor = factorRef.current;
        workAreaRef.current = {
          x: area.x / factor,
          y: area.y / factor,
          width: area.width / factor,
          height: area.height / factor,
        };
        const noteNow = noteRef.current;
        if (cancelled || noteNow === null || !noteNow.docked) return;
        const edge = noteNow.dockEdge ?? "left";
        const slot = await floatDockRegister(id, edge);
        slotRef.current = slot;
        const rect = sliverRect(edge, workAreaRef.current, expandedSize(), slot);
        ignoreUntilRef.current = Date.now() + ECHO_MS;
        await setWindowFrame(rect.x, rect.y, rect.width, rect.height);
      } catch (error) {
        logger.caught(SCOPE, "工作区不可用，本窗停用贴边", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, expandedSize]);

  // —— 解除贴边：就地恢复展开尺寸 ——
  const detach = useCallback(
    async (logical: { x: number; y: number }) => {
      const noteNow = noteRef.current;
      if (noteNow === null || !noteNow.docked) return;
      void floatDockUnregister(id).catch(() => {});
      updateDocked(id, false, null);
      const size = expandedSize();
      ignoreUntilRef.current = Date.now() + ECHO_MS;
      try {
        await setWindowFrame(
          Math.round(logical.x),
          Math.round(logical.y),
          size.width,
          size.height,
        );
      } catch (error) {
        logger.caught(SCOPE, "解除贴边恢复尺寸失败", error);
      }
      revealedRef.current = false;
      setRevealed(false);
    },
    [id, expandedSize],
  );

  // —— 开始贴边：注册槽位 → 落状态 → 动画滑进细丝位 ——
  const beginDock = useCallback(
    async (edge: DockEdge, from: { x: number; y: number }) => {
      const area = workAreaRef.current;
      if (
        area === null ||
        animatingRef.current ||
        minimizedRef.current ||
        noteRef.current === null
      ) {
        return;
      }
      animatingRef.current = true;
      setAnimating(true);
      try {
        const slot = await floatDockRegister(id, edge);
        slotRef.current = slot;
        updateDocked(id, true, edge);
        const size = expandedSize();
        const target = sliverRect(edge, area, size, slot);
        const factor = factorRef.current;
        const start: Rect = {
          x: from.x,
          y: from.y,
          width: size.width,
          height: size.height,
        };
        ignoreUntilRef.current = Date.now() + DOCK_ANIM_MS + ECHO_MS;
        await tweenRect(start, target, DOCK_ANIM_MS, factor);
        revealedRef.current = false;
        setRevealed(false);
      } catch (error) {
        logger.caught(SCOPE, "贴边失败", error);
        // 贴失败了就当没贴过：状态回滚，免得出现"状态贴了、窗没贴"的怪相
        updateDocked(id, false, null);
        void floatDockUnregister(id).catch(() => {});
      } finally {
        animatingRef.current = false;
        setAnimating(false);
      }
    },
    [id, expandedSize],
  );

  const toggleReveal = useCallback((): void => {
    const area = workAreaRef.current;
    if (
      area === null ||
      animatingRef.current ||
      noteRef.current === null ||
      !noteRef.current.docked
    ) {
      return;
    }
    void (async () => {
      animatingRef.current = true;
      setAnimating(true);
      try {
        const noteNow = noteRef.current;
        if (noteNow === null) return;
        const edge = noteNow.dockEdge ?? "left";
        const size = expandedSize();
        const target = revealedRef.current
          ? sliverRect(edge, area, size, slotRef.current)
          : revealedRect(edge, area, size, slotRef.current);
        ignoreUntilRef.current = Date.now() + ECHO_MS;
        await setWindowFrame(target.x, target.y, target.width, target.height);
        revealedRef.current = !revealedRef.current;
        setRevealed(revealedRef.current);
      } catch (error) {
        logger.caught(SCOPE, "滑出/收回失败", error);
      } finally {
        animatingRef.current = false;
        setAnimating(false);
      }
    })();
  }, [expandedSize]);

  // —— moved 监听：贴边判定与解除的唯一入口 ——
  // 处理器经 ref 间接（监听只绑一次），但 ref 的写入必须发生在 effect 里，
  // 渲染期写 ref 是新 react-hooks 规则明确禁止的。
  const handleMovedRef = useRef<((pos: { x: number; y: number }) => void) | null>(null);
  useEffect(() => {
    handleMovedRef.current = (pos) => {
      if (Date.now() < ignoreUntilRef.current) return; // 自己写入的回声
      if (minimizedRef.current || animatingRef.current) return;
      const area = workAreaRef.current;
      if (area === null) return;
      const factor = factorRef.current;
      const logical = { x: pos.x / factor, y: pos.y / factor };
      const noteNow = noteRef.current;
      if (noteNow !== null && noteNow.docked) {
        // 已贴边：真实拖动 = 解除（细丝被拖、滑出态被拖都走这条）
        void detach(logical);
        return;
      }
      const hit = nearestEdge({ ...logical, ...expandedSize() }, area);
      if (hit !== null) void beginDock(hit.edge, logical);
    };
  });

  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const offMoved = await currentWindow().onMoved(({ payload }) => {
          handleMovedRef.current?.({ x: payload.x, y: payload.y });
        });
        if (cancelled) offMoved();
        else off = offMoved;
      } catch {
        /* 非 Tauri 环境（单测），贴边本就不存在 */
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return {
    docked: note?.docked ?? false,
    revealed,
    suppressGeometry: minimized || (note?.docked ?? false) || animating,
    toggleReveal,
  };
}

/** 贴边状态落库（x/y 不动：贴边不改变用户记下的展开位置） */
function updateDocked(id: string, docked: boolean, edge: DockEdge | null): void {
  updateNote(id, { docked, dockEdge: edge });
}

/** rAF 逐帧补间：位置与尺寸一起插值（ease-out cubic），每帧一次 setWindowFrame */
async function tweenRect(
  from: Rect,
  to: Rect,
  ms: number,
  _factor: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const started = performance.now();
    const step = (): void => {
      const t = Math.min(1, (performance.now() - started) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const x = from.x + (to.x - from.x) * eased;
      const y = from.y + (to.y - from.y) * eased;
      const width = from.width + (to.width - from.width) * eased;
      const height = from.height + (to.height - from.height) * eased;
      void setWindowFrame(
        Math.round(x),
        Math.round(y),
        Math.round(width),
        Math.round(height),
      );
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}
