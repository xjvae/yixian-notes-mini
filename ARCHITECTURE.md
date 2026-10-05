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
  data/             纯领域逻辑（entities / validate / theme / due / scheme / private-state…）
  window/           窗口行为（身份注入 / 几何合流 / 贴边 dock-model 纯函数 / use-dock-snap）
  ui/               共享视觉件（WindowChrome 全窗口共用一份标题条）
  features/         每扇窗一个目录（sticky / ring / trash / search / settings / unlock）
  entries/          HTML 入口装配（boot：initScheme → initPrivateState → hydrate）
src-tauri/          Rust
  commands/         全部 IPC 命令（唯一注册点；generate_handler 必须写完整模块路径）
  db/               SQLite 主库（pool / migrate / models / query/{sticky,group,search,…}）
  data/             私密层（crypto / private 封套与 vault）
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

## 私密层不变量（改任何一条 = 安全变更）

Argon2id（口令按字符数 8..=1024，上限只挡写路径）+ AES-256-GCM（盐 16B / nonce 12B
每次随机；AAD 按版本×用途成套）。密钥零持久化（`Zeroizing`，锁定=丢内存）。
错误只分两级（WEAK_PASSWORD / CRYPTO_OPEN），不细分防侧信道。原子落盘 tmp→rename。
损坏封套按未配置算、不删不猜。重置（忘记密码唯一出路）清空私密内容、仅未解锁可走。
私密便签主库行只留空占位，真身整份进 private.json——读合并/写拆分在
`store/private-backend.ts`（Backend 包装层），store 与视图对此无感知。

## Rust 侧纪律（真机换来的，动摇即回归）

- 钩子回调（WH_MOUSE_LL）**零跨进程调用、零阻塞锁、零日志**；互斥用 `try_lock`
  竞争即放行；注入事件带 LLMHF_INJECTED 直接放行防自反馈；预算 ≤1ms。
- 浮窗销毁用 `destroy` 不用 `close`（close 依赖前端监听器往返，会留僵尸窗）。
- 建窗必须 async；`CreatingRegistry` 把"开始创建"变成原子占位防重复建窗。
- 锁 poison 可恢复（`unwrap_or_else(|p| p.into_inner())`）——release 是 `panic="abort"`。
- 单实例：二次启动只唤起星环，绝不重复装钩子/快捷键。
- 退出（RunEvent::Exit）第一件事卸鼠标钩子。

## 门禁

`npm run typecheck` / `lint` / `format:check` / `test`（55+）/
`build`（六入口）/ `size`（dist ≤1.5MB 预警、安装包 ≤12MB 硬线）；
`cargo clippy --all-targets -- -D warnings` / `cargo test`（55+）。

## 现在不做（有意）

- 便签墙（作者拍板删除；分组保留降级：移进/移出已有组，无新建入口）。
- FTS5 检索（LIKE 子串在当前量级零成本；索引同步才是 FTS 的真成本，量级到了再做）。
- localStorage 兜底 / 存储模式机（Backend 注入替代，故障 = 明确错误界面）。
- 悬停滑出贴边（点细丝滑出 / 收纳钮收回 / 拖动即解除——确定性优先，可再调）。
