// RichText — 把一段文字**按识别结果**画出来：链接可点、代码等宽、图出缩略。
//
// 这一层是"画法"，不是"壳"：不带滚动、不带光标、不管编辑态。所以正文（阅读态）、
// 清单条目、时间轴条目可以共用同一份 —— 识别口径在 data/body-parse.ts 只有一处，
// 画法在这里只有一处。哪天再加一档（比如搜索片段要出图），也是接这一份而不是再抄一遍。
//
// 三条画法上的口径（与 body-parse 的头注释一对）：
//  · 链接是 `<a href>`（href 已由 safeHref 挡过协议）+ onClick 交给 openExternal：
//    语义与键盘可达性都留着，真开浏览器由平台层决定；
//  · 远程图**不加载**：CSP 的 img-src 不放 https（tauri.conf.json:21），放开等于让
//    任何一张便签拿用户的 IP 去敲陌生服务器。这里画一枚芯片，点它才开浏览器；
//  · 本机图（media://）从库里取字节，取不到分三种说：没解锁 / 库里没这行 / 读失败。
//
// **凡是这一层画出来的人话文字，都带 `select-text`**：窗体那层是 `select-none`
// （拖窗不该把整屏字都涂蓝），它一路继承进来，正文与条目就变成"根本选不中"——
// 真机报的"选中文字右键还是无效"第一层根因就在这儿：拖不出选区，右键自然没有
// "把选中变成链接"。 selectable 归 selectable 的事跟着**画法**走，别在每个外壳上
// 各补一次（漏一个外壳就是同一个 bug 再来一遍）。

const SELECTABLE = "select-text";

import { X } from "lucide-react";
import { parseBodySpans } from "@/data/body-parse";
import type { BodySegment } from "@/data/body-parse";
import { mediaIdOf } from "@/data/body-parse";
import { openExternal } from "@/platform/open-link";
import { useMedia } from "@/features/sticky/use-media";
import { logger } from "@/platform/logger";

const SCOPE = "rich-text";

export interface RichTextProps {
  body: string;
  ink: string;
  accent: string;
  /** 传了才在本机图下面给一个"删掉这张图"（正文里有，清单条目里没有） */
  onDeleteImage?: (id: string) => void;
}

export function RichText({ body, ink, accent, onDeleteImage }: RichTextProps) {
  return (
    <>
      {parseBodySpans(body).map((span, index) => (
        <Segment
          key={`${index}-${span.segment.kind}`}
          segment={span.segment}
          start={span.start}
          end={span.end}
          ink={ink}
          accent={accent}
          onDeleteImage={onDeleteImage}
        />
      ))}
    </>
  );
}

function Segment({
  segment,
  start,
  end,
  ink,
  accent,
  onDeleteImage,
}: {
  segment: BodySegment;
  /** 这一段在正文里的原文区间，写在 DOM 上给右键选中文本用（见 data/body-parse.ts） */
  start: number;
  end: number;
  ink: string;
  accent: string;
  onDeleteImage?: (id: string) => void;
}) {
  switch (segment.kind) {
    case "text":
      // 只有纯文本带区间：链接/代码/图的区间含着 `[]()` 那些语法字符，
      // 拿它们包链接会把语法一起裹进去，所以那几类压根不给"变成链接"
      return (
        <span className={SELECTABLE} data-start={start} data-end={end}>
          {segment.text}
        </span>
      );

    case "code":
      return segment.block ? (
        <CodeBlock code={segment.code} lang={segment.lang} ink={ink} />
      ) : (
        <code
          className={`${SELECTABLE} rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[12px]`}
          style={{ color: ink }}
        >
          {segment.code}
        </code>
      );

    case "link":
      return (
        <a
          href={segment.href}
          data-seg="link"
          data-href={segment.href}
          onClick={(event) => {
            // webview 里 target=_blank 被拦，交给 opener 才真打得开
            event.preventDefault();
            event.stopPropagation();
            void openExternal(segment.href).catch((error: unknown) =>
              logger.caught(SCOPE, "打开链接失败", error),
            );
          }}
          className={`break-all underline decoration-dotted underline-offset-2 hover:opacity-70 ${SELECTABLE}`}
          style={{ color: accent }}
        >
          {segment.text}
        </a>
      );

    case "image":
      return segment.local ? (
        <LocalImage
          id={mediaIdOf(segment.src) ?? ""}
          alt={segment.alt}
          ink={ink}
          accent={accent}
          onDelete={onDeleteImage}
        />
      ) : (
        <RemoteImageChip url={segment.src} alt={segment.alt} ink={ink} accent={accent} />
      );
  }
}

function CodeBlock({
  code,
  lang,
  ink,
}: {
  code: string;
  lang: string | null;
  ink: string;
}) {
  return (
    <pre
      className={`my-1 w-full overflow-x-auto rounded-md bg-black/[0.05] p-2 font-mono text-[12px] leading-snug ${SELECTABLE}`}
      style={{ color: ink }}
    >
      {lang !== null && (
        <span className="mb-1 block text-[10px] uppercase opacity-45">{lang}</span>
      )}
      <code>{code}</code>
    </pre>
  );
}

/** 正文里那句引用对应的图。取字节这件事整个应用只在这一处问库 */
function LocalImage({
  id,
  alt,
  ink,
  accent,
  onDelete,
}: {
  id: string;
  alt: string;
  ink: string;
  accent: string;
  onDelete?: (id: string) => void;
}) {
  const media = useMedia(id);

  const shell = "my-1 flex w-full flex-col items-start gap-0.5";
  if (media.state === "loading") {
    return (
      <span className={`${shell} text-[11px] opacity-45`} style={{ color: ink }}>
        读图…
      </span>
    );
  }
  if (media.state === "locked") {
    // 到这儿的机会很窄，但不是零：便签本身没遮罩（所以渲染得到这里）而它名下某张图仍是
    // 密文 —— 就是"取消私密时把图搬回明文那一步失败了"（note-content 里那条日志）。
    // 反过来做（当普通碎图显示）就把一次部分失败说成了图坏了
    return (
      <span
        className={`${shell} rounded-md border border-dashed px-2 py-3 text-[11px]`}
        style={{ color: ink, borderColor: "rgba(0,0,0,0.2)" }}
      >
        这张图解不开（私密便签，解锁后才看得到）
      </span>
    );
  }
  if (media.state !== "ok" || media.url === null) {
    return (
      <span className={`${shell} text-[11px] opacity-45`} style={{ color: ink }}>
        {media.state === "error"
          ? (media.message ?? "这张图读不出来")
          : "这张图已经不在库里了"}
      </span>
    );
  }
  return (
    <span className={shell}>
      <img
        src={media.url}
        alt={alt}
        title={alt}
        loading="lazy"
        data-seg="image"
        data-media={id}
        className="max-h-[240px] w-auto max-w-full rounded-md border border-black/10 object-contain"
        style={{ boxShadow: `0 0 0 1px ${accent}22` }}
      />
      {onDelete !== undefined && (
        <button
          type="button"
          aria-label={`删掉这张图${alt === "" ? "" : `「${alt}」`}`}
          title="删掉这张图（连同正文里那句引用）"
          onClick={(event) => {
            // 别把这一下漏给外层"进编辑态"：删图不是一个想改字的动作
            event.stopPropagation();
            onDelete(id);
          }}
          className="flex items-center gap-0.5 self-end text-[10px] opacity-40 transition-opacity hover:opacity-100"
          style={{ color: ink }}
        >
          <X size={10} aria-hidden />
          删掉这张图
        </button>
      )}
    </span>
  );
}

/** 远程图：一枚芯片，点它才开浏览器（不替用户去敲陌生服务器） */
function RemoteImageChip({
  url,
  alt,
  ink,
  accent,
}: {
  url: string;
  alt: string;
  ink: string;
  accent: string;
}) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // safeHref 只放过 http/https，这里到不了；真到了就原样显示整串
  }
  return (
    <a
      href={url}
      data-seg="remote-image"
      data-href={url}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void openExternal(url).catch((error: unknown) =>
          logger.caught(SCOPE, "打开图片链接失败", error),
        );
      }}
      title={`${url}\n（不自动加载，点了才在浏览器里打开）`}
      className={`my-1 inline-flex max-w-full items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] ${SELECTABLE}`}
      style={{ color: ink, borderColor: `${accent}66` }}
    >
      <span className="opacity-60">图片链接</span>
      <span className="truncate">{alt === "" ? host : alt}</span>
    </a>
  );
}
