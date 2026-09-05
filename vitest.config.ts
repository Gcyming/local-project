import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // 端到端渲染测试（markdown-render.spec.ts）需解析 React——根仓库未 hoist，指到 gui/node_modules
      react: fileURLToPath(new URL("./gui/node_modules/react", import.meta.url)),
      "react-dom": fileURLToPath(new URL("./gui/node_modules/react-dom", import.meta.url)),
      "react-dom/server": fileURLToPath(new URL("./gui/node_modules/react-dom/server", import.meta.url)),
      "react/jsx-runtime": fileURLToPath(new URL("./gui/node_modules/react/jsx-runtime", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});