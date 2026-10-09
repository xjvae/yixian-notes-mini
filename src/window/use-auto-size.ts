// 自动长高 — 便签窗按内容改自己的窗（单张便签；叠窗另有尺寸口径，不走这里）。
//
// 三件要紧的事，先说清楚为什么：
//  1. **不往行里写 width/height**。开着自动时每一寸尺寸都是算出来的，写回行里就等于
//     把"用户手拉的那个固定值"覆盖了——而这条模式的全部前提就是那个固定值还得留着、
//     关掉那一刻回得去。所以这里只改窗，几何持久化由调用方一并抑制。
//  2. **手拉就是表态**。用户拖窗边 = 这张要固定：写 autoSize=false（三态里的"强制固定"）
//     并把拉到的尺寸记进行里。判"是不是用户拉的"靠差值：我们每次写的目标都记着，
//     落点与它差 >2px 且**稳了 200ms** 才算手拉——系统还在改的中间态不算。
//  3. **量早了不改**。图未解码时 naturalWidth 是 0（预览台实测到过：lazy 加载第一帧量到
//     的就是 0），壳体还没布局时正文那一格 clientHeight 是 0。这两种由 autoSizeFor 挡掉
//     （见 window/auto-size.ts），这里只负责别把它们当有效测量。
//
// 为什么不用 ResizeObserver 驱动：正文那一格是 `flex-1`，内容长它**不动**，RO 就不会响
// （与 use-content-box.ts 头注释"只挂 RO 可以一次都不回调"是同一类坑）。真正会变的时刻
// 都有显式触发：正文改了、窗改了（含我们自己改的）、图 load 完。每次写完再排一次量，
// 是为了让"宽变了 → 图换行高 → 高也要跟着变"这两步收敛（一轮改宽，一轮改高）。

import { useEffect, useRef } from "react";
import { resizeKeepingPosition } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { autoSizeFor, differsEnough } from "@/window/auto-size";
import type { StickyNote } from "@/platform/contracts";

const SCOPE = "auto-size";
/** 一次改完再量一次的合流窗口：打字是连续的，逐字符改窗会抖 */
const APPLY_MS = 120;
/** 手拉判定要稳这么久：中间的过渡尺寸不算表态 */
const MANUAL_SETTLE_MS = 200;
/**
 * 我们自己写下去之后的静默期。没有这一条就是自己抓自己：`settledRef` 记的是**写之前**
 * 看到的视口，我们自己那一下落地时必然"差得多"，于是把自动改窗误判成用户手拉，
 * 这张当场被拨回强制固定（症状：高度一上去，宽度就莫名少 2px）。
 * 静默期内的尺寸一律只用来重新锚定 `settledRef`；真手拉是连发的事件，
 * 过了这 500ms 还在动就照样抓得到。
 */
const WRITE_QUIET_MS = 500;

export interface UseAutoSizeArgs {
  note: StickyNote | null | undefined;
  /** 生效值：note.autoSize ?? 全局默认。收起/遮罩/贴边由调用方一并算进来（false 就不动） */
  enabled: boolean;
  /** 取正文那一格（阅读态的 div 与编辑态的 textarea 共用一个 data 标记） */
  getSlot: () => HTMLElement | null;
  /** 用户手拉：这张退回强制固定，并由调用方把尺寸记进行里 */
  onManualResize: (size: { width: number; height: number }) => void;
}

/**
 * 内容本体的自然高。**不能**读那一格自己的 scrollHeight：滚动盒的 scrollHeight
 * 永远不低于 clientHeight，于是"内容变短了"这件事量不出来——症状是窗只会长不会缩。
 * 阅读态量里面那层 `data-body-content`（它是内容撑开的）；编辑态的 textarea 没有内层，
 * 就临时把它从 flex 里摘出来（`flex: 0 0 auto` + `height: auto`）读一次 scrollHeight。
 * 只压 height 不摘 flex 是没用的：那一格是 `flex-1`，列向 flex 里 height 被 flex-basis
 * 与 grow 盖着，量回来还是被撑满的高（第一版就栽在这，症状是"删到一行也不缩"）。
 * 全程同步，读完原样还回去，120ms 的合流窗口里只重排这一次。
 */
function contentHeightOf(slot: HTMLElement): number {
  if (slot instanceof HTMLTextAreaElement) {
    const { flex, height } = slot.style;
    slot.style.flex = "0 0 auto";
    slot.style.height = "auto";
    const natural = slot.scrollHeight;
    slot.style.flex = flex;
    slot.style.height = height;
    return natural;
  }
  const inner = slot.querySelector("[data-body-content]");
  return inner === null
    ? slot.scrollHeight
    : Math.ceil(inner.getBoundingClientRect().height);
}

export function useAutoSize({
  note,
  enabled,
  getSlot,
  onManualResize,
}: UseAutoSizeArgs): void {
  /**
   * 两个基准分开记，因为"写下去的尺寸"与"量到的视口"天生差一圈（预览台那层 iframe 有
   * 1px 边框；真机上边框归系统）。拿其中一个去比另一个，就成了每轮漂 2px。
   *  · `baseRef` —— 写下去那一侧（改窗的目标，也是下一次算高的基准）
   *  · `settledRef` —— 视口那一侧（判"这一下是不是用户拉的"要跟用户看到的比）
   */
  const baseRef = useRef<{ width: number; height: number } | null>(null);
  const settledRef = useRef<{ width: number; height: number } | null>(null);
  /** 上一次我们自己写窗的时刻（静默期用） */
  const wroteAtRef = useRef(0);
  const enabledRef = useRef(enabled);
  const onManualRef = useRef(onManualResize);
  // 只把"有没有这张便签"当依赖，而不是整行：换主题、改图标不该重排一次测量，
  // 而正文改了必须重排（那一格是 flex-1，内容长了它自己不动）
  const hasNote = note !== null && note !== undefined;
  const body = note?.body;

  useEffect(() => {
    enabledRef.current = enabled;
    onManualRef.current = onManualResize;
    if (!enabled) {
      baseRef.current = null;
      settledRef.current = null;
    }
  }, [enabled, onManualResize]);

  useEffect(() => {
    if (!enabled || !hasNote) return;

    const apply = (): void => {
      const slot = getSlot();
      if (slot === null) return;
      const images: { width: number; height: number }[] = [];
      for (const img of slot.querySelectorAll("img")) {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          images.push({ width: img.naturalWidth, height: img.naturalHeight });
        }
      }
      const base = baseRef.current ?? {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const target = autoSizeFor({
        windowWidth: base.width,
        windowHeight: base.height,
        bodyClientHeight: slot.clientHeight,
        bodyContentHeight: contentHeightOf(slot),
        images,
      });
      baseRef.current = target;
      if (!differsEnough(base, target)) {
        // 与"上次写下去的"比，不和视口比：视口天生小一圈，比它就成了永远差 2px 改不完
        return;
      }
      wroteAtRef.current = Date.now();
      void resizeKeepingPosition(target.width, target.height)
        .catch((error: unknown) =>
          logger.caught(SCOPE, `自动改窗到 ${target.width}x${target.height} 失败`, error),
        )
        // 写完排一次：宽变了图就换行高，第二轮把高补上
        .finally(schedule);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        // 排到下一帧：这一帧的布局可能还没落定（刚换行的文字、刚 wrap 的页脚）
        requestAnimationFrame(apply);
      }, APPLY_MS);
    };

    schedule();
    // 图 load 不冒泡，用 capture 接：未解码时量到的是 0，得等它到
    const onLoad = (event: Event): void => {
      if (event.target instanceof HTMLImageElement) schedule();
    };
    // 进出编辑态也要重量：正文没改但**量的对象换了**（textarea ↔ 阅读层），
    // 只挂 body 的依赖就会停在编辑态算出来的那个高度上（"点出去一看还是那么高"）
    const onModeChange = (): void => {
      schedule();
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("load", onLoad, true);
    window.addEventListener("focusin", onModeChange, true);
    window.addEventListener("focusout", onModeChange, true);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("load", onLoad, true);
      window.removeEventListener("focusin", onModeChange, true);
      window.removeEventListener("focusout", onModeChange, true);
    };
    // 正文进依赖：那一格是 flex-1，内容长了它不动，只能在这里显式重算
  }, [enabled, hasNote, body, getSlot]);

  // 手拉 = 表态。落点与"上一次看到的视口尺寸"差 >2px 且稳了 200ms 才算（过渡尺寸不算）。
  // 比的是视口对视口：写下去的值与量到的视口差一圈，混着比会把我们自己那一下当成手拉
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const now = { width: window.innerWidth, height: window.innerHeight };
        const seen = settledRef.current;
        if (!enabledRef.current) return;
        // 刚自己写过、或还没有基准：这一律只用来重新锚定，不判手拉
        if (seen === null || Date.now() - wroteAtRef.current < WRITE_QUIET_MS) {
          settledRef.current = now;
          return;
        }
        if (differsEnough(now, seen)) onManualRef.current(now);
        else settledRef.current = now;
      }, MANUAL_SETTLE_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [enabled]);
}
