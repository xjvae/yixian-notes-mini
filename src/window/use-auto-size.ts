// 自动长高 — 便签窗按内容改自己的窗（单张便签；叠窗另有口径，不走这里）。三条纪律：
//  1. **不往行里写 width/height**：写回就覆盖"用户手拉的固定值"，这条模式的前提是它留着、关掉回得去。
//  2. **手拉就是表态**：落点与写下去的目标差 >2px 且稳 200ms 才算（中间过渡态不算），写 autoSize=false。
//  3. **量早了不改**：图未解码/壳体未布局量到 0，由 autoSizeFor 挡掉（见 window/auto-size.ts）。
// 为什么不用 ResizeObserver：正文格是 flex-1，内容长它**不动**，RO 可以一次都不回调。
// 触发：正文改、窗改、图 load 完；每次写完再排一次量——"宽变→图换行→高跟着变"要两轮收敛。

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
 * 我们自己写下去之后的静默期，没有它就自己抓自己：自己的落地必然"差得多"，会被误判成
 * 手拉（症状：高度一上去，宽度莫名少 2px）。期内尺寸只用来重新锚定 `settledRef`。
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
 * 内容本体的自然高。**不能**读那一格自己的 scrollHeight：滚动盒的 scrollHeight 永远不低于
 * clientHeight，"变短了"量不出来（症状：窗只会长不会缩）。阅读态量内层 data-body-content；
 * 编辑态临时把 textarea 摘出 flex（留着 flex-1，height 被 basis/grow 盖着，量回来还是撑满值）。
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
   * 两个基准分开记：写下去的尺寸与量到的视口天生差一圈（iframe 有 1px 边框，真机边框归系统），
   * 混着比每轮漂 2px。`baseRef` = 写下去那侧；`settledRef` = 视口那侧（判手拉跟用户看到的比）。
   */
  const baseRef = useRef<{ width: number; height: number } | null>(null);
  const settledRef = useRef<{ width: number; height: number } | null>(null);
  /** 上一次我们自己写窗的时刻（静默期用） */
  const wroteAtRef = useRef(0);
  const enabledRef = useRef(enabled);
  const onManualRef = useRef(onManualResize);
  // 依赖只认 hasNote 与 body：换主题/改图标不该重测，正文改了必须重测（那一格是 flex-1，内容长了它不动）
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
    // 进出编辑态也要重量：量的对象换了（textarea ↔ 阅读层），不重测会停在编辑态那个高度
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

  // 手拉 = 表态（判据见文件头第 2 条）。比的是视口对视口：混着写下去的值比，会把自己那一下当手拉
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
