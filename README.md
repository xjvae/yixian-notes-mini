# 一闲笔记 mini（全新实现）

Windows 桌面便签。Tauri 2 + React 19 + SQLite；从零写起，不带历史实现。

```
src/            前端（每扇窗一个 WebView）
  platform/     与 Tauri 的唯一接面（contracts / bridge / commands / errors / logger）
  store/        数据核：typed store，实体粒度写，单一跨窗机制（db:changed），无 localStorage
  data/         纯领域逻辑（entities / validate / theme …）
  window/       窗口行为（身份注入 / 几何 / 生命周期 / 贴边）
  ui/           共享视觉件（WindowChrome 等）
  features/     每扇窗一个目录
  entries/      HTML 入口装配
src-tauri/      Rust 后端
  commands/     全部 IPC 命令（唯一注册点）
  db/           SQLite 主库（pool / migrate / models / query）
  windows/      窗口构建（factory 声明式规格 + 防重复注册 / float 浮窗）
  support/      错误类型
docs/           方案与文档
```

## 开发

```bash
npm install
npm run tauri:dev        # 前端 + Rust 一起跑（首次编译较久）
npm test                 # 前端测试
cargo test               # 在 src-tauri/ 下
npm run lint && npm run typecheck
```

数据目录：`%APPDATA%\com.yixian.notes.mini.v2\`（与旧版应用隔离，旧库导入见 ROADMAP M4）。

## 关键设计决定（详见 ROADMAP.md）

- 便签墙**不做**；分组保留降级（叠窗 + 移进/移出已有组）。
- 数据核没有 localStorage、没有模式机：主库不可用就是错误界面。
- 写路径是实体粒度：`updateNote(id, patch)` → 去抖 250ms → 单行 upsert，
  不存在"整包差集"这类能丢数据的机制。
- Rust 侧锁 poison 可恢复、`MutexGuard` 不跨 `.await`、浮窗销毁用 `destroy`。
