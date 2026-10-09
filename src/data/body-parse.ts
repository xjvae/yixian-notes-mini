// 正文识别 — 把一段纯文本切成"能看出来的东西"：代码、图片、链接，其余是文本。
//
// 为什么住在 data/ 而不是组件里：识别口径是一份真相。正文渲染（便签）、搜索片段、
// 以后的导出都要问它；散在组件里就是每处各写一遍正则，迟早对不上。
// 这一层不认 React、不认图标、不认 IPC：字符串进、段出，所以能穷举单测。
//
// 口径三条（都有用例钉着）：
//  · 代码优先于一切：``` 围栏里出现 URL 就只是 URL 的字面文本，行内 `x` 同理。
//    未闭合的围栏按"到结尾都是代码"算——用户正打着第三行，不该看到它先被认成句子。
//  · href 只放 http/https 过。javascript: / data: / file: 一律退回普通文本：
//    便签上的字是用户自己敲的，但这不代表它可以被点成一次执行。
//  · 图片两种来源差别对待：media://<id> 是本机图库（字节从库里取，见 media 表），
//    http(s) 的图**不自动加载**——CSP 是 `img-src 'self' data: blob:`
//    （tauri.conf.json:21），放开它等于让任何一张便签拿用户的 IP 去敲陌生服务器。
//    于是远程图给成一枚"图片链接"芯片，点开走系统浏览器。

/** 一段正文切出来的结果。`text` 之外的段由渲染层单独画 */
export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "code"; code: string; lang: string | null; block: boolean }
  | { kind: "link"; href: string; text: string }
  /** 图片引用。local = media:// 本机图库；false = 远程链接（只出芯片，不加载） */
  | { kind: "image"; src: string; alt: string; local: boolean };

/**
 * 本机图库引用的形状。`m` 前缀 + 十六进制尾巴，与 Rust 侧 `support::id::media()`
 * 一字不差（那条是 `format!("m{:x}{:x}", 毫秒, 序号)`）——两边形状对不上，
 * 粘进去的图就永远认不出来。长度给个区间：序号位数会变。
 */
const MEDIA_REF = /^media:\/\/(m[0-9a-f]{8,24})$/;

/**
 * 裸 URL 的字符集：空白、引号、尖括号、成对括号与中文标点都不算地址的一部分。
 * ASCII 括号也一并排除——`https://a.b/x_(y)` 这种地址会少截尾巴，换过来的是
 * "详见 https://a.b（官网）"不把后半句话吃进链接。宁可地址短一截，
 * 也不该把他打的字变成链接的一部分。
 */
const URL_CHAR = String.raw`[^\s<>"'()（）【】「」，。；！？、,;:!]`;

/**
 * 一次扫描五类记号。顺序即优先级：围栏 → 行内码 → 图 → 链 → 裸 URL。
 * 嵌套一律不做（链接文字里再套行内码这种）：认得越少越不会把用户的话切错。
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
 * 把人打的地址收成能用的那一种：没写协议就补 https://（"example.com" 十有八九是这个意思），
 * 补完仍过 `safeHref`。返回 null = 这个地址开不了（`javascript:`、`data:`、`file:` 全在这挡）。
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
 * 把正文里 `[start, end)` 这一段包成 `[原文](地址)`。人只在右键里填一个地址，
 * 剩下这些"写进去还能认得出来"的规矩由这里当场判掉：
 *  · 区间必须真落在正文里、选中不能是空白；
 *  · 选中里带 `]` 就到此为止——markdown 那句会从这里断开，包出来的是半截链接半截字
 *    （与其产出一个认不出来的东西，不如明说为什么不做）；
 *  · 地址过 `normalizeLinkUrl`：协议只认 http/https，带空格或 `)` 的地址会把
 *    `(...)` 那半边切坏（TOKENS 里那条是 `[^)\s]+`），一律不收；
 *  · 包完超长就不写（与粘图同一条口径：**放不下就说放不下，不偷偷截**。用户看不见
 *    地被裁掉一段话，比拒一次严重得多）。
 * 区间来自 `parseBodySpans`，不能是渲染后的字数——那是另一个数。
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
 * 一句图片引用的**最坏长度**（`![alt](media://m…)` 加前后各一个换行）。
 * 正文有 BODY_MAX 字上限，粘图之前要按它先腾地方——腾不出来就当场说"正文放不下"，
 * 而不是先把几 MB 字节存进库、再发现那句引用写不进去。
 */
export const MEDIA_REF_BUDGET = 64;

/**
 * 造一句本机图引用。与 `mediaIdOf` 同一条形状，所以"写进去的"与"认得出的"
 * 不会哪天对不上。alt 里 `]` `[` 与换行会切坏 markdown，一律换成空格。
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
 * 把正文折成"念给人听的一句话"：图片引用换成「图片」，链接留文字。
 * aria-label 里直接塞 `![截图](media://m…)` 会被读屏念成一串符号——那是把内部格式
 * 端到了用户耳朵里。只给标签用，不改正文本身。
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
 * 切正文并**保住每段的原文区间**。"选中了正文里的哪几个字"这件事只能靠它：
 * 渲染出来的字数和原文不是一回事（`![名](media://m…)` 画成一张图，原文占 28 个字），
 * 拿渲染文本反推就会把链接包错位置。区间只在此处算一次，别处不许再推。
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
 * 切正文。空串返回空数组（渲染层据此出占位）。
 * 认不出的写法一律原样留成文本，绝不吞字：识别失败的代价必须是"看不出图"，
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
