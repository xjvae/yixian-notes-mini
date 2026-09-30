// 提醒角标的驱动时钟：每窗一个 60 秒 tick。分档只认"日历天"（due.ts），
// 所以这个 tick 给不了"到 18:00 那一刻"的精度——到点后最多一分钟内角标变化，
// 这是有意接受的口径（要真通知另立功能轨）。

import { useEffect, useState } from "react";

export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
