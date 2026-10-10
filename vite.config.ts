import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 入口 = 窗口类型。main（便签浮窗与叠窗，index.html 内按注入身份分岔）、trash（回收站）、
// search（搜索）、settings（设置）、unlock（口令窗）、ring（星环）；
// 加入时 Rust 侧 WindowSpec 的 url 必须与这里一一对应。
// preview（预览台）只在 dev server 上存在：tauri 的构建产物里不许有它，
// 它带着替身桥，装进包里就是给生产留一条假 IPC 的路。
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    reportCompressedSize: true,
    // 浮窗不背 preload 链接；碎 chunk 靠并块兜底
    modulePreload: false,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        trash: path.resolve(import.meta.dirname, "trash.html"),
        search: path.resolve(import.meta.dirname, "search.html"),
        settings: path.resolve(import.meta.dirname, "settings.html"),
        unlock: path.resolve(import.meta.dirname, "unlock.html"),
        ring: path.resolve(import.meta.dirname, "ring.html"),
        guide: path.resolve(import.meta.dirname, "guide.html"),
        ...(command === "serve"
          ? { preview: path.resolve(import.meta.dirname, "preview.html") }
          : {}),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/js/[name]-[hash].js",
        assetFileNames: "assets/[ext]/[name]-[hash].[ext]",
        experimentalMinChunkSize: 4096,
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
}));
