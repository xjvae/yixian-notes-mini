# ROADMAP — 一闲笔记 mini（全新实现）

> 本工程是「一闲笔记 mini」的 clean-room 全新实现：不搬旧代码，旧实现只作为
> 行为参照（尤其是真机换来的窗口纪律）。目标：无历史债的 1.0。

## 架构基线（已定，不重开）

- **栈**：Tauri 2 + React 19 + TypeScript(strict) + Tailwind 4 + bundled SQLite。
- **数据核**：typed store（`src/store/`）——实体粒度写、单一跨窗机制（`db:changed`）、
  **无 localStorage**、无模式机（主库不可用 = 明确错误态；测试/预览注入内存 Backend）。
- **窗体外壳**：只有一份 `ui/WindowChrome`（拖动条/把手/关闭/置顶），所有窗口共用。
- **便签墙**：**不做**（作者拍板）。分组保留降级：叠窗 + 移进/移出已有组，无新建组入口；
  标签保留为便签芯片。
- **Rust 侧纪律**（真机换来的，绝不动摇）：命令全在 `commands/`；`MutexGuard` 不跨
  `.await`（DB 走 `run_db`/spawn_blocking）；锁 poison 可恢复；浮窗销毁用 `destroy`；
  建窗必须 async + 防重复注册；钩子回调内零跨进程调用/锁/日志。

## 里程碑

### M0 · 可跑骨架 ✅（本次提交）

- [x] schema v1（stickies/groups/settings/window_state）+ 迁移器 + 单测
- [x] 命令：get_bootstrap / sticky_list / sticky_upsert / sticky_delete /
      create_floating_sticky / close_floating_sticky
- [x] 前端 typed store + useSyncExternalStore 绑定 + 行为契约测试
      （实体粒度写 / 远端合流不覆盖在途 / 失败重试）
- [x] 便签浮窗：标题/正文/六色/置顶/关闭 + WindowChrome
- [x] 托盘：新建便签、退出
- [x] 持久化往返：编辑 → 去抖单实体落库 → 重启恢复

### M1 · 便签本体完整（目标 0.2.x）

- [x] 四类便签：清单（勾选/增删行/条目 id 稳定）、提醒（due_at 分档角标）、时间轴
- [x] 标签芯片（增删、色彩）；类型转换（转类保留 due_at）
- [x] 收起 62px 标题栏形态；窗口几何持久化（moved/resized 合流 180ms + 最小尺寸纠偏）
- [x] 贴边吸附（纯函数判定层 + rAF 接线 + 20px 细丝 + 多窗错开）——交互口径：点细丝滑出 / 收纳钮收回 / 拖动即解除（确定性优先，不做悬停滑出）
- [x] 删除 → 回收站 + 回收站窗（恢复/彻底删除/30 天清算）
- [x] 字数上限、错误反馈条、ErrorBoundary
- [x] dev 预览台（假 IPC + 指定尺寸 iframe）与对拍工具：`preview.html`（只在 vite serve
      模式存在，装桥代码在 DEV=false 时被折掉）。拦在 `platform/bridge` 的 DevBridge 一层，
      store / 去抖落库 / 跨窗合流 / 私密包装 / 窗体组件全走真路径；
      假数据核逐条对着 Rust 的 SQL 与错误码抄（`src/preview/fake-db.ts`），
      窗型尺寸是 Rust 常量的镜像（`src/preview/window-specs.ts`）。
      落地当天抓到四条：桥回包把 `event.source` 当 HTMLIFrameElement 用（回包全丢）、
      身份判定放在 boot 之前（叠窗分支永不成立）、宿主订阅了 `frames.length` 而不是
      版本号（改摆位不重渲染）、假库漏仿 `store:private-changed`（差点把"明文不落盘"
      误报成应用 bug）。
      验不了的：OS 边框拖动、贴边细丝、多显示器/DPI、全局快捷键、鼠标钩子、文件日志；
      也不校验 IPC 参数名契约（camelCase 由 Tauri 转，那条只能真机看）

### M2 · 检索与设置（目标 0.3.x）

- [x] 检索 + 搜索窗（子串匹配 LIKE + 转义；标题命中优先；私密/已删不进结果；
      150ms 防抖；点结果拉窗；Esc 关窗。FTS5 待量级需要再做，索引同步是它的真成本）
- [x] 设置窗（外观三档主题 / 行为开机恢复开关 / 数据立即备份）
- [x] 全局快捷键后端：默认 Alt+1..4 直达（新建/搜索/回收站/设置）+ Alt+Space 唤星环，
      逐条注册逐条容忍失败，app_set_hotkey 校验+热重绑+落库（被占用回退旧键）；
      **设置窗的改键 UI 已落**（键盘捕获：Esc 取消、纯修饰键不结束捕获、必须带 Ctrl/Alt；键名走 event.code 与 global-hotkey 同口径，见 hotkey-section.tsx）
- [x] 深色模式（scheme.ts 三档 + <html data-theme> 变量层 + 便签深色成对纸色/强调色）
- [x] 文件日志（按天 mini.log.YYYYMMDD、保留 7 天、stderr 双写）；崩溃转储随 M4

### M3 · 私密层与组合（目标 0.4.x）

- [x] 私密层：Argon2id + AES-256-GCM 私密封套、解锁窗（设置/解锁/重置三相 +
      改密经 private_rekey）、私密便签读合并/写拆分（**不变量**：密钥零持久化、
      错误两级、原子落盘、AAD 成套、口令按字符数 8..=1024——均已用例钉住）
- [x] 标记私密当场开口令窗引导；托盘「立即锁定」（未配置也开口令窗显示设置表单）
- [x] 组合（降级）：叠窗（一叠一窗 + 翻页：条状切片点击跳张、上一张/下一张环形，
      **不做真扇面动画**）、移进/移出已有组、空组自动清。连带落定的三条口径：
      ①组员不再单开一扇——`open_sticky` 认到在组里的成员就改开它所在叠窗，
      所以搜索点结果与回收站恢复都落在叠窗里；
      ②叠窗几何的活住址是 window_state（`frames::is_tracked` 认 stickygrp-*），
      groups 行的 x/y/w/h 只当首次落点（导入带进来的摆位）；
      ③空组自动清跟着四条写路径：归组/移出/删除/开机回收站清算后。
      翻页当前张认 id 不认下标（成员序是 updated_at DESC，敲字会把那张顶到最前）
- [x] 组合的两条尾巴（预览台实测抓出来，都在后端形状上）：
      ①**叠窗落点**：点搜索结果 / 归组 / 回收站恢复都要落在"你点的那一张"，
      不再停在叠窗首张。冷开走 init_script 的 `__STICKY_FOCUS_ID__`，
      窗已经在了走 `sticky:reveal {groupId,stickyId}` 广播（叠窗按 groupId 认领）；
      ②**私密写不认缓存位**：`private-backend` 的写与硬删改为一律 `privateStatus()` 取权威，
      并在整份重写封套前先装填——缓存停在"未配置"时按直通写下去就是明文落主库，
      而没装填就重写会把别人的真身抹掉。两条各有用例钉住
- [ ] 组合真机判据（本机没有带组的旧库就开不出这一叠）：导入旧库 → 叠窗显形 → 翻页/
      跳张/移进移出/删空自关；叠窗拖动重开的摆位是否回来；置顶不持久（groups 行无
      pinned 列）是否可接受——要持久得加列，属架构决定

### M4 · 唤起与系统级（目标 0.5.x）

- [x] 星环（radial menu）4 节点：新建便签/搜索/回收站/设置。**每次开在光标处**
      （GetCursorPos 物理像素 + scale_factor 换算，再整块夹回该显示器工作区——半个环出界
      = 两个节点点不到）；**关 = 隐藏**（要秒开，销毁重建 WebView 的代价正好落在
      "按下到看见"这段时间上；预览台实测重开拿到的还是同一个窗实例）。
      收场三条：点节点、点环外空白、Esc，外加窗失焦。
      工作区取值那份 unsafe 集中到 `windows/monitor.rs`，命令层 monitor_work_area 与星环共用；
      负坐标的副屏有夹取用例
- [x] WH_MOUSE_LL 长按右键钩子：state.rs 纯状态机（按下吞事件起计时→阈值只武装→松手在松手点开盘；短按 SendInput 补一对完整 down/up；位移>6px 判拖拽补 down 转透传）+ allowlist.rs 纯白名单（基名/结尾通配/去重/上限32，读不到算不命中）+ win_hook.rs 机器房（回调零跨进程/try_lock 竞争即放行/LLMHF_INJECTED 防自反馈；采样线程 200ms；退出 PostThreadMessageW(WM_QUIT)+500ms+主线程卸钩兜底）。阈值 450 默认/150..=2000 夹取，落库；暂停不落库（重启即恢复）
- [x] 单实例唤起：二次启动不再静默退出，回调里唤起星环（回调内不碰锁不碰 DB）
- [x] 退出清理：RunEvent::Exit 第一件事 input::shutdown()（换 build()+app.run(closure)）。崩溃转储：有意不做（文件日志已够定位，且 panic=abort 下留不了堆）
- [x] window_state 面板窗记忆（搜索/回收站/设置三扇，合流 600ms，物理像素往返）
- [x] 旧版 mini.db 一次性导入（幂等标记同事务；只读旧库；列映射逐格对齐；
      items "[x] 文本"+item_ids 合成对象数组；墙存量 floating=0 导入时摊回桌面；
      已删行原样进回收站）

### M5 · 1.0

- [ ] 全量真机清单（钩子/贴边/多显示器/DPI/私密三件套/单实例/退出）——作者执行，清单见 README 与各期验收注
- [x] NSIS 安装包 + 体积门禁（`npm run size`：dist ≤1.5MB 预警、安装包 ≤12MB 硬线 --ci 可作 release 关卡）
- [x] ARCHITECTURE.md（目标架构 + 数据流 + 不变量 + 纪律清单）

## 执行约定

- 每个里程碑出一次包（`scripts/release` 三处版本同步——M1 建脚本）。
- 前端门禁：typecheck / lint / test / build；Rust 门禁：clippy -D warnings + cargo test。
- 测试字面量绑定**用户可见行为**；机制类断言随实现演进，行为断言不静默改。
- 数据不可逆动作（清算/导入/摊回）必须有幂等用例 + 真机判据。
