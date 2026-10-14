// 命令名单对照 — 同一个命令名现在抄在三处：Rust 注册表（`lib.rs` 的 generate_handler）、
// 前端的调用封装（`platform/commands.ts`）、预览台的假核（`preview/fake-db.ts`）。
// 少一处就是"按了没反应"或"预览台上演不出来"，而这类缺失**编译与运行都不报错**。
// 所以这里抽三份名单硬碰硬，剩下真的没法在预览台演的走显式白名单（要写明为什么）。

// 三份源文件按原文读进来（Vite 的 `?raw`）：这个 tsconfig 里没有 node 类型，
// 用 node:fs 会同时崩了 tsc 与 eslint 的类型规则
import libRs from "../../src-tauri/src/lib.rs?raw";
import bridgeSource from "../platform/commands.ts?raw";
import fakeSource from "./fake-db.ts?raw";
import { describe, expect, it } from "vitest";

/** Rust 注册表里 `commands::<模块>::<命令>` 那一段（只在 generate_handler![…] 之内数） */
function rustCommands(): Set<string> {
  const start = libRs.indexOf("generate_handler![");
  if (start < 0) throw new Error("lib.rs 里找不到 generate_handler");
  const list = libRs.slice(start, libRs.indexOf("])", start));
  return new Set([...list.matchAll(/commands::\w+::(\w+)/g)].map((m) => m[1]));
}

/** 前端封装里真正 invoke 出去的命令名 */
function bridgeCommands(): Set<string> {
  return new Set(
    [...bridgeSource.matchAll(/invoke(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]),
  );
}

/** 假核 handle() 那个 switch 接住的命令名 */
function fakeCommands(): Set<string> {
  const start = fakeSource.indexOf("switch (cmd)");
  if (start < 0) throw new Error("fake-db 里找不到 switch (cmd)");
  const body = fakeSource.slice(start);
  return new Set([...body.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]));
}

/** 预览台**演不了**的那些：不是遗漏，是决定不演，所以每一条都得写下为什么。
 *  今天这一格是空的——三处名单现在逐字对得上，留着它是为了让以后真加不进假核的那一发
 *  必须在这里留一句理由，而不是悄悄少一个 case（少一个就是预览台上点了没反应的按钮） */
const NOT_IN_PREVIEW: Record<string, string> = {};

describe("命令名单三处对照", () => {
  const rust = rustCommands();
  const bridge = bridgeCommands();
  const fake = fakeCommands();

  it("三份名单都抽得出东西来（抽不到就是解析器漂了，不是代码漂）", () => {
    expect(rust.size).toBeGreaterThan(50);
    expect(bridge.size).toBeGreaterThan(40);
    expect(fake.size).toBeGreaterThan(40);
  });

  it("前端调的每一发都在 Rust 注册表里", () => {
    const missing = [...bridge].filter((name) => !rust.has(name)).sort();
    expect(missing, `commands.ts 调了 Rust 没注册的命令：${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("假核接住的名字都是真命令（不留再也对不上的旧 case）", () => {
    const extra = [...fake].filter((name) => !rust.has(name)).sort();
    expect(extra, `fake-db 里有 Rust 不认识的 case：${extra.join(", ")}`).toEqual([]);
  });

  it("Rust 注册的每一发要么假核演得了，要么在显式白名单里写明为什么演不了", () => {
    const gaps = [...rust]
      .filter((name) => !fake.has(name))
      .filter((name) => !(name in NOT_IN_PREVIEW))
      .sort();
    expect(
      gaps,
      `预览台演不出这些命令（补 case，或加进 NOT_IN_PREVIEW 并写清理由）：${gaps.join(", ")}`,
    ).toEqual([]);
    // 白名单里若有已经补上的或根本不存在的名字，一并报出来：过期白名单比没有更坏
    const stale = Object.keys(NOT_IN_PREVIEW).filter(
      (name) => fake.has(name) || !rust.has(name),
    );
    expect(stale, `白名单里这些条已经不作数了，删掉：${stale.join(", ")}`).toEqual([]);
  });

  it("前端调到的每一发假核都得演（预览台上不许有点了没反应的按钮）", () => {
    const gaps = [...bridge]
      .filter((name) => !fake.has(name))
      .filter((name) => !(name in NOT_IN_PREVIEW))
      .sort();
    expect(gaps, `预览台上点了没反应：${gaps.join(", ")}`).toEqual([]);
  });
});
