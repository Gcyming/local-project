








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

export { setImageDiffer, getImageDiffer, imageDiffRatio, type ImageDiffer } from "./optimize.js";
