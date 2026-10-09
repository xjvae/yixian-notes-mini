import { describe, expect, it } from "vitest";
import {
  MEDIA_REF_BUDGET,
  mediaIdOf,
  mediaRef,
  parseBody,
  parseBodySpans,
  plainPreview,
  safeHref,
  withoutMediaRef,
  wrapLink,
} from "@/data/body-parse";
import type { BodySegment } from "@/data/body-parse";

/** 段的形状序列，读断言时一眼看出"切成了什么" */
function shape(body: string): string[] {
  return parseBody(body).map((segment: BodySegment) =>
    segment.kind === "code" ? `code:${segment.block ? "块" : "内"}` : segment.kind,
  );
}

function links(body: string): [string, string][] {
  return parseBody(body)
    .filter((s): s is Extract<BodySegment, { kind: "link" }> => s.kind === "link")
    .map((s) => [s.href, s.text]);
}

function images(body: string): [string, boolean][] {
  return parseBody(body)
    .filter((s): s is Extract<BodySegment, { kind: "image" }> => s.kind === "image")
    .map((s) => [s.src, s.local]);
}

describe("safeHref", () => {
  it("只放 http/https 过，大小写都认", () => {
    expect(safeHref("https://a.b/c")).toBe("https://a.b/c");
    expect(safeHref("HTTP://a.b")).toBe("HTTP://a.b");
    expect(safeHref("  https://a.b  ")).toBe("https://a.b");
  });

  it("javascript: / data: / file: 一律不算链接", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("file:///C:/Windows/win.ini")).toBeNull();
  });
});

describe("mediaIdOf", () => {
  /// 形状必须与 Rust 侧 `support::id::media()`（`m` + 十六进制）对得上：
  /// 两边各写一套形状，粘进去的图就永远认不出来
  it("m 前缀 + 8~24 位小写十六进制才算本机图库", () => {
    expect(mediaIdOf("media://m18e3f2a1b2c0d")).toBe("m18e3f2a1b2c0d");
    expect(mediaIdOf("media://m0123456789ab")).toBe("m0123456789ab");
    expect(mediaIdOf("media://18e3f2a1b2c0d")).toBeNull();
    expect(mediaIdOf("media://m18e3f2")).toBeNull();
    expect(mediaIdOf("media://m18e3F2a1b2c0d")).toBeNull();
    expect(mediaIdOf("media://m18e3f2a1b2c0dffffffffffffffffffff")).toBeNull();
    expect(mediaIdOf("https://a.b/x.png")).toBeNull();
  });
});

describe("parseBody 基本形状", () => {
  it("空正文一段都没有（渲染层据此出占位）", () => {
    expect(parseBody("")).toEqual([]);
  });

  it("纯文本原样，换行不丢", () => {
    expect(parseBody("第一行\n第二行")).toEqual([
      { kind: "text", text: "第一行\n第二行" },
    ]);
  });

  it("相邻文本并成一段，不留空段", () => {
    const segments = parseBody("买 `x` 和 y");
    expect(segments.filter((s) => s.kind === "text").every((s) => s.text !== "")).toBe(
      true,
    );
    expect(shape("买 `x` 和 y")).toEqual(["text", "code:内", "text"]);
  });
});

describe("parseBody 链接", () => {
  it("裸 URL 成链，中文括号与句点不吃进地址", () => {
    expect(links("详见 https://a.b/c（官网）")).toEqual([
      ["https://a.b/c", "https://a.b/c"],
    ]);
    expect(links("地址是 https://a.b/c.")).toEqual([["https://a.b/c", "https://a.b/c"]]);
    expect(shape("详见 https://a.b/c（官网）")).toEqual(["text", "link", "text"]);
  });

  it("markdown 链接用文字，空文字回落地址", () => {
    expect(links("[官网](https://a.b)")).toEqual([["https://a.b", "官网"]]);
    expect(links("[](https://a.b)")).toEqual([["https://a.b", "https://a.b"]]);
  });

  it("不安全协议整串退回文本，一个字都不吞", () => {
    const body = "[点我](javascript:alert(1))";
    expect(parseBody(body)).toEqual([{ kind: "text", text: body }]);
    expect(shape("![x](data:text/html,hi)")).toEqual(["text"]);
  });
});

describe("parseBody 代码", () => {
  it("围栏块带语言，块里的 URL 只是字面文本", () => {
    const segments = parseBody('```ts\nconst a = "https://a.b";\n```');
    expect(segments).toEqual([
      { kind: "code", code: 'const a = "https://a.b";', lang: "ts", block: true },
    ]);
  });

  it("围栏不写语言、结尾换行不吃进代码", () => {
    expect(parseBody("```\nls -al\n```")).toEqual([
      { kind: "code", code: "ls -al", lang: null, block: true },
    ]);
  });

  it("只开了围栏还没收尾：到结尾都算代码（用户正打第三行）", () => {
    const segments = parseBody("前话\n```py\nprint(1)\nhttps://a.b");
    expect(shape("前话\n```py\nprint(1)\nhttps://a.b")).toEqual(["text", "code:块"]);
    expect(segments[1]).toEqual({
      kind: "code",
      code: "print(1)\nhttps://a.b",
      lang: "py",
      block: true,
    });
    expect(segments[0]).toEqual({ kind: "text", text: "前话\n" });
  });

  it("行内码成块，跨行的两个反引号不算", () => {
    expect(shape("用 `npm run dev` 起")).toEqual(["text", "code:内", "text"]);
    expect(shape("两个反引号跨\n`x`\n行也算")).toEqual(["text", "code:内", "text"]);
    expect(shape("没有配对的一个 ` 反引号")).toEqual(["text"]);
  });
});

describe("parseBody 图片", () => {
  it("media:// 是本机图，http 是远程芯片", () => {
    expect(images("![截图](media://m0123456789ab)")).toEqual([
      ["media://m0123456789ab", true],
    ]);
    expect(images("![网图](https://a.b/x.png)")).toEqual([["https://a.b/x.png", false]]);
  });

  it("id 形状不对的 media 引用按文本处理", () => {
    expect(shape("![x](media://tooshort)")).toEqual(["text"]);
  });

  it("图与文字混排按出现顺序切", () => {
    expect(shape("看图 ![a](media://m0123456789ab) 完了 https://a.b")).toEqual([
      "text",
      "image",
      "text",
      "link",
    ]);
  });
});

describe("mediaRef / withoutMediaRef", () => {
  it("造出来的引用自己认得回来（写与认是同一条形状）", () => {
    const ref = mediaRef("m0123456789ab", "截图.png");
    expect(ref).toBe("![截图](media://m0123456789ab)");
    expect(shape(ref)).toEqual(["image"]);
    expect(mediaIdOf(ref.slice(ref.indexOf("(") + 1, ref.length - 1))).toBe(
      "m0123456789ab",
    );
  });

  it("alt 里会切坏 markdown 的字符换成空格，空 alt 回落「图片」", () => {
    expect(mediaRef("m0123456789ab", "a]b\nc.png")).toBe(
      "![a b c](media://m0123456789ab)",
    );
    expect(mediaRef("m0123456789ab", ".png")).toBe("![图片](media://m0123456789ab)");
    expect(mediaRef("m0123456789ab", "")).toBe("![图片](media://m0123456789ab)");
  });

  it("引用预算装得下最长的一句（正文腾地方按它算）", () => {
    const longest = mediaRef(`m${"f".repeat(24)}`, "字".repeat(20));
    expect(longest.length).toBeLessThanOrEqual(MEDIA_REF_BUDGET);
  });

  it("删图把那句引用一起摘掉，不留一行空壳", () => {
    expect(
      withoutMediaRef("前话\n![截图](media://m0123456789ab)\n后话", "m0123456789ab"),
    ).toBe("前话\n后话");
    expect(withoutMediaRef("![a](media://m0123456789ab)", "m0123456789ab")).toBe("");
    expect(withoutMediaRef("没有引用的正文", "m0123456789ab")).toBe("没有引用的正文");
    // 只摘这一张：另一张的引用一个字都不动
    const two = "![a](media://m0123456789ab)\n![b](media://m9999999999ab)";
    expect(withoutMediaRef(two, "m0123456789ab")).toBe("![b](media://m9999999999ab)");
  });
});

describe("plainPreview", () => {
  it("图说成「图片」、链接留文字——给 aria-label 用，不把内部格式念给人听", () => {
    expect(plainPreview("看图 ![截图](media://m0123456789ab) 完了")).toBe(
      "看图 图片 完了",
    );
    expect(plainPreview("[官网](https://a.b) 值得看")).toBe("官网 值得看");
    expect(plainPreview("远程图 ![x](https://a.b/y.png)")).toBe("远程图 图片");
  });

  it("换行折成空格、超长截断、空串还是空", () => {
    expect(plainPreview("第一行\n第二行")).toBe("第一行 第二行");
    expect(plainPreview("字".repeat(40))).toBe(`${"字".repeat(24)}…`);
    expect(plainPreview("   \n  ")).toBe("");
  });
});

describe("parseBodySpans 保住原文区间", () => {
  it("纯文本：区间就是它自己", () => {
    expect(parseBodySpans("abc")).toEqual([
      { segment: { kind: "text", text: "abc" }, start: 0, end: 3 },
    ]);
  });

  it("链接那一段的区间含语法字符（这就是不能拿渲染字数反推的原因）", () => {
    const spans = parseBodySpans("看 https://a.b 完");
    expect(spans.map((s) => [s.segment.kind, s.start, s.end])).toEqual([
      ["text", 0, 2],
      ["link", 2, 13],
      ["text", 13, 15],
    ]);
  });

  it("裸 URL 尾巴上的标点不算地址的一部分，但那几个字仍要有区间", () => {
    const spans = parseBodySpans("见 https://a.b.");
    expect(
      spans.map((s) => [
        s.segment.kind,
        s.start,
        s.end,
        s.segment.kind === "link" ? s.segment.href : undefined,
      ]),
    ).toEqual([
      ["text", 0, 2, undefined],
      ["link", 2, 13, "https://a.b"],
      ["text", 13, 14, undefined],
    ]);
  });

  it("那句图引用整段算一个区间，画出来是一张图但原文占一整串", () => {
    const ref = mediaRef("m1a2b3c4d5", "截图.png");
    const spans = parseBodySpans(ref);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.start).toBe(0);
    expect(spans[0]?.end).toBe(ref.length);
    expect(spans[0]?.segment.kind).toBe("image");
  });

  it("每个字符都恰好落在某一段里（区间加起来就是整篇正文）", () => {
    const body =
      "前 `npm i` 中 [官网](https://a.b) 后 https://c.d\n```ts\nconst a = 1\n```";
    const spans = parseBodySpans(body);
    expect(spans[0]?.start).toBe(0);
    expect(spans.at(-1)?.end).toBe(body.length);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]?.start).toBe(spans[i - 1]?.end);
    }
  });

  it("没收尾的围栏也算到正文结尾", () => {
    const body = "字\n```py\nprint(1)";
    const spans = parseBodySpans(body);
    expect(spans.at(-1)?.end).toBe(body.length);
  });
});

describe("wrapLink 把选中包成链接", () => {
  const MAX = 5000;

  it("没写协议就补 https://，包完还能被认回一条链接", () => {
    const out = wrapLink("visit x now", 6, 7, "example.com/a", MAX);
    expect(out.ok && out.body).toBe("visit [x](https://example.com/a) now");
    expect(parseBody(out.ok ? out.body : "")).toContainEqual({
      kind: "link",
      href: "https://example.com/a",
      text: "x",
    });
  });

  it("整段选中（跨好几个字）照样只包那一段，前后的字不动", () => {
    const out = wrapLink("一二三", 0, 3, "https://a.b", MAX);
    expect(out.ok && out.body).toBe("[一二三](https://a.b)");
  });

  it("右方括号会把那句切坏：不做，并说清为什么", () => {
    expect(wrapLink("a]b", 0, 3, "https://a.b", MAX)).toEqual({
      ok: false,
      reason: "选中里有右方括号，包出来会断，先去掉再试",
    });
  });

  it("只认 http/https：javascript: 与 data: 一律不写", () => {
    expect(wrapLink("abc", 0, 3, "javascript:alert(1)", MAX)).toEqual({
      ok: false,
      reason: "这个地址开不了（只认 http/https）",
    });
    expect(wrapLink("abc", 0, 3, "data:text/html,x", MAX).ok).toBe(false);
  });

  it("地址里有空格或括号会把 (...) 那半边切坏：也不写", () => {
    expect(wrapLink("abc", 0, 3, "https://a.b/c d", MAX).ok).toBe(false);
    expect(wrapLink("abc", 0, 3, "https://a.b/c(1)", MAX).ok).toBe(false);
  });

  it("空白选中与对不上的区间都不写", () => {
    expect(wrapLink("a b", 1, 2, "https://a.b", MAX).ok).toBe(false);
    expect(wrapLink("abc", 2, 2, "https://a.b", MAX).ok).toBe(false);
    expect(wrapLink("abc", 1, 99, "https://a.b", MAX).ok).toBe(false);
    expect(wrapLink("abc", 0.5, 2, "https://a.b", MAX).ok).toBe(false);
  });

  it("放不下就不写，并报超了几个字（不偷偷裁用户的正文）", () => {
    const body = "字".repeat(10);
    // 包完是 [字](https://a.b) + 9 个"字" = 25 个字；上限给 20 就是超 5，给 25 就正好写得下
    expect(wrapLink(body, 0, 1, "https://a.b", 20)).toEqual({
      ok: false,
      reason: "正文放不下（超 5 个字）",
    });
    expect(wrapLink(body, 0, 1, "https://a.b", 25).ok).toBe(true);
  });
});
