import { defineConfig } from "vite";
import electron from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
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
