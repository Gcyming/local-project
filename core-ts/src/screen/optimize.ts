/**
 * core-ts/src/screen/optimize.ts — 截图后处理（缩放 + 压缩）注入点。
 *
 * 为什么需要：原图直接回灌模型会吃掉巨量 token。
 * Anthropic Computer Use 与 computer-use-mcp 的共同做法是「截图先缩到 ≤1920px 宽 + JPEG q80」。
 * core-ts 不能依赖 Electron，因此这里留一个注入点，由 GUI 主进程用
 * electron.nativeImage（零新依赖）实现缩放与 PNG→JPEG 转换。
 */

export interface OptimizedImage {
  /** data:image/...;base64,... 完整 URL */
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

/** A-975：截图标注（网格刻度 + 可点元素编号框）——让模型能按刻度/编号定位，而非纯目测 */
export interface AnnotateSpec {
  /** 是否绘制 10×10 刻度网格（含像素标签） */
  grid?: boolean;
  /** 可点元素框（坐标空间见 marksSpace） */
  marks?: Array<{ index: number; label?: string; x1: number; y1: number; x2: number; y2: number }>;
  /** marks 的坐标空间尺寸（设备物理像素）——绘制时按图像尺寸等比缩放 */
  marksSpace?: { width: number; height: number };
}

export type ImageOptimizer = (
  pngBase64: string,
  maxWidth: number,
  quality: number,
  annotate?: AnnotateSpec,
) => OptimizedImage | null;

let optimizer: ImageOptimizer | null = null;

export function setImageOptimizer(fn: ImageOptimizer | null): void {
  optimizer = fn;
}

export function getImageOptimizer(): ImageOptimizer | null {
  return optimizer;
}

/** 默认最大宽度（超过则等比缩小；对齐 computer-use-mcp 的 1920px 阈值） */
export const DEFAULT_MAX_WIDTH = 1600;
/** 默认 JPEG 质量 */
export const DEFAULT_QUALITY = 72;

/** A-975：默认开启刻度网格——实测能显著降低"坐标目测漂移"（模型可对着刻度读数） */
export const DEFAULT_ANNOTATE: AnnotateSpec = { grid: true };

/** 把 PNG base64 转成「已瘦身」的 data URL；无优化器时原样返回 PNG */
export function toOptimizedDataUrl(
  pngBase64: string,
  annotate?: AnnotateSpec,
): { dataUrl: string; bytes: number; width: number; height: number } {
  const raw = (pngBase64 ?? "").trim();
  const fallback = {
    dataUrl: `data:image/png;base64,${raw}`,
    bytes: Math.floor((raw.length * 3) / 4),
    width: 0,
    height: 0,
  };
  if (!raw || !optimizer) { return fallback; }
  try {
    const opt = optimizer(raw, DEFAULT_MAX_WIDTH, DEFAULT_QUALITY, annotate);
    if (!opt) { return fallback; }
    return { dataUrl: opt.dataUrl, bytes: opt.bytes, width: opt.width, height: opt.height };
  } catch {
    return fallback;
  }
}
