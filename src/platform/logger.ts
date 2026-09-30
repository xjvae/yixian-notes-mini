// 日志 — 分级 + 环形缓冲。落盘随 ROADMAP 加入（Rust 侧文件日志先行，
// 前端日志先只进内存缓冲 + console，发布版没有控制台时靠崩溃转储取）。

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
