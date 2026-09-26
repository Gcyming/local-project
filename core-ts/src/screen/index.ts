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
// A-1123：画面差异度量（命中校验的数据源）—— 与 setImageOptimizer 同款注入点
export { setImageDiffer, getImageDiffer, imageDiffRatio, type ImageDiffer } from "./optimize.js";
