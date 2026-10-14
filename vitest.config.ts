import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // import.meta.dirname 而不是 __dirname：与 vite.config.ts（5.5+）同一口径，
      // 也消掉 native config loader 的不支持特性警告
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    clearMocks: true,
  },
});
