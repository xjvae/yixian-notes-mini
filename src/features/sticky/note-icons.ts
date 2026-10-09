// 便签图标的唯一住址 — 两类信息放一起：**类型默认**（四类各一个）与**可选的自定义图标**
// （侧边色块签用，落库存的是这里的 key）。
//
// 为什么收在 feature 层：图标是 lucide 组件，`data/note-types.ts` 明确只放口径不放图标；
// 而"某张便签该画哪个图标"这件事一旦散在两处（编辑器一个映射、叠窗又一个映射），
// 换图标就要改两个地方，迟早对不上。
//
// 库里存的是这里的 key。认不出的 key（手改库、以后删掉的图标、别的版本写的值）不用另一套
// 校验去拦：`chipIconOf` 落不回注册表就画类型默认 —— 签上永远不会出现空白或错位。
//
// 自定义图标全是 lucide 线条图标（stroke 一致、跟着主题强调色走）：不引第三方图标包，
// 也不存 emoji —— emoji 自带颜色，在六套纸色上跟主题对不齐。

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
  History,
  Home,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Music,
  Phone,
  Smile,
  Star,
  TextIcon,
  type LucideIcon,
} from "lucide-react";
import type { StickyContentType, StickyNote } from "@/platform/contracts";

/** 四类便签的默认图标（编辑器那条类型标记与签列的回落都用它） */
export const TYPE_ICONS: Record<StickyContentType, LucideIcon> = {
  text: TextIcon,
  todo: ListChecks,
  reminder: AlarmClock,
  timeline: History,
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
