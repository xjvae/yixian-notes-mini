// 窗口几何 — moved/resized 事件的合流持久化。两条真机经验：
// 拖动/缩放期间事件连发，合流 180ms（静默这么久才算"这一版"，期间补丁合并）；
// 逻辑像素 = 物理像素 ÷ 缩放系数（挂载时量一次），存库口径与 Rust 开窗路径一致。
// 收起/贴边这类"程序在改尺寸"由调用方用 isSuppressed 挡住——62px 收起栏不是展开尺寸，记下它就是毁掉恢复尺寸。

import { useEffect, useRef } from "react";
import { currentWindow } from "@/platform/bridge";

export interface WindowFrame {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}

const MERGE_MS = 180;

export function useWindowGeometry(
  onCommit: (patch: Partial<WindowFrame>) => void,
  isSuppressed: () => boolean,
  minSize: { width: number; height: number },
): void {
  const commitRef = useRef(onCommit);
  const suppressedRef = useRef(isSuppressed);
  const minRef = useRef(minSize);
  useEffect(() => {
    commitRef.current = onCommit;
    suppressedRef.current = isSuppressed;
    minRef.current = minSize;
  });

  useEffect(() => {
    let factor = 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let patch: Partial<WindowFrame> = {};
    const offListeners: Array<() => void> = [];
    let cancelled = false;

    const flush = (): void => {
      timer = null;
      const batch = patch;
      patch = {};
      if (Object.keys(batch).length === 0) return;
      const next = { ...batch };
      if (next.width !== undefined && next.width !== null) {
        next.width = Math.max(minRef.current.width, next.width);
      }
      if (next.height !== undefined && next.height !== null) {
        next.height = Math.max(minRef.current.height, next.height);
      }
      commitRef.current(next);
    };
    const schedule = (): void => {
      if (timer !== null) return;
      timer = setTimeout(flush, MERGE_MS);
    };

    void (async () => {
      const win = currentWindow();
      try {
        factor = await win.scaleFactor();
      } catch {
        return; // 非 Tauri 环境（单测/预览），几何本就不存在
      }
      const offMoved = await win.onMoved(({ payload }) => {
        if (suppressedRef.current()) return;
        patch = {
          ...patch,
          x: Math.round(payload.x / factor),
          y: Math.round(payload.y / factor),
        };
        schedule();
      });
      const offResized = await win.onResized(({ payload }) => {
        if (suppressedRef.current()) return;
        patch = {
          ...patch,
          width: Math.round(payload.width / factor),
          height: Math.round(payload.height / factor),
        };
        schedule();
      });
      if (cancelled) {
        offMoved();
        offResized();
        return;
      }
      offListeners.push(offMoved, offResized);
    })();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      for (const off of offListeners) off();
    };
  }, []);
}
