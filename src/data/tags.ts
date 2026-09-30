// 标签 — 便签上的芯片。颜色由名字哈希决定（同一标签永远同色，跨窗一致），
// 不存库里：标签数据只有名字（tags_json），颜色是纯展示推导。

export interface TagInk {
  background: string;
  ink: string;
}

const PALETTE: readonly TagInk[] = [
  { background: "#FDE9D9", ink: "#8A4B08" },
  { background: "#E2EFDA", ink: "#375623" },
  { background: "#DDEBF7", ink: "#1F4E79" },
  { background: "#FCE4EC", ink: "#880E4F" },
  { background: "#EDE7F6", ink: "#4527A0" },
  { background: "#FFF8E1", ink: "#7F6000" },
  { background: "#E0F2F1", ink: "#004D40" },
  { background: "#EFEBE9", ink: "#4E342E" },
];

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function tagInk(name: string): TagInk {
  return PALETTE[hashName(name) % PALETTE.length];
}

/** 归一化一次输入：去空白、去重、限长限量。返回 null = 这条输入不该成为标签 */
export function normalizeTagInput(
  raw: string,
  existing: readonly string[],
): string | null {
  const name = raw.trim();
  if (name === "" || name.length > 20) return null;
  if (existing.includes(name)) return null;
  if (existing.length >= 8) return null;
  return name;
}
