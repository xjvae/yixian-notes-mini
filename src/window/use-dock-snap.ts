// 贴边吸附的接线层 — 判定全在 dock-model.ts（纯函数），这里只做四件事：
// 听拖动 → 问纯函数该不该贴 → 动画把窗口写过去 → 管理贴边态的滑出/收回/解除。
//
// 时序纪律（每条都对应"悬停时窗口来回闪"这类事故的防法）：
//  1. **程序性写入会引发原生 moved 事件**：与"刚写进去的位置"差 ≤2px 的一律当回声
//     忽略。**不用时间窗**——按时间吞的话，滑出后 350ms 内用户的真拖动会被一起吃掉，
//     手感就是"窗不跟手"（旧实现改成位置容差的同一条理由）；
//  2. **贴边后几何持久化必须关**：20px 细丝不是用户的展开尺寸，记下它就是毁掉恢复
//     尺寸（suppression 由调用方接进 useWindowGeometry）；
//  3. **贴边后的任何真实拖动 = 解除**（不做迟滞）：解除时把展开尺寸原位还回去，
//     位置取拖动落点；
//  4. 交互口径：**点细丝滑出、点「收纳」收回、拖动即解除**——悬停滑出对手抖的人
//     是灾难，第一版选确定性优先。
//  5. 滑出/收回也要补间：硬跳是"啪"，补间才看得出它是同一张纸在动。
//     三段时长分开，收回比滑出快（旧实现实测：同一时长手感黏）。
//  6. **贴边态必须撤掉窗的原生最小尺寸**：浮窗的 min_size 是 220×200，细丝是 20×20，
//     下限不撤 `setSize(20,20)` 会被系统夹回 220×200——那副样子是"一块正常大小的窗
//     贴在边上"，不是收起。离开贴边态（滑出/解除/贴失败）把下限还回去，但**还的是
//     这一档的下限**：收起态那条栏 62 高，把 220×200 还回去等于当场把它撑大，所以
//     收起中就还是不限（规则与 window.tsx 里那条 effect 一字不差）。
//     "手拉不能把便签缩到捏不住"这条保证只在展开档里留着。
//     另外细丝那 20×20 里装不下壳体（标题条三颗按钮 + 正文），呈现层整支换成
//     `dock-sliver.tsx` 的小签——本钩子只管几何与状态，长什么样归窗体。
//  7. **状态翻在补间之前，判定等拖动停下**：壳体/小签要在第一帧就位（动完才翻就是
//     "小签拉长 → 啪一下变正文"，真机报的"闪"）；moved 是连续流，逐条判会把还在手里的
//     窗吸到边上、再拖又判成解除（来回弹 = "不自然"），所以静置 180ms 才算一次。
//
// 开机恢复：行里 docked=1 的那一扇，挂载量到工作区后直接摆到细丝位（无动画），
// 槽位从 Rust 注册表现领——同侧多张按 26px 错开。"行"两种都算：单窗是便签行，
// 叠窗是组行（`groups.docked`），差别只在组行是异步到的（见 restoredRef 那条）。

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
} from "@/features/sticky/window-statics";

const SCOPE = "dock";
/** 贴进边（远距离补间） */
const DOCK_ANIM_MS = 170;
/** 滑出：慢一点点，让人看清它展开了 */
const REVEAL_MS = 180;
/** 收回：比滑出快，同一时长会显得黏 */
const COLLAPSE_MS = 140;
/**
 * 拖动"算停下了"的静置时长（旧实现同值）：moved 是连续流，逐条判贴边会把还在手里的窗
 * 吸到边上，再拖就又被判成解除——来回弹就是"闪、不自然"。180ms 比一次自然停顿短，
 * 比连续事件流的两帧长，落在"手停了"这个感觉上。
 */
const SETTLE_MS = 180;

interface Props {
  /**
   * 这扇窗贴边要读写的那一份。`null` = 实体还没到（挂载后那一瞬），
   * 按自由窗处理，所有写路径自行空转。
   */
  target: DockTarget | null;
  minimized: boolean;
}

/**
 * 贴边对象的形状 — 单窗给便签行，叠窗给组行。
 *
 * 为什么不再直接吃 `StickyNote`：叠窗那一侧根本没有一张便签可给（一叠好几张），
 * 而它自己的那行（`groups`）记的就是"这一叠摆哪儿、多大、贴没贴"。
 * 于是这里只要求**这几样**，落库那条路由调用方接（`write`）——
 * 判定与动画只有一份，谁存哪儿各说各的。
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
   * 自己刚写进去的那一帧矩形。moved 与它比位置：差 ≤2px 当回声。
   * 这是"按时间吞"的替代——时间窗会把滑出后头几百毫秒的真拖动一起吃掉。
   */
  const lastWrittenRef = useRef<Rect | null>(null);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  useEffect(() => {
    minimizedRef.current = minimized;
  }, [minimized]);

  /**
   * **这一档的尺寸**（作者拍板："收起为标题栏也要能贴边，点细丝滑出来还是标题条"）。
   * 以前这里只有"展开尺寸"一种，收起态被明令禁止贴边——因为拿 220×200 的下限去摆
   * 一条 62 高的栏，滑出来就成了一叠被撑大的正文。
   * 收起态用收起态的那套数（与 window.tsx 的 handleMinimize 一模一样：宽夹到 360、高 62），
   * 于是贴进去是细丝、滑出来是那条栏、解除还是那条栏。
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

  /**
   * 贴边落回自由态时该摆的那块矩形：行里记着的位置 + 这一档的尺寸。
   * 贴边不动 x/y（见 write 那条），所以滑出落到哪儿由"这张纸原来摆哪儿"决定，
   * 与它挤在第几号槽无关——槽位只服务细丝之间的避让。
   */
  const modeRect = useCallback((): Rect => {
    const now = targetRef.current;
    return { x: now?.x ?? 0, y: now?.y ?? 0, ...modeSize() };
  }, [modeSize]);

  /**
   * 贴边态撤掉原生最小尺寸，离开立刻还回去（文件头第 6 条）。
   * 时机讲究一句：滑出那一趟补间**走完再还**——途中的帧还是窄的，提前还就等于
   * 第一帧就被夹回 220；收回那一趟则**先撤再走**，否则末帧落不到 20。
   *
   * **收起态没有下限可还**：那条栏是 62 高，把 220×200 还回去等于当场把它撑成一块
   * 正常大小的窗。所以"还"的目标跟着这一档走——收起中就还是不限。
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

  /**
   * 当下窗几何（逻辑像素）。等完表再判一次时读的是**这个**，不是事件里那份旧坐标：
   * 从最后一个 moved 到计时器落地中间那 180ms 里，用户可能又拖了一段。
   */
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

  // —— 开始贴边：注册槽位 → 落状态 → 动画滑进细丝位 ——
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
        // 先撤下限再补间：末帧要落到 20×20，留着下限系统就把末帧夹回 220×200，
        // 于是"贴上了但还是那么大一块"——正是这条 bug 的样子
        await applySliverMode(true);
        // 起点用**当下这块矩形**（拖动落点 + 量到的尺寸），不是算出来的"这一档尺寸"：
        // 手拉过的那一档宽度只有窗自己知道，拿算的当起点，第一帧就会跳一下
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
        // 贴失败了就当没贴过：状态回滚，免得出现"状态贴了、窗没贴"的怪相。
        // 下限也要跟着回滚——不还回去，这扇窗之后就再没有最小尺寸了
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
        // **先翻状态，再动窗**：壳体与小签要在补间的第一帧就位。反过来（动完才翻）
        // 看到的就是"小签被拉长成 320 宽 → 啪一下变成正文"、或"整个壳体被挤进
        // 20px → 啪一下变成小签"——真机报的"贴边会闪"就是这两下。
        revealedRef.current = !collapsing;
        setRevealed(revealedRef.current);
        // 收回：先撤下限，末帧才落得到 20×20。滑出：整趟都留着撤开的下限
        //（途中每一帧都可能比 220 窄），落地之后再还——反过来就是滑出第一帧
        // 被系统撑成 220 宽，看到"跳一下再展开"
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
  // 处理器经 ref 间接（监听只绑一次），但 ref 的写入必须发生在 effect 里，
  // 渲染期写 ref 是新 react-hooks 规则明确禁止的。
  //
  // **拖动停下才算一次，不逐条判**：moved 在拖动里是连续流，逐条判会把还在手里的窗
  // "啪"一下吸到边上，用户接着拖又立刻被判成解除——来回弹两下就是真机报的
  // "贴边会闪、操作不自然"。每个事件只重置一张表，停下才算；算的时候再读一次
  // **当下**几何，不拿事件里那份旧坐标（等表的这点时间里用户可能又拖了一段）。
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
        // **贴边时读回来的"细丝位"或"滑出位"都是自己的回声，不是用户拖的。**
        // 只跟"最新写入的那一帧"比不够：动画途中写的帧还在路上，它和最新帧差着
        // 好几个像素，于是被判成真拖动 → 解除 → 下一拍又贴回去。真机看到的
        // "贴边会闪、来回弹"正是这一串（旧实现同一条：拿两个**目标**比）。
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
 * 读回来的位置与"自己刚摆出来的那个"重合（±2px）= 回声，不是用户拖的。
 * 按位置不按时间：时间窗会把滑出后头几百毫秒的真拖动一起吃掉（= "窗不跟手"）。
 */
function samePlace(point: { x: number; y: number }, written: Rect): boolean {
  return (
    Math.abs(point.x - written.x) <= LATE_EVENT_TOLERANCE_PX &&
    Math.abs(point.y - written.y) <= LATE_EVENT_TOLERANCE_PX
  );
}

/** rAF 逐帧补间：位置与尺寸一起插值（ease-out cubic），每帧一次 setWindowFrame。
 *  三件事必须做对，否则要么"贴上了又被自己弹开"，要么"贴一次就把贴边永久锁死"：
 *   · 每一帧都记进 lastWritten（回声比对的是"最新那一帧"，不是最终目标）；
 *   · 最后一帧要 await 落地再返回——调用方在它之后才清 animating，否则 animating
 *     先清、迟到的回声后到，被当成真拖动去 detach；
 *   · **rAF 可能一帧都不跑**：页面不可见、窗被遮挡或最小化时 WebView2 会节流
 *     requestAnimationFrame，补间 Promise 就永不落地，animating 永远为 true，
 *     之后每次点细丝都静默无事发生。所以加一个到点必归的看门狗：超时就把目标值
 *     一次写到位（宁可没有动画，也不能把功能锁死）。预览台上就是这么撞到的。 */
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
