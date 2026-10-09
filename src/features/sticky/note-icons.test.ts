// 图标注册表的契约 — 钉的是"这张便签到底画哪个"这三件事：类型默认、自定义优先、
// 遮罩态先于一切给锁。私密的便签在没解锁时连图标都是泄露面（一张"酒杯"就够说明内容），
// 所以那一条不是审美选择，是边界。

import { describe, expect, it } from "vitest";
import { Lock } from "lucide-react";
import { createDefaultSticky } from "@/data/entities";
import type { StickyNote } from "@/platform/contracts";
import { chipIconOf, NOTE_ICON_CHOICES, TYPE_ICONS } from "@/features/sticky/note-icons";

function note(overrides: Partial<StickyNote> = {}): StickyNote {
  return { ...createDefaultSticky("s1", 1_700_000_000_000), ...overrides };
}

describe("NOTE_ICON_CHOICES 选板", () => {
  it("正好十六个，key 不重、label 不缺", () => {
    expect(NOTE_ICON_CHOICES).toHaveLength(16);
    const keys = NOTE_ICON_CHOICES.map((choice) => choice.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const choice of NOTE_ICON_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.Icon).toBeTruthy();
    }
  });

  it("每一类的默认图标都在 lucide 里配好了（不许有 undefined 落进映射）", () => {
    for (const type of ["text", "todo", "reminder", "timeline"] as const) {
      expect(TYPE_ICONS[type]).toBeTruthy();
    }
  });
});

describe("chipIconOf 画哪个", () => {
  it("没设过 = 画这一类默认的那个", () => {
    const todo = note({ contentType: "todo", icon: null });
    expect(chipIconOf(todo, false)).toBe(TYPE_ICONS.todo);
  });

  it("设过了就优先画自定义的，且不再画类型的", () => {
    const coffee = NOTE_ICON_CHOICES.find((choice) => choice.key === "coffee");
    const todo = note({ contentType: "todo", icon: "coffee" });
    expect(coffee).toBeDefined();
    expect(chipIconOf(todo, false)).toBe(coffee?.Icon);
    expect(chipIconOf(todo, false)).not.toBe(TYPE_ICONS.todo);
  });

  it("认不出的 key（手改库 / 以后删掉的图标）回落类型默认，不画空白", () => {
    const odd = note({ contentType: "reminder", icon: "no-such-icon" });
    expect(chipIconOf(odd, false)).toBe(TYPE_ICONS.reminder);
  });

  it("遮罩态先于一切：私密的没解锁时只画锁，自定义图标也一样不给看", () => {
    const maskedPrivate = note({ private: true, icon: "wine" });
    expect(chipIconOf(maskedPrivate, true)).toBe(Lock);
    expect(chipIconOf(maskedPrivate, true)).not.toBe(chipIconOf(maskedPrivate, false));
  });

  it("解锁后的私密便签照常用它自己那个图标", () => {
    const book = NOTE_ICON_CHOICES.find((choice) => choice.key === "book");
    expect(chipIconOf(note({ private: true, icon: "book" }), false)).toBe(book?.Icon);
  });
});
