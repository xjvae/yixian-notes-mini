// React 绑定 — useSyncExternalStore 之上的读钩子。getSnapshot 的引用稳定性由
// store 保证（实体未更新时返回同一对象），所以这里不需要再 memo。

import { useSyncExternalStore } from "react";
import type { StickyNote } from "@/platform/contracts";
import {
  getHydrationError,
  getNote,
  getNotesSnapshot,
  isStoreReady,
  subscribe,
} from "@/store/notes-store";

/** 单便签订阅。id 为 null 或实体不存在时返回 null */
export function useNote(id: string | null): StickyNote | null {
  return useSyncExternalStore(subscribe, () => (id === null ? null : getNote(id)));
}

/** 全量列表订阅（回收站/搜索/将来的一切列表视图） */
export function useNotes(): readonly StickyNote[] {
  return useSyncExternalStore(subscribe, getNotesSnapshot);
}

/** 就绪态订阅（入口错误界面用）。拆成原语快照：对象字面量每次都是新引用，会触发重渲染循环 */
export function useStoreStatus(): { ready: boolean; error: unknown } {
  const ready = useSyncExternalStore(subscribe, isStoreReady);
  const error = useSyncExternalStore(subscribe, getHydrationError);
  return { ready, error };
}
