import { describe, expect, it } from "vitest";
import {
  AUTO_MAX,
  AUTO_MIN,
  CONTENT_X_PADDING,
  IMAGE_MAX_HEIGHT,
  IMAGE_X_BORDER,
  autoSizeFor,
  differsEnough,
} from "@/window/auto-size";
import type { AutoSizeMeasure } from "@/window/auto-size";

const base: AutoSizeMeasure = {
  windowWidth: 318,
  windowHeight: 298,
  bodyClientHeight: 126,
  bodyContentHeight: 126,
  images: [],
};

const size = (width: number, height: number) => ({ width, height });

describe("autoSizeFor 高", () => {
  it("正文比可视高就长窗（差值法：壳体那几行全是 shrink-0）", () => {
    expect(autoSizeFor({ ...base, bodyContentHeight: 191 })).toEqual({
      width: 318,
      height: 363, // 298 − 126 + 191
    });
  });

  it("删到只剩一行会回缩，但不低于 MIN_SIZE 的 200", () => {
    // 这一条钉的是真踩过的坑：窗已经被顶到 381 高、那一格可视 209，内容只剩 21。
    // 拿滚动盒自己的 scrollHeight 量会永远量到 209（它不低于 clientHeight），
    // 于是"只会长不会缩"
    const shrunk = autoSizeFor({
      ...base,
      windowHeight: 381,
      bodyClientHeight: 209,
      bodyContentHeight: 21,
    });
    expect(shrunk.height).toBe(AUTO_MIN.height);
  });

  it("满正文（几千字要几千高）夹到作者拍的 900，多出来的正文自己滚", () => {
    expect(autoSizeFor({ ...base, bodyContentHeight: 1900 }).height).toBe(
      AUTO_MAX.height,
    );
  });

  it("壳体还没布局出来（可视高 0）时不改高——量早了不能把窗顶成一屏多高", () => {
    expect(
      autoSizeFor({ ...base, bodyClientHeight: 0, bodyContentHeight: 1900 }).height,
    ).toBe(298);
  });
});

describe("autoSizeFor 宽", () => {
  it("没有图时宽原样（打字不改宽，才不会出现每行字数变了行数又变了的抖）", () => {
    expect(autoSizeFor(base).width).toBe(318);
  });

  it("小图按图的原始宽对齐（不放大）", () => {
    expect(autoSizeFor({ ...base, images: [size(240, 120)] }).width).toBe(
      240 + IMAGE_X_BORDER + CONTENT_X_PADDING,
    );
  });

  it("宽图按 240 高那条压出来的显示宽对齐，不是原图宽", () => {
    // 2560×1707 的截图：高限 240 → 显示宽 360，开 2560 的窗看一张 360 的图是荒唐
    const target = autoSizeFor({ ...base, images: [size(2560, 1707)] });
    expect(target.width).toBe(
      Math.ceil(IMAGE_MAX_HEIGHT * (2560 / 1707) + IMAGE_X_BORDER + CONTENT_X_PADDING),
    );
    expect(target.width).toBeLessThan(400);
  });

  it("竖长图把宽夹回 220，不会开出一扇比正文还窄的窗", () => {
    expect(autoSizeFor({ ...base, images: [size(600, 2000)] }).width).toBe(
      AUTO_MIN.width,
    );
  });

  it("超宽图夹到 900 上限", () => {
    expect(autoSizeFor({ ...base, images: [size(5000, 100)] }).width).toBe(
      AUTO_MAX.width,
    );
  });

  it("多张图取最宽那一张", () => {
    const wide = autoSizeFor({
      ...base,
      images: [size(240, 120), size(500, 400), size(300, 100)],
    });
    expect(wide.width).toBe(300 + IMAGE_X_BORDER + CONTENT_X_PADDING);
  });

  it("未解码的图（0×0）不参与算宽", () => {
    expect(autoSizeFor({ ...base, images: [size(0, 0)] }).width).toBe(318);
  });
});

describe("autoSizeFor 稳定性", () => {
  it("同输入同输出（不抖）", () => {
    const measure: AutoSizeMeasure = {
      ...base,
      bodyContentHeight: 480,
      images: [size(2560, 1707), size(240, 120)],
    };
    expect(autoSizeFor(measure)).toEqual(autoSizeFor(measure));
  });

  it("宽高都取整（系统只吃整数尺寸）", () => {
    const target = autoSizeFor({
      ...base,
      bodyContentHeight: 127.3,
      images: [size(301, 133)],
    });
    expect(Number.isInteger(target.width)).toBe(true);
    expect(Number.isInteger(target.height)).toBe(true);
  });
});

describe("differsEnough", () => {
  it("2px 以内的回声不算差异（否则尺寸事件回来一点就自己改自己）", () => {
    expect(differsEnough({ width: 318, height: 298 }, { width: 319, height: 299 })).toBe(
      false,
    );
    expect(differsEnough({ width: 318, height: 298 }, { width: 321, height: 298 })).toBe(
      true,
    );
    expect(differsEnough({ width: 318, height: 298 }, { width: 318, height: 400 })).toBe(
      true,
    );
  });
});
