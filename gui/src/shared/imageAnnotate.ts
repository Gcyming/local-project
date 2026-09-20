/**
 * gui/src/main/imageAnnotate.ts — 截图标注绘制（A-975）。
 *
 * 目的：让视觉模型**有刻度可读、有编号可点**，而不是对着一张 JPEG 纯目测坐标。
 * 依据（前沿调研结论）：Set-of-Mark 标注化让 OmniParser+GPT-4o 在 ScreenSpot-Pro 上从 0.8% → 39.6%；
 * 「网格刻度 + 元素编号」是工程上成本最低、收益最高的一档。
 *
 * 实现约束：Electron 主进程没有 Canvas/DOM，不引任何新依赖——
 * 直接操作 nativeImage 的原始位图（BGRA，Skia N32 小端序）逐像素绘制。
 */

/** 3×5 点阵数字字体（0-9）——用于在图上标注像素刻度值与元素编号 */
const DIGITS: Record<string, number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b001, 0b001, 0b001],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  " ": [0, 0, 0, 0, 0],
  "#": [0b101, 0b111, 0b101, 0b111, 0b101],
};

export interface AnnotateMark {
  index: number;
  label?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface AnnotateOptions {
  grid?: boolean;
  marks?: AnnotateMark[];
  /** marks 的坐标空间（设备物理像素）；用于等比换算到图像坐标 */
  marksSpace?: { width: number; height: number };
}

type Bmp = { buf: Buffer; width: number; height: number };

/** 写一个像素（BGRA；alpha 混合，a=0..1） */
function blend(b: Bmp, x: number, y: number, r: number, g: number, bl: number, a: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= b.width || yi >= b.height) { return; }
  const off = (yi * b.width + xi) * 4;
  if (off + 3 >= b.buf.length) { return; }
  const inv = 1 - a;
  b.buf[off] = Math.round(bl * a + b.buf[off] * inv);       // B
  b.buf[off + 1] = Math.round(g * a + b.buf[off + 1] * inv); // G
  b.buf[off + 2] = Math.round(r * a + b.buf[off + 2] * inv); // R
  b.buf[off + 3] = 255;                                      // A
}

/** 画实心矩形（描边用） */
function rect(b: Bmp, x1: number, y1: number, x2: number, y2: number, r: number, g: number, bl: number, a = 1, thick = 1): void {
  for (let t = 0; t < thick; t++) {
    const yy1 = Math.round(y1) + t; const yy2 = Math.round(y2) - t;
    const xx1 = Math.round(x1) + t; const xx2 = Math.round(x2) - t;
    for (let x = xx1; x <= xx2; x++) { blend(b, x, yy1, r, g, bl, a); blend(b, x, yy2, r, g, bl, a); }
    for (let y = yy1; y <= yy2; y++) { blend(b, xx1, y, r, g, bl, a); blend(b, xx2, y, r, g, bl, a); }
  }
}

/** 画竖向/横向线 */
function hLine(b: Bmp, x1: number, x2: number, y: number, r: number, g: number, bl: number, a: number): void {
  for (let x = Math.round(x1); x <= Math.round(x2); x++) { blend(b, x, y, r, g, bl, a); }
}
function vLine(b: Bmp, x: number, y1: number, y2: number, r: number, g: number, bl: number, a: number): void {
  for (let y = Math.round(y1); y <= Math.round(y2); y++) { blend(b, x, y, r, g, bl, a); }
}

/** 画一个字符（3×5 点阵，scale 倍） */
function glyph(b: Bmp, ch: string, ox: number, oy: number, scale: number, r: number, g: number, bl: number): void {
  const rows = DIGITS[ch];
  if (!rows) { return; }
  for (let ry = 0; ry < 5; ry++) {
    const bits = rows[ry];
    for (let rx = 0; rx < 3; rx++) {
      if ((bits >> (2 - rx)) & 1) {
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            blend(b, ox + rx * scale + dx, oy + ry * scale + dy, r, g, bl, 1);
          }
        }
      }
    }
  }
}

/** 画一串字符（带深色底衬 + 白字，保证在明暗界面上都可读） */
function text(b: Bmp, s: string, ox: number, oy: number, scale = 2, pad = 2): void {
  const str = String(s);
  const w = str.length * 3 * scale + (str.length - 1) * scale;
  const h = 5 * scale;
  // 底衬（半透明黑）
  for (let y = oy - pad; y < oy + h + pad; y++) {
    for (let x = ox - pad; x < ox + w + pad; x++) { blend(b, x, y, 0, 0, 0, 0.72); }
  }
  let cx = ox;
  for (const ch of str) {
    glyph(b, ch, cx, oy, scale, 255, 255, 255);
    cx += 4 * scale;
  }
}

/**
 * 在 nativeImage 上绘制刻度网格与元素编号框，返回新图像。
 * @param toBitmap   取原始位图（BGRA Buffer）
 * @param createBmp  由位图重建新图像
 */
export function annotateBitmap(b: Bmp, opts: AnnotateOptions): void {
  const { width: W, height: H } = b;
  if (W <= 0 || H <= 0) { return; }

  // ① 刻度网格：每 10% 一条线，并在顶部/左侧标出**图像像素值**（模型可直接读数）
  if (opts.grid) {
    const lineColor = { r: 0, g: 200, b: 255 };   // 青色（明暗界面都醒目）
    for (let i = 1; i <= 9; i++) {
      const x = Math.round((W * i) / 10);
      const y = Math.round((H * i) / 10);
      vLine(b, x, 0, H - 1, lineColor.r, lineColor.g, lineColor.b, 0.5);
      hLine(b, 0, W - 1, y, lineColor.r, lineColor.g, lineColor.b, 0.5);
    }
    // 像素刻度标签（只标 10% 间隔，避免遮挡画面）
    for (let i = 1; i <= 9; i++) {
      const x = Math.round((W * i) / 10);
      const y = Math.round((H * i) / 10);
      text(b, String(x), Math.min(W - 30, x + 2), 2, 2);
      text(b, String(y), 2, Math.min(H - 16, y + 2), 2);
    }
  }

  // ② 元素编号框：把可点元素的编号画到框上，模型可"点 #N"
  if (opts.marks && opts.marks.length > 0) {
    const sp = opts.marksSpace;
    const sx = sp && sp.width > 0 ? W / sp.width : 1;
    const sy = sp && sp.height > 0 ? H / sp.height : 1;
    for (const m of opts.marks) {
      const x1 = m.x1 * sx; const y1 = m.y1 * sy;
      const x2 = m.x2 * sx; const y2 = m.y2 * sy;
      // 编号框：亮黄描边（与网格青区分）
      rect(b, x1, y1, x2, y2, 255, 214, 10, 0.95, 2);
      // 编号标签贴框左上角
      const label = m.label ? `${m.index}:${m.label}` : String(m.index);
      const lx = Math.max(0, Math.min(W - 20, x1 + 1));
      const ly = Math.max(0, Math.min(H - 14, y1 + 1));
      text(b, label.slice(0, 10), lx, ly, 2);
    }
  }
}
