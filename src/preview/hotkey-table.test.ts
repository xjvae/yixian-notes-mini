// 热键表有三份抄本，漂一处就是"设置里那个键按了没反应"：
//  · Rust `hotkeys.rs::DEFAULT_BINDINGS`（真正注册的那份，顺序 = 界面顺序）
//  · 预览台 `preview/fake-db.ts::DEFAULT_BINDINGS`（假核要答同样的清单）
//  · `data/hotkey-labels.ts::ACTION_LABELS`（每个动作的人话名字，设置窗与引导教程共用）
// 三边都写着"改一边要同步另一边"的注释，注释拦不住过——所以让它测试红。
//
// 三份都**按文本读**（vite 的 `?raw`），不 import：`fake-db.ts` 与设置窗那一层都会顺着
// `platform/bridge.ts` 静态摸到 `@tauri-apps/api/window`，而 app 的 tsconfig 不带 node 类型，
// 用 `node:fs` 也过不了 typecheck。读的是源码形状：改形状（把常量拆了、挪走了）这条
// 用例会以"没解析到那段"失败，那时一起改。

import { describe, expect, it } from "vitest";
import rustSource from "../../src-tauri/src/hotkeys.rs?raw";
import previewSource from "../../src/preview/fake-db.ts?raw";
import labelSource from "../../src/data/hotkey-labels.ts?raw";

/** Rust 那份：`("action", "Alt+1"),` */
function rustBindings(): [string, string][] {
  const block = /pub const DEFAULT_BINDINGS[^=]*=\s*&\[(.*?)\n\];/s.exec(rustSource);
  expect(block, "hotkeys.rs 里没找到 DEFAULT_BINDINGS 那段").not.toBeNull();
  return [...block![1].matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
}

/** 预览台那份：`["sticky", "Alt+1"],` */
function previewBindings(): [string, string][] {
  const block = /const DEFAULT_BINDINGS[^=]*=\s*(?:readonly )?\[(.*?)\n\];/s.exec(
    previewSource,
  );
  expect(block, "fake-db.ts 里没找到 DEFAULT_BINDINGS 那段").not.toBeNull();
  return [...block![1].matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
}

/** 设置窗那份的键名：`sticky: "新建便签",`（`"hide-all"` 带引号，因为有连字符） */
function labelKeys(): string[] {
  const block = /const ACTION_LABELS[^=]*=\s*{(.*?)\n};/s.exec(labelSource);
  expect(block, "hotkey-labels.ts 里没找到 ACTION_LABELS 那段").not.toBeNull();
  return [...block![1].matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]);
}

const rust = rustBindings();

describe("热键表三份抄本不许漂", () => {
  it("Rust 与预览台：同序同键位", () => {
    expect(previewBindings()).toEqual(rust);
  });

  it("每个动作都有人话名字，也没有留着已经没了的动作", () => {
    // 只比集合不比顺序：ACTION_LABELS 是一张查表，界面顺序由 Rust 那份定
    const sorted = (list: string[]) => [...list].sort();
    expect(sorted(labelKeys())).toEqual(sorted(rust.map(([action]) => action)));
  });

  it("动作 id 不重复、默认键位不撞车", () => {
    const actions = rust.map(([action]) => action);
    expect(new Set(actions).size, `动作 id 重复：${actions.join(",")}`).toBe(
      actions.length,
    );
    const keys = rust.map(([, key]) => key);
    expect(new Set(keys).size, `默认键位撞车：${keys.join(",")}`).toBe(keys.length);
  });

  // 整张表按顺序钉住：新加一条动作时**这里会红**，逼着同时补预览台那份与那个名字，
  /// 而不是让"设置里多出一行没有名字的键"跑到真机上。
  it("默认表就是这七条，顺序即界面顺序", () => {
    expect(rust).toEqual([
      ["sticky", "Alt+1"],
      ["search", "Alt+2"],
      ["trash", "Alt+3"],
      ["settings", "Alt+4"],
      ["ring", "Alt+Space"],
      ["hide-all", "Alt+6"],
      ["show-all", "Alt+7"],
    ]);
  });
});
