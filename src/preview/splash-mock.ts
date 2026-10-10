// 开场动画的**预览台复刻** — 看的是时长、形状、配色，不是真机那身像素。
//
// 真机那份在 `src-tauri/src/splash.rs`：原生分层窗 + `CreateDIBSection` 逐像素写预乘 BGRA
// + `UpdateLayeredWindow` 提交。浏览器里放不进去，所以这里用 SVG 的 `stroke-dashoffset`
// 复现同一条弧。两份的参数靠下面这张表对起来，**改一边要同时改另一边**
// （与 `windows/ring.rs` 的 RING_SIZE=360 那三处同一个做法）。
//
// 这条复刻验不出来的东西，别把它当已验：
//  · 分层窗的 alpha 边与超采样覆盖率（真机的边是 `band_coverage` 手抹的 1 像素）；
//  · DPI 换算后环带的实际粗细（这里恒按 100% 画）；
//  · 颜色的判据不同：真机读 HKCU 的 `AppsUseLightTheme`，这里退到 `prefers-color-scheme`；
//  · **退场那一刻的真实时序**：真机是"第一扇窗 reveal 才收"，而预览台里那一下是秒出的，
//    所以这里不自动演，交给工具条那颗钮——要看满 600ms 那条弧就按它。

/** 与 `splash.rs` 同值的参数表（逻辑像素 / 毫秒）。改这里不改那边 = 分叉 */
export const SPLASH_MOCK = {
  /** 画面见方 */
  box: 200,
  /** 环带内外径 */
  bandInner: 62,
  bandOuter: 70,
  /** 弧扫满一圈 */
  arcMs: 600,
  /** 图标起淡入 / 淡入时长 */
  iconFromMs: 380,
  iconSpanMs: 220,
  /** 退场淡出——与星环那条弧的下台同档 */
  fadeMs: 90,
  /** 无条件退场的上限 */
  maxMs: 2500,
  /** 项目里唯一现成的一条曲线（`index.css`） */
  curve: "cubic-bezier(0.22, 0.8, 0.28, 1)",
} as const;

const SVG_NS = "http://www.w3.org/2000/svg";

/** 底环不透明度，与 `data/theme.ts` 的 `RING_INK.divider` 同值 */
const TRACK_LIGHT = 0.08;
const TRACK_DARK = 0.1;
/** 墨色，与 `RING_INK.label` 同值（light #1d2329 / dark #E7E9EC） */
const INK_LIGHT = "#1d2329";
const INK_DARK = "#E7E9EC";

let overlay: HTMLElement | null = null;
let capTimer: number | null = null;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function darkBySystem(): boolean {
  // 真机读的是注册表那一档；浏览器里只有这个判据可用（形状一致，来源不一致）
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 立刻收场。`fade` 给 false 就是 reduce 档："关掉动画"不等于"淡得快一点" */
function stop(fade: boolean): void {
  if (capTimer !== null) {
    window.clearTimeout(capTimer);
    capTimer = null;
  }
  const node = overlay;
  if (node === null) return;
  overlay = null;
  if (!fade) {
    node.remove();
    return;
  }
  // 淡出交给 WAAPI：结束后再卸节点，别在动画中途 remove
  const done = (): void => node.remove();
  const handle = node.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: SPLASH_MOCK.fadeMs,
    easing: SPLASH_MOCK.curve,
    fill: "both",
  });
  handle.finished.then(done).catch(done);
}

/**
 * 演一次。已经在演就先把上一场收掉（不叠两份弧）。
 *
 * 返回"这一场演了多久"没意义，所以不返回东西——工具条那颗钮只管放。
 */
export function playSplashMock(): void {
  stop(false);
  const { box, bandInner, bandOuter, arcMs, iconFromMs, iconSpanMs, maxMs, curve } =
    SPLASH_MOCK;
  const dark = darkBySystem();
  const ink = dark ? INK_DARK : INK_LIGHT;
  const track = dark ? TRACK_DARK : TRACK_LIGHT;
  const radius = (bandInner + bandOuter) / 2;
  const stroke = bandOuter - bandInner;
  const circumference = 2 * Math.PI * radius;
  const still = reducedMotion();

  const node = document.createElement("div");
  node.dataset.splashMock = "1";
  // pointer-events:none：复刻也不许吃鼠标，理由与真机那条 WS_EX_TRANSPARENT 一样
  node.style.cssText = [
    "position:fixed",
    "inset:0",
    "display:grid",
    "place-items:center",
    "pointer-events:none",
    // 盖在全部 iframe 之上：预览台的框都在同一层文档里，没有原生 topmost可靠
    "z-index:2147483000",
  ].join(";");

  const center = box / 2;
  // 全程 DOM 构造，不拼 HTML 串：这里插进去的只有数字与常量色值，本来没有可注入的面，
  // 但"用 innerHTML 搭东西"这一条形成长得像给后面留口子，不必留
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(box));
  svg.setAttribute("height", String(box));
  svg.setAttribute("viewBox", `0 0 ${box} ${box}`);
  svg.setAttribute("aria-hidden", "true");

  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", String(center));
  ring.setAttribute("cy", String(center));
  ring.setAttribute("r", String(radius));
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", ink);
  ring.setAttribute("stroke-opacity", String(track));
  ring.setAttribute("stroke-width", String(stroke));

  const arc = document.createElementNS(SVG_NS, "circle");
  arc.setAttribute("cx", String(center));
  arc.setAttribute("cy", String(center));
  arc.setAttribute("r", String(radius));
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", ink);
  arc.setAttribute("stroke-width", String(stroke));
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", String(circumference));
  arc.setAttribute("stroke-dashoffset", String(circumference));
  // 12 点起、顺时针：把 0 度从 3 点转到 12 点
  arc.setAttribute("transform", `rotate(-90 ${center} ${center})`);
  svg.append(ring, arc);

  const icon = document.createElement("img");
  icon.alt = "";
  icon.src = "/src-tauri/icons/icon.png";
  icon.width = 32;
  icon.height = 32;
  icon.style.cssText = "position:absolute;opacity:0";

  node.append(svg, icon);
  document.body.appendChild(node);
  overlay = node;

  // reduce 档：钉成满环 + 图标直接在场，与 splash.rs 的 `sweep_at(_, true)` 同一条口径
  // （停在起点等于整条弧都不画，那与"关掉动画就把反馈也关掉"是同一个错误）
  if (still) {
    arc.setAttribute("stroke-dashoffset", "0");
  } else {
    arc.animate(
      [{ strokeDashoffset: String(circumference) }, { strokeDashoffset: "0" }],
      { duration: arcMs, easing: curve, fill: "both" },
    );
  }

  // 图标读不到就什么也不画，环照扫——与真机那条"打包图标缺失也不许拖住启动"同口径
  icon.onerror = (): void => icon.remove();
  if (still) {
    icon.style.opacity = "1";
  } else {
    icon.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: iconSpanMs,
      delay: iconFromMs,
      easing: curve,
      fill: "both",
    });
  }

  // 兜底那一条也要演出来：真机是"没人叫收场就自己收"，这里同样给一个上限
  capTimer = window.setTimeout(() => stop(!still), maxMs);
}

/** 一扇窗露脸了 = 真机里 `float_reveal` 那一声。没在演就是 no-op */
export function dismissSplashMock(): void {
  if (overlay === null) return;
  stop(!reducedMotion());
}
