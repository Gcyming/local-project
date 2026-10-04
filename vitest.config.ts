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
      // electron：根目录没有 node_modules/electron，而 gui/ 有 ⇒ 同一句 `import ... from "electron"`
      // 在 tests/ 与 gui/src/ 里会解析到**两个不同的 id**，于是 spec 里的 `vi.mock("electron")`
      // 只对前者生效、对 `gui/src/main/*` 静默失效（不报错）。统一指到替身，两边同 id。
      // 详见 tests/_stubs/electron.ts。
      electron: fileURLToPath(new URL("./tests/_stubs/electron.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});