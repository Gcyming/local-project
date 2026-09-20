/**
 * core-ts/src/zip.ts — 零依赖 ZIP 读取/解压（只用 `node:zlib`）。
 *
 * **为什么要自己写**（A-1034）：
 * 之前解压走外部命令 —— Windows 用 `spawn("tar")`、POSIX 用 `unzip`。但
 * **"系统自带" ≠ "在 PATH 里"**：打包后进程 PATH 与开发机不同，`tar` 直接 `ENOENT`，
 * 用户实测「platform-tools 无法安装」的红字就是 `spawn tar ENOENT`。
 * 换成绝对路径只治标：机器种类太多（精简版系统、被组策略改过 PATH、容器）。
 * Node 自带 zlib 就能解 deflate —— ZIP 的压缩主体，所以这里直接零依赖实现。
 * 顺带它也是 Office 文档（docx/pptx/xlsx 全是 ZIP 容器）的读取基础。
 *
 * 支持：stored(0) / deflate(8)、中央目录定位、ZIP64 基础字段（条目数/尺寸/偏移溢出）。
 * 不支持：加密、分卷、多磁盘 —— 遇到一律**明确抛错**，绝不静默返回错数据。
 */

import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** EOCD 里表示"溢出到 ZIP64"的哨兵值 */
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export interface ZipEntry {
  /** 归档内路径（正斜杠，目录以 `/` 结尾） */
  name: string;
  isDir: boolean;
  /** 0 = stored，8 = deflate */
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  /** 本地头偏移（读取内容用） */
  localOffset: number;
}

/** 是不是一个 ZIP 容器（Office 文档判定也靠它）。 */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 4
    && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/** 自尾部向前找 EOCD（末尾最多 64KB 注释 + 22 字节固定头）。 */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { return i; }
  }
  return -1;
}

/** 读取 ZIP64 扩展信息（只有基础字段溢出时才需要）。 */
function readZip64(buf: Buffer, eocd: number): { total: number; cdOffset: number } | null {
  const locator = eocd - 20;
  if (locator < 0 || buf.readUInt32LE(locator) !== SIG_ZIP64_LOCATOR) { return null; }
  const z64 = Number(buf.readBigUInt64LE(locator + 8));
  if (z64 <= 0 || z64 + 56 > buf.length || buf.readUInt32LE(z64) !== SIG_ZIP64_EOCD) { return null; }
  return {
    total: Number(buf.readBigUInt64LE(z64 + 32)),
    cdOffset: Number(buf.readBigUInt64LE(z64 + 48)),
  };
}

/**
 * 解析中央目录，列出全部条目。
 *
 * 只读中央目录、不逐条读本地头 —— 本地头在"流式写入"场景下尺寸字段可能是 0
 * （真实值放在数据描述符里），而中央目录永远是权威值。
 */
export function listZip(buf: Buffer): ZipEntry[] {
  if (!isZip(buf)) { throw new Error("不是 ZIP 容器（缺少 PK 签名）"); }
  const eocd = findEocd(buf);
  if (eocd < 0) { throw new Error("ZIP 结构损坏：找不到中央目录结束标记（可能被截断）"); }

  let total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === U16_MAX || cdOffset === U32_MAX) {
    const z64 = readZip64(buf, eocd);
    if (z64) { total = z64.total; cdOffset = z64.cdOffset; }
  }
  if (total > 200_000) { throw new Error(`ZIP 条目数异常（${total}），拒绝解析`); }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`ZIP 中央目录条目 ${i} 越界或签名不符`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);

    // ZIP64 扩展字段（0x0001）：按顺序覆盖被置为哨兵的字段
    if (compressedSize === U32_MAX || size === U32_MAX || localOffset === U32_MAX) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === U32_MAX) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === U32_MAX) { compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === U32_MAX) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }

    // 0x0800 = UTF-8 文件名标志；未置位时按 latin1 解（保底不抛错）
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x0800) ? rawName.toString("utf8") : rawName.toString("latin1");
    entries.push({
      name,
      isDir: name.endsWith("/"),
      method,
      compressedSize,
      size,
      crc32,
      localOffset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 取某条目的**解压后**内容；不存在返回 null。 */
export function readZipEntry(buf: Buffer, name: string, entries?: ZipEntry[]): Buffer | null {
  const list = entries ?? listZip(buf);
  const e = list.find((x) => x.name === name);
  if (!e || e.isDir) { return null; }
  return readEntry(buf, e);
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const loc = e.localOffset;
  if (loc + 30 > buf.length || buf.readUInt32LE(loc) !== SIG_LOCAL) {
    throw new Error(`ZIP 本地头损坏：${e.name}`);
  }
  const nameLen = buf.readUInt16LE(loc + 26);
  const extraLen = buf.readUInt16LE(loc + 28);
  const start = loc + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (raw.length !== e.compressedSize) { throw new Error(`ZIP 数据被截断：${e.name}`); }
  if (e.method === 0) { return Buffer.from(raw); }
  if (e.method === 8) { return inflateRawSync(raw); }
  throw new Error(`不支持的 ZIP 压缩方式 ${e.method}（仅支持 stored/deflate）：${e.name}`);
}

/** 解压后按 UTF-8 当文本读（Office 内部 XML 用）。 */
export function readZipText(buf: Buffer, name: string, entries?: ZipEntry[]): string | null {
  const b = readZipEntry(buf, name, entries);
  return b ? b.toString("utf8") : null;
}

/**
 * 路径安全：归档内路径**不可**逃出 destDir（Zip-Slip）。
 *
 * ⚠️ **只有一条载荷规则**：把条目名解析成绝对路径后，必须仍在解压根之内。
 * 这一条同时覆盖 `..`、绝对路径 `/x`、盘符 `C:\x`、UNC `\\host\share` 四类逃逸。
 *
 * 为什么不做成"先挡 `..`、再挡绝对路径、最后兜底"三层：变异测试实测（A-1034）
 * 删掉前两层中的任意一层，守卫**依然全绿** —— 因为兜底那条已经兜住了，三层里
 * 只有一层真正载荷。留着它们只会造出"看起来有保护、其实永远不单独生效"的假防线
 * （本项目已多次吃过这个亏）。**一条能被测出来的规则，胜过三条测不出来的。**
 */
function safeTarget(destDir: string, name: string): string | null {
  const norm = normalize(name.replace(/\\/g, "/"));
  if (!norm || norm === ".") { return null; }
  const base = resolve(destDir);
  const target = resolve(base, norm);
  if (target !== base && !target.startsWith(base + sep)) { return null; }
  return target;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  /** 被安全规则拒绝的条目（正常情况下应为空） */
  skipped: string[];
}

/**
 * 解压到目录（等价 `unzip -o` / `tar -xf`）。
 *
 * 保留归档内的目录层级：`platform-tools/adb.exe` 会落到 `<destDir>/platform-tools/adb.exe`，
 * 与之前 tar 的行为一致，调用方的路径探测逻辑无需改动。
 */
export function extractZipTo(buf: Buffer, destDir: string, opts: { entries?: ZipEntry[] } = {}): ExtractResult {
  const list = opts.entries ?? listZip(buf);
  mkdirSync(destDir, { recursive: true });
  const result: ExtractResult = { files: 0, bytes: 0, skipped: [] };
  for (const e of list) {
    if (e.isDir) { continue; }
    const target = safeTarget(destDir, e.name);
    if (!target) { result.skipped.push(e.name); continue; }
    const data = readEntry(buf, e);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    result.files += 1;
    result.bytes += data.length;
  }
  return result;
}

/** 归档内所有条目名（调试/守卫用）。 */
export function zipEntryNames(buf: Buffer): string[] {
  return listZip(buf).map((e) => e.name);
}
