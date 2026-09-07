import { defineConfig } from "vite";
import electron from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // A-966：@lancedb 原生 .node 无法进 rollup bundle（清缓存全量构建必现 \0 解析错）。
      // 顶层 alias 对 main/preload/renderer 全生效；桌面端默认 [memory.lancedb] disabled → 指针 stub，构建内联即过。
      "@lancedb/lancedb": resolve(__dirname, "src/main/__stubs/lancedb-stub.ts"),
    },
  },
  plugins: [
    electron({
      main: {
        build: {
          rollupOptions: {
            input: resolve(__dirname, "src/main/index.ts"),
          },
        },
      },
      preload: {
        build: {
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
