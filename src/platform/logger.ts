// 日志 — 分级 + 环形缓冲。**前端这份不落盘**（原来这里写着"落盘随 ROADMAP 加入"，
// 一直没做，那句话就是在骗人）：发布版没有控制台，`console.*` 出了窗就没人接得住。
// 所以要还原现场，读 Rust 那份文件日志（`%APPDATA%\<标识>\logs\mini.log.YYYYMMDD`，
// 按天一个、留 7 天）——命令两端都记账就是为了让这条路走得通。
// 这份内存缓冲留着有两个用处：窗内的错误界面与 `dump()`（崩溃转储时才有意义）。

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
