// 拖拽进组 — 把一扇便签窗拖到另一扇（或一叠）上松手就并进去。
//
// 为什么只能这么绕：**系统拖着窗走的时候鼠标被系统捕获，前端一个 pointermove 都收不到**，
// 更不知道"我此刻悬在谁上面"。手上只有两样东西：自己的 moved 事件流，和一份别窗矩形快照
// （`float_frames`）。命中判定只能在本地拿这两样算：
//  · **探针点**取自己的标题带中线：x = 自己左边 + 自身宽/2，y = 自己顶边 + 20 物理像素。
//    拖窗抓的就是标题带，而那条带在任何缩放下都不止 20 物理像素高 —— 不去抄
//    WindowChrome 的条高，抄一个数进来就是第二个真相；
//  · **真的按住了标题条才算**（pointerdown 才 arm）：开机恢复、贴边、滑出这些程序性摆位
//    一样会发 moved，不设这道闸就会把"窗被程序放回原位"读成"用户把它拖到别人身上"，
//    误并组是毁数据级的错，宁可漏判不误判；
//  · **松手没有事件**：moved 静默 180ms 就算松手（与贴边那侧同一条经验）。
//    有的环境拖完会补一个 pointerup，那只用来在"其实只是点了一下"时快速收摊。

import { useCallback, useEffect, useRef, useState } from "react";
import type { FloatFrame } from "@/platform/contracts";
import { floatFrames, groupList, stickyMergeInto } from "@/platform/commands";
import { currentWindow, currentWindowLabel } from "@/platform/bridge";
import { logger } from "@/platform/logger";
import { flushNow } from "@/store/notes-store";
import { useNotes } from "@/store/hooks";

const SCOPE = "merge";
/** 探针点离窗顶的物理像素：落在标题带里，又不用抄那条带的高度 */
const PROBE_INSET_PHYS = 20;
/** moved 静默多久算"松手了" */
const SETTLE_MS = 180;
/** 悬停条上的名字上限：窗最窄才 240 物理像素，名字一长那条胶囊就顶出纸外 */
const NAME_MAX = 12;

export interface MergeCandidate {
  frame: FloatFrame;
  /** 浮层上要说给用户看的名字（已按 NAME_MAX 截断） */
  name: string;
}

interface Point {
  x: number;
  y: number;
}

/**
 * 命中谁：探针点落在谁的矩形里（含边界）。自己不算。
 * 多个候选时叠窗优先（一叠是明确的容器），再按面积小的优先（指哪儿是哪儿），
 * 最后按 label 定序 —— 纯函数要可复现。
 */
export function pickMergeTarget(
  selfLabel: string,
  frames: readonly FloatFrame[],
  probe: Point,
): FloatFrame | null {
  const hits = frames.filter(
    (frame) =>
      frame.label !== selfLabel &&
      probe.x >= frame.x &&
      probe.x <= frame.x + frame.width &&
      probe.y >= frame.y &&
      probe.y <= frame.y + frame.height,
  );
  if (hits.length === 0) return null;
  return (
    [...hits].sort(
      (a, b) =>
        rank(a) - rank(b) || areaOf(a) - areaOf(b) || a.label.localeCompare(b.label),
    )[0] ?? null
  );
}

function rank(frame: FloatFrame): number {
  return frame.kind === "stack" ? 0 : 1;
}

function areaOf(frame: FloatFrame): number {
  return frame.width * frame.height;
}

/** 名字进胶囊前先裁：胶囊是"浮在纸上的一条字"，长了就顶出纸外变成第二个 bug */
function clip(name: string): string {
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name;
}

interface UseDragToGroup {
  /** 当前悬在谁身上；null = 没有候选（也意味着没在拖） */
  candidate: MergeCandidate | null;
}

/**
 * @param id      这一扇窗是哪张便签（拖走的就是它）
 * @param enabled 收起态/贴边态/动画期间关掉：那几趟 moved 都不是用户把窗往别人身上拖
 */
export function useDragToGroup(id: string, enabled: boolean): UseDragToGroup {
  const notes = useNotes();
  const [candidate, setCandidate] = useState<MergeCandidate | null>(null);
  const label = currentWindowLabel();
  const enabledRef = useRef(enabled);
  const armedRef = useRef(false);
  const movedRef = useRef(false);
  const settleRef = useRef<number | null>(null);
  const framesRef = useRef<FloatFrame[]>([]);
  const selfRef = useRef<FloatFrame | null>(null);
  const groupsRef = useRef<Map<string, string>>(new Map());
  const candidateRef = useRef<MergeCandidate | null>(null);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const nameOf = useCallback(
    (frame: FloatFrame): string => {
      if (frame.kind === "stack") {
        return clip(groupsRef.current.get(frame.id) ?? "那一叠");
      }
      const note = notes.find((row) => row.id === frame.id);
      const title = note?.title.trim() ?? "";
      return clip(title === "" ? "未命名便签" : title);
    },
    [notes],
  );

  const clearCandidate = useCallback((): void => {
    if (candidateRef.current === null) return;
    candidateRef.current = null;
    setCandidate(null);
  }, []);

  const settle = useCallback(async (): Promise<void> => {
    settleRef.current = null;
    armedRef.current = false;
    const hit = candidateRef.current;
    const dragged = movedRef.current;
    clearCandidate();
    if (hit === null || !dragged) return;
    try {
      // 先落自己的在途编辑：合并要销毁这一扇，晚一步那笔编辑就跟着窗没了
      await flushNow();
      await stickyMergeInto(id, hit.frame.id);
    } catch (error) {
      logger.caught(SCOPE, `拖到「${hit.name}」上并组失败`, error);
    }
  }, [clearCandidate, id]);

  const arm = useCallback((): void => {
    if (!enabledRef.current || armedRef.current) return;
    armedRef.current = true;
    movedRef.current = false;
    void (async () => {
      try {
        const [frames, groups] = await Promise.all([floatFrames(), groupList()]);
        groupsRef.current = new Map(
          groups.map((row) => [row.id, row.name.trim() === "" ? "未命名组合" : row.name]),
        );
        framesRef.current = frames;
        selfRef.current = frames.find((frame) => frame.label === label) ?? null;
      } catch (error) {
        logger.caught(SCOPE, "取浮窗矩形失败，这一趟不判拖拽进组", error);
        framesRef.current = [];
        selfRef.current = null;
      }
    })();
  }, [label]);

  const onMoved = useCallback(
    (position: Point): void => {
      if (!armedRef.current) return;
      movedRef.current = true;
      const self = selfRef.current;
      if (self === null) return;
      const probe = {
        x: position.x + self.width / 2,
        y: position.y + PROBE_INSET_PHYS,
      };
      const target = pickMergeTarget(label, framesRef.current, probe);
      const next: MergeCandidate | null = target
        ? { frame: target, name: nameOf(target) }
        : null;
      const same =
        (next === null && candidateRef.current === null) ||
        (next !== null && candidateRef.current?.frame.label === next.frame.label);
      if (!same) {
        candidateRef.current = next;
        setCandidate(next);
      }
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
      settleRef.current = window.setTimeout(() => void settle(), SETTLE_MS);
    },
    [label, nameOf, settle],
  );

  const onMovedRef = useRef(onMoved);
  useEffect(() => {
    onMovedRef.current = onMoved;
  });

  // moved 订阅：与 useWindowGeometry 各订各的（两条职责不同，不需要合一条流）
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const offMoved = await currentWindow().onMoved(({ payload }) => {
          onMovedRef.current({ x: payload.x, y: payload.y });
        });
        if (cancelled) offMoved();
        else off = offMoved;
      } catch {
        /* 非 Tauri 环境（单测）没有窗口事件，拖拽进组本就不存在 */
      }
    })();
    return () => {
      cancelled = true;
      off?.();
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target instanceof Element ? event.target : null;
      if (node !== null && node.closest("[data-tauri-drag-region]") !== null) arm();
    };
    const onPointerUp = (): void => {
      // 只是点了一下标题条（一动没动）：立刻收摊，别等那张表
      if (armedRef.current && !movedRef.current) {
        armedRef.current = false;
        clearCandidate();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [arm, clearCandidate]);

  return { candidate };
}
