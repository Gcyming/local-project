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

/* ───────────────────────── A-1123：画面差异度量（命中校验的数据源） ─────────────────────────
 *
 * 【为什么需要它】屏幕控制的既有形态是「动作 → 复截 → 回图给模型，让模型自己看有没有生效」。
 * 这对模型是**无判据**的：它得凭两张图目测"画面变了没有"，而点击一个**本来就没反应的**
 * 位置（点空了、被遮挡、窗口没聚焦）与点击成功，在回执文字上**完全同形**（都写"已点击 (x,y)"）。
 * 业界优秀做法（Claude Computer Use / OpenAI Operator）都会在动作后校验效果，未命中就重试。
 *
 * 【为什么是注入点而不是自己实现】core-ts **不许** import electron（这条边界是整个仓库的硬约束，
 * 见 optimize.ts 顶部说明）。因此与 `setImageOptimizer` 完全同款：这里只定义契约，
 * 由 GUI 主进程用 `electron.nativeImage` 实现（零新依赖）。
 *
 * 【为什么"比较不了"必须是 null 而不是 0】0 的语义是"两张图一模一样"，
 * 会被上层读成「确定未命中」并触发重试。而"没装配度量 / 尺寸不一致 / 解码失败"
 * 是**没有判据**，此时重试是**瞎猜**（可能把一次已经成功的点击再点一遍）。
 * 两种情形必须分两态 —— 这是本项目 A-1088/A-1122 反复确认的判据。
 */

/**
 * A-1123：比较两张**同尺寸 PNG**（base64，不含 data: 前缀）的像素差异率。
 * @returns 变化像素占比 `0..1`；`null` = **无法比较**（不是"没变化"）
 */
export type ImageDiffer = (pngA: string, pngB: string) => number | null;

let differ: ImageDiffer | null = null;

/** 装配/卸载画面差异度量（由 GUI 主进程用 nativeImage 实现） */
export function setImageDiffer(fn: ImageDiffer | null): void {
  differ = fn;
}

export function getImageDiffer(): ImageDiffer | null {
  return differ;
}

/**
 * A-1123：算两张截图的差异率 —— **唯一对外的比较入口**（controller 只调它）。
 * 归一化输出到 `0..1`；任何异常/非法返回值一律折成 `null`（= 没有判据，不许猜）。
 */
export function imageDiffRatio(pngA: string | undefined, pngB: string | undefined): number | null {
  if (!pngA || !pngB) { return null; }
  const fn = differ;
  if (!fn) { return null; }
  try {
    const r = fn(pngA, pngB);
    if (r === null || r === undefined || !Number.isFinite(r)) { return null; }
    return Math.min(1, Math.max(0, r));
  } catch {
    return null;
  }
}

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
