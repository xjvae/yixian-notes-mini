// 自动尺寸的算术 — "这张便签该多大"的**唯一**一处判定，纯函数（不碰 DOM、不碰 IPC）。
//
// 为什么单独拎出来：这条链上最容易出事的就是"量到什么算成什么"——上限、下限、
// 图没解码、还没布局就被量了一次，每一个都得有明确说法。写成纯函数才能把这些
// 情况全枚举进用例，而不是等真机上撞见。
//
// 高 = 当前窗高 − 正文可视高 + 正文自然高（差值法：壳体里除了正文那一格全是 shrink-0，
// 所以"正文要多高"直接换算成"窗要多高"，不必另抄一份标题条/页脚的高度）。
// 宽 = 最宽那张图**渲染后**的宽 + 左右内边距。为什么按渲染后的宽而不是原图宽：
// 图在签上是 `max-h-[240px] + max-w-full`（body-view.tsx），2560 宽的原图渲染只有 360，
// 照原图开就是开一扇 2560 的窗看一张 360 的图。没有图时宽**不动**——作者拍板
// "文字仍用行里的宽"，打字不改宽，也就不会出现"每行字数变了、行数又变了"的抖动。
//
// 上限 900 是作者拍的（不是工作区高）：本机工作区 2560×1392，一张写满正文的签按差值法
// 要几千像素高，不设上限就能把整屏吃掉、下面的字既看不见也滚不动。
// 超出的部分由正文那一格自己滚（阅读态本来就 overflow-y-auto）。

/** 与 float.rs 的 `MIN_SIZE`（220×200）同值：自动不许把窗缩到手都捏不住 */
export const AUTO_MIN = { width: 220, height: 200 } as const;

/** 作者拍的固定上限：一屏至少还摆得下两张高的 */
export const AUTO_MAX = { width: 900, height: 900 } as const;

/** 与 body-view.tsx 里那张图的 `max-h-[240px]` 同值（改一边要同步另一边） */
export const IMAGE_MAX_HEIGHT = 240;

/** 正文左右内边距之和（壳体是 `p-3`：12 + 12） */
export const CONTENT_X_PADDING = 24;

/** 图自己那一圈边框（body-view 的 `border`：左右各 1px）。不算进来就会把图挤 2px */
export const IMAGE_X_BORDER = 2;

export interface AutoSizeMeasure {
  windowWidth: number;
  windowHeight: number;
  /** 正文那一格的可视高（clientHeight）。0 = 还没布局出来，这时不改高 */
  bodyClientHeight: number;
  /**
   * 内容本体的自然高。**不是**那一格的 scrollHeight——滚动盒的 scrollHeight 永不低于
   * clientHeight，拿它算就变成"窗只会长不会缩"。量法见 use-auto-size 的 contentHeightOf。
   */
  bodyContentHeight: number;
  /** 名下每张**已解码**图的原尺寸；未解码的别放进来（naturalWidth 是 0） */
  images: { width: number; height: number }[];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** 一张图渲染后的宽（含它自己那 2px 边框）：受"高不超过 240"压着，也受原宽压着（不放大） */
function renderedWidthOf(image: { width: number; height: number }): number | null {
  if (image.width <= 0 || image.height <= 0) return null;
  return (
    Math.min(image.width, IMAGE_MAX_HEIGHT * (image.width / image.height)) +
    IMAGE_X_BORDER
  );
}

/**
 * 该开多大。同输入必同输出（不抖），且**不会**因为量早了就把窗改坏：
 * 壳体还没布局（bodyClientHeight 0）时高保持不动，图还没解码时宽保持不动。
 */
export function autoSizeFor(m: AutoSizeMeasure): { width: number; height: number } {
  const wantedWidth = m.images
    .map(renderedWidthOf)
    .filter((w): w is number => w !== null)
    .reduce<number | null>((max, w) => (max === null || w > max ? w : max), null);

  const width =
    wantedWidth === null
      ? m.windowWidth
      : clamp(Math.ceil(wantedWidth + CONTENT_X_PADDING), AUTO_MIN.width, AUTO_MAX.width);

  // 还没布局：这一格 0 高，差值法会算出"窗 + 整个内容高"那种荒唐值，原样退回
  if (m.bodyClientHeight <= 0) {
    return { width, height: m.windowHeight };
  }
  const height = clamp(
    Math.ceil(m.windowHeight - m.bodyClientHeight + m.bodyContentHeight),
    AUTO_MIN.height,
    AUTO_MAX.height,
  );
  return { width, height };
}

/**
 * 要不要为这个目标改窗。差 1px 以内不动——系统的尺寸事件会带回来一个"差一点"的
 * 回声（use-dock-snap 里那条 2px 容差是同一件事），每次都改就成了自激振荡。
 */
export function differsEnough(
  current: { width: number; height: number },
  target: { width: number; height: number },
  tolerance = 2,
): boolean {
  return (
    Math.abs(current.width - target.width) > tolerance ||
    Math.abs(current.height - target.height) > tolerance
  );
}
