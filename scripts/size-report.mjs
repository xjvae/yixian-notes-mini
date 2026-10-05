#!/usr/bin/env node
// size-report — 构建产物的体积门禁。
//
// 两条线：
//   · dist/（前端六入口 + 资源）预警线 1.5 MB——超了说明有东西混进主包（预览台
//     混进产物、图标没压缩、依赖没按入口分包），属于"该查"的信号；
//   · 安装包（NSIS exe）硬线 12 MB——超过即 exit 1。桌面便签装 50MB 是丑闻。
//
// 用法：先 npm run tauri:build（或至少 vite build），再 node scripts/size-report.mjs。
// --ci 模式（release 流程用）：dist 超预警线或安装包超硬线都 exit 1。

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST_BUDGET = 1.5 * 1024 * 1024;
const INSTALLER_BUDGET = 12 * 1024 * 1024;
const ci = process.argv.includes("--ci");

function walk(dir) {
  let total = 0;
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(path);
      total += sub.total;
      files.push(...sub.files);
    } else {
      const size = statSync(path).size;
      total += size;
      files.push({ name: entry.name, size });
    }
  }
  return { total, files };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

let failed = false;

if (existsSync("dist")) {
  const dist = walk("dist");
  console.log(
    `dist/            ${mb(dist.total)}  （${dist.files.length} 个文件，预警线 1.5 MB）`,
  );
  if (dist.total > DIST_BUDGET) {
    const top = dist.files.sort((a, b) => b.size - a.size).slice(0, 5);
    console.log("  超预警线！最大的几个文件：");
    for (const file of top) console.log(`    ${file.name}  ${mb(file.size)}`);
    if (ci) failed = true;
  }
} else {
  console.log("dist/ 不存在（先 npm run build）");
  if (ci) failed = true;
}

const nsisDir = "src-tauri/target/release/bundle/nsis";
if (existsSync(nsisDir)) {
  const installers = walk(nsisDir).files.filter((f) => f.name.endsWith(".exe"));
  for (const file of installers) {
    console.log(`安装包            ${mb(file.size)}  （${file.name}，硬线 12 MB）`);
    if (file.size > INSTALLER_BUDGET) {
      console.log("  超硬线！");
      failed = true;
    }
  }
  if (installers.length === 0) {
    console.log("nsis/ 目录里没有安装包（tauri:build 未跑或失败）");
    if (ci) failed = true;
  }
} else {
  console.log("安装包目录不存在（先 npm run tauri:build）");
}

if (failed) {
  console.error("体积门禁未过");
  process.exit(1);
}
console.log("体积门禁通过");
