// React 绑定 — useSyncExternalStore 之上的读钩子。getSnapshot 的引用稳定性由
// store 保证（实体未更新时返回同一对象），所以这里不需要再 memo。

import { useSyncExternalStore } from "react";
import type { StickyNote } from "@/platform/contracts";
import {
  getFailedSnapshot,
  getHydrationError,
  getMembersSnapshot,
  getNote,
  getNotesSnapshot,
  getTitlesSnapshot,
  isStoreReady,
  subscribe,
} from "@/store/notes-store";

const EMPTY_NOTES: readonly StickyNote[] = [];

/** 单便签订阅。id 为 null 或实体不存在时返回 null */
export function useNote(id: string | null): StickyNote | null {
  return useSyncExternalStore(subscribe, () => (id === null ? null : getNote(id)));
}

/** 全量列表订阅（回收站与搜索都用它，叠窗的成员也从这里算） */
export function useNotes(): readonly StickyNote[] {
  return useSyncExternalStore(subscribe, getNotesSnapshot);
}

/** 某一叠的成员订阅。引用只在"这一叠的成员或内容"变化时才换——
 *  别的叠里敲一个字不再带着整扇叠窗重渲（全量 useNotes() 会） */
export function useGroupMembers(groupId: string | null): readonly StickyNote[] {
  return useSyncExternalStore(subscribe, () =>
    groupId === null ? EMPTY_NOTES : getMembersSnapshot(groupId),
  );
}

/** 只要 "id → 标题" 那一份（引用稳定性由 store 那一格保证：改正文不换引用）。
 *  拖拽进组的悬停胶囊要认名字，用它订阅就别因为别人敲了一个字带着整扇窗重渲 */
export function useNoteTitles(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, getTitlesSnapshot);
}

/** 就绪态订阅（入口错误界面用）。拆成原语快照：对象字面量每次都是新引用，会触发重渲染循环 */
export function useStoreStatus(): { ready: boolean; error: unknown } {
  const ready = useSyncExternalStore(subscribe, isStoreReady);
  const error = useSyncExternalStore(subscribe, getHydrationError);
  return { ready, error };
}

/** 落库失败的实体 id（引用稳定快照）。非空 = 反馈条要亮 */
export function useWriteFailures(): readonly string[] {
  return useSyncExternalStore(subscribe, getFailedSnapshot);
}
