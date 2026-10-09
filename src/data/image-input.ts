// 图片输入 — 把一张外来的图（粘贴 / 拖入 / 选文件）变成"能存进库里的那一张"。
//
// 三件事按顺序做，每件都有理由：
//  · **只收白名单 mime**（与 Rust 侧 `media::ALLOWED_MIME` 同表同序）：svg 是文本格式、
//    能带脚本，不收；
//  · **缩到最长边 MAX_EDGE**：一张 4K 截图原图 8~20 MB，原样进库就是"贴一张图库涨
//    20 MB"，而便签里那块图撑死也就 320 宽上下——2560 已经留足了放大与换高分屏的余地；
//  · **重编码**：不透明走 jpeg(0.9)、带透明走 png。截图基本不透明，这一条把
//    "一张 4K 图" 从 6 MB 量级压到 1 MB 以内，是这条链路存在的理由。
//
// 为什么在前端做而不是 Rust：前端有 canvas，Rust 侧要重编码就得引 image crate
// （多一个依赖面）。字节最终仍由 Rust 校验并落库，一条口径都没绕过。
//
// gif / bmp 原样透传：canvas 编码不出 gif（重编码就把动图变成静图），bmp 也没必要
// 转——它们只过大小这一关。

/** 与 Rust `media::MAX_BYTES` 同值：重编码**之后**还要过这一关 */
export const MAX_BYTES = 5 * 1024 * 1024;

/** 进来的原图上限。防的是"误拖进一个 300 MB 的文件"，不是拦正常截图 */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

/** 缩到最长边多少像素 */
export const MAX_EDGE = 2560;

/** 与 src-tauri/src/db/query/media.rs 的 ALLOWED_MIME 同表同序（改一边要同步另一边） */
export const ALLOWED_MIME: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
];

/** canvas 能重编码的那几种（其余透传） */
const RECODEABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface PreparedImage {
  mime: string;
  /** 裸字节的 base64（不带 data: 前缀），直接交给 mediaSave */
  dataBase64: string;
  width: number;
  height: number;
  /** 原图字节数，报给用户看"缩掉了多少" */
  originalBytes: number;
}

export function isAcceptedMime(mime: string): boolean {
  return ALLOWED_MIME.includes(mime);
}

/** Uint8Array → base64。分块 push 再 join：`btoa(String.fromCharCode(...bytes))`
 *  几 MB 就把调用栈撑爆 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)));
  }
  return btoa(parts.join(""));
}

/** 最长边超过 MAX_EDGE 才缩，返回要画进 canvas 的目标尺寸 */
export function targetSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= MAX_EDGE) return { width, height };
  const scale = MAX_EDGE / edge;
  // 至少 1 像素：极端长条图（1×20000）按比例会算出 0
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 画布里有没有真透明像素。全不透明就能走 jpeg（小一个量级） */
function hasAlpha(source: HTMLCanvasElement): boolean {
  const data = source
    .getContext("2d")
    ?.getImageData(0, 0, source.width, source.height).data;
  if (data === undefined) return true; // 拿不到就当有透明，走 png 这条安全的路
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

function encode(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob === null ? reject(new Error(`这张图编码成 ${mime} 失败`)) : resolve(blob),
      mime,
      0.9,
    );
  });
}

/**
 * 准备好一张图。抛错 = 这张图进不来，消息都是能直接给用户看的一句话
 * （调用方负责显示，别在这儿包一层返回值）。
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isAcceptedMime(file.type)) {
    throw new Error(
      `只收 png / jpeg / gif / webp / bmp，这个是 ${file.type || file.name}`,
    );
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`这张图 ${(file.size / 1048576).toFixed(1)} MB，太大了`);
  }
  const raw = new Uint8Array(await file.arrayBuffer());
  const bitmap = await createImageBitmap(file);

  if (!RECODEABLE.has(file.type)) {
    // 透传：动图不能被压成一张静图，bmp 也没必要转
    if (raw.length > MAX_BYTES) {
      throw new Error(
        `${file.type === "image/gif" ? "这张动图" : "这张图"} ${(raw.length / 1048576).toFixed(1)} MB，超过单张 5 MB 上限`,
      );
    }
    return {
      mime: file.type,
      dataBase64: toBase64(raw),
      width: bitmap.width,
      height: bitmap.height,
      originalBytes: file.size,
    };
  }

  const size = targetSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("这台机器开不出画布，图存不进来");
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();

  const mime = file.type === "image/png" && !hasAlpha(canvas) ? "image/jpeg" : file.type;
  const encoded = new Uint8Array(await (await encode(canvas, mime)).arrayBuffer());
  if (encoded.length > MAX_BYTES) {
    throw new Error(
      `这张图压完还有 ${(encoded.length / 1048576).toFixed(1)} MB，超过单张 5 MB 上限`,
    );
  }
  return {
    mime,
    dataBase64: toBase64(encoded),
    width: size.width,
    height: size.height,
    originalBytes: file.size,
  };
}
