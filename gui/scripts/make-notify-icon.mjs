/**
 * gui/scripts/make-notify-icon.mjs — 由**应用图标**生成**通知专用**位图（唯一实现，可复现）。
 *
 * ══ 为什么必须存在这张"另存"的图（#228 的真实根因）════════════════════════════════
 * 用户反馈：「通知的图标加的位置不对」——他要的是 toast **头部应用身份行**那一格（AUMID 的
 * `IconUri`）显示 slime 图标。而 `gui/build/icon.png` 是**安装器用的大图**：
 *
 *     1024 × 1024 px，974 547 B（951.7 KB）
 *
 * Windows 通知图片有**硬约束**（一手来源，MS Learn「磁贴、Toast 和锁屏提醒通知疑难解答」
 * `dn457490` / `dn457491`，以及「Tile and toast visual assets」`hh781198`）：
 *
 *     Images for all notifications must be smaller than 1024 x 1024 pixels and less than
 *     200 KB in size. **If any image in a notification exceeds any of these dimensions,
 *     the notification will be discarded.**
 *
 * ⇒ 951.7 KB 远超标；超限的后果不是"图标小一点"，而是**整条通知被丢弃 / 图标静默不显示**。
 *   这正是本项目反复踩的那类「静默失败」：不报错、不看用户屏幕就发现不了。
 * ⇒ 而且头部那格本来就只渲染成 24–32 px 上下，塞一张 1024² 位图纯属浪费（系统每次弹通知都读它）。
 *
 * 本脚本做三件事：
 *   ① 把 `build/icon.png` **面积平均**降采样到目标尺寸（默认 256×256，2 的幂，缩放干净）；
 *   ② 用**自适应行滤波 + zlib level 9** 重新编码，把体积压到远低于 200 KB；
 *   ③ 生成后**自己验收**（尺寸/体积/PNG 魔数），不合格就 exit 1 —— 不许静默产出一张废图。
 *
 * A-1075（Issue 5）追加：本脚本同时产出 **`build/icon.ico`（多尺寸 16/24/32/48/64/128/256）**，
 * 供 **托盘 / 任务栏 / exe** 按需取用。原由与上面完全同源 —— 托盘渲染 16 px（200% DPI 下 32 px）、
 * 任务栏 24/32/48 px，此前直接喂 1024² 位图等于让系统现场缩，观感糊且每处读近 1 MB。
 * ⇒ 判据：**渲染处需要多大，就给它多大**（`icon.ico` 逐尺寸预置 ⇒ 全程零缩放）。
 *
 * ⚠️ 纯 Node（只用内置 `node:zlib`）：本机 pip 索引不可用（`Could not find a version that
 *   satisfies the requirement pillow`）、也没有 ImageMagick，所以不引入任何外部依赖。
 *   代价是要自己解/编 PNG —— 因此**只支持**最平凡的那一种：非隔行、8 bit、colorType 2(RGB)
 *   或 6(RGBA)。遇到别的形态**显式报错**，不猜。
 *
 * ⚠️ 产物 `gui/build/notify-icon.png` 是**随包资源**：`electron-builder.json` 的 `extraFiles`
 *   必须显式列出它（`buildResources` 目录不会自动随包），否则打包版 `INSTALL_ROOT/build/`
 *   下没有这张图 → `notificationIconPath()` 回落 → 头部又没图标（同一故障的第二次发生）。
 *
 * 用法：
 *   node gui/scripts/make-notify-icon.mjs                # 256×256
 *   node gui/scripts/make-notify-icon.mjs --size 192     # 自定义边长（正方形）
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Windows 通知图片的上限（与 `gui/src/main/notifyIdentity.ts` 的常量同源；此处**只做验收**） */
const MAX_BYTES = 200 * 1024;
const MAX_DIM = 1024;

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "gui", "build", "icon.png");
const DST = join(ROOT, "gui", "build", "notify-icon.png");

/** 解析 PNG：返回 { w, h, colorType, bitDepth, idat:Buffer }（只认真实支持的那几种形态） */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error("不是 PNG（魔数不符）");
  }
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len; // len + type(4) + data + crc(4)
  }
  if (!w || !h) { throw new Error("PNG 里没有 IHDR"); }
  if (bitDepth !== 8) { throw new Error(`只支持 8 bit/通道，实际 ${bitDepth}`); }
  if (colorType !== 2 && colorType !== 6) { throw new Error(`只支持 colorType 2/6，实际 ${colorType}`); }
  if (interlace !== 0) { throw new Error("只支持非隔行（interlace=0）"); }
  return { w, h, channels: colorType === 6 ? 4 : 3, idat: Buffer.concat(idat) };
}

/** 逐行反滤波 → 连续的像素字节（每像素 `channels` 字节） */
function unfilter(raw, w, h, channels) {
  const stride = w * channels;
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y += 1) {
    const ft = raw[pos]; pos += 1;
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;         // 左
      const b = prev ? prev[i] : 0;                            // 上
      const c = prev && i >= channels ? prev[i - channels] : 0; // 左上
      const x = line[i];
      switch (ft) {
        case 0: cur[i] = x; break;
        case 1: cur[i] = (x + a) & 0xff; break;
        case 2: cur[i] = (x + b) & 0xff; break;
        case 3: cur[i] = (x + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          cur[i] = (x + pr) & 0xff;
          break;
        }
        default: throw new Error(`未知行滤波类型 ${ft}（第 ${y} 行）`);
      }
    }
  }
  return out;
}

/** 面积平均降采样（比最近邻干净得多；对图标这种有抗锯齿边缘的图尤其明显） */
function downscale(pixels, w, h, channels, size) {
  const out = Buffer.alloc(size * size * channels);
  const scaleX = w / size, scaleY = h / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
      const acc = new Uint32Array(channels);
      let n = 0;
      for (let sy = y0; sy < y1 && sy < h; sy += 1) {
        for (let sx = x0; sx < x1 && sx < w; sx += 1) {
          const at = (sy * w + sx) * channels;
          for (let c = 0; c < channels; c += 1) { acc[c] += pixels[at + c]; }
          n += 1;
        }
      }
      const dst = (y * size + x) * channels;
      for (let c = 0; c < channels; c += 1) { out[dst + c] = n ? Math.round(acc[c] / n) : 0; }
    }
  }
  return out;
}

/** 单行滤波：自适应（在 5 种滤波里挑"绝对值和最小"的那个，PNG 编码器的标准启发式） */
function filterLine(cur, prev, channels) {
  const stride = cur.length;
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < stride; i += 1) {
    const a = i >= channels ? cur[i - channels] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= channels ? prev[i - channels] : 0;
    const x = cur[i];
    cand[0][i] = x;
    cand[1][i] = (x - a) & 0xff;
    cand[2][i] = (x - b) & 0xff;
    cand[3][i] = (x - ((a + b) >> 1)) & 0xff;
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    cand[4][i] = (x - ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff;
  }
  for (let t = 0; t < 5; t += 1) {
    let score = 0;
    for (let i = 0; i < stride; i += 1) { const v = cand[t][i]; score += v < 128 ? v : 256 - v; }
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return Buffer.concat([Buffer.from([best]), cand[best]]);
}

/** PNG 块（含 CRC32） */
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(pixels, size, channels) {
  const stride = size * channels;
  const raw = [];
  for (let y = 0; y < size; y += 1) {
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    raw.push(filterLine(cur, prev, channels));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;                          // bit depth
  ihdr[9] = channels === 4 ? 6 : 2;     // color type
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // deflate / adaptive filter / non-interlaced
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(raw), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const sizeArg = argv.indexOf("--size");
const size = sizeArg >= 0 ? Number.parseInt(argv[sizeArg + 1], 10) : 256;
if (!Number.isInteger(size) || size < 16 || size > MAX_DIM) {
  console.error(`--size 必须是 ${16}..${MAX_DIM} 之间的整数，实际 ${argv[sizeArg + 1]}`);
  process.exit(1);
}

const srcBuf = readFileSync(SRC);
const { w, h, channels, idat } = decodePng(srcBuf);
const pixels = unfilter(inflateSync(idat), w, h, channels);
const small = downscale(pixels, w, h, channels, size);
const out = encodePng(small, size, channels);
writeFileSync(DST, out);

// 自验收：不合格就不许"产出一张图然后当成功"
const problems = [];
if (out.length > MAX_BYTES) { problems.push(`体积 ${(out.length / 1024).toFixed(1)} KB > ${MAX_BYTES / 1024} KB`); }
if (size > MAX_DIM) { problems.push(`${size}px > ${MAX_DIM}px`); }
const check = readFileSync(DST);
if (check.readUInt32BE(0) !== 0x89504e47) { problems.push("产物不是 PNG"); }
if (problems.length > 0) {
  console.error(`生成失败（不符 Windows 通知图片约束）：${problems.join("；")}`);
  process.exit(1);
}

// ── A-1075（Issue 5）：多尺寸 ICO ──────────────────────────────────────────────
/* 为什么必须有它：**托盘**渲染尺寸是 16 px（200% DPI 下 32 px），**任务栏** 24/32/48 px。
   此前这两处直接喂 `build/icon.png`（1024×1024、951.7 KB）—— 等于让系统把一张 1024² 位图
   现场缩到 16 px，观感糊、还每处都读近 1 MB。这与 #228「通知图标」是**同一类**问题
   （渲染处只有几十像素，却喂它一张 1024²），所以沿用同一个生成器、同一套纯 Node 实现。
   `.ico` 里逐尺寸**预置**好位图 ⇒ 系统按需取那一张，**全程零缩放**。
   ⚠️ Windows 之外不用它（`.ico` 在 Linux/macOS 上 Electron 读不了）——选哪张由
   `gui/src/main/index.ts` 的 `appIconPath()` 按平台决定，见该函数的守卫。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICO_DST = join(ROOT, "gui", "build", "icon.ico");

/** 组装 ICO：ICONDIR(6) + ICONDIRENTRY(16×N) + 各尺寸 PNG 原始字节（Vista+ 支持内嵌 PNG）。 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = 1（图标）
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const at = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 0);      // 0 表示 256
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    dir.writeUInt8(0, at + 2);                                // 调色板数
    dir.writeUInt8(0, at + 3);                                // reserved
    dir.writeUInt16LE(1, at + 4);                             // planes
    dir.writeUInt16LE(32, at + 6);                            // 位深
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const icoEntries = ICO_SIZES.map((s) => ({
  size: s,
  png: encodePng(downscale(pixels, w, h, channels, s), s, channels),
}));
const ico = buildIco(icoEntries);
writeFileSync(ICO_DST, ico);

// ICO 自验收（不合格就 exit 1 —— 不许产出一张废图标然后当成功）
const icoProblems = [];
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) { icoProblems.push("ICO 头不符（reserved/type）"); }
if (ico.readUInt16LE(4) !== ICO_SIZES.length) { icoProblems.push(`ICO 条目数 ${ico.readUInt16LE(4)} ≠ ${ICO_SIZES.length}`); }
for (let i = 0; i < ICO_SIZES.length; i += 1) {
  const at = 6 + 16 * i;
  const want = ICO_SIZES[i] >= 256 ? 0 : ICO_SIZES[i];
  if (ico.readUInt8(at) !== want) { icoProblems.push(`第 ${i} 条的宽字段不是 ${want}`); }
  const off = ico.readUInt32LE(at + 12);
  if (ico.readUInt32BE(off) !== 0x89504e47) { icoProblems.push(`第 ${i} 条内嵌的不是 PNG`); }
}
if (icoProblems.length > 0) {
  console.error(`ICO 生成失败：${icoProblems.join("；")}`);
  process.exit(1);
}

console.log(`源图  ${w}×${h}  ${(srcBuf.length / 1024).toFixed(1)} KB  ${SRC}`);
console.log(`产物  ${size}×${size}  ${(out.length / 1024).toFixed(1)} KB  ${DST}`);
console.log(`验收  上限 ${MAX_DIM}×${MAX_DIM} / ${MAX_BYTES / 1024} KB → 通过（余量 ${(MAX_BYTES - out.length) / 1024 | 0} KB）`);
console.log(`产物  ICO ${ICO_SIZES.join("/")}  ${(ico.length / 1024).toFixed(1)} KB  ${ICO_DST}`);
