








export interface OptimizedImage {
  
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}


export interface AnnotateSpec {
  
  grid?: boolean;
  
  marks?: Array<{ index: number; label?: string; x1: number; y1: number; x2: number; y2: number }>;
  
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


export const DEFAULT_MAX_WIDTH = 1600;

export const DEFAULT_QUALITY = 72;


export const DEFAULT_ANNOTATE: AnnotateSpec = { grid: true };






















export type ImageDiffer = (pngA: string, pngB: string) => number | null;

let differ: ImageDiffer | null = null;


export function setImageDiffer(fn: ImageDiffer | null): void {
  differ = fn;
}

export function getImageDiffer(): ImageDiffer | null {
  return differ;
}





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
