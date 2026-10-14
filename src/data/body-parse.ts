// 正文识别 — 把纯文本切成代码、图片、链接，其余是文本。住 data/ 而非组件里：识别口径一份真相，
// 渲染/搜索/导出都问它。字符串进、段出，不认 React/IPC，能穷举单测。口径三条（用例钉着）：
//  · 代码优先于一切：围栏/行内码里的 URL 只是字面文本。未闭合围栏按"到结尾都是代码"算——
//    用户正打着第三行，不该看到它先被认成句子。
//  · href 只放 http/https：javascript:/data:/file: 退回普通文本——字是用户敲的不代表可以被点成执行。
//  · 图片两来源差别对待：media://<id> 从库里取字节；远程图**不自动加载**（CSP 是
//    `img-src 'self' data: blob:`，放开等于让便签拿用户 IP 敲陌生服务器），给成芯片走系统浏览器。

/** 一段正文切出来的结果。`text` 之外的段由渲染层单独画 */
export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "code"; code: string; lang: string | null; block: boolean }
  | { kind: "link"; href: string; text: string }
  /** 图片引用。local = media:// 本机图库；false = 远程链接（只出芯片，不加载） */
  | { kind: "image"; src: string; alt: string; local: boolean };

/**
 * 本机图库引用的形状。与 Rust 侧 `support::id::media()` 一字不差（`m` + 毫秒/序号的十六进制）
 * ——两边形状对不上，粘进去的图就永远认不出来。长度区间：序号位数会变。
 */
const MEDIA_REF = /^media:\/\/(m[0-9a-f]{8,24})$/;

/**
 * 裸 URL 的字符集：空白/引号/尖括号/成对括号/中文标点都不算地址的一部分。ASCII 括号也排除——
 * 换过来的是"详见 https://a.b（官网）"不把后半句吃进链接；宁可地址短一截，不把他打的字变成链接。
 */
const URL_CHAR = String.raw`[^\s<>"'()（）【】「」，。；！？、,;:!]`;

/**
 * 一次扫描五类记号。顺序即优先级：围栏 → 行内码 → 图 → 链 → 裸 URL。嵌套一律不做。
 */
const TOKENS = new RegExp(
  [
    "```([\\w+-]*)[ \\t]*\\n([\\s\\S]*?)```",
    "|`([^`\\n]+)`",
    "|!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)",
    "|\\[([^\\]]*)\\]\\(([^)\\s]+)\\)",
    `|(https?:\\/\\/${URL_CHAR}+)`,
  ].join(""),
  "g",
);

/** 围栏行的开头（行首三个反引号）。成对正则吃不掉"只开了头没收尾"的那一个，靠它数 */
const FENCE_LINES = /^```[ \t]*[\w+-]*[ \t]*$/gm;

/** 只放行 http/https。返回 null = 这个"看着像链接"的东西按普通文本渲染 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return trimmed;
  return null;
}

/**
 * 把人打的地址收成能用的：没写协议补 https://（"example.com" 十有八九是这个意思），
 * 补完仍过 `safeHref`（`javascript:`、`data:`、`file:` 全在这挡）。
 */
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return safeHref(withScheme);
}

export type LinkWrapResult = { ok: true; body: string } | { ok: false; reason: string };

/**
 * 把正文 [start, end) 包成 `[原文](地址)`，当场判掉"写进去还能认得出来"的规矩：
 * 选中带 `]` 会断 markdown、地址带空格或 `)` 会把 `(...)` 半边切坏（TOKENS 那条是 `[^)\s]+`）、
 * 包完超长就不写（与粘图同口径：**放不下就说放不下，不偷偷截**）。区间来自 `parseBodySpans`，不是渲染后字数。
 */
export function wrapLink(
  body: string,
  start: number,
  end: number,
  rawUrl: string,
  max: number,
): LinkWrapResult {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, reason: "没找准选中在正文里的位置" };
  }
  if (start < 0 || end > body.length || start >= end) {
    return { ok: false, reason: "选中的范围对不上正文" };
  }
  const selected = body.slice(start, end);
  if (selected.trim() === "") return { ok: false, reason: "选中的是空白，包不成链接" };
  if (selected.includes("]")) {
    return { ok: false, reason: "选中里有右方括号，包出来会断，先去掉再试" };
  }
  const url = normalizeLinkUrl(rawUrl);
  if (url === null) return { ok: false, reason: "这个地址开不了（只认 http/https）" };
  if (/[\s()]/.test(url)) {
    return { ok: false, reason: "地址里有空格或括号，先换成能用的地址" };
  }
  const next = `${body.slice(0, start)}[${selected}](${url})${body.slice(end)}`;
  if (next.length > max) {
    return { ok: false, reason: `正文放不下（超 ${next.length - max} 个字）` };
  }
  return { ok: true, body: next };
}

/** media://<id> 里的 id；不是本机图库引用就返回 null */
export function mediaIdOf(src: string): string | null {
  const hit = MEDIA_REF.exec(src.trim());
  return hit === null ? null : hit[1];
}

/**
 * 一句图引用的**最坏长度**。粘图前先按它腾地方——腾不出来当场说"正文放不下"，
 * 而不是把几 MB 字节存进库再发现引用写不进去。
 */
export const MEDIA_REF_BUDGET = 64;

/**
 * 造一句本机图引用，与 `mediaIdOf` 同一条形状（写进去的与认得出的不会对不上）。
 * alt 里 `]` `[` 与换行会切坏 markdown，一律换成空格。
 */
export function mediaRef(id: string, name: string): string {
  const alt = name
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[\][\r\n]/g, " ")
    .trim()
    .slice(0, 20);
  return `![${alt === "" ? "图片" : alt}](media://${id})`;
}

/**
 * 把正文折成"念给人听的一句话"（只给 aria-label 用，不改正文）：
 * 直接塞 `![截图](media://m…)` 会被读屏念成一串符号——那是把内部格式端到用户耳朵里。
 */
export function plainPreview(text: string, max = 24): string {
  const flat = text
    .replace(/!\[[^\]]*\]\(media:\/\/[^)\s]+\)/g, "图片")
    .replace(/!\[[^\]]*\]\([^)\s]+\)/g, "图片")
    .replace(/\[([^\]]*)\]\([^)\s]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 把某张图的引用从正文里摘掉（删图时连带删那句引用）。没有这句就原样返回 */
export function withoutMediaRef(body: string, id: string): string {
  const pattern = new RegExp(`!?\\[[^\\]\\n]*\\]\\(media:\\/\\/${id}\\)\\n?`, "g");
  return body.replace(pattern, "").trim();
}

function pushText(out: BodySpan[], text: string, start: number): void {
  if (text === "") return;
  const end = start + text.length;
  const last = out[out.length - 1];
  // 相邻文本段并一块：渲染层少一堆无意义的 span（区间跟着两头扩，别留第二份真相）
  if (last !== undefined && last.segment.kind === "text") {
    out[out.length - 1] = {
      segment: { kind: "text", text: last.segment.text + text },
      start: last.start,
      end,
    };
    return;
  }
  out.push({ segment: { kind: "text", text }, start, end });
}

function push(out: BodySpan[], segment: BodySegment, start: number, end: number): void {
  out.push({ segment, start, end });
}

/** 最后一个没配对的围栏行的下标；全是成对（或根本没有）就返回 -1 */
function danglingFenceAt(body: string): number {
  const starts: number[] = [];
  FENCE_LINES.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_LINES.exec(body)) !== null) starts.push(match.index);
  // 奇数个围栏行 = 最后一个没收尾。偶数个都在成对的那条里被吃掉了
  return starts.length % 2 === 1 ? starts[starts.length - 1] : -1;
}

/** 围栏行首行里的语言名（```ts → "ts"），没写或不认识就 null */
function fenceLang(fenceLine: string): string | null {
  const hit = /^```([\w+-]*)[ \t]*$/.exec(fenceLine);
  if (hit === null) return null;
  return hit[1] === "" ? null : hit[1];
}

/** 一段识别结果 + 它在**原文**里的区间。区间是 `[start, end)`。 */
export interface BodySpan {
  segment: BodySegment;
  start: number;
  end: number;
}

/**
 * 切正文并**保住每段的原文区间**。"选中了正文哪几个字"只能靠它：渲染出来的字数和原文
 * 不是一回事（一张图画出来只占一格，原文 28 个字）。区间只在此处算一次，别处不许再推。
 */
export function parseBodySpans(body: string): BodySpan[] {
  const out: BodySpan[] = [];
  if (body === "") return out;

  const dangling = danglingFenceAt(body);
  const scannable = dangling === -1 ? body : body.slice(0, dangling);
  scan(scannable, out);

  if (dangling !== -1) {
    const rest = body.slice(dangling);
    const newline = rest.indexOf("\n");
    const fenceLine = newline === -1 ? rest : rest.slice(0, newline);
    push(
      out,
      {
        kind: "code",
        code: newline === -1 ? "" : rest.slice(newline + 1),
        lang: fenceLang(fenceLine),
        block: true,
      },
      dangling,
      body.length,
    );
  }
  return out;
}

/**
 * 切正文。认不出的写法一律原样留成文本，绝不吞字：识别失败的代价必须是"看不出图"，
 * 不能是"我的字没了"。
 */
export function parseBody(body: string): BodySegment[] {
  return parseBodySpans(body).map((span) => span.segment);
}

function scan(body: string, out: BodySpan[]): void {
  TOKENS.lastIndex = 0;
  let cursor = 0;
  let hit: RegExpExecArray | null;
  while ((hit = TOKENS.exec(body)) !== null) {
    const at = hit.index;
    pushText(out, body.slice(cursor, at), cursor);
    cursor = at + hit[0].length;
    const [, lang, blockCode, inlineCode, imgAlt, imgSrc, linkText, linkHref, bare] = hit;
    if (lang !== undefined) {
      push(
        out,
        {
          kind: "code",
          code: (blockCode ?? "").replace(/\n$/, ""),
          lang: lang === "" ? null : lang,
          block: true,
        },
        at,
        cursor,
      );
    } else if (inlineCode !== undefined) {
      push(out, { kind: "code", code: inlineCode, lang: null, block: false }, at, cursor);
    } else if (imgAlt !== undefined) {
      const src = (imgSrc ?? "").trim();
      const id = mediaIdOf(src);
      const remote = safeHref(src);
      if (id !== null) {
        push(out, { kind: "image", src, alt: imgAlt, local: true }, at, cursor);
      } else if (remote !== null) {
        push(out, { kind: "image", src: remote, alt: imgAlt, local: false }, at, cursor);
      } else {
        pushText(out, hit[0], at); // 不安全协议塞在 ![]() 里：整串原样退回文本
      }
    } else if (linkText !== undefined) {
      const href = safeHref((linkHref ?? "").trim());
      if (href === null) {
        pushText(out, hit[0], at);
      } else {
        push(
          out,
          { kind: "link", href, text: linkText === "" ? href : linkText },
          at,
          cursor,
        );
      }
    } else if (bare !== undefined) {
      // 尾巴上的标点不算地址的一部分（"…见 https://a.b/c." 那个句号）
      const url = bare.replace(/[.,;:!?]+$/, "");
      push(out, { kind: "link", href: url, text: url }, at, at + url.length);
      pushText(out, bare.slice(url.length), at + url.length);
    }
  }
  pushText(out, body.slice(cursor), cursor);
}
