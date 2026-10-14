// 纸边闪一圈 — "就是这一张"的可见回应。提醒卡点「去看这张便签」时那张常常本来就开着还在前台，
// show()+set_focus() 什么都不改变（作者报的"点了没反应"）；Rust 摆位之外广播 `sticky:ping`，这层翻成一次闪光。
// 贴边那张光闪不够（细丝 20×20，壳体没渲染）：先叫 onPing 让窗体把细丝滑出来，再闪。
// 判定给的是"这扇窗手里有哪些 id"（叠窗承载多张）；定时器只留一个（新 ping 重新计时），卸载清掉。

import { useEffect, useRef, useState } from "react";
import { listen } from "@/platform/bridge";
import { STICKY_PING } from "@/platform/contracts";
import type { StickyPingEvent } from "@/platform/contracts";
import { logger } from "@/platform/logger";

/** 闪多久。比一圈动画略长，宁可留一点点尾巴，也别闪到一半就断 */
const FLASH_MS = 1100;

export function useStickyPing(holds: () => string[], onPing?: () => void): boolean {
  const [flash, setFlash] = useState(false);
  const holdsRef = useRef(holds);
  const onPingRef = useRef(onPing);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    holdsRef.current = holds;
    onPingRef.current = onPing;
  });

  useEffect(() => {
    let unbind: (() => void) | null = null;
    let cancelled = false;
    // 普通函数就够：它只在订阅那一刻装一次，读的东西全走 ref
    const handle = (payload: StickyPingEvent): void => {
      if (!holdsRef.current().includes(payload?.stickyId)) return;
      onPingRef.current?.();
      setFlash(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setFlash(false);
      }, FLASH_MS);
    };
    void listen<StickyPingEvent>(STICKY_PING, handle)
      .then((off) => {
        if (cancelled) off();
        else unbind = off;
      })
      .catch((error: unknown) => logger.caught("ping", "订阅纸边闪光失败", error));
    return () => {
      cancelled = true;
      unbind?.();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return flash;
}
