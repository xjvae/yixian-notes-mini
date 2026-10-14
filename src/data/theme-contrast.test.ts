// 配色可读性 — 钉住"字一律走 ink，accent 只做描边与图标"这条口径的**算术根据**。
//
// 为什么值得写成一跑就红的测试：强调色压在纸上做文字色，肉眼看着"还行"，实测比值却
// 全在 AA 线以下（浅色档 鹅黄 3.23 / 豆绿 3.50 / 藕粉 3.74 / 天青 4.16，AA 要 4.5）。
// 所以这里不写"记得别用 accent 写字"，只把两件事钉死：墨色配纸色必须过线，
// 而强调色**不能**单独当文字色用（它过不了线是事实，测试把这条事实留住）。

import { describe, expect, it } from "vitest";
import { NOTE_THEMES, themeColors } from "@/data/theme";

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 相对亮度 */
function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** 前景对背景的对比度（1..21） */
function ratio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_NORMAL = 4.5;

describe("便签配色", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme} 档：每个主题的墨色都读得清自己的纸`, () => {
      for (const theme of NOTE_THEMES) {
        const { ink, paper } = themeColors(theme.key, scheme);
        expect(ratio(ink, paper), `${theme.name}（${scheme}）`).toBeGreaterThanOrEqual(
          AA_NORMAL,
        );
      }
    });
  }

  /// 强调色只留描边与图标：浅色档里过半数那几支压在纸上做文字色是过不了线的，
  /// 这条断言把"为什么要有这条口径"留住（不是断言哪一支能用，那会随调色漂移）
  it("强调色不能当文字色：浅色档有一多半达不到 AA", () => {
    const below = NOTE_THEMES.filter((t) => ratio(t.accent, t.paper) < AA_NORMAL);
    expect(below.length).toBeGreaterThanOrEqual(4);
    expect(below.map((t) => t.name)).toEqual(["鹅黄", "豆绿", "天青", "藕粉"]);
  });

  it("到期角标那一层淡底不许吃掉墨色的可读性", () => {
    // 角标是 `accent` 加 26（≈15%）透明度铺在纸上 + ink 字：淡底不能把线拉破
    for (const theme of NOTE_THEMES) {
      const { accent, ink, paper } = themeColors(theme.key, "light");
      const tinted = blend(accent, paper, 0x26 / 0xff);
      expect(ratio(ink, tinted), `${theme.name}`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});

/** 前景按 alpha 铺在背景上的合成色（十六进制，两位一组） */
function blend(foreground: string, background: string, alpha: number): string {
  const pick = (hex: string, i: number): number => parseInt(hex.slice(i, i + 2), 16);
  const channels = [1, 3, 5].map((i) => {
    const f = pick(foreground, i);
    const b = pick(background, i);
    return Math.round(f * alpha + b * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}
