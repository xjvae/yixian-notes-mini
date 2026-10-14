// 跨语言常量对照 — 同一个数抄在 Rust 与前端两份代码里，改一边忘了另一边**不报错**，
// 只是行为从此分叉（"设置上写着 5 分钟、实际按别的数锁"那一类）。
// 这里把两边逐条对着源文件比。镜像的常量加一条就往下列一行；
// **读不到那个名字会直接抛**——改名与删掉同样被抓，那正是想要的。

import { describe, expect, it } from "vitest";
import floatRs from "../../src-tauri/src/windows/float.rs?raw";
import guideRs from "../../src-tauri/src/windows/guide.rs?raw";
import ringRs from "../../src-tauri/src/windows/ring.rs?raw";
import mediaRs from "../../src-tauri/src/db/query/media.rs?raw";
import searchRs from "../../src-tauri/src/db/query/search.rs?raw";
import revisionRs from "../../src-tauri/src/db/query/revision.rs?raw";
import reminderRs from "../../src-tauri/src/db/query/reminder.rs?raw";
import groupRs from "../../src-tauri/src/db/query/group.rs?raw";
import autolockRs from "../../src-tauri/src/autolock.rs?raw";
import cryptoRs from "../../src-tauri/src/data/crypto.rs?raw";
import fakeDbTs from "../preview/fake-db.ts?raw";
import specsTs from "../preview/window-specs.ts?raw";
import {
  BAR_HEIGHT,
  BAR_MAX_WIDTH,
  STICKY_DEFAULT_SIZE,
  STICKY_MIN_SIZE,
} from "@/data/window-geometry";
import { GROUP_NAME_MAX } from "@/data/limit";
import { MAX_BYTES as IMAGE_MAX_BYTES } from "@/data/image-input";
import {
  AUTO_LOCK_DEFAULT_MIN,
  AUTO_LOCK_KEY,
  AUTO_LOCK_MAX_MIN,
} from "@/data/auto-lock";

/** `const NAME: 类型 = 式;`（Rust）与 `const NAME = 式`（TS）都认，式只支持数与 `a * b` 乘积 */
function numConst(source: string, name: string): number {
  const found = new RegExp(`const\\s+${name}\\s*(?::[^=;]+)?=\\s*([^;\\n]+)`).exec(
    source,
  );
  const raw = found?.[1];
  if (raw === undefined) throw new Error(`读不到常量 ${name}`);
  const cleaned = raw.trim().replace(/_/g, "");
  const parts = cleaned.split("*").map((part) => Number(part.trim()));
  if (parts.some((n) => !Number.isFinite(n)))
    throw new Error(`${name} 的式子认不出：${raw}`);
  return parts.reduce((acc, n) => acc * n, 1);
}

/** 元组常量 `(320.0, 300.0)`，返回两支 */
function pairConst(source: string, name: string): [number, number] {
  const found = new RegExp(`const\\s+${name}\\s*:[^=;]+=\\s*\\(([^)]*)\\)`).exec(source);
  const raw = found?.[1];
  if (raw === undefined) throw new Error(`读不到成对常量 ${name}`);
  const [w, h] = raw.split(",").map((part) => Number(part.trim()));
  if (!Number.isFinite(w) || !Number.isFinite(h))
    throw new Error(`${name} 读不出两支：${raw}`);
  return [w, h];
}

/** 预览台规格表里某个窗型的尺寸。条目之间夹着注释，所以从 kind 往后**找第一支** size */
function specSize(kind: string): [number, number] {
  const from = specsTs.indexOf(`${kind}:`);
  if (from < 0) throw new Error(`规格表里没有 ${kind}`);
  const found = /size:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)/.exec(
    specsTs.slice(from),
  );
  if (found === null || found[1] === undefined || found[2] === undefined) {
    throw new Error(`规格表里读不到 ${kind} 的尺寸`);
  }
  return [Number(found[1]), Number(found[2])];
}

describe("跨语言常量对得上", () => {
  it("便签窗那四个几何数", () => {
    expect(STICKY_DEFAULT_SIZE).toEqual({
      width: pairConst(floatRs, "DEFAULT_SIZE")[0],
      height: pairConst(floatRs, "DEFAULT_SIZE")[1],
    });
    expect(STICKY_MIN_SIZE).toEqual({
      width: pairConst(floatRs, "MIN_SIZE")[0],
      height: pairConst(floatRs, "MIN_SIZE")[1],
    });
    expect(BAR_HEIGHT).toBe(numConst(floatRs, "BAR_HEIGHT"));
    expect(BAR_MAX_WIDTH).toBe(numConst(floatRs, "BAR_MAX_WIDTH"));
  });

  it("预览台的规格表自己认这份几何，不在 specs 里另抄一份数", () => {
    expect(specsTs).toContain("size: STICKY_DEFAULT_SIZE");
    expect(specsTs).toContain("min: STICKY_MIN_SIZE");
  });

  it("星环与引导气泡的尺寸跟着 Rust 走", () => {
    // 星环是正方形：Rust 那一侧只一个数，规格表里宽高分明写两遍（对不上就是圆被压成椭圆）
    const side = numConst(ringRs, "RING_SIZE");
    expect(specSize("ring")).toEqual([side, side]);
    const [guideW, guideH] = pairConst(guideRs, "BUBBLE_SIZE");
    expect(specSize("guide")).toEqual([guideW, guideH]);
  });

  it("图片那两条字节线", () => {
    expect(IMAGE_MAX_BYTES).toBe(numConst(mediaRs, "MAX_BYTES"));
    expect(numConst(fakeDbTs, "MEDIA_MAX_BYTES")).toBe(numConst(mediaRs, "MAX_BYTES"));
    expect(numConst(fakeDbTs, "MEDIA_MAX_PER_NOTE")).toBe(
      numConst(mediaRs, "MAX_PER_NOTE"),
    );
  });

  it("检索条数与稍后再响的时长", () => {
    expect(numConst(fakeDbTs, "SEARCH_LIMIT")).toBe(numConst(searchRs, "SEARCH_LIMIT"));
    expect(numConst(fakeDbTs, "SNOOZE_MS")).toBe(numConst(reminderRs, "SNOOZE_MS"));
  });

  it("历史版本的四个阈值（预览台抄的是同一套）", () => {
    expect(numConst(fakeDbTs, "REVISION_KEEP")).toBe(
      numConst(revisionRs, "KEEP_PER_NOTE"),
    );
    expect(numConst(fakeDbTs, "REVISION_COALESCE_MS")).toBe(
      numConst(revisionRs, "COALESCE_MS"),
    );
    expect(numConst(fakeDbTs, "REVISION_KEEP_MS")).toBe(
      numConst(revisionRs, "KEEP_DAYS") * numConst(revisionRs, "DAY_MS"),
    );
    expect(numConst(fakeDbTs, "REVISION_PREVIEW_CHARS")).toBe(
      numConst(revisionRs, "PREVIEW_CHARS"),
    );
  });

  it("自动上锁的默认档、上限与那条设置键", () => {
    expect(AUTO_LOCK_DEFAULT_MIN).toBe(numConst(autolockRs, "DEFAULT_MINUTES"));
    const bound = /\(0\.\.=(\d+)\)/.exec(autolockRs)?.[1];
    if (bound === undefined)
      throw new Error("autolock.rs 的 minutes_from 读不到上限那一格");
    expect(AUTO_LOCK_MAX_MIN).toBe(Number(bound));
    expect(autolockRs).toContain(`"${AUTO_LOCK_KEY}"`);
  });

  it("口令长度那两条线", () => {
    expect(numConst(fakeDbTs, "PASSWORD_MIN_CHARS")).toBe(
      numConst(cryptoRs, "MIN_PASSWORD_CHARS"),
    );
    expect(numConst(fakeDbTs, "PASSWORD_MAX_CHARS")).toBe(
      numConst(cryptoRs, "MAX_PASSWORD_CHARS"),
    );
  });

  it("组合名上限", () => {
    expect(GROUP_NAME_MAX).toBe(numConst(groupRs, "NAME_MAX"));
  });
});
