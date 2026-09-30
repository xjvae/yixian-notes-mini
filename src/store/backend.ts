// Backend — store 与传输层之间的接缝。生产实现走 Tauri 命令；测试与将来的
// 预览台注入内存假体。store 对"数据从哪来"一无所知，也就不需要任何模式机。

import type { StickyInput, StickyNote } from "@/platform/contracts";
import {
  getBootstrap,
  stickyDelete,
  stickyList,
  stickyUpsert,
} from "@/platform/commands";

export interface NotesBackend {
  /** 首屏引导（一次 IPC 拿齐）；失败 = 主库不可用 */
  bootstrap(): Promise<StickyNote[]>;
  list(includeDeleted: boolean): Promise<StickyNote[]>;
  /** 落库一行。返回 Rust 盖完时间戳的权威版本 */
  upsert(input: StickyInput): Promise<StickyNote>;
  remove(id: string, hard: boolean): Promise<void>;
}

export function createTauriBackend(): NotesBackend {
  return {
    bootstrap: () => getBootstrap().then((b) => b.stickies),
    list: (includeDeleted) => stickyList(includeDeleted),
    upsert: (input) => stickyUpsert(input),
    remove: (id, hard) => stickyDelete(id, hard),
  };
}
