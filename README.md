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
  preview/      dev 预览台（假数据核 + 替身桥 + 宿主），不进生产构建
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

数据目录：`%APPDATA%\com.yixian.notes.mini.v2\`（与旧版应用隔离；旧库导入是一次性路径，代码在 `src-tauri/src/import.rs`）。

## 预览台（dev only）

```bash
npm run dev              # 然后开 http://localhost:5174/preview.html
```

每扇框是一个真 iframe，跑的是真入口（`index.html?preview=1&…`），所以 `h-screen` 量的是
真窗尺寸；`preview.html` 与替身桥都不进 tauri 的构建产物（`vite.config.ts` 只在 serve
模式加这个入口，`entries/boot.tsx` 的装桥代码在 `import.meta.env.DEV=false` 时被折掉）。

拦在 `platform/bridge` 的 DevBridge 一层，不拦 Backend：store、去抖落库、跨窗合流、
私密层包装、窗体组件全走真路径，被替代的只有"操作系统 + Rust"。
假数据核 `src/preview/fake-db.ts` 逐条对着 Rust 的 SQL/错误码抄——**改了 Rust 侧那些行为，
这里必须跟抄**，否则预览台就在骗人；窗型尺寸在 `src/preview/window-specs.ts` 同样是一份镜像。

预览台验不了（只能真机）：OS 边框拖动、贴边细丝与 20px 收纳、多显示器/DPI、全局快捷键、
长按右键钩子、文件日志与崩溃转储。它也**不校验 IPC 参数名契约**（camelCase↔snake_case
由 Tauri 转换，那条只能真机或 clippy 侧看）。

## 关键设计决定

- 便签墙**不做**；分组保留降级（叠窗 + 移进/移出已有组）。
- 数据核没有 localStorage、没有模式机：主库不可用就是错误界面。
- 写路径是实体粒度：`updateNote(id, patch)` → 去抖 250ms → 单行 upsert，
  不存在"整包差集"这类能丢数据的机制。
- Rust 侧锁 poison 可恢复、`MutexGuard` 不跨 `.await`、浮窗销毁用 `destroy`。
