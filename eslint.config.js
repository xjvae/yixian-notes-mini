import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "coverage", "src-tauri/target", "src-tauri/gen"] },
  js.configs.recommended,
  // Node 脚本（scripts/*.mjs）跑在 node 全局里，浏览器 globals 不适用
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  // 类型化规则只作用于 ts/tsx：eslint.config.js 这类 js 文件不在 tsconfig 工程里
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 事件处理器允许传 async 函数（void 化由调用方决定），但 fire-and-forget 仍要显式 void
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // 分层锁：只有 platform 层允许接触 Tauri 运行时。测试文件是造 mock 的接缝，放行。
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/platform/**", "**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@tauri-apps/api/core" },
            { name: "@tauri-apps/api/event" },
            { name: "@tauri-apps/api/window" },
          ],
        },
      ],
    },
  },
  prettier,
);
