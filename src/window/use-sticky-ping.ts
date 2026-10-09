// 纸边闪一圈 — "就是这一张"的那个可见回应。
//
// 为什么要有它：提醒卡上点「去看这张便签」时，那张便签**常常本来就开着、还在前台**，
// 于是 `show()` + `set_focus()` 在它身上什么也没改变——作者报的"点了没反应"就是这个形状
// （日志证明命令到了：`reminder: 点卡：要打开 s…`，可窗那边确实没变）。
// Rust 那边除了摆位还会广播一条 `sticky:ping`，这一层把它翻译成一次纸边闪光。
//
// 贴边那一张光闪不够：细丝只有 20×20，壳体压根没渲染，圈画在哪儿都看不见。
// 所以命中时先叫 `onPing`（窗体拿它把细丝滑出来），再闪。作者问"是不是和贴边了有关系"
// ——就是这一种：贴着的窗点完确实一动不动。
//
// 一扇窗可能承载好几张纸（叠窗），所以判定给的是"这扇窗手里有哪些 id"而不是一个 id。
// 定时器只留一个（新的 ping 会重新计时），卸载时清掉——不然闪完的那一下会写到已卸载的组件上。

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
