// 引导气泡 — 320×168 无边框透明置顶小窗（`windows/guide.rs`），一步一停，卡片+箭头指着真东西。
// **不遮罩**：Tauri 的点击穿透是整窗开关（`set_ignore_cursor_events` 没有区域粒度），
// 做不出"遮罩上挖一个能点的洞"，所以引导期间桌面上那张便签照样能点、能拖。
// 每步换两样：卡片内容 + **这扇窗自己的位置**（`spotFor` 问几何、`setWindowFrame` 把自己搬过去）。
// 关 = 销毁，下次开都从第一步起；销账在 Rust 那条 close 命令里做。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentWindow, listen, setWindowFrame } from "@/platform/bridge";
import {
  floatFrames,
  guideDemoNote,
  guideReleaseRing,
  guideShowRing,
  hookStatus,
  hotkeyList,
  monitorWorkArea,
  privateStatus,
  trayRect,
} from "@/platform/commands";
import { logger } from "@/platform/logger";
import { GUIDE_STEPS, type Anchor, type GuideFacts } from "@/features/guide/steps";

/** 与 `windows/guide.rs` 的 BUBBLE_SIZE 同值（逻辑像素）：出生高，也是下限；三行文案放不下时按实测高往下长（见量高 effect） */
const BUBBLE = { w: 320, h: 168 };
/** 卡片到窗边的内缩，与 `index.css` 的 `.g-bubble { inset: 6px }` 同值 */
const INSET = 6;
/** 气泡与目标之间留的缝：箭头占掉一部分，别把目标压住 */
const GAP = 14;
/** 夹回工作区时留的边 */
const EDGE = 8;
/** 等"那张纸落下来"时问浮窗表的间隔（毫秒）。只有第三步挂着，落成就停 */
const LOOK_MS = 300;
/** 指着便签的那几步的回头看间隔（毫秒）：他拖着那张走时气泡要跟得上 */
const FOLLOW_MS = 120;
/** 哪些锚点要跟着走：只有指着便签那一种。环与卡、托盘的位置都不会动 */
const TRACKED: ReadonlySet<Anchor["kind"]> = new Set<Anchor["kind"]>(["note"]);

/** `guide_show_ring` 的回报：屏幕上那只环的真实中心与半径（逻辑像素） */
interface RingSpot {
  cx: number;
  cy: number;
  half: number;
}

type Dir = "up" | "down" | "left" | "right" | null;

interface Spot {
  x: number;
  y: number;
  dir: Dir;
  /**
   * 箭头离气泡左边的距离（逻辑像素），只有托盘那格用得上：图标贴屏幕边时气泡被 `fit`
   * 夹回来就不再以它为中轴，不补这个偏移箭头指的就是空地。没给就按 CSS 的居中走。
   */
  arrowX?: number;
}

interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 越界就贴回工作区内侧：宁可挡住一点，也不许把气泡甩到屏外够不着 */
function fit(area: Area, x: number, y: number, h: number): { x: number; y: number } {
  return {
    x: Math.round(
      Math.min(
        Math.max(x, area.x + EDGE),
        Math.max(area.x + EDGE, area.x + area.w - BUBBLE.w - EDGE),
      ),
    ),
    y: Math.round(
      Math.min(
        Math.max(y, area.y + EDGE),
        Math.max(area.y + EDGE, area.y + area.h - h - EDGE),
      ),
    ),
  };
}

/**
 * 这一步摆在哪（窗左上角，逻辑像素）。`monitor_work_area`/`float_frames` 报的是**物理像素**，
 * 而 `setWindowFrame` 吃逻辑像素，先除缩放系数再算；`taught` 是这一步教出来的那张便签的窗 label。
 * 任何一处问不到都退回屏幕正中：摆错位置只是不贴切，摆不出来是"引导打不开"，那严重得多。
 */
async function spotFor(
  anchor: Anchor,
  ring: RingSpot | undefined,
  taught: string | null,
  h: number,
): Promise<Spot> {
  const scale = await currentWindow()
    .scaleFactor()
    .catch(() => 1);
  const px = (v: number): number => Math.round(v / (scale || 1));
  const area = await monitorWorkArea().catch(() => null);
  const wa: Area = area
    ? { x: px(area.x), y: px(area.y), w: px(area.width), h: px(area.height) }
    : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const mid: Spot = {
    ...fit(wa, wa.x + (wa.w - BUBBLE.w) / 2, wa.y + (wa.h - h) / 2, h),
    dir: null,
  };

  switch (anchor.kind) {
    case "center":
      return mid;
    case "top":
      return { ...fit(wa, wa.x + (wa.w - BUBBLE.w) / 2, wa.y + 10, h), dir: "down" };
    case "ring":
      // 中心与半径都是 Rust 读窗的实际外框给的，不在这儿猜；拿不到就退回正中
      if (ring === undefined) return mid;
      return {
        ...fit(
          wa,
          ring.cx + ring.half + GAP,
          // 0.55 是**近似**：格子真实半径前端算得出（SVG 那份），但跨语言再抄一份数值容易漂，
          // 气泡贴到盘的上半部已经足够指对东西
          anchor.cell === "top" ? ring.cy - ring.half * 0.55 - h / 2 : ring.cy - h / 2,
          h,
        ),
        dir: "left",
      };
    case "tray": {
      // 图标归 Explorer 所有、没有句柄，只有 UIA 报得出矩形（`tray.rs::icon_rect`）；
      // 问不到（被收进溢出面板等）才退工作区右下角
      const rect = await trayRect().catch(() => null);
      if (rect !== null && rect.width > 0) {
        const ix = px(rect.x);
        const iy = px(rect.y);
        const iw = px(rect.width);
        const center = ix + iw / 2;
        const pos = fit(wa, center - BUBBLE.w / 2, iy - GAP - h, h);
        // 箭头钉在图标中心上（气泡被夹过就跟着偏），两头各留 12 像素别掉出卡片
        return {
          ...pos,
          dir: "down",
          arrowX: Math.round(Math.min(Math.max(center - pos.x, 12), BUBBLE.w - 12)),
        };
      }
      return {
        ...fit(wa, wa.x + wa.w - BUBBLE.w - 12, wa.y + wa.h - h - 12, h),
        dir: "down",
      };
    }
    case "note": {
      const frames = await floatFrames().catch(() => []);
      // `float_frames` 是遍历 webview 的 map 出来的，**顺序不固定**，必须排序：
      // id 是 `s` + 十六进制毫秒 + 序号，按 label 从新到旧排就是按创建先后排
      const byNewLabel = (a: { label: string }, b: { label: string }): number =>
        b.label.localeCompare(a.label);
      const newestFirst = [...frames].sort(byNewLabel);
      // **教出来的那一张在哪一档形态里都算**：贴边收成细丝、收起成栏还是它，气泡要一路跟着
      const taughtFrame =
        taught === null ? undefined : newestFirst.find((f) => f.label === taught);
      // 只有"不知道是哪一张"时才挑正常大小的：贴着来路不明的细丝讲事情，看着就是摆错了地方
      const roomy = newestFirst.filter((f) => f.width >= 100 && f.height >= 100);
      const target = taughtFrame ?? roomy[0] ?? newestFirst[0];
      if (target === undefined) return mid;
      const nx = px(target.x);
      const ny = px(target.y);
      const nw = px(target.width);
      const nh = px(target.height);
      // 优先摆右边（箭头朝左指它），右侧放不下摆左边，两边都不行摆下边
      if (nx + nw + GAP + BUBBLE.w <= wa.x + wa.w) {
        return { ...fit(wa, nx + nw + GAP, ny, h), dir: "left" };
      }
      if (nx - GAP - BUBBLE.w >= wa.x) {
        return { ...fit(wa, nx - GAP - BUBBLE.w, ny, h), dir: "right" };
      }
      return { ...fit(wa, nx, ny + nh + GAP, h), dir: "up" };
    }
  }
}

async function closeWindow(): Promise<void> {
  const { closeGuideWindow } = await import("@/platform/commands");
  await closeGuideWindow().catch(() => {});
}

export function GuideBubble() {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<Dir>(null);
  /** 箭头的水平落点（只有托盘那一格会给）。null = 按 CSS 居中 */
  const [arrowX, setArrowX] = useState<number | null>(null);
  /** 引导正占着环（讲环的那两步）：离开时要放开闸门并把环收掉 */
  const ringHeldRef = useRef(false);
  /** 开场这一刻桌面上已经开着哪些浮窗；之后新冒出来的那一扇才是"这一步教出来的那张" */
  const baselineRef = useRef<Set<string> | null>(null);
  /** 教出来的那张便签的窗 label，摆位时优先指着它 */
  const [taught, setTaught] = useState<string | null>(null);
  /** 演示便签按"要几张"各试过没有（建失败也算试过，别每步重试） */
  const demoTriedRef = useRef(new Set<number>());
  const total = GUIDE_STEPS.length;
  const step = GUIDE_STEPS[Math.min(index, total - 1)];
  const last = index === total - 1;
  /** 讲环那几步问到的环位：跟着走只重算便签，不该每次都去唤一只新环 */
  const ringRef = useRef<RingSpot | undefined>(undefined);
  /** 上一次真写进窗里的那个数：一样就不搬，省得每 120 毫秒撞一次 SetWindowPos */
  const writtenRef = useRef<{ x: number; y: number; h: number } | null>(null);
  /** 只有最晚问的那一趟算数：拖拽期间回头看会叠着好几趟没走完 */
  const seqRef = useRef(0);
  /** 里面那张卡（用来量这一屏到底要多高） */
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** 这一屏要的窗高（逻辑像素，下限 168）。摆位与搬窗都读它 */
  const hRef = useRef(BUBBLE.h);
  /** 这台机器上的事实（阈值 / 劫持开没开 / 键位表）。null = 还没读到，文案自己兜底 */
  const [facts, setFacts] = useState<GuideFacts | null>(null);

  // 读事实失败不算错：文案退回不依赖这些数的说法。第一条命令挂了不能让引导整扇开不起来
  useEffect(() => {
    void (async () => {
      const [hook, hotkeys, vault] = await Promise.all([
        hookStatus().catch(() => null),
        hotkeyList().catch(() => []),
        privateStatus().catch(() => null),
      ]);
      if (hook === null) return;
      setFacts({
        holdMs: hook.holdMs,
        hookPaused: hook.paused,
        hotkeys,
        privateConfigured: vault?.configured === true,
        revealedCount: vault?.revealed.length ?? 0,
      });
    })();
  }, []);

  const lines = typeof step.lines === "function" ? step.lines(facts) : step.lines;

  // 演示便签：讲便签的那几步**必须有"这张"**，并叠那一步还必须有"另一张"。
  // 他自己建出来的那张（`taught`）优先，没有就建——**哪怕桌上本来就开着别的纸也建**：
  // 那几步说的是"这张"，指到来路不明的旧纸上讲换类讲长高都不对号。
  // 并叠要两张：除"这张"外一张都不剩时才补。每种只试一次；建出来的由 `close_guide_window` 硬删。
  useEffect(() => {
    if (step.anchor.kind !== "note") return;
    const need = step.demoNeeds ?? 1;
    if (demoTriedRef.current.has(need)) return;
    demoTriedRef.current.add(need);
    void (async () => {
      if (need === 1) {
        if (taught !== null) return;
      } else {
        const frames = await floatFrames().catch(() => []);
        // "另一张"的口径：正常大小的（细丝与收起态不拿来讲并叠）、不是"这张"本身
        if (frames.some((f) => f.label !== taught && f.width >= 100 && f.height >= 100)) {
          return;
        }
      }
      const label = await guideDemoNote(need);
      // 进基线：它是"引导自己造的"，不该被第三步那条"新落下来的那张纸"认领去翻页
      baselineRef.current?.add(label);
      if (need === 1) setTaught(label);
      // need=2 不用在这儿搬窗：这一步本来就挂着 120 毫秒的回头看
    })().catch((error: unknown) => {
      logger.caught("guide", "演示便签没建出来（那几步退回屏幕正中）", error);
    });
  }, [step, taught]);

  /** 算一次位并搬过去。搬不动只记一行：内容照样换，气泡停在原地——那比"这一步没出来"好得多 */
  const place = useCallback(async (): Promise<void> => {
    const seq = (seqRef.current += 1);
    const h = hRef.current;
    try {
      const spot = await spotFor(step.anchor, ringRef.current, taught, h);
      if (seq !== seqRef.current) return;
      const before = writtenRef.current;
      if (
        before !== null &&
        before.x === spot.x &&
        before.y === spot.y &&
        before.h === h
      ) {
        return;
      }
      writtenRef.current = { x: spot.x, y: spot.y, h };
      setDir(spot.dir);
      setArrowX(spot.arrowX ?? null);
      await setWindowFrame(spot.x, spot.y, BUBBLE.w, h);
    } catch (error: unknown) {
      logger.caught("guide", "这一步没摆到位（内容已换）", error);
    }
  }, [step, taught]);

  // 最新那份 place（给量高 effect 用，免得为触发重算往 place 里塞假依赖）。
  // 晚一拍同步不要紧：量高只在真换档时搬窗，那一趟要么本来就会跑，要么被 seq 序号挡回
  const placeRef = useRef(place);
  useEffect(() => {
    placeRef.current = place;
  }, [place]);

  // 量这一屏要多高：三行文案在 168 里装不下（实测内容要 170），透明窗把矩形以外全裁走——裁的正是最后一行和「知道了」钮。
  // 高 = scrollHeight（含内边距不含描边）+ 窗边到内容边的全部厚度（内缩 + 描边）；描边从 computed style 读不写死。
  // **不写依赖数组**：有几行、每行折几行、事实异步读到没读到，都只体现在卡片此刻的布局里（事实到那一下 step 没换）。
  // place 自己会比上次落点与高度，真换档才写窗，每渲染问一次不吵
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    const style = getComputedStyle(card);
    const chrome =
      INSET * 2 +
      (parseFloat(style.borderTopWidth) || 0) +
      (parseFloat(style.borderBottomWidth) || 0);
    const need = Math.max(BUBBLE.h, card.scrollHeight + chrome);
    if (need === hRef.current) return;
    hRef.current = need;
    // 换档了就必须重写一次：左上角可能没动，被裁的那截也正是在下缘
    writtenRef.current = null;
    void placeRef.current();
  });

  // 换步：先把环放开或唤出来，再搬窗
  useEffect(() => {
    let cancelled = false;
    // 换步 = 重新认一次位置（"跟着走"只在这一步之内成立）
    writtenRef.current = null;
    void (async () => {
      try {
        const wantsRing = step.anchor.kind === "ring";
        // 离开讲环的那几步：闸门放下、环还开着就收掉（它是被引导占着的，不该留在桌上）
        if (ringHeldRef.current && !wantsRing) {
          ringHeldRef.current = false;
          await guideReleaseRing().catch(() => {});
        }
        ringRef.current = wantsRing ? await guideShowRing() : undefined;
        if (wantsRing) ringHeldRef.current = true;
        if (cancelled) return;
        await place();
      } catch (error: unknown) {
        logger.caught("guide", "这一步没摆到位（内容已换）", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, place]);

  // 指着便签的那几步要**跟着走**：系统拖着窗走时前端收不到 pointermove，别的窗的 moved 也不发给这一扇
  // ——只能按一个不算快的间隔回头看它。回头走同一趟 place：没挪地方就不写窗，表挂一整步也不吵
  useEffect(() => {
    if (!TRACKED.has(step.anchor.kind)) return;
    const timer = window.setInterval(() => void place(), FOLLOW_MS);
    return () => window.clearInterval(timer);
  }, [step, place]);

  // 开场拍一张浮窗底：桌面上原本开着哪几张。这一步之后新出现的那一扇才算"落下来的那张纸"，
  // 拿 label 比而不是拿"最新 id"比——省掉了对 id 单调性的所有假设
  useEffect(() => {
    void (async () => {
      const frames = await floatFrames().catch(() => []);
      baselineRef.current ??= new Set(frames.map((f) => f.label));
    })();
  }, []);

  // 有两步不靠点「下一步」推进，而是等真事：第一步等 `ring:open`（Rust 每次开盘都广播，不用猜），第三步等窗落下。
  // 第三步尤其要等**窗**而不是库里的写：便签先写库再开窗、窗是隐藏建好等 `float_reveal` 才亮——
  // 只盯 `db:changed` 会把气泡搬到他还没看见的那张上。监听只在该挂着的那一步挂着，兜底开环不会多推一页
  useEffect(() => {
    const mode = step.advanceOn;
    if (mode === undefined) return;
    let cancelled = false;
    let off: (() => void) | null = null;
    let timer = 0;
    const bump = (): void => setIndex((i) => Math.min(i + 1, total - 1));

    if (mode === "ring-open") {
      void listen("ring:open", () => {
        if (!cancelled) bump();
      }).then((unlisten) => {
        if (cancelled) unlisten();
        else off = unlisten;
      });
      return () => {
        cancelled = true;
        off?.();
      };
    }

    const look = async (): Promise<void> => {
      const frames = await floatFrames().catch(() => []);
      if (cancelled) return;
      const labels = frames.map((f) => f.label);
      const seen = baselineRef.current ?? new Set(labels);
      baselineRef.current = seen;
      const fresh = labels.find((label) => !seen.has(label));
      if (fresh === undefined) {
        timer = window.setTimeout(look, LOOK_MS);
        return;
      }
      // 认领掉它：这张纸之后一直开着，别让别的步骤再把它当"刚落下的"翻一次页
      seen.add(fresh);
      setTaught(fresh);
      bump();
    };
    timer = window.setTimeout(look, LOOK_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [step, total]);

  /** 关引导：先放开占着的环，再销毁这扇窗 */
  const quit = useCallback((): void => {
    if (ringHeldRef.current) {
      ringHeldRef.current = false;
      void guideReleaseRing().catch(() => {});
    }
    void closeWindow();
  }, []);

  const next = useCallback((): void => {
    if (last) {
      quit();
      return;
    }
    setIndex((i) => Math.min(i + 1, total - 1));
  }, [last, quit, total]);

  const prev = useCallback((): void => {
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        prev();
      } else if (event.key === "Escape") {
        quit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, quit]);

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden">
      {dir !== null && (
        <span
          className="g-arrow"
          data-dir={dir}
          style={arrowX === null ? undefined : { left: `${arrowX}px` }}
        />
      )}
      {/* key 换步 = 卡片重挂载 = 淡入重演一次；关掉系统动画时它是完整可见的（见 index.css） */}
      <div key={step.id} ref={cardRef} className="g-bubble g-bubble-in">
        <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
          <h1 className="text-[13px] font-semibold">{step.title}</h1>
          <span className="text-[10px] text-[var(--panel-muted)]" aria-live="polite">
            {index + 1} / {total}
          </span>
        </div>
        <ul className="flex flex-col" style={{ gap: 3 }}>
          {lines.map((line) => (
            <li key={line} className="text-[11px] leading-4 text-[var(--panel-ink)]">
              {line}
            </li>
          ))}
        </ul>
        <div className="mt-auto flex items-center justify-between">
          <button
            type="button"
            onClick={quit}
            className="text-[11px] text-[var(--panel-muted)] underline-offset-2 hover:underline"
          >
            跳过
          </button>
          <div className="flex items-center" style={{ gap: 6 }}>
            <button
              type="button"
              onClick={prev}
              disabled={index === 0}
              className="rounded-md border border-[var(--panel-border)] px-2 py-1 text-[11px] hover:bg-[var(--panel-hover)] disabled:opacity-40"
            >
              上一步
            </button>
            <button
              type="button"
              onClick={next}
              className="rounded-md border border-[var(--panel-ink)] px-2.5 py-1 text-[11px] font-semibold hover:bg-[var(--panel-hover)]"
            >
              {last ? "知道了" : "下一步"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
