// 锁档的读法：只有明写的 never / now 才算数，其余一律回到"每次问我"。
// 缺键回 ask 是默认档；脏值也回 ask——脏值悄悄变成"不锁"或"立即锁"都会让人
// 以为按了另一个意思的钮，问一句最坏也就是多问一句。

import { describe, expect, it } from "vitest";
import { lockAfterMarkFrom } from "@/data/lock-after-mark";

describe("标记私密后的锁档", () => {
  it("明写的 never / now 照收", () => {
    expect(lockAfterMarkFrom("never")).toBe("never");
    expect(lockAfterMarkFrom("now")).toBe("now");
  });

  it.each([[null], [""], ["ask"], ["ASK"], ["ask "], ["yes"], ["0"], ["now now"]])(
    "脏值 %s 回到每次问我",
    (stored) => {
      expect(lockAfterMarkFrom(stored)).toBe("ask");
    },
  );
});
