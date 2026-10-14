# ARCHITECTURE — 一闲笔记 mini

> 面向下一个改代码的人。目标架构、数据流、以及"改哪里会出事"的清单。

## 形态

Windows 桌面便签。Tauri 2 + React 19 + TypeScript(strict) + Tailwind 4 + 打包 SQLite。
每扇窗一个 WebView；窗型 = HTML 入口（`vite.config.ts` input ↔ 根目录 html ↔ Rust
`WindowSpec.url` 三方对齐，是跨语言契约）。

```
src/                前端
  platform/         与 Tauri 的唯一接面（contracts / bridge / commands / errors / logger）
                    —— 其余层 import @tauri-apps/* 会被 eslint 直接拦下
  store/            数据核：typed store + NotesBackend 接缝
  data/             纯领域逻辑（entities / validate / theme / due / scheme /
                    private-state / body-parse 正文识别 / image-input 图片缩放编码…）
  window/           窗口行为（身份注入 / 几何合流 / 贴边 dock-model 纯函数 / use-dock-snap）
  ui/               共享视觉件（WindowChrome 全窗口共用一份标题条；ContextMenu、
                    LinkPrompt 是"窗内自画、夹回窗内、Esc 关"的两个浮层）
  features/         每扇窗一个目录（sticky / ring / trash / search / settings / unlock）
  entries/          HTML 入口装配（boot：initScheme → initPrivateState → hydrate）
src-tauri/          Rust
  commands/         全部 IPC 命令（唯一注册点；generate_handler 必须写完整模块路径）
  db/               SQLite 主库（pool / migrate / models / query/{sticky,group,search,media,…}）
  data/             私密层（crypto / private 封套与 vault）+ media 表的字节加解密
  input/            长按右键手势（state 纯状态机 / allowlist 纯判定 / win_hook 机器房）
  windows/          窗口构建（factory 防重复注册 / float / dock 槽位 / frames 位置记忆）
  hotkeys.rs        全局快捷键（逐条注册逐条容忍失败）
scripts/            size 体积门禁
```

## 数据流（三条，各有一条铁律）

**写**：视图 → `store.updateNote(id, patch)`（同步改内存，`useSyncExternalStore` 订阅者
即时重渲染）→ 去抖 250ms → `Backend.upsert` **单实体落库** → Rust 广播
`db:changed {writer, kind}`。没有整包 JSON、没有差集——写哪个实体调用点自己知道。
铁律：**锁不跨 `.await`**（Rust 命令全部走 `run_db`/`run_task` spawn_blocking）。

**跨窗**：只有一条机制——订阅 `db:changed`，`writer` 是调用方窗口 label，本窗跳过
自己的广播；`pending` 集合里的实体在远端合流时不被覆盖（在途编辑保护）。
没有合成 storage 事件。私密层的广播走 `store:private-changed`（全局状态，人人重读）。

**启动**：挂载前 `hydrateStore()`（先订阅、后读——次序反了就是丢更新真空）。
主库打不开 = 明确错误界面，没有 localStorage 退路；测试/预览注入内存 Backend。

## 正文识别与图片（M6 追加）

正文是**两态**：默认阅读态（`features/sticky/body-view.tsx` 画识别结果），点进去是编辑态
（一个 `<textarea>`）。两态读同一份 `note.body`——识别只存在于"读"的那一侧，写进去的
永远是用户打的那串字符，没有第二份真相。切分口径在 `data/body-parse.ts`（纯函数，
字符串进段出），渲染与 IPC 都不许自己再写一遍正则。

**画法也只有一处**：`features/sticky/rich-text.tsx`（段 → 节点，不带滚动、不带编辑态）。
正文阅读态、清单条目、时间轴条目共用它——清单/时间轴每条也是同样的两态（读态出链接与
缩略图，点进去才是 input）。哪天再加一档（搜索片段要出图），接的也是这一份。
**"这段人话可以选"跟着画法走**：卡片是 `select-none`（拖窗不涂蓝整屏），`user-select`
一路继承进正文，所以每一段的根节点自己带 `select-text`（由 `rich-text` 给），
阅读态那一格整格放开。写在外壳上会漏，漏一次就是"根本拖不出选区"这种只有真机发现的 bug。
粘图/拖图同样只有一个口：`features/sticky/use-note-image.ts`（压好 + 存库 + 回引用，
**不碰文本**：往哪儿插、还剩几个字是宿主的事——正文 5000、条目 200）。

每张纸的配色除了走 `themeColors`，还在便签根上落两个 CSS 变量 `--nb-ink` /
`--nb-accent`：滚动条（`index.css`）读它们，所以一根滚条属于它所在的那张纸，
而不是系统默认那根浅灰。面板窗没写这两个变量，回落到 `--panel-ink`。
**窗体外圈那一圈描边同一条规矩**：`WindowChrome` 收一个可选 `ink`，边框是
`color-mix(in srgb, <ink> 8%, transparent)`，不用 `black/10`——黑色半透明压在近白的
纸（岩灰 `#ECEEF1`）上就是一条灰圈，看着像没关干净的阴影。窗体不透明白色时角外是真
透明，所以卡片上**不再有 CSS 投影**：卡片是 `h-screen w-screen`，影子只会画到窗外被裁掉。

图片字节住 `media` 表（BLOB），不住文件系统：备份是 `VACUUM INTO` 一份库、导入只读一个
`mini.db`，图放进目录就是凭空多出第二类数据。正文里那句 `![名](media://m…)` 是唯一凭据，
id 由 Rust 生成（`support/id.rs`，与便签/组同一套生成法；**跨语言形状契约**：
`body-parse.ts` 的正则认 `m[0-9a-f]{8,24}`，两边各写一套就永远认不出来）。
缩放与重编码在前端（`data/image-input.ts`：有 canvas；Rust 侧做就得引 image crate）。

三条"改了就出事"的清单：

- **删同步**：全库不用外键，所以硬删便签（`sticky::delete`）、回收站清算
  （`trash::purge_expired` 的子查询）、私密翻转三处都要显式带走 media 行；
  软删一律不动（恢复回来图还在）。
- **私密图**用封套里的**媒体密钥**加，不是会话密钥：改密只重裹那 32 字节，
  库里图片一个都不动。重置换新密钥 → 旧私密图永久解不开 → `private_reset` 顺手清掉。
- **远程图不自动加载**：CSP 是 `img-src 'self' data: blob:`，放开 https 等于让任何一张
  便签拿用户的 IP 去敲陌生服务器。所以远程图渲染成一枚芯片，点开走 opener。

## 自动长高（M6 追加）

生效值 = `stickies.auto_size`（三态：NULL 跟全局 / 1 强制开 / 0 强制关）
`?? settings["sticky.auto_size"]`（**"1" 才算开**，缺键与脏值都算关——这条会改窗体行为，
脏值悄悄打开的症状是"便签自己乱跳"）。算术全在 `window/auto-size.ts`（纯函数、可穷举），
量与写在 `window/use-auto-size.ts`，抑制与"关掉回到固定值"在 `features/sticky/window.tsx`。

三条"改了就出事"：

- **开着自动时不许把尺寸写回 `width/height`**（`useWindowGeometry` 的抑制位）。写了就没有
  "回去"这回事了——这条模式的全部前提就是那个手拉的固定值还得留着。
- **量的必须是内容本体，不是滚动盒**：`scrollHeight` 永不低于 `clientHeight`，拿它算就是
  "只会长不会缩"。写下去的尺寸与量到的视口差一圈（边框），所以基准分两侧记。
- **自动改窗那一下不能被当成手拉**：写下去之后留 500ms 静默期，期间的尺寸只用来重新锚定。

## 右键菜单（M6 追加）

判定与画法是两层，分开放：`features/sticky/note-menu.ts`（纯函数：右键落在什么上 →
该给哪几项，`data/body-parse.ts` 之后第二条"规则比 JSX 更容易改乱"的拆法）和
`ui/context-menu.tsx`（窗内自画的定宽菜单，只管夹位置、键盘走焦、关掉的三条途径）。
菜单项靠 DOM 上的 `data-seg` / `data-media` / `data-href` 认领——这些属性由
`rich-text.tsx` 在画段的时候一起写进去，所以命中判定不需要第二份正则。

三条口径：**尾巴那五项跟着谁右键都同一串**（通用项不该因为点在链接上就消失）；
**危险项排在自己那一段的最后**（删除便签、删掉这张图），不让人闭眼点到；
**"删掉这张图"只对正文里的引用开**——条目里那张要删就连条目一起删，判定是
`note.body.includes('media://id')`，不是"这是一张图"。

不用系统菜单：无框透明窗里原生菜单的样式跟这张纸对不上，也带不动应用内动作。
**落点在表单控件里就交回浏览器**（`target.closest("input, textarea, select")`）：正文
textarea、标题框、清单/时间轴每条那个 input，人要的是剪切/复制/粘贴/拼写。
**唯一的例外**是正文那块 textarea：**一律接管**（作者要了两次），给的是
变成链接/复制/剪切/全选，**没有粘贴**（`clipboard-read` 在 WebView2 上不稳，没引插件），
没选区时就只剩「全选」+ 通用五条。标题框与清单/时间轴每条那个 input 仍走系统菜单。
**菜单弹在 `pointerup`（capture）那一拍**，不等 `contextmenu`：可编辑区里 Chromium 要先
准备它自己的菜单才派发那个事件（真机报的"有延迟"），我们这侧从事件到画完只有 0.4ms，
能做的只是把弹出挪到那段等待之前；随后的 `contextmenu` 只 `preventDefault`。
剪切是自己实现的（复制 + 删选区），**先复制、成了才删**：失败就把字原样留着说清楚。
阅读态的"点一下进编辑态"必须**先认选区**（`isCollapsed`）——Chromium 里拖选结束照样派发
`click`，无条件进编辑态就是把刚拖出来的选区销毁掉，右键菜单永远到不了。

"把选中变成链接"多了一层，因为菜单项需要一个**原文区间**而不是几个字：
`parseBodySpans` 算区间（唯一的算法处，`parseBody` 是它的投影），`rich-text` 只把区间
写给纯文本那几段（链接/代码/图的区间含着 `[]()` 那些语法字符，裹进链接就是坏数据），
`selection-range.ts` 把 DOM 选区落回区间，最后**必须逐字比一次**
`body.slice(start,end) === range.toString()` 才承认——选跨了非文本段必然不等，
那条菜单项就不出现。改正文的动作全收在 `wrapLink` 里（协议、`[]`、空格括号、超长），
失败**不关输入块**：他还没打完。

**四类便签的"这块文本"不在同一个字段**：文本/提醒是 `body`，清单是 `items[].text`，
时间轴是 `timeline[].text`。凡是对"这一块文本"动手的动作（变成链接、删掉那张图的引用、
加一张图加到哪、以及"复制这一块"的回执文案）都要先问目标是哪块 —— `row-target.ts`
就是这一层，`RowRef` 用 **id** 不用下标（条目能增删能重排，下标在右键之后就可能变了）。
`plainBody` / `bodyActionLabel` 在 `data/note-types.ts`。漏一个分支不会报错，
只会**给你一句假的「复制正文」并且复制出空串**，所以文案与取数都得跟着类型走。

## 这一档的尺寸（M6 追加）

便签有三种"多大"：展开（行里的 `width/height`，下限 220×200）、收起成标题栏
（高固定 62、宽 `min(当前, 360)`）、贴边细丝（20×20）。**任何要摆窗的地方都得先问
"现在是哪一档"**——`use-dock-snap` 以前只认展开尺寸，所以收起态被明令禁止贴边。
现在 dock 的落点走 `modeSize/modeRect`（同一个口径），什么形态贴进去就什么形态滑出来。

跟着档走的还有**原生最小尺寸**：`minimized || docked` 时必须是"不限"，否则系统当场把
62 的栏撑成 200、把细丝撑成 220×200。这条有**两个时刻**要管，漏一个就有对应的 bug：
出生那一刻由 Rust 管（`float::mode_geometry` 一次给「尺寸 + 下限」，单窗与叠窗共用——
以前两处各写一遍，单窗漏了，症状是"收起态退出重开那条栏占一大块"）；会话内切换由前端管
（`features/sticky/window.tsx` 与 `group-stack.tsx` 各一条 effect，贴边动画途中的两次写
留在 `use-dock-snap`，因为它要挑时机）。

**叠窗也有收起这一档**（`features/sticky/group-stack.tsx`）：同一条 62/360、同一条
"先撤下限再缩"。它与单窗差在一件事——**恢复成多大的住址不同**。单窗存进行里的
`width/height`，叠窗的窗体记忆在 `window_state`（`frames::track` 认 `stickygrp-*`），
收起期间它记的就是那条栏，所以收起那一刻要把**当时的展开尺寸**报给 `group_set_collapsed`
写进 `groups.width/height`：一处存两处用，不另立字段。开合状态同理双址——
跨会话读组行（出生尺寸与 `__STICKY_COLLAPSED__` 都由 Rust 在建窗前给定），
会话内归这扇窗自己的 state（与 `pinned` 的分工一模一样）。

还有一条只属于叠窗：它吃 `frames::apply_saved`（`stickygrp-*` 在追踪表里），而那条栏
是能被手拽高的（这一档没有原生下限挡着），于是记着的尺寸会大于 62、下次开机被原样放回
→ "收起了，但下面空一块"。所以 `open_group_stack` 在 `apply_saved` 之后按这一档把高度
压回 62（宽度不管）。单窗不吃 `apply_saved`（出生尺寸从便签行重算），没这一笔。

**窗级动作归标题条右侧那一槽**（`WindowChrome` 的 `trailing`）：「收起为标题栏」与贴边
滑出时的「收回」都在那儿，单窗与叠窗同一个位置（作者要的就是这句"统一最小化按钮到右上角，
和组合保持一致"）。`NoteContent` 原来那个 `windowActions` 槽随之整条删掉——叠窗三档里有两档
压根不渲染正文，页脚那个位置对它不存在，两颗钮分住两处就迟早要长成两条规则。
收起态不给「收起」：那条栏上已经有「展开」。

**贴边这一档单窗与叠窗共用同一份实现**：`use-dock-snap` 不吃 `StickyNote`，吃的是一份
`DockTarget`（id / docked / dockEdge / x / y / 展开档宽高 / `write`）——单窗那份来自便签行、
`write` 走 `updateNote`；叠窗那份来自组行（`groups.docked/dock_edge`，迁移 0008）、`write` 走
`group_set_dock`。判定与动画只有一份：那七条时序纪律（回声按位置不比时间、状态翻在补间前、
原生下限跟着档走、rAF 可能一帧都不跑所以要有可能到点的看门狗……）一条都经不起被抄第二遍。
两个只属于叠窗的差别：组行是异步到的 → 恢复那条 effect 的依赖带 `target?.docked`，且用
`restoredRef` 保证只摆一次；`write` 必须**先翻本地 state 再发 IPC**（单窗靠 store 回流天然有
这一拍），否则细丝摆出去了壳体还挂着。销毁清账（`on_window_event`）要剥**两个**前缀——
只认 `sticky-` 的话，一叠贴着边被关掉会把槽位永远留在册上。

**贴边的入口只有"用户真的拖过窗"这一种**，两条配套的护栏：
· `isMaximized()` 为真一律不贴。Tauri 的 drag region 在 Windows/Linux 上是
"mousedown 拖、**双击最大化**"（`window/scripts/drag.js` 里 `e.detail` 1 与 2 同路），
最大化后的矩形离四条边 gap 全是 0，不挡就等于"双击标题条 → 这张签自己贴边跑了"；
· 标题条上要放可点的改名入口，就得是 **BUTTON 而不是给 span 加双击**——同一份 drag.js
里"clickable 元素不带该属性就不触发拖动"，这条既是交互也是那个坑的绕法。

## 提醒（M6 追加）

**计时不许住在窗里**：便签窗可能是隐藏的（贴边、收起、被关掉），而 WebView2 对隐藏页
把 `setInterval` 节流甚至暂停——"到点不响"就是这么来的。常驻判定住在 Rust：
`src-tauri/src/reminders.rs` 一条**自己的线程**，30 秒一轮。不是
`async_runtime::spawn`：每轮睡 30 秒等于把一格 worker 整段堵死，而开窗、清算、
钩子事件都在同一个运行时上跑。

三条判据（纯函数 `db/query/reminder.rs::due_to_fire`）：发生点已经过去、
`now - 发生点 ≤ 24h`、`reminded_at != 发生点`。**`reminded_at` 存的是发生点而不是时间戳**——
一改到期时间就自动重新生效，于是全工程没有"清标记"这个动作可以写错。门槛只有
`content_type='reminder'` 且未删未勾（别的类型填了 `due_at` 没有意义，不响）。

动作顺序是刻意的：**先发通知，再写 `reminded_at`**（反过来一旦发的那步崩了，这条提醒
永远哑，而用户完全看不出来）。"拉到屏上"按 `group_id` 分流：散着的找 `sticky-<id>`，
组员找 `stickygrp-<gid>` 并广播 `sticky:reveal` 翻到那一张——只 show 不翻等于拉出来
一叠里的别的张。**一律不 `set_focus`**（星环那条老理由：右键一下就把用户正在打字的
应用的焦点抢走，比没有反馈严重得多）。

toast 里不许出现私密便签的标题（它会出现在锁屏与通知中心）。插件 `show()` 的返回值
是被丢掉的，所以日志那句"已发系统通知"只等于"交给系统了"，不是"用户看见了"——
真机上到底有没有出 toast，只能看屏幕。

**"看得见"这件事不能押在系统上**（作者两次报"提醒没弹"，日志两次都写着"已发系统通知"）。
系统通知只在 `looks_installed()` 为真时发：直跑 `target/*` 那一版里插件不写
AppUserModelID，notify-rust 会退回它的兜底常量，那条 toast 就以 **Windows PowerShell**
的名义出；而 Windows 认领 AUMID 靠开始菜单里那条快捷方式——没装过就没有。
取而代之的是**自己画的一张卡**（`windows/card.rs`）：主屏**工作区**右下角一扇 320×88 的
透明置顶窗，`focused: false` 且报就绪走 `float_reveal(focus: false)`（到点的提醒不许抢走
打字的光标），12 秒自己走。**整张卡就是"去看这张便签"那一个按钮**，底色/墨色/那道脊取自
那张便签自己的 `theme`（payload 传键不传十六进制——颜色表只有前端 `data/theme.ts` 那一份）。
点它跳到那张便签。三条纪律：

- 卡上的字**只从注入的 payload 拿**。按 id 回查 store 就等于把锁后面的标题正文
  画到了一张不锁的卡上（Rust 那边已经按私密口径洗过一遍，这层不再判第二次）；
- 收窗**只有 Rust 一处计时**（`GENERATION` 那一格才有权 destroy）。两处计时必有一个是错的，
  而那个错的形状是"卡赖着不走"或"还没读完就没"；
- 一叠提醒只留一张卡：已经有窗就广播 `reminder:show` 换内容，不 destroy + 重建
  （那会撞 `factory` 的建窗占位）；
- 点卡 = `unminimize` + `show` + `set_focus` **+ 一条 `sticky:ping`**。最后那条不是装饰：
  那张便签常常本来就开着、还在前台，摆位与焦点对它改变不了任何看得见的东西（作者报的
  "点了没反应"），所以握着她的那扇窗要把纸边**内侧**闪一圈答一声（外描边会被透明窗裁掉）。
  **贴着的那一张要先滑出再闪**——细丝那 20×20 里壳体压根没渲染，圈画在哪儿都看不见。
  命令两端都要留日志——前端 `logger` 只进内存与 console，发布版里看不见。

**托盘那两条批量动作**（`windows/hide_all.rs`）：「收起全部便签 / 恢复全部便签」是
**会话级**的——记的是"这一手藏了哪几扇 label"，不落库（落库会做出"我明明开着它，重开却
没了"，而"从此不显示"已有归宿：关掉那扇窗 / `floating` 那一列）。只动 `sticky-*` 与
`stickygrp-*`，面板窗/令窗/星环/提醒卡都不碰。连带一条：全收着的时候到点的提醒**不往屏上
拉**（卡照画、点卡仍会开那一扇），否则"一键隐藏"就成了"只安静三十秒"。
快捷键是同两条动作（`Alt+6` / `Alt+7`），**动作 id 与托盘菜单 id 同一条**（`hide-all` /
`show-all`）：一个动作两个名字迟早分叉成"设置里那一行按了没反应"。热键表在三个地方各有一份
抄本（Rust 的 `DEFAULT_BINDINGS`、预览台那份、设置窗的 `ACTION_LABELS`），由
`preview/hotkey-table.test.ts` 按源码文本比对钉住——注释里那句"改一边要同步另一边"拦不住过。

## 私密层不变量（改任何一条 = 安全变更）

Argon2id（口令按字符数 8..=1024，上限只挡写路径）+ AES-256-GCM（盐 16B / nonce 12B
每次随机；AAD 按版本×用途成套）。密钥零持久化（`Zeroizing`，锁定=丢内存）。
错误只分两级（WEAK_PASSWORD / CRYPTO_OPEN），不细分防侧信道。原子落盘 tmp→rename。
损坏封套按未配置算、不删不猜。重置（忘记密码唯一出路）清空私密内容、仅未解锁可走。
私密便签主库行只留空占位，真身整份进 private.json——读合并/写拆分在
`store/private-backend.ts`（Backend 包装层），store 与视图对此无感知。
图片字节不进 private.json（那文件每次写都整份重加密），而是 `media.bytes` + `enc=1`，
密钥是被会话密钥包在封套里的 `mediaKey`（缺字段的老封套照样解，第一次用到时补上）。

## Rust 侧纪律（真机换来的，动摇即回归）

- 钩子回调（WH_MOUSE_LL）**零跨进程调用、零阻塞锁、零日志**；互斥用 `try_lock`
  竞争即放行；注入事件带 LLMHF_INJECTED 直接放行防自反馈；预算 ≤1ms。
- 浮窗销毁用 `destroy` 不用 `close`（close 依赖前端监听器往返，会留僵尸窗）。
- 建窗必须 async；`CreatingRegistry` 把"开始创建"变成原子占位防重复建窗。
- 锁 poison 可恢复（`unwrap_or_else(|p| p.into_inner())`）——release 是 `panic="abort"`。
- 单实例：二次启动只唤起星环，绝不重复装钩子/快捷键。
- 退出（RunEvent::Exit）第一件事卸鼠标钩子。
- **透明窗在建窗处统一 `set_shadow(false)`，且返回值要记账**（`windows/factory.rs`）。
  系统阴影绕着 *窗口矩形*画 1px 亮边 + 矩形投影，而卡片自己是圆角的 → 四角露白边。
  这条必须在建窗一处收口：星环先踩过、自己在 `ring.rs` 调了一句，便签与叠窗是漏的那个。
  它走系统属性、成不成随系统版本与窗样式，`let _ =` 吞掉就等于让"白纸上还有一圈"
  变成猜——所以关成了/关不掉各记一行，真机看一眼日志就定性。
- **透明窗别出生就可见**：`WindowSpec.reveal_timeout_ms` = 建隐窗，前端整树提交后
  喊 `float_reveal` 才 show（`entries/boot.tsx` 的 `RevealWhenCommitted`）。
  Tauri 只在 `background_color` **显式给了**才下传，没给就吃 WebView2 默认白 →
  开机那块白要撑到 hydrate + 首帧。别指望用 `background_color(0,0,0,0)` 代替：
  Windows 的 window 层忽略 alpha，那是一块黑刷子。**必须有超时兜底**（到点无条件
  show）——看不见便签比闪一下白严重。

## 门禁

`npm run typecheck` / `lint` / `format:check` / `test` /
`build`（六入口）/ `size`（dist ≤1.5MB 预警、安装包 ≤12MB 硬线）；
`cargo clippy --all-targets -- -D warnings` / `cargo test`。
（用例条数故意不写在这里——它每轮都变，写死就是等着过期。当前条数看 `npm test` / `cargo test` 的输出。）

## 现在不做（有意）

- 便签墙（作者拍板删除；分组保留降级：移进/移出已有组，无新建入口）。
- FTS5 检索（LIKE 子串在当前量级零成本；索引同步才是 FTS 的真成本，量级到了再做）。
- localStorage 兜底 / 存储模式机（Backend 注入替代，故障 = 明确错误界面）。
- 悬停滑出贴边（点细丝滑出 / 收纳钮收回 / 拖动即解除——确定性优先，可再调）。
- 远程图片自动加载（要放开 CSP 的 `img-src https:`，代价是任何一张便签都能拿用户的 IP
  去敲陌生服务器；现在给芯片 + 点开走浏览器）。
- Markdown 渲染器（正文识别只做"看出来"，不做排版：不认标题/表格/列表嵌套，
  嵌套记号一律不解析——认得越少越不会把用户的话切错）。
- 正文里删掉引用时的孤儿图片字节（撤销会把引用打回来，跟着删就变成"撤回来一张碎图"；
  硬删便签与回收站清算都照清）。
