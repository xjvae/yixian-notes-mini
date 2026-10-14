// 引导教程十二步 — **只有数据**：一步 = 标题 + 正文（最多三行，一行一件事）+ **锚点**（气泡摆哪、箭头朝哪）。
// 锚点：`center` 没东西可指、落正中；`top` 键盘动作摆上缘、别挡住正在讲的便签；
// `note`/`ring`/`tray` 贴真物件（语义见各分支注释），算不出真位置的退路在 `window.tsx`。
// 文案分两种：**固定的**照着代码核过（四类 `data/note-types.ts`、托盘八条 `tray.rs`、长高上限 900 像素、备份进 backups\）；
// **带机器事实的**（第一步长按阈值、第九步键位表）经 `GuideFacts` 现读现写——写死就是等着骗人。

import type { HotkeyBinding } from "@/platform/contracts";
import { describeBinding } from "@/data/hotkey-labels";

export type Anchor =
  | { kind: "center" }
  | { kind: "top" }
  /** 指着**这一步教出来的那张便签**（开场后新出现的那扇窗），贴边收成细丝也照跟；没有它才退到最新的一张 */
  | { kind: "note" }
  /**
   * 讲星环的那几步：气泡贴到**屏幕上那只真环**的右边（`guide_show_ring` 报回它的中心）。
   * `cell: "top"` = 竖直偏上，指上面那一格（新建便签）。
   */
  | { kind: "ring"; cell?: "top" }
  /** 指着托盘里我们那一格（`tray_rect` 问得到就贴上去；问不到才退右下角，正文也就只能说"屏幕右下角的托盘"） */
  | { kind: "tray" };

/**
 * 这一步要说的**这台机器上的事实**，读不到就传 null，文案自己退回不依赖这些数的说法。
 */
export interface GuideFacts {
  /** 毫秒。设置里能调，所以第一步不能念死一个 450 */
  holdMs: number;
  /** 右键劫持被暂停了：第一步那个动作根本按不出来，得先说这件事 */
  hookPaused: boolean;
  /** 热键清单（来自 `hotkey_list`，就是"实际注册上的那份"）。空数组 = 还没读到 */
  hotkeys: HotkeyBinding[];
  /** 私密层设过口令没有（`private_status.configured`）。没设过，标私密是**直通不加密**的 */
  privateConfigured: boolean;
  /** **现在揭开着几张**（`private_status.revealed.length`）。逐张模型里没有"整层开着"这回事 */
  revealedCount: number;
}

/** 一步的正文：固定几行，或者照着这台机器的实际情况现写 */
export type StepLines = (facts: GuideFacts | null) => string[];

export interface GuideStep {
  id: string;
  title: string;
  /** 最多三行——再多就不是气泡该说的话了。数组或写它的函数，两种都行 */
  lines: string[] | StepLines;
  anchor: Anchor;
  /**
   * 这一步桌上**要有几张可指的纸**（不说就 1 张）。并叠那一步填 2：桌面上除"这张"以外
   * 没有别的浮窗时，引导再补一张演示便签，不然这一步根本演不出来。
   * 补出来的那几张由 `close_guide_window` 硬删，不进回收站。
   */
  demoNeeds?: 2;
  /**
   * 这一步不靠点「下一步」推进，而是等真事发生：
   *  · `"ring-open"` —— 他真按住右键把盘叫出来了（Rust 每次开盘都广播 `ring:open`）；
   *  · `"note-created"` —— 那一张纸真落到了桌面上（浮窗表里冒出一扇开场没有的窗）。
   */
  advanceOn?: "ring-open" | "note-created";
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: "long-press",
    title: "第一件事：按住右键",
    // 阈值是设置里可调的，念死一个数就是骗人；劫持暂停时这动作根本按不出来，先说这件事
    lines: (facts) =>
      facts?.hookPaused
        ? [
            "先说一件事：右键劫持现在是暂停的，按住不会出盘。",
            "设置 → 右键 里把它打开，再回到这一步按。",
          ]
        : [
            `在桌面任意处按住鼠标右键不放，${
              facts === null ? "按住约半秒" : `约 ${facts.holdMs} 毫秒`
            }到位。`,
            "这是主入口——桌面上没有任何按钮提示你它存在，所以这条得先说。",
            "你按出来那一刻，我自动翻下一页。",
          ],
    anchor: { kind: "center" },
    advanceOn: "ring-open",
  },
  {
    id: "ring",
    title: "盘就在你按住的地方展开",
    lines: [
      "四格：新建便签 · 搜索 · 回收站 · 设置。",
      "不想用鼠标也行：↑↓←→ 移动、Enter 确认、1-4 直达、Esc 关闭。",
    ],
    // 这一步把星环真的开出来（不是示意图）：讲一个不在屏幕上的东西，气泡就只能指着空气
    anchor: { kind: "ring" },
  },
  {
    id: "new-note",
    title: "点上面那一格：新建便签",
    lines: [
      "盘的最上面那格就是「新建便签」，点它，一张纸落在桌面上。",
      "不想用鼠标：按 1，或者 Alt+1（这条在桌面上也直接生效，不用先开盘）。",
      "纸落下来那一刻，我自动翻下一页。",
    ],
    // 还是指着同一只环，只是竖直偏上——这一格在盘的上方
    anchor: { kind: "ring", cell: "top" },
    advanceOn: "note-created",
  },
  {
    id: "types",
    title: "一张签有四种样子",
    lines: [
      "工具条上换类：文本 · 清单 · 提醒 · 时间轴。",
      "换类不动你写过的字，每一项、每一条都跟着带过去。",
      "这一步指的这张：没见着你刚建的那张的话，就是引导放的「引导演示」，走完自动收。",
    ],
    anchor: { kind: "note" },
  },
  {
    id: "auto-grow",
    title: "它随内容长高",
    lines: [
      "写的字把窗顶高，删了缩回来；上限 900 像素，多出来的正文自己滚。",
      "手拉某一扇窗的边就把那一张退回固定尺寸，页脚那个钮还能单独翻。",
    ],
    anchor: { kind: "note" },
  },
  {
    id: "dock",
    title: "不用的时候拖到边上",
    lines: [
      "把这张拖到屏幕边，它收成一条细丝；鼠标碰一下就滑出来。",
      "占地方的是窗，不是那张纸——四边都能贴。",
    ],
    anchor: { kind: "note" },
  },
  {
    id: "merge",
    title: "两张并成一叠",
    // 气泡指着的是**要被压的那一张**，正文里"这一张"就是它；第二张由引导补在旁边（见 demoNeeds）
    lines: [
      "两张才并得成：桌上没有第二张的话，引导在旁边再放一张「引导演示」。",
      "把那张拖到这一张上松手，它们并成一叠，箭头翻页。",
      "一叠有三种呈现：分页翻、侧边色块签、手风琴。切档不动数据。",
    ],
    anchor: { kind: "note" },
    demoNeeds: 2,
  },
  {
    id: "reminder",
    title: "到点它自己冒出来",
    lines: [
      "在这张上换到「提醒」类、设好时间，到点它会自己在屏幕右下角画一张卡。",
      "点卡把这张便签拉到眼前（不抢你正在打字的焦点）；点 × 只收卡。",
    ],
    // 摆在这张上：要做的事（换类、设时间）全在这张纸上，右下角此刻还是一块没有东西的空地
    anchor: { kind: "note" },
  },
  {
    id: "hotkeys",
    title: "不动鼠标也能做事",
    // 念**这台机器上真注册上了的那份**：改过键或某条被别的程序占着时，照默认表念就是教一个按了没反应的键
    lines: (facts) => {
      if (facts === null || facts.hotkeys.length === 0) {
        return [
          "正在读你机器上现在生效的键位表…",
          "读到了我自动改这一页，也可以先点下一步。",
        ];
      }
      return [
        `这是你机器上现在生效的那份：${facts.hotkeys.map((b) => describeBinding(b)).join(" · ")}。`,
        "标了「没绑上」的是被别的程序占着——设置 → 快捷键 里能改，改完回来接着看。",
      ];
    },
    anchor: { kind: "top" },
  },
  {
    id: "tray",
    title: "托盘是常驻的那一条",
    lines: [
      "关掉所有窗应用也不退出——它在屏幕右下角的托盘里。",
      "新建便签、搜索、回收站、设置、开机启动、收起全部、恢复全部、立即锁定私密便签、退出。",
    ],
    anchor: { kind: "tray" },
  },
  {
    id: "private",
    title: "私密层：一道口令开一张",
    // 结论一条：**没设过口令的机器上标私密是直通存放、一个字节都不加密**（`private_note.rs::plan` 的分岔），先问 `private_status` 两种情况各说各的话
    lines: (facts) => {
      if (facts === null) {
        return ["正在看你机器上私密层的状况…", "读到了我自动改这一页。"];
      }
      if (!facts.privateConfigured) {
        return [
          "先把这件事说了：你还没设过口令，所以这会儿标成私密是不加密的（直通存放）。",
          "第一次标私密会让你设一把口令 —— 设过之后，正文与图才真的进信封。",
          "忘了口令只有一条路：重置＝清空全部私密内容，没有后门。",
        ];
      }
      return [
        "标成私密，这张的正文与图就加密存放；没揭开时连标题都不进搜索与通知。",
        "点开哪张就输哪张的口令：**一道口令只开那一张**，别的便签连自己的密文都解不开。",
        facts.revealedCount > 0
          ? `现在有 ${facts.revealedCount} 张是开着的。托盘「立即锁定私密便签」会把揭开的一起蒙回。`
          : "现在一张都没开着。要删私密便签也会再要你输一次口令。",
        "忘了口令只有一条路：重置＝清空全部私密内容，没有后门。",
      ];
    },
    anchor: { kind: "note" },
  },
  {
    id: "backup",
    title: "备份与开机启动",
    lines: [
      "设置 → 数据 →「立即备份」出一份完整快照（含正在写的那部分），落在数据目录的 backups\\ 下。",
      "设置 → 行为 里还有主题、开机恢复、自动长高、长按阈值、改键与「开机启动」。",
      "看完了。想再来一遍：设置 → 行为 →「重看引导教程」。",
    ],
    anchor: { kind: "top" },
  },
];
