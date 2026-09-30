import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 入口 = 窗口类型。main（便签浮窗）、trash（回收站）、search（搜索）、
// settings（设置）、unlock（口令窗）；星环随 M4 加入，
// 加入时 Rust 侧 WindowSpec 的 url 必须与这里一一对应。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
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
        main: path.resolve(__dirname, "index.html"),
        trash: path.resolve(__dirname, "trash.html"),
        search: path.resolve(__dirname, "search.html"),
        settings: path.resolve(__dirname, "settings.html"),
        unlock: path.resolve(__dirname, "unlock.html"),
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
});
