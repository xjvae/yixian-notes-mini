// RingMenu — 星环：长按右键松手后在按下点绽开的 4 节点直达盘。
//
// 移植自旧实现（features/radial/menu.tsx），几何、扇区、充电弧、入场动画、
// 错峰、键盘交互全部照旧；适配只有三处：
//  · 五格 → 四格（上=新建便签、右=搜索、下=回收站、左=设置，正交四方位）；
//    强调色的错峰取 [-7, 7, -3, 3]（原五格 [-14,-6,0,6,14] 的等距中置版）；
//  · 旧版"唤起意图"（get_radial_action / popup:action）在本项目没有对应后端，
//    唤起一律停在主菜单；充电弧事件链等价移植（ring:charging / ring:up / ring:open
//    / ring:dismiss，由钩子的消费线程广播）；
//  · 新建便签不带类型参数（四类切换在便签窗工具条上，环上不重复）。
//
// 收场四条：点节点、点环外空白、Esc、盘外左键（钩子转 ring:dismiss）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListChecks, Search, Settings2, Trash2, X } from "lucide-react";
import { createFloatingSticky } from "@/platform/commands";
import { RING_INK } from "@/data/theme";
import { useScheme, type ResolvedScheme } from "@/data/scheme";
import { logger } from "@/platform/logger";
import { listen } from "@/platform/bridge";
import {
  closeRingWindow,
  openSearchWindow,
  openSettingsWindow,
  openTrashWindow,
} from "@/platform/commands";

type NodeId = "sticky" | "search" | "trash" | "settings";

interface RingNode {
  id: NodeId;
  label: string;
  icon: typeof ListChecks;
}

/** 起始角 -90°、step 90°：顺序即方位（正上 → 正右 → 正下 → 正左） */
const NODES: RingNode[] = [
  { id: "sticky", label: "新建便签", icon: ListChecks },
  { id: "search", label: "搜索", icon: Search },
  { id: "trash", label: "回收站", icon: Trash2 },
  { id: "settings", label: "设置", icon: Settings2 },
];

/** 中心核：只做「取消」，不做快速捕获 */
const CORE_LABEL = "取消";

/** 充电弧几何：绕锚点一圈半径 14px 的弧，整块只占 40×40 */
const ARC_RADIUS = 14;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;

const FALLBACK_PRIMARY = { h: 155, s: 35, l: 46 };
/** 深色盘的回退主色：读不到变量时也不该拿浅色的深绿去压深底 */
const FALLBACK_PRIMARY_DARK = { h: 155, s: 28, l: 52 };

function parseHsl(input: string | null | undefined, fallback = FALLBACK_PRIMARY) {
  if (!input) return fallback;
  // 兼容 `hsl(155 35% 46%)` 与 `hsl(155, 35%, 46%)` 两种分隔
  const m = input.match(/hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)/i);
  if (!m) return fallback;
  return {
    h: (parseFloat(m[1]) + 360) % 360,
    s: Math.min(100, Math.max(0, parseFloat(m[2]))),
    l: Math.min(100, Math.max(0, parseFloat(m[3]))),
  };
}

function readPrimary(scheme: ResolvedScheme) {
  const fallback = scheme === "dark" ? FALLBACK_PRIMARY_DARK : FALLBACK_PRIMARY;
  try {
    return parseHsl(
      getComputedStyle(document.documentElement).getPropertyValue("--primary"),
      fallback,
    );
  } catch (error) {
    logger.caught("ring", "读取主题主色失败，使用回退色", error);
    return fallback;
  }
}

function hex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) =>
    ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const p = (v: number) =>
    Math.round(255 * Math.min(1, Math.max(0, f(v))))
      .toString(16)
      .padStart(2, "0");
  return `#${p(0)}${p(8)}${p(4)}`;
}

function hexToRgb(hexStr: string): string {
  const c = hexStr.replace("#", "");
  return `${parseInt(c.slice(0, 2), 16)},${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)}`;
}

function useUnit(): number {
  // 初值由 window 尺寸直接算，不在 effect 里 setState（少一轮渲染）
  const [size, setSize] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        setSize({ w: window.innerWidth, h: window.innerHeight }),
      );
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, []);
  const min = Math.max(280, Math.min(size.w, size.h));
  return Math.min(1.6, Math.max(0.62, min / 360));
}

function sectorPath(
  cx: number,
  cy: number,
  a0: number,
  a1: number,
  r1: number,
  r2: number,
): string {
  const rad = (d: number) => (d * Math.PI) / 180;
  const px = (d: number, r: number) => cx + r * Math.cos(rad(d));
  const py = (d: number, r: number) => cy + r * Math.sin(rad(d));
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${px(a0, r1)} ${py(a0, r1)}`,
    `L ${px(a0, r2)} ${py(a0, r2)}`,
    `A ${r2} ${r2} 0 ${large} 1 ${px(a1, r2)} ${py(a1, r2)}`,
    `L ${px(a1, r1)} ${py(a1, r1)}`,
    `A ${r1} ${r1} 0 ${large} 0 ${px(a0, r1)} ${py(a0, r1)}`,
    "Z",
  ].join(" ");
}

export function RingMenu() {
  const [hover, setHover] = useState<NodeId | null>(null);
  const [cursor, setCursor] = useState(0);
  const [entered, setEntered] = useState(false);
  /** 充电弧四态：off=不画；on=扫；full=满环呼吸；up=淡出 */
  const [charging, setCharging] = useState<"off" | "on" | "full" | "up">("off");
  const [chargingMs, setChargingMs] = useState(450);
  const [notice, setNotice] = useState("");
  // 防重入：Enter 与鼠标点击几乎同时到达时会开两扇窗，锁掉第二次
  const busyRef = useRef(false);
  const unit = useUnit();
  // 星环跑在透明窗口里，扇区/标签/提示是 SVG 属性与内联样式，
  // CSS 深色层覆盖不住，只能按方案取（盘面本身走 index.css 的 .radial-disc）
  const scheme = useScheme();
  const ring = RING_INK[scheme.resolved];

  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 20);
    return () => window.clearTimeout(t);
  }, []);

  // 钩子事件链：到阈值 → charging（带此刻生效的阈值）；松手 → up；盘亮 → open；
  // 盘驻留时盘外左键 → dismiss
  useEffect(() => {
    let cancelled = false;
    let unCharge: (() => void) | undefined;
    let unUp: (() => void) | undefined;
    let unOpen: (() => void) | undefined;
    let unDismiss: (() => void) | undefined;
    void (async () => {
      if (cancelled) return;
      unCharge = await listen<number>("ring:charging", (holdMs) => {
        setNotice("");
        setChargingMs(holdMs);
        setCharging("on");
      });
      unUp = await listen("ring:up", () => {
        // 没亮过就不动：盘驻留期间再按一次右键也会发这条，
        // 那时弧根本没画，收到就收窗等于把用户的盘抢走
        setCharging((cur) => (cur === "off" ? "off" : "up"));
      });
      unOpen = await listen("ring:open", () => {
        setNotice("");
        // 盘要绽开了，充电态必须先下台：charging !== "off" 时渲染的是
        // "只有弧"那一棵树，留着它盘就永远出不来
        setCharging("off");
      });
      unDismiss = await listen("ring:dismiss", () => {
        void closeMenu();
      });
    })().catch(() => {});
    return () => {
      cancelled = true;
      unCharge?.();
      unUp?.();
      unOpen?.();
      unDismiss?.();
    };
    // closeMenu 是模块级稳定引用，不进依赖数组
  }, []);

  // 扫满就转"满环微呼吸"：用 effect + 定时器而不是 CSS delay——阈值可改，
  // CSS 里写死的数迟早和运行时不一致
  useEffect(() => {
    if (charging !== "on") return;
    const t = window.setTimeout(() => setCharging("full"), chargingMs);
    return () => window.clearTimeout(t);
  }, [charging, chargingMs]);

  // 淡出 90ms 后收窗
  useEffect(() => {
    if (charging !== "up") return;
    const t = window.setTimeout(() => {
      setCharging("off");
      void closeMenu();
    }, 90);
    return () => window.clearTimeout(t);
  }, [charging]);

  const close = useCallback(() => {
    void closeMenu();
  }, []);

  const runSticky = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setNotice("");
    try {
      await createFloatingSticky();
      close();
    } catch (error) {
      logger.caught("ring", "新建便签失败", error);
      setNotice("便签没有建成，请稍后再试");
    } finally {
      // 延迟释放锁，确保同一次操作不会被快速重复触发
      window.setTimeout(() => {
        busyRef.current = false;
      }, 400);
    }
  }, [close]);

  const runWindow = useCallback(
    async (open: () => Promise<void>, label: string) => {
      setNotice("");
      try {
        await open();
      } catch (error) {
        logger.caught("ring", `打开${label}窗失败`, error);
        setNotice(`${label}没有打开，请稍后再试`);
        return;
      }
      close();
    },
    [close],
  );

  /** 一格 = 一个去处 */
  const activate = useCallback(
    (node: RingNode) => {
      if (node.id === "sticky") {
        void runSticky();
        return;
      }
      if (node.id === "search") {
        void runWindow(openSearchWindow, "搜索");
        return;
      }
      if (node.id === "trash") {
        void runWindow(openTrashWindow, "回收站");
        return;
      }
      if (node.id === "settings") {
        void runWindow(openSettingsWindow, "设置");
      }
    },
    [runSticky, runWindow],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= NODES.length) {
        const index = n - 1;
        setCursor(index);
        const node = NODES[index];
        if (node) activate(node);
        return;
      }
      if (e.key === "Escape") {
        // 中心核的「取消」键：环上唯一的全局退出键
        close();
        return;
      }
      if (e.key === "Enter") {
        const node = NODES[cursor];
        if (node) activate(node);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => (c + 1) % NODES.length);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c - 1 + NODES.length) % NODES.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, close, activate]);

  // 主色从 CSS 变量读（--primary 在深色层换档），方案一变就重读
  const primary = useMemo(() => readPrimary(scheme.resolved), [scheme.resolved]);
  const accent = (i: number) => {
    const h = (primary.h + [-7, 7, -3, 3][i] + 360) % 360;
    const s = primary.s;
    const base = hex(h, s, Math.min(86, primary.l + 12));
    // 浅色盘上"更醒目 = 更深一档"，深色盘方向反过来（同一档明度差）
    const solid =
      scheme.resolved === "dark"
        ? hex(h, s, Math.min(92, primary.l + 26))
        : hex(h, s, Math.max(13, primary.l - 3));
    return { base, solid };
  };

  const SEG = 360 / NODES.length;
  const SIZE = 300;
  const C = SIZE / 2;
  const R_CORE = 62 * unit;
  const R_IN = 78 * unit;
  const R_OUT = 148 * unit;
  const LABEL_OFF = 110 * unit;
  const coreRgba = (a: number) => `rgba(${hexToRgb(accent(2).base)},${a})`;

  // 充电态：整棵盘树换成"只有锚点与那一圈弧"。早返回而不是叠 CSS 隐藏——
  // 盘上格子带着 hover/提示语，充电期间既不该看见也不该被读屏念出来
  if (charging !== "off") {
    return (
      <div className="radial-root relative h-screen w-screen select-none overflow-hidden">
        <svg
          aria-hidden
          viewBox="0 0 40 40"
          className={`radial-charging absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ${
            charging === "up" ? "radial-charging--up" : ""
          } ${charging === "full" ? "radial-charging--full" : ""}`}
          style={{
            width: 40 * unit,
            height: 40 * unit,
            ["--ring-c" as string]: String(ARC_CIRCUMFERENCE),
            ["--ring-ms" as string]: `${chargingMs}ms`,
          }}
        >
          {/* 锚点小圆点：出盘时它就是中心核（盘与弧共用一条 -90° 的起线） */}
          <circle cx="20" cy="20" r="1.5" fill={accent(0).solid} />
          <circle
            className="radial-charging__arc"
            cx="20"
            cy="20"
            r={ARC_RADIUS}
            fill="none"
            stroke={accent(0).solid}
            strokeWidth="3"
            strokeLinecap="round"
            transform="rotate(-90 20 20)"
          />
        </svg>
      </div>
    );
  }

  return (
    <div
      className={`radial-root relative h-screen w-screen select-none overflow-hidden transition-opacity duration-300 ${
        entered ? "opacity-100" : "opacity-0"
      }`}
    >
      {/*
        点环外空白关闭。真 <button> 而不是根 div 挂 onClick：静态元素挂 onClick
        键盘与读屏都不可达。tabIndex={-1} 刻意——键盘已有 Esc 与中央「取消」。
      */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="关闭菜单"
        onClick={close}
        className="absolute inset-0 cursor-default"
      />
      <div
        className="radial-disc pointer-events-none absolute left-1/2 top-1/2"
        style={{
          width: 320 * unit,
          height: 320 * unit,
          borderRadius: "50%",
          transform: "translate(-50%,-50%)",
        }}
      />
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: SIZE * unit, height: SIZE * unit }}
      >
        {NODES.map((it, i) => {
          const gap = 3;
          const a0 = i * SEG - 90 + gap;
          const a1 = (i + 1) * SEG - 90 - gap;
          const ac = accent(i);
          const hovered = hover === it.id;
          const keyboardFocused = cursor === i && !hovered;
          const active = hovered || cursor === i;
          const d = sectorPath(C, C, a0, a1, R_IN, R_OUT);
          return (
            <g key={it.id}>
              <path
                d={d}
                // 亮色盘片式扇区：默认不填，1px 浅灰分隔；悬停整块浅灰填充。
                // 强调色只留给键盘焦点环（Tab 没有可见反馈就是坏味道）。
                fill={active ? ring.sectorHover : "transparent"}
                fillOpacity={hovered ? 1 : active ? 0.7 : 0}
                stroke={keyboardFocused ? ac.solid : ring.divider}
                strokeOpacity={keyboardFocused ? 0.95 : 1}
                strokeWidth={keyboardFocused ? 2 : 1}
                className="pointer-events-auto cursor-pointer"
                // 扇区只做鼠标热区：键盘统一走下方按钮，避免双焦点/读屏重复
                aria-hidden="true"
                onMouseEnter={() => {
                  setHover(it.id);
                  setCursor(i);
                }}
                onMouseLeave={() => setHover((h) => (h === it.id ? null : h))}
                onClick={() => activate(it)}
                style={{
                  opacity: entered ? 1 : 0,
                  transition: "opacity .45s, fill-opacity .15s, stroke .15s",
                  transitionDelay: entered ? `${i * 45}ms` : "0ms",
                }}
              />
            </g>
          );
        })}
      </svg>

      <div
        className="pointer-events-none absolute left-1/2 top-1/2"
        style={{
          width: SIZE * unit,
          height: SIZE * unit,
          transform: "translate(-50%,-50%)",
        }}
      >
        {/* 内圈空白：吞掉点击，避免点偏扇区误落"关闭菜单" */}
        <span
          aria-hidden
          className="pointer-events-auto absolute rounded-full"
          style={{
            left: (SIZE / 2) * unit - R_IN,
            top: (SIZE / 2) * unit - R_IN,
            width: R_IN * 2,
            height: R_IN * 2,
          }}
        />
        {/* 中央取消 */}
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
          title={`${CORE_LABEL} (Esc)`}
          aria-label={CORE_LABEL}
          className="group pointer-events-auto absolute z-30 flex items-center justify-center rounded-full"
          style={{
            left: (SIZE / 2) * unit - R_CORE,
            top: (SIZE / 2) * unit - R_CORE,
            width: R_CORE * 2,
            height: R_CORE * 2,
            transition: "transform .3s cubic-bezier(.34,1.56,.64,1)",
            transform: entered ? "scale(1)" : "scale(.6)",
          }}
        >
          <span
            className="radial-core flex flex-col items-center justify-center rounded-full"
            style={{ width: "100%", height: "100%", borderRadius: "50%" }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background: `radial-gradient(circle at 50% 38%, ${coreRgba(0.12)} 0%, rgba(255,255,255,0) 62%)`,
              }}
            />
            <X
              strokeWidth={2.4}
              className="relative z-10"
              style={{ width: 22 * unit, height: 22 * unit }}
            />
            <span
              className="relative z-10 whitespace-nowrap"
              style={{ fontSize: Math.max(11, 11 * unit), marginTop: 3 * unit }}
            >
              {CORE_LABEL}
            </span>
          </span>
        </button>

        {NODES.map((it, i) => {
          const angle = (i * SEG - 90 + SEG / 2) * (Math.PI / 180);
          const x = (SIZE / 2) * unit + Math.cos(angle) * LABEL_OFF;
          const y = (SIZE / 2) * unit + Math.sin(angle) * LABEL_OFF;
          const ac = accent(i);
          const active = hover === it.id || cursor === i;

          return (
            <button
              key={it.id}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => {
                setHover(it.id);
                setCursor(i);
              }}
              onMouseLeave={() => setHover((h) => (h === it.id ? null : h))}
              onClick={() => activate(it)}
              className="pointer-events-auto absolute z-20 flex flex-col items-center"
              style={{
                left: x,
                top: y,
                transform: `translate(-50%,-50%) scale(${entered ? 1 : 0.5})`,
                transition: "transform .2s",
              }}
              title={`${it.label}（${i + 1}）`}
            >
              {/* 节点图标无底托：悬停不缩放、不加衬底，靠扇区浅灰填充表达选中。
                  外层 span 40px 见方只为撑命中区（WCAG 2.5.8） */}
              <span
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 40 * unit,
                  height: 40 * unit,
                }}
              >
                <it.icon
                  strokeWidth={2.2}
                  style={{
                    width: 24 * unit,
                    height: 24 * unit,
                    color: active ? ac.solid : ac.base,
                  }}
                />
              </span>
              <span
                className="whitespace-nowrap font-semibold leading-none"
                style={{
                  fontSize: Math.max(11, 11 * unit),
                  marginTop: 5 * unit,
                  color: ring.label,
                }}
              >
                {it.label}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role={notice ? "status" : undefined}
        className={`pointer-events-none fixed bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap text-center ${
          notice ? "text-red-600" : ""
        }`}
        style={{
          color: notice ? undefined : ring.hint,
          fontSize: Math.max(11, 11 * unit),
        }}
      >
        {notice || "↑↓ ←→ 移动 · Enter 确认 · 1-4 直达 · Esc 关闭"}
      </div>
    </div>
  );
}

async function closeMenu() {
  try {
    await closeRingWindow();
  } catch (error) {
    // 菜单是隐藏而非销毁，command 失败意味着它可能留在屏幕上
    logger.caught("ring", "隐藏星环失败", error);
  }
}
