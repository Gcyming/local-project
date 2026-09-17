/**
 * core-ts/src/screen/index.ts — slime 图形控制能力统一出口。
 *
 * 装配方式（gui/src/main/index.ts）：
 *   import { getScreenController, DesktopScreenBackend, AndroidScreenBackend } from "core-ts/src/screen"
 *   const ctl = getScreenController();
 *   ctl.register(new DesktopScreenBackend());
 *   ctl.register(new AndroidScreenBackend(adbService));
 */
export * from "./types.js";
export { ScreenController, ScreenError, getScreenController, resetScreenController } from "./controller.js";
export { AndroidScreenBackend, type AdbLike } from "./backends/android.js";
export { DesktopScreenBackend } from "./backends/desktop.js";
export {
  setImageOptimizer,
  getImageOptimizer,
  toOptimizedDataUrl,
  DEFAULT_MAX_WIDTH,
  DEFAULT_QUALITY,
  type ImageOptimizer,
  type OptimizedImage,
} from "./optimize.js";
