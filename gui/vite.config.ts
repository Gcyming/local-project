import { defineConfig } from "vite";
import electron from "electron-vite";
import { resolve } from "node:path";

/** LanceDB 指向**构建期桩 / 运行期转发器**的路径（见 src/main/__stubs/lancedb-stub.ts）。
 *  ⚠️ 必须在 main 构建里**显式再写一遍**：顶层 `resolve.alias` 不保证被 electron-vite 的
 *  main target 继承（实测：顶层写了但产物里仍内联 297MB 真实包 —— 顶层 alias 只作用于
 *  共享解析阶段，main 的 rollup 配置是独立合并的）。 */
const LANCEDB_STUB = resolve(__dirname, "src/main/__stubs/lancedb-stub.ts");

export default defineConfig({
  resolve: {
    alias: {
      // A-966 / A-1041：@lancedb 原生 .node 无法进 rollup bundle（清缓存全量构建必现 \0 解析错）。
      // 构建期指向桩（几 KB），真实包由桩在运行时按「内嵌组件目录」require —— 297MB 不再进产物。
      "@lancedb/lancedb": LANCEDB_STUB,
    },
  },
  plugins: [
    electron({
      main: {
        // ⚠️ electron-vite 的 main 是 vite InlineConfig：`resolve` 与 `build` **同级**，
        // 写成 `build.resolve` 会被静默忽略（实测 297MB 照样进产物）。
        resolve: { alias: { "@lancedb/lancedb": LANCEDB_STUB } },
        build: {
          rollupOptions: {
            input: resolve(__dirname, "src/main/index.ts"),
          },
        },
      },
      preload: {
        build: {
          // ⚠️⚠️ **别在这里加第二个 preload 入口**（A-1137 实测结论，留档防重踩）：
          // electron-vite 的 preload 构建走 `findLibEntry(root,'preload')` —— **单入口 + 固定文件名**
          // （`src/preload/index.{js,ts,mjs,cjs}`）；`preload.build.rollupOptions.input` 被**整体忽略**。
          // 判别实验：把 input 键名改成 `foo` 后产物**仍是 `index.js` 且字节数一字不差（42341）**。
          // 官方多入口开关 `build.isolatedEntries`（配 `externalizeDeps:false`）在本仓当前版本配了也不生效。
          // ⇒ 右栏 webview 的 guest preload 改走「构建期 `?raw` 内联 + 运行期落盘」，
          //   见 `gui/src/preload/searchHost.cjs` 顶部与 `gui/src/main/searchBridge.ts`。
          // ⚠️ `gui/tsconfig.json` 的 `include` 只含 `src/**/*.ts` ⇒ 本文件**不受类型检查**，
          //   这类"装饰性配置"不会被 tsc 发现。
          rollupOptions: {
            input: resolve(__dirname, "src/preload/index.ts"),
          },
        },
      },
      renderer: [
        "html",
        {
          test: {
            include: /src\/renderer\/.*\.(ts|tsx)$/,
          },
        },
      ],
    }),
  ],
});
