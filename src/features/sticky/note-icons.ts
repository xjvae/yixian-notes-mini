// 便签图标的唯一住址 — 类型默认（四类各一）与可选的自定义图标（落库存的是这里的 key）。
// 收在 feature 层：图标是 lucide 组件，data/note-types.ts 只放口径；"该画哪个图标"散两处迟早对不上。
// 认不出的 key 不用另一套校验拦：chipIconOf 落不回注册表就画类型默认，签上永远不出现空白。
// 自定义图标全是 lucide 线条图标（跟主题强调色走）：不引第三方包、不存 emoji（emoji 自带颜色，跟主题对不齐）。

import {
  AlarmClock,
  Bell,
  BookOpen,
  Calendar,
  Camera,
  CheckSquare,
  Clock,
  Coffee,
  Flag,
  Bookmark,
  Home,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Music,
  Milestone,
  Phone,
  Smile,
  Star,
  TextIcon,
  type LucideIcon,
} from "lucide-react";
import type { StickyContentType, StickyNote } from "@/platform/contracts";

/** 四类便签的默认图标（编辑器那条类型标记与签列的回落都用它）。
 *  时间轴刻意不用 `History`：页脚那颗"历史版本"就是它，同一只页脚里不能出现两个同样字形 */
export const TYPE_ICONS: Record<StickyContentType, LucideIcon> = {
  text: TextIcon,
  todo: ListChecks,
  reminder: AlarmClock,
  timeline: Milestone,
};

export interface NoteIconChoice {
  /** 落库的那串字符（`stickies.icon`） */
  key: string;
  label: string;
  Icon: LucideIcon;
}

/** 选板上的十六个。顺序就是选板上的顺序（常用的放前面） */
export const NOTE_ICON_CHOICES: readonly NoteIconChoice[] = [
  { key: "star", label: "星标", Icon: Star },
  { key: "check", label: "待办", Icon: CheckSquare },
  { key: "flag", label: "旗标", Icon: Flag },
  { key: "bookmark", label: "书签", Icon: Bookmark },
  { key: "bell", label: "提醒", Icon: Bell },
  { key: "clock", label: "时间", Icon: Clock },
  { key: "calendar", label: "日期", Icon: Calendar },
  { key: "key", label: "钥匙", Icon: Key },
  { key: "lightbulb", label: "点子", Icon: Lightbulb },
  { key: "coffee", label: "咖啡", Icon: Coffee },
  { key: "book", label: "书本", Icon: BookOpen },
  { key: "home", label: "家", Icon: Home },
  { key: "phone", label: "电话", Icon: Phone },
  { key: "camera", label: "相机", Icon: Camera },
  { key: "music", label: "音乐", Icon: Music },
  { key: "smile", label: "心情", Icon: Smile },
];

const BY_KEY = new Map(NOTE_ICON_CHOICES.map((choice) => [choice.key, choice]));

/**
 * 这张便签该画哪个图标。遮罩态（私密且没解锁）先于一切给锁：那时真实标题都不在内存里，
 * 自定义图标同样是泄露面。
 */
export function chipIconOf(note: StickyNote, masked: boolean): LucideIcon {
  if (masked) return Lock;
  const choice = note.icon === null ? undefined : BY_KEY.get(note.icon);
  return choice?.Icon ?? TYPE_ICONS[note.contentType] ?? TextIcon;
}
