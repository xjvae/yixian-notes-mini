// 日志 — 分级 + 环形缓冲，warn/error 同时递给 Rust 落盘（发布版没有控制台，"点了没反应"
// 不落盘就等于没发生）。只落 warn 以上（每扇窗每次落库都刷一行，7 天保留期会被噪音吃掉）。
// 目录：`%APPDATA%\<标识>\logs\mini.log.YYYYMMDD`，按天一个、留 7 天。

import { logWrite } from "@/platform/commands";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RING_SIZE = 200;
const ring: string[] = [];

function push(level: LogLevel, scope: string, message: string): void {
  const line = `[${level}] ${scope}: ${message}`;
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  if (level === "warn" || level === "error") {
    // 不 await，也不接错误：日志通道自己坏了就是坏了——它正跑在别的错误处理那条路上，
    // 再绊一次就是把"看得见的问题"换成"卡死的窗"
    void logWrite(level, scope, message).catch(() => {});
  }
}

export const logger = {
  debug: (scope: string, message: string) => push("debug", scope, message),
  info: (scope: string, message: string) => push("info", scope, message),
  warn: (scope: string, message: string) => push("warn", scope, message),
  error: (scope: string, message: string) => push("error", scope, message),
  /** 记录被捕获的异常：消息 + 原始抛出物 */
  caught: (scope: string, message: string, error: unknown) =>
    push("error", scope, `${message} :: ${String(error)}`),
  /** 最近 RING_SIZE 条（崩溃转储用） */
  dump: (): readonly string[] => ring,
};
