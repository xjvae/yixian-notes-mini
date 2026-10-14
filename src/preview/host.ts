// 预览台宿主（父页）— 持假数据核，按 label 管 iframe，把命令的窗口副作用落成真实框。
// 拦在桥这一层（DevBridge）而不是拦 Backend：store、去抖落库、跨窗合流、私密层包装、窗组件全走真路径；
// 这里验的是前端行为不是 Rust 行为——Rust 语义要逐条跟抄进 fake-db.ts，抄漏了预览台就在骗人。
// 未覆盖（在这儿验不出来）：真拖动（原生 drag-region 在 iframe 里点不动）、贴边细丝、多显示器/DPI、WH_MOUSE_LL；
// 摆位用右侧面板数值框注入 moved/resized，够把"几何合流 + 最小尺寸纠偏"这条链路跑通。

import type { FloatFrame, StickyNote } from "@/platform/contracts";
import {
  FakeDb,
  PreviewError,
  type Broadcast,
  type PreviewArgs,
  type WindowAction,
} from "@/preview/fake-db";
import { dismissSplashMock } from "@/preview/splash-mock";
import {
  BAR_HEIGHT,
  BAR_MAX_WIDTH,
  FLOAT_PREFIX,
  GROUP_PREFIX,
  HIDE_ON_CLOSE,
  PANEL_LABELS,
  centerBlock,
  specOf,
  spawnPosition,
  type FrameSpec,
  type Rect,
} from "@/preview/window-specs";

/**
 * 预览台的"工作区" = 放窗的画布（不是整个视口，按视口会把窗算到画布外看不见的一截）。
 * 没有任务栏也没有缩放，逻辑像素即画布像素；画布未挂上（首帧前）退回视口尺寸。
 */
function hostWorkArea(): Rect {
  const box = document
    .querySelector<HTMLElement>("[data-preview-layer]")
    ?.getBoundingClientRect();
  return {
    x: 0,
    y: 0,
    width: Math.round(box?.width ?? window.innerWidth),
    height: Math.round(box?.height ?? window.innerHeight),
  };
}

export interface FrameHandle {
  spec: FrameSpec;
  element: HTMLIFrameElement | null;
}

/** 一次命令分发的结果。失败不抛（宿主与窗内两条调用路都要能拿同一个形状） */
type Dispatch =
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** "这一档没有原生下限"（收起成标题栏、贴边细丝那两档）。0×0 = 不夹，与别处同一种写法 */
const NO_MIN = { width: 0, height: 0 };

/**
 * 出生尺寸过一遍原生下限（builder 的 `min_inner_size` 就是当场夹的）。不夹这一刀，
 * "挂着 220×200 去建 62 高的栏"这种错在这儿演不出来，只能等真机报。
 */
function birthRect(rect: Rect, min: { width: number; height: number }): Rect {
  return {
    ...rect,
    width: Math.max(rect.width, min.width),
    height: Math.max(rect.height, min.height),
  };
}

/** 开窗时定形：入口 html + 预览标记 + label + 身份 + 初始几何（+ 叠窗的落点那张、收起旗） */
function frameSrc(
  spec: Omit<FrameSpec, "src" | "hidden">,
  focus: string | null,
  collapsed: boolean,
): string {
  const search = new URLSearchParams({
    preview: "1",
    label: spec.label,
    x: String(Math.round(spec.rect.x)),
    y: String(Math.round(spec.rect.y)),
    w: String(Math.round(spec.rect.width)),
    h: String(Math.round(spec.rect.height)),
  });
  if (spec.entityId !== null && spec.label.startsWith(FLOAT_PREFIX)) {
    search.set("stickyId", spec.entityId);
  }
  if (spec.entityId !== null && spec.label.startsWith(GROUP_PREFIX)) {
    search.set("groupId", spec.entityId);
    if (focus !== null) search.set("focus", focus);
    // 与 Rust initialization_script 同一条注入；单窗不需要——它的 collapsed 住在便签行里，挂载时已进 store
    if (collapsed) search.set("collapsed", "1");
  }
  return `/${spec.entry}?${search.toString()}`;
}

export class PreviewHost {
  readonly db = new FakeDb();
  private readonly frames = new Map<string, FrameHandle>();
  private readonly listeners = new Set<() => void>();
  /** 每一笔结构或几何变化都涨一格：订阅面只认这个数（认 frames.length 会漏掉改摆位/改尺寸） */
  private version = 0;
  private readonly origin = window.location.origin;

  constructor() {
    // 假核答不了"桌面上有哪几扇浮窗在哪"——矩形只在宿主手里，挂过去
    this.db.floatsProvider = () => this.floatFrames();
  }

  get snap(): number {
    return this.version;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
  frameList(): FrameSpec[] {
    return [...this.frames.values()].map((handle) => handle.spec);
  }

  /**
   * 与 commands/window.rs::float_frames 同口径：只给**可见**的浮窗与叠窗。
   * 预览台是 1:1 画布坐标，逻辑像素就是 Rust 那份"物理像素"的等价物。
   */
  floatFrames(): FloatFrame[] {
    const out: FloatFrame[] = [];
    for (const handle of this.frames.values()) {
      const { label, kind, entityId, rect, hidden } = handle.spec;
      if (hidden || entityId === null) continue;
      if (kind !== "sticky" && kind !== "stack") continue;
      out.push({
        label,
        kind,
        id: entityId,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    return out;
  }

  attach(element: HTMLIFrameElement | null, label: string): void {
    const handle = this.frames.get(label);
    if (handle) handle.element = element;
  }

  reset(): void {
    for (const label of [...this.frames.keys()]) this.closeByLabel(label);
    this.db.reset();
    this.seedOpen();
    this.notify();
  }

  /** 开局就把要看的东西摆上：一张单窗 + 一叠三张（面板窗要按上面那排钮开） */
  seedOpen(): void {
    this.openSticky("s-text");
    this.openStack("g-demo", null);
  }

  private findRow(id: string): StickyNote | undefined {
    return this.db.snapshot().stickies.find((row) => row.id === id);
  }

  /** 与 float.rs::open_sticky 同口径：行里记过就按行的，收起态换成 62px 条 */
  openSticky(id: string): void {
    const label = `${FLOAT_PREFIX}${id}`;
    if (this.frames.has(label)) {
      this.focus(label);
      return;
    }
    const spec = specOf("sticky");
    const row = this.findRow(id);
    if (row === undefined) return;
    const floats = [...this.frames.keys()].filter((l) =>
      l.startsWith(FLOAT_PREFIX),
    ).length;
    // 收起那一档**连原生下限一起摘**（同 `float::mode_geometry`），否则 62 的栏被夹回 200
    const min = row.collapsed ? NO_MIN : spec.min;
    // 尺寸先定，落点再按这一档尺寸居中（与 `float.rs::open_sticky` 同一个先后）
    const size = row.collapsed
      ? {
          width: Math.min(row.width ?? spec.size.width, BAR_MAX_WIDTH),
          height: BAR_HEIGHT,
        }
      : {
          width: row.width ?? spec.size.width,
          height: row.height ?? spec.size.height,
        };
    const born = spawnPosition(hostWorkArea(), size, floats);
    const shaped: Rect = { x: row.x ?? born.x, y: row.y ?? born.y, ...size };
    this.add({
      label,
      kind: "sticky",
      entityId: id,
      entry: spec.entry,
      rect: birthRect(shaped, min),
      min,
      title: spec.title,
    });
  }

  openStack(gid: string, focus: string | null): void {
    const label = `${GROUP_PREFIX}${gid}`;
    const existing = this.frames.get(label);
    if (existing !== undefined) {
      this.focus(label);
      // 窗已经在了：与 Rust 同一条路——广播 sticky:reveal，叠窗按 groupId 认领
      if (focus !== null) {
        for (const handle of this.frames.values()) {
          handle.element?.contentWindow?.postMessage(
            {
              t: "event",
              event: "sticky:reveal",
              payload: { groupId: gid, stickyId: focus },
            },
            this.origin,
          );
        }
      }
      return;
    }
    const spec = specOf("stack");
    const group = this.db.snapshot().groups.find((row) => row.id === gid);
    if (group === undefined) return;
    const floats = [...this.frames.keys()].filter((l) =>
      l.startsWith(FLOAT_PREFIX),
    ).length;
    // 同 float.rs::open_group_stack：收起态出生就是 62 高的栏、宽夹到 360，且连下限一起摘
    const min = group.collapsed ? NO_MIN : spec.min;
    // 先后同单窗：尺寸先定，落点按这一档尺寸居中
    const size = group.collapsed
      ? {
          width: Math.min(group.width ?? spec.size.width, BAR_MAX_WIDTH),
          height: BAR_HEIGHT,
        }
      : {
          width: group.width ?? spec.size.width,
          height: group.height ?? spec.size.height,
        };
    const born = spawnPosition(hostWorkArea(), size, floats);
    const shaped: Rect = { x: group.x ?? born.x, y: group.y ?? born.y, ...size };
    this.add(
      {
        label,
        kind: "stack",
        entityId: gid,
        entry: spec.entry,
        rect: birthRect(shaped, min),
        min,
        title: spec.title,
      },
      focus,
      group.collapsed,
    );
  }

  openPanel(label: string): void {
    if (this.frames.has(label)) {
      this.focus(label);
      return;
    }
    // 窗型从 window-specs 查，不在这里再抄一张表——上一版两份名单漂移，命令回成功、框静悄悄不建
    const kind = PANEL_LABELS.find((panel) => panel.label === label)?.kind;
    if (kind === undefined) return;
    const spec = specOf(kind);
    // unlock 真机每次落光标屏正中（monitor::spawn_centered）；其余面板位置交系统，这里固定左上角代表
    const at =
      kind === "unlock" ? centerBlock(hostWorkArea(), spec.size) : { x: 60, y: 60 };
    this.add({
      label,
      kind,
      entityId: null,
      entry: spec.entry,
      rect: { x: at.x, y: at.y, width: spec.size.width, height: spec.size.height },
      min: spec.min,
      title: spec.title,
    });
  }

  private add(
    spec: Omit<FrameSpec, "src" | "hidden">,
    focus: string | null = null,
    collapsed = false,
  ): void {
    this.frames.set(spec.label, {
      spec: { ...spec, hidden: false, src: frameSrc(spec, focus, collapsed) },
      element: null,
    });
    this.notify();
  }

  /**
   * 按 Rust 语义分两档关：search·trash·settings·ring 是 hide（保住 WebView 实例，下次秒开——
   * 销毁重建的代价正落在"按下快捷键到看见"那段）；unlock 与便签/叠窗是 destroy。
   */
  closeByLabel(label: string): void {
    const handle = this.frames.get(label);
    if (!handle) return;
    if (HIDE_ON_CLOSE.includes(handle.spec.kind)) {
      handle.spec.hidden = true;
      this.notify();
      return;
    }
    this.frames.delete(label);
    this.notify();
  }

  /** 预览台自己的"关掉这扇"：不管语义，真把 iframe 卸掉（画布要能清空） */
  destroyFrame(label: string): void {
    if (!this.frames.delete(label)) return;
    this.notify();
  }

  /** 唤起一扇窗：隐藏的把它显示回来（对应 Rust 的 show + set_focus） */
  focus(label: string): void {
    const handle = this.frames.get(label);
    if (!handle) return;
    if (handle.spec.hidden) {
      handle.spec.hidden = false;
      this.notify();
    }
    handle.element?.focus();
  }

  /** 数值框注入几何：moved / resized 各自触发窗内监听，进而走 store 的 180ms 合流 */
  pushGeometry(label: string, patch: Partial<Rect>): void {
    const handle = this.frames.get(label);
    if (!handle) return;
    handle.spec.rect = { ...handle.spec.rect, ...patch };
    handle.element?.contentWindow?.postMessage({ t: "geom", ...patch }, this.origin);
    this.notify();
  }

  /**
   * 宿主自己发命令也走同一条路（writer="preview"）。父页没装替身桥，**不能**直接用 app 的
   * data 层（那些会去 invoke 真 Tauri 而失败）——必须经这里。
   */
  run(cmd: string, args: PreviewArgs = {}): Dispatch {
    return this.dispatch(cmd, args, "preview");
  }

  /**
   * 模拟托盘「立即锁定」：真机走 `private::lock` + 托盘自己发 `store:private-changed`（tray.rs）；
   * 这里借 `private_lock` 命令走同一步（它现在也发同一条广播，不必手动补发）。
   */
  trayLock(): void {
    this.run("private_lock");
  }

  private dispatch(cmd: string, args: PreviewArgs, writer: string): Dispatch {
    let result: unknown;
    let error: { code: string; message: string } | null = null;
    try {
      result = this.db.handle(cmd, args, writer);
    } catch (caught) {
      error =
        caught instanceof PreviewError
          ? caught.toWire()
          : { code: "PREVIEW_CRASH", message: String(caught) };
    }
    this.applyActions(this.db.drain());
    // 命令落库后刷一次：右侧「数据核快照/命令流水」要跟着动
    this.notify();
    return error === null ? { ok: true, result } : { ok: false, error };
  }

  handleRequest(source: MessageEventSource | null, msg: unknown): void {
    if (!isRecord(msg) || msg["t"] !== "ipc") return;
    const id = msg["id"] as number;
    const out = this.dispatch(
      msg["cmd"] as string,
      isRecord(msg["args"]) ? msg["args"] : {},
      msg["label"] as string,
    );
    // 来自 iframe 的消息，event.source 就是那扇窗的 contentWindow（不是 HTMLIFrameElement）
    const target = source as Window | null;
    target?.postMessage(
      out.ok
        ? { t: "reply", id, ok: true, result: out.result }
        : { t: "reply", id, ok: false, error: out.error },
      this.origin,
    );
  }

  handleWindowOp(msg: unknown): void {
    if (!isRecord(msg) || msg["t"] !== "winop") return;
    const label = msg["label"] as string;
    const handle = this.frames.get(label);
    if (!handle) return;
    if (msg["op"] === "resize") {
      this.pushGeometry(label, {
        width: msg["width"] as number,
        height: msg["height"] as number,
      });
    }
    if (msg["op"] === "frame") {
      const patch: Partial<Rect> = {};
      if (typeof msg["x"] === "number") patch.x = msg["x"];
      if (typeof msg["y"] === "number") patch.y = msg["y"];
      if (typeof msg["width"] === "number") patch.width = msg["width"];
      if (typeof msg["height"] === "number") patch.height = msg["height"];
      this.pushGeometry(label, patch);
    }
    if (msg["op"] === "focus") this.focus(label);
  }

  private applyActions(drain: {
    actions: WindowAction[];
    broadcasts: Broadcast[];
  }): void {
    // 任何"把一扇窗拉到眼前"都算真机的 `float_reveal` 那一声——开场复刻在这儿收场
    //（真机侧面板窗出生就可见、不走 float_reveal，收场在建窗处按 `spec.visible` 叫，见 factory.rs）
    if (
      drain.actions.some(
        (action) =>
          action.kind === "open-sticky" ||
          action.kind === "open-stack" ||
          action.kind === "open-panel",
      )
    ) {
      dismissSplashMock();
    }
    for (const action of drain.actions) {
      switch (action.kind) {
        case "open-sticky":
          this.openSticky(action.id);
          break;
        case "close-sticky":
          this.closeByLabel(`${FLOAT_PREFIX}${action.id}`);
          break;
        case "open-stack":
          this.openStack(action.gid, action.focus);
          break;
        case "close-stack":
          this.closeByLabel(`${GROUP_PREFIX}${action.gid}`);
          break;
        case "open-panel":
          this.openPanel(action.label);
          break;
        case "close-panel":
          this.closeByLabel(action.label);
          break;
        case "note":
          break;
      }
    }
    // 跨窗广播与 Rust emit 同形，发给所有窗（store 按 writer label 跳过；私密层按事件重读状态、不看 writer）
    for (const broadcast of drain.broadcasts) {
      for (const handle of this.frames.values()) {
        handle.element?.contentWindow?.postMessage(
          { t: "event", event: broadcast.event, payload: broadcast.payload },
          this.origin,
        );
      }
    }
  }
}
