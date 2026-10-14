// 贴边吸附的接线层 — 判定全在 dock-model.ts（纯函数），这里只做：听拖动 → 判该不该贴 → 补间写过去 → 管滑出/收回/解除。
// 时序纪律：
//  1. 程序性写入会引发原生 moved：与"刚写进去的位置"差 ≤2px 一律当回声，**不用时间窗**（会吃掉真拖动，见 samePlace）；
//  2. 贴边后几何持久化必须关——20px 细丝不是展开尺寸，记下就毁掉恢复尺寸（suppressGeometry 接进 useWindowGeometry）；
//  3. 贴边态撤原生最小尺寸（否则细丝被夹回 220×200），还的时候跟着"这一档"走——收起态的栏 62 高，还是不限；
//  4. 贴边后任何真实拖动 = 解除（不做迟滞）；状态翻在补间之前；moved 连续流，静置 180ms 才判一次（见 SETTLE_MS）。

import { useCallback, useEffect, useRef, useState } from "react";
import type { DockEdge } from "@/platform/contracts";
import {
  floatDockRegister,
  floatDockUnregister,
  monitorWorkArea,
} from "@/platform/commands";
import { currentWindow, setWindowFrame, setWindowMinSize } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import {
  LATE_EVENT_TOLERANCE_PX,
  nearestEdge,
  revealedRect,
  sliverRect,
  type Rect,
} from "@/window/dock-model";
import {
  BAR_HEIGHT,
  BAR_MAX_WIDTH,
  STICKY_DEFAULT_SIZE,
  STICKY_MIN_SIZE,
} from "@/data/window-geometry";

const SCOPE = "dock";
const DOCK_ANIM_MS = 170;
/** 收回比滑出快（同一时长手感黏） */
const REVEAL_MS = 180;
const COLLAPSE_MS = 140;
/**
 * 拖动"算停下了"的静置时长（旧实现同值）：moved 是连续流，逐条判会把还在手里的窗吸到
 * 边上、再拖又判成解除（来回弹 = "闪、不自然"）。180ms 短过一次自然停顿、长过两帧。
 */
const SETTLE_MS = 180;

interface Props {
  /** 这扇窗贴边读写的那一份；`null` = 实体还没到（挂载后那一瞬），按自由窗处理 */
  target: DockTarget | null;
  minimized: boolean;
}

/**
 * 贴边对象的形状 — 单窗给便签行，叠窗给组行（一叠好几张，没有单张便签可给）。
 * 只要求这几样；落库那条路由调用方接（`write`）——判定与动画只有一份，谁存哪儿各说各的。
 */
export interface DockTarget {
  /** 注册进 Rust `DockLayout` 的键：单窗是便签 id，叠窗是组 id */
  id: string;
  docked: boolean;
  dockEdge: DockEdge | null;
  /** 行里记着的摆位：解除贴边后落回这里 */
  x: number | null;
  y: number | null;
  /** **展开档**的尺寸（默认值由调用方带好，这里不再猜） */
  width: number;
  height: number;
  /** 落库：单窗 `updateNote`，叠窗 `groupSetDock` */
  write: (docked: boolean, edge: DockEdge | null) => void;
}

export interface DockSnap {
  docked: boolean;
  revealed: boolean;
  /** 接进 useWindowGeometry 的抑制开关：贴边/动画/收起期间几何不许落库 */
  suppressGeometry: boolean;
  /** 点细丝滑出 / 点收纳收回（仅 docked 时有意义） */
  toggleReveal: () => void;
}

export function useDockSnap({ target, minimized }: Props): DockSnap {
  const [revealed, setRevealed] = useState(false);
  const [animating, setAnimating] = useState(false);

  const workAreaRef = useRef<Rect | null>(null);
  const factorRef = useRef(1);
  const targetRef = useRef(target);
  const minimizedRef = useRef(minimized);
  const animatingRef = useRef(false);
  const revealedRef = useRef(false);
  const slotRef = useRef(0);
  /** 开机恢复只摆一次：`target` 是异步到的（叠窗要等 `group_list`），effect 会跑第二遍 */
  const restoredRef = useRef(false);
  /**
   * 自己刚写进去的那一帧矩形：moved 与它比位置，差 ≤2px 当回声（比时间窗可靠）。
   */
  const lastWrittenRef = useRef<Rect | null>(null);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  useEffect(() => {
    minimizedRef.current = minimized;
  }, [minimized]);

  /**
   * **这一档的尺寸**（作者拍板：收起成标题栏也要能贴边）。收起态用收起态那套数
   * （宽夹到 360、高 62，与 window.tsx 的 handleMinimize 一致）：贴进去是细丝、滑出来是那条栏。
   */
  const modeSize = useCallback((): { width: number; height: number } => {
    const now = targetRef.current;
    const width = now?.width ?? STICKY_DEFAULT_SIZE.width;
    const height = now?.height ?? STICKY_DEFAULT_SIZE.height;
    return minimizedRef.current
      ? { width: Math.min(width, BAR_MAX_WIDTH), height: BAR_HEIGHT }
      : {
          width: Math.max(STICKY_MIN_SIZE.width, width),
          height: Math.max(STICKY_MIN_SIZE.height, height),
        };
  }, []);

  /** 贴边落回自由态的矩形：行里记着的位置 + 这一档尺寸（贴边不动 x/y，槽位只服务细丝避让） */
  const modeRect = useCallback((): Rect => {
    const now = targetRef.current;
    return { x: now?.x ?? 0, y: now?.y ?? 0, ...modeSize() };
  }, [modeSize]);

  /**
   * 贴边态撤原生下限、离开立刻还（文件头第 3 条）。滑出**走完再还**（提前还第一帧就被夹回
   * 220），收回**先撤再走**（否则末帧落不到 20）。收起态没有下限可还——那条栏 62 高。
   */
  const applySliverMode = useCallback(async (on: boolean): Promise<void> => {
    const restore = minimizedRef.current ? null : STICKY_MIN_SIZE;
    try {
      await setWindowMinSize(on ? null : restore);
    } catch (error) {
      logger.caught(
        SCOPE,
        on ? "撤原生下限失败：细丝会被夹回最小窗" : "恢复原生下限失败",
        error,
      );
    }
  }, []);

  /** 当下窗几何（逻辑像素）。等完表再判时读这个，不拿事件里的旧坐标——等表的 180ms 里用户可能又拖了 */
  const readLogicalRect = useCallback(async (): Promise<Rect> => {
    const win = currentWindow();
    const factor = factorRef.current;
    const position = await win.outerPosition();
    const size = await win.innerSize();
    return {
      x: position.x / factor,
      y: position.y / factor,
      width: size.width / factor,
      height: size.height / factor,
    };
  }, []);

  // —— 量工作区 + 开机恢复贴边态 ——
  // 依赖里带 `docked`：叠窗那一行是异步到的（要等 `group_list`），只挂一次会读到 null
  // 就永远不恢复了。摆位本身由 `restoredRef` 保证只做一次。
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
        const now = targetRef.current;
        if (cancelled || now === null || !now.docked || restoredRef.current) return;
        restoredRef.current = true;
        const edge = now.dockEdge ?? "left";
        const slot = await floatDockRegister(now.id, edge);
        slotRef.current = slot;
        await applySliverMode(true);
        const rect = sliverRect(edge, workAreaRef.current, slot);
        lastWrittenRef.current = rect;
        await setWindowFrame(rect.x, rect.y, rect.width, rect.height);
      } catch (error) {
        logger.caught(SCOPE, "工作区不可用，本窗停用贴边", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target?.id, target?.docked, applySliverMode]);

  // —— 解除贴边：就地恢复**这一档**的尺寸（收起态解除就回到那条栏）——
  const detach = useCallback(
    async (logical: { x: number; y: number }) => {
      const now = targetRef.current;
      if (now === null || !now.docked) return;
      void floatDockUnregister(now.id).catch(() => {});
      now.write(false, null);
      const size = modeSize();
      const restored: Rect = {
        x: Math.round(logical.x),
        y: Math.round(logical.y),
        width: size.width,
        height: size.height,
      };
      lastWrittenRef.current = restored;
      try {
        await setWindowFrame(restored.x, restored.y, restored.width, restored.height);
      } catch (error) {
        logger.caught(SCOPE, "解除贴边恢复尺寸失败", error);
      }
      // 尺寸已经还回去了，才把原生下限也还回去（反过来做的话，20×20 的细丝
      // 会在原地被系统撑成 220×200 闪一下）
      await applySliverMode(false);
      revealedRef.current = false;
      setRevealed(false);
    },
    [modeSize, applySliverMode],
  );

  // —— 开始贴边：注册槽位 → 落状态 → 补间滑进细丝位 ——
  const beginDock = useCallback(
    async (edge: DockEdge, from: Rect) => {
      const area = workAreaRef.current;
      const now = targetRef.current;
      if (area === null || animatingRef.current || now === null) return;
      animatingRef.current = true;
      setAnimating(true);
      try {
        const slot = await floatDockRegister(now.id, edge);
        slotRef.current = slot;
        now.write(true, edge);
        await applySliverMode(true);
        // 起点用**当下这块矩形**（拖动落点+量到的尺寸），不是算出来的"这一档尺寸"：拿算的当起点第一帧会跳
        const sliver = sliverRect(edge, area, slot);
        const start: Rect = {
          x: from.x,
          y: from.y,
          width: from.width,
          height: from.height,
        };
        await tweenRect(start, sliver, DOCK_ANIM_MS, (written) => {
          lastWrittenRef.current = written;
        });
        revealedRef.current = false;
        setRevealed(false);
      } catch (error) {
        logger.caught(SCOPE, "贴边失败", error);
        // 贴失败就当没贴过：状态与下限都回滚，免得"状态贴了、窗没贴"且这扇窗再没有最小尺寸
        now.write(false, null);
        void floatDockUnregister(now.id).catch(() => {});
        await applySliverMode(false);
      } finally {
        animatingRef.current = false;
        setAnimating(false);
      }
    },
    [applySliverMode],
  );

  const toggleReveal = useCallback((): void => {
    const area = workAreaRef.current;
    if (
      area === null ||
      animatingRef.current ||
      targetRef.current === null ||
      !targetRef.current.docked
    ) {
      return;
    }
    void (async () => {
      animatingRef.current = true;
      setAnimating(true);
      try {
        const now = targetRef.current;
        if (now === null) return;
        const edge = now.dockEdge ?? "left";
        const collapsing = revealedRef.current;
        const expanded = modeRect();
        // **先翻状态再动窗**：壳体与小签要在补间第一帧就位（动完才翻就是真机报的"贴边会闪"）
        revealedRef.current = !collapsing;
        setRevealed(revealedRef.current);
        if (collapsing) await applySliverMode(true);
        // 起止都按同一套算式取：滑出与收回是同一张纸在同一条轨道上往返
        const from = collapsing
          ? revealedRect(edge, area, expanded)
          : sliverRect(edge, area, slotRef.current);
        const to = collapsing
          ? sliverRect(edge, area, slotRef.current)
          : revealedRect(edge, area, expanded);
        await tweenRect(from, to, collapsing ? COLLAPSE_MS : REVEAL_MS, (written) => {
          lastWrittenRef.current = written;
        });
        if (!collapsing) await applySliverMode(false);
      } catch (error) {
        logger.caught(SCOPE, "滑出/收回失败", error);
      } finally {
        animatingRef.current = false;
        setAnimating(false);
      }
    })();
  }, [modeRect, applySliverMode]);

  // —— moved 监听：贴边判定与解除的唯一入口 ——
  // 处理器经 ref 间接（监听只绑一次），ref 的写入必须发生在 effect 里（react-hooks 规则）。
  // **拖动停下才算一次**（SETTLE_MS），算时再读当下几何——理由见文件头第 4 条。
  const handleMovedRef = useRef<((pos: { x: number; y: number }) => void) | null>(null);
  const settleRef = useRef<(() => Promise<void>) | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    settleRef.current = async () => {
      const area = workAreaRef.current;
      if (area === null || animatingRef.current) return;
      let rect: Rect;
      try {
        rect = await readLogicalRect();
      } catch (error) {
        logger.caught(SCOPE, "停下后读窗几何失败，这一轮不判贴边", error);
        return;
      }
      // 停下时读到的还是"刚自己写进去的那一帧" = 动画的回声，不是用户拖的
      const last = lastWrittenRef.current;
      if (last !== null && samePlace(rect, last)) return;
      const now = targetRef.current;
      if (now !== null && now.docked) {
        const edge = now.dockEdge ?? "left";
        // **贴边时读回的"细丝位/滑出位"都是自己的回声**：只跟最新写入帧比不够——动画途中的帧
        // 还在路上、与最新帧差好几个像素，会被判成真拖动 → 解除 → 下一拍又贴回去（"来回弹"）。
        // 所以要跟两个**目标**比。
        const targets = [
          sliverRect(edge, area, slotRef.current),
          revealedRect(edge, area, modeRect()),
        ];
        if (targets.some((target) => samePlace(rect, target))) return;
        // 真的被拖到别处了：就地解除（细丝被拖、滑出态被拖都走这条）。
        // detach 会写新位置，lastWritten 跟着更新，不会自锁
        void detach({ x: rect.x, y: rect.y });
        return;
      }
      const hit = nearestEdge(rect, area);
      if (hit === null) return;
      // **最大化不是"拖到边上"**：Windows 上双击 drag region 就会最大化窗
      // （tauri 的 drag.js：`e.detail` 1 与 2 都走这条路），而最大化后的矩形离四条边
      // 的 gap 全是 0 —— 不挡的话症状就是作者报的"双击后直接贴边了"
      try {
        if (await currentWindow().isMaximized()) return;
      } catch (error) {
        logger.caught(SCOPE, "读不到最大化状态，这一轮不贴边", error);
        return;
      }
      void beginDock(hit.edge, rect);
    };
    handleMovedRef.current = (pos) => {
      const factor = factorRef.current;
      const logical = { x: pos.x / factor, y: pos.y / factor };
      // 回声在事件时刻就先丢掉：省得给动画里的每一帧都排一张表
      const last = lastWrittenRef.current;
      if (last !== null && samePlace(logical, last)) return;
      if (animatingRef.current) return;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        void settleRef.current?.();
      }, SETTLE_MS);
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
      // 还没落表的判定要丢掉：那张表回调抓着 detach/beginDock，窗都没了不该再判
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, []);

  return {
    docked: target?.docked ?? false,
    revealed,
    suppressGeometry: minimized || (target?.docked ?? false) || animating,
    toggleReveal,
  };
}

/**
 * 读回位置与"自己刚摆出来的"重合（±2px）= 回声。按位置不按时间：时间窗会吃掉滑出后的真拖动。
 */
function samePlace(point: { x: number; y: number }, written: Rect): boolean {
  return (
    Math.abs(point.x - written.x) <= LATE_EVENT_TOLERANCE_PX &&
    Math.abs(point.y - written.y) <= LATE_EVENT_TOLERANCE_PX
  );
}

/** rAF 逐帧补间（位置尺寸一起插值）。三件事必须做对：
 *  · 每帧记进 lastWritten（回声比对的是最新帧，不是最终目标）；
 *  · 最后一帧 await 落地再返回——否则 animating 先清、迟到的回声被当成真拖动去 detach；
 *  · **看门狗必加**：窗不可见/被遮挡时 WebView2 会节流 rAF，补间 Promise 永不落地，
 *    animating 永远为 true 就把贴边锁死了——超时一次写到位，宁可没动画。 */
async function tweenRect(
  from: Rect,
  to: Rect,
  ms: number,
  remember: (written: Rect) => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const land = (written: Rect): Promise<void> =>
      setWindowFrame(written.x, written.y, written.width, written.height).catch(
        (error: unknown) => logger.caught(SCOPE, "贴边补间写入失败", error),
      );
    const settle = (written: Rect): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      remember(written);
      void land(written).finally(resolve);
    };
    const watchdog = window.setTimeout(() => settle(to), ms + 500);
    const started = performance.now();
    const step = (): void => {
      if (settled) return;
      const t = Math.min(1, (performance.now() - started) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const written: Rect = {
        x: Math.round(from.x + (to.x - from.x) * eased),
        y: Math.round(from.y + (to.y - from.y) * eased),
        width: Math.round(from.width + (to.width - from.width) * eased),
        height: Math.round(from.height + (to.height - from.height) * eased),
      };
      remember(written);
      const frame = land(written);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        // 末帧落地才收兵：这一句 await 就是"动画期间"的尾巴
        settled = true;
        window.clearTimeout(watchdog);
        void frame.finally(resolve);
      }
    };
    requestAnimationFrame(step);
  });
}
