// 便签窗内的"无操作"时钟上报 — 私密层自动上锁（`autolock.rs`）唯一的输入源。
//
// 口径是作者拍的"**便签内**无操作"：只有单窗与叠窗挂这一条，设置窗/搜索窗/回收站里
// 打字不算续期。挂在这两扇窗的根上而不是每个可点元素上——"这扇窗里刚有人动过"
// 要的是窗级事实，逐元素挂会漏掉滚轮与右键菜单。
//
// 节流：≤每 5 秒一次 IPC。自动锁的粒度是分钟，多报没有意义；而打字时每个字符
// 一次 IPC 会跟落库那条路挤在一起（私密便签那条尤其贵）。

import { useEffect } from "react";
import { privateNoteActivity } from "@/platform/commands";
import { logger } from "@/platform/logger";

const SCOPE = "note-activity";
const REPORT_EVERY_MS = 5000;
/** 三种都算"有人在用这扇窗"：按下、敲键、滚轮（光看不滚也算动过） */
const EVENTS = ["pointerdown", "keydown", "wheel"] as const;

export function useNoteActivity(): void {
  useEffect(() => {
    let last = 0;
    const report = (): void => {
      const now = Date.now();
      if (now - last < REPORT_EVERY_MS) return;
      last = now;
      void privateNoteActivity().catch((error: unknown) =>
        // 报不上去只是这一次不续期，最坏结果是被按时锁掉——不打扰用户
        logger.caught(SCOPE, "无操作时钟上报失败", error),
      );
    };
    // capture：正文里那些 stopPropagation 的编辑控件不许把这一声挡掉
    for (const name of EVENTS) {
      window.addEventListener(name, report, { capture: true, passive: true });
    }
    return () => {
      for (const name of EVENTS) {
        window.removeEventListener(name, report, { capture: true });
      }
    };
  }, []);
}
