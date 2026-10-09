// 叠窗内容区的盒子尺寸 — 手风琴那一档要的"量"（侧签用死尺寸块堆，不量）。
//
// 为什么量而不抄数字：卡片要多大得看内容区还剩多少，而内容区高度是 WindowChrome
// 那条标题条让出来的。抄一个 36 进来就是第二个真相，壳体一改这里就悄悄错位。
//
// 挂载时先量一次（`getBoundingClientRect`），之后跟 resize 与 ResizeObserver。
// 只挂 RO 的话，帧被节流的环境里它可以一次都不回调——那时整片布局按 0×0 走，
// 用户看到的是"这一叠空了"，所以挂载时那一次量不是优化，是底线。

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Size } from "@/window/stack-model";

export function useContentBox(): [RefObject<HTMLDivElement | null>, Size] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const measure = (): void => {
      const node = ref.current;
      if (node === null) return;
      const rect = node.getBoundingClientRect();
      setBox((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(ref.current as Element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return [ref, box];
}
