// 主题 — 便签六色。底色与强调色**成对**定义：纸色走内联样式（CSS 变量盖不住
// 内联背景），强调色供标题栏脊、按钮 hover 等使用。深色模式的成对值随深色模式一起加。

export interface NoteTheme {
  key: string;
  name: string;
  /** 纸面底色（浅色档） */
  paper: string;
  /** 强调色（脊、焦点、按钮） */
  accent: string;
  /** 纸面上的正文墨色 */
  ink: string;
  /** 深色档的成对值：纸色变深、墨色变浅、强调色提亮。三者必须成对供给——
   * 走内联样式，CSS 的深色层盖不住它们 */
  darkPaper: string;
  darkAccent: string;
  darkInk: string;
}

export const NOTE_THEMES: readonly NoteTheme[] = [
  {
    key: "yellow",
    name: "鹅黄",
    paper: "#FBF2C7",
    accent: "#B7791F",
    ink: "#4A3B12",
    darkPaper: "#3B3527",
    darkAccent: "#D9A441",
    darkInk: "#F0E6C8",
  },
  {
    key: "green",
    name: "豆绿",
    paper: "#DDF3D5",
    accent: "#388E3C",
    ink: "#1E3D20",
    darkPaper: "#26382B",
    darkAccent: "#6FBF73",
    darkInk: "#D7EAD8",
  },
  {
    key: "blue",
    name: "天青",
    paper: "#D8ECFA",
    accent: "#1E72B8",
    ink: "#14314A",
    darkPaper: "#233340",
    darkAccent: "#5FA8DC",
    darkInk: "#D6E8F5",
  },
  {
    key: "pink",
    name: "藕粉",
    paper: "#FBE0E4",
    accent: "#C04D6A",
    ink: "#4C1F2B",
    darkPaper: "#3C2A30",
    darkAccent: "#D9829B",
    darkInk: "#F5DCE3",
  },
  {
    key: "purple",
    name: "黛紫",
    paper: "#EAE2F8",
    accent: "#6B46C1",
    ink: "#2E2354",
    darkPaper: "#2E2A3E",
    darkAccent: "#A78BDB",
    darkInk: "#E4DCF5",
  },
  {
    key: "gray",
    name: "岩灰",
    paper: "#ECEEF1",
    accent: "#4B5563",
    ink: "#1F2937",
    darkPaper: "#282B2F",
    darkAccent: "#9CA3AF",
    darkInk: "#E5E7EB",
  },
];

const BY_KEY = new Map(NOTE_THEMES.map((t) => [t.key, t]));

export function themeOf(key: string): NoteTheme {
  return BY_KEY.get(key) ?? NOTE_THEMES[0];
}

export const THEME_KEYS: readonly string[] = NOTE_THEMES.map((t) => t.key);

export interface ThemeColors {
  paper: string;
  accent: string;
  ink: string;
}

/** 按当前深浅档取成对色。三值永远来自同一档，绝不允许"深纸浅墨"错配 */
export function themeColors(key: string, resolved: "light" | "dark"): ThemeColors {
  const theme = themeOf(key);
  return resolved === "dark"
    ? { paper: theme.darkPaper, accent: theme.darkAccent, ink: theme.darkInk }
    : { paper: theme.paper, accent: theme.accent, ink: theme.ink };
}
