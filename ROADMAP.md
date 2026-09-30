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
- [ ] dev 预览台（假 IPC + 指定尺寸 iframe）与对拍工具

### M2 · 检索与设置（目标 0.3.x）

- [x] 检索 + 搜索窗（子串匹配 LIKE + 转义；标题命中优先；私密/已删不进结果；
      150ms 防抖；点结果拉窗；Esc 关窗。FTS5 待量级需要再做，索引同步是它的真成本）
- [x] 设置窗（外观三档主题 / 行为开机恢复开关 / 数据立即备份）
- [x] 全局快捷键后端：默认 Alt+1..4 直达（新建/搜索/回收站/设置），逐条注册逐条容忍失败，
      app_set_hotkey 校验+热重绑+落库（被占用回退旧键）。Alt+Space 唤星环随 M4 进表；
      **设置窗的改键 UI（键盘捕获组件）随 M4 与星环一起落**
- [x] 深色模式（scheme.ts 三档 + <html data-theme> 变量层 + 便签深色成对纸色/强调色）
- [x] 文件日志（按天 mini.log.YYYYMMDD、保留 7 天、stderr 双写）；崩溃转储随 M4

### M3 · 私密层与组合（目标 0.4.x）

- [x] 私密层：Argon2id + AES-256-GCM 私密封套、解锁窗（设置/解锁/重置三相 +
      改密经 private_rekey）、私密便签读合并/写拆分（**不变量**：密钥零持久化、
      错误两级、原子落盘、AAD 成套、口令按字符数 8..=1024——均已用例钉住）
- [x] 标记私密当场开口令窗引导；托盘「立即锁定」（未配置也开口令窗显示设置表单）
- [ ] 组合（降级）：叠窗（一叠一窗、扇面翻页）、移进/移出已有组、空组自动清

### M4 · 唤起与系统级（目标 0.5.x）

- [ ] 星环（radial menu）4 节点：新建便签/搜索/回收站/设置
- [ ] WH_MOUSE_LL 长按右键钩子（吞 down + 阈值 + 补偿注入 + 前台进程白名单采样线程）
- [ ] 单实例唤起（动作随星环落地）、退出清理（钩子卸载兜底）、崩溃转储
- [x] window_state 面板窗记忆（搜索/回收站/设置三扇，合流 600ms，物理像素往返）
- [x] 旧版 mini.db 一次性导入（幂等标记同事务；只读旧库；列映射逐格对齐；
      items "[x] 文本"+item_ids 合成对象数组；墙存量 floating=0 导入时摊回桌面；
      已删行原样进回收站）

### M5 · 1.0

- [ ] 全量真机清单（钩子/贴边/多显示器/DPI/私密三件套/单实例/退出）
- [ ] NSIS 安装包 + ≤12MB 体积门禁 + size 报告
- [ ] ARCHITECTURE.md（目标架构 + 数据流 + 不变量）

## 执行约定

- 每个里程碑出一次包（`scripts/release` 三处版本同步——M1 建脚本）。
- 前端门禁：typecheck / lint / test / build；Rust 门禁：clippy -D warnings + cargo test。
- 测试字面量绑定**用户可见行为**；机制类断言随实现演进，行为断言不静默改。
- 数据不可逆动作（清算/导入/摊回）必须有幂等用例 + 真机判据。
