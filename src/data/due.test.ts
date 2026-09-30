// describeDue 分档契约。基准时刻固定（2026-01-15 周四 09:30 本地），
// 隐式输入"跑测试的时分"在这里不存在——now 永远显式传。

import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  describeDue,
  fromLocalInputValue,
  nextOccurrence,
  toLocalInputValue,
} from "@/data/due";

const NOW = new Date(2026, 0, 15, 9, 30, 0).getTime(); // 周四 09:30

function at(y: number, m: number, d: number, hh: number, mm: number): number {
  return new Date(y, m - 1, d, hh, mm).getTime();
}

describe("describeDue 分档", () => {
  it("没设到期 → none；已完成 → done", () => {
    expect(describeDue(null, null, NOW)).toEqual({ state: "none", text: "" });
    expect(describeDue(at(2026, 1, 10, 8, 0), NOW, NOW)).toEqual({
      state: "done",
      text: "已完成",
    });
  });

  it("当天未到点 → 今天 HH:mm", () => {
    expect(describeDue(at(2026, 1, 15, 18, 0), null, NOW).text).toBe("今天 18:00");
  });

  it("当天已过点 → 补（已过点），不升级成逾期", () => {
    const view = describeDue(at(2026, 1, 15, 8, 0), null, NOW);
    expect(view.state).toBe("today");
    expect(view.text).toBe("今天 08:00（已过点）");
  });

  it("逾期按日历天计数", () => {
    // 前天 18:00 → 逾期 2 天（跨了两个日历天，与时刻无关）
    expect(describeDue(at(2026, 1, 13, 18, 0), null, NOW).text).toBe("逾期 2 天");
    expect(describeDue(at(2026, 1, 14, 23, 59), null, NOW).text).toBe("逾期 1 天");
  });

  it("明天 / 7 天内 / 更远", () => {
    expect(describeDue(at(2026, 1, 16, 9, 0), null, NOW).text).toBe("明天 09:00");
    expect(describeDue(at(2026, 1, 20, 9, 0), null, NOW).text).toBe("5 天后");
    expect(describeDue(at(2026, 2, 3, 14, 5), null, NOW).text).toBe("2月3日 14:05");
  });

  it("月跨度的日历天计数不吃夏令时亏（本机无夏令时也逐日走）", () => {
    expect(calendarDaysBetween(new Date(2026, 0, 31), new Date(2026, 1, 1))).toBe(1);
    expect(calendarDaysBetween(new Date(2026, 0, 1), new Date(2026, 2, 1))).toBe(59);
  });
});

describe("nextOccurrence", () => {
  it("daily 保持时刻推进一天，跨月正确", () => {
    const next = nextOccurrence(at(2026, 1, 31, 18, 0), "daily");
    expect(next).toBe(at(2026, 2, 1, 18, 0));
  });

  it("weekly 推进七天", () => {
    const next = nextOccurrence(at(2026, 1, 15, 9, 30), "weekly");
    expect(next).toBe(at(2026, 1, 22, 9, 30));
  });

  it("none 没有下一次", () => {
    expect(nextOccurrence(at(2026, 1, 15, 9, 30), "none")).toBeNull();
  });
});

describe("datetime-local 往返", () => {
  it("toLocalInputValue / fromLocalInputValue 保秒内往返", () => {
    const ms = at(2026, 1, 15, 9, 30);
    expect(fromLocalInputValue(toLocalInputValue(ms))).toBe(ms);
  });

  it("空串与非法输入 → null", () => {
    expect(fromLocalInputValue("")).toBeNull();
    expect(fromLocalInputValue("not-a-date")).toBeNull();
  });
});
