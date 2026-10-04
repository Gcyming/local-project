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

import { deflateRawSync, inflateRawSync } from "node:zlib";
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

/** 解压进度快照（A-1038）：主进程据此推「解压中 N/M」给界面，不再让用户干等。 */
export interface ExtractProgress {
  /** 已处理（写出 + 被拒）的条目数 */
  processed: number;
  /** 待处理条目总数（非目录条目；被拒的也计入，否则进度永远到不了 100%） */
  total: number;
  /** 已写出文件数（真正的落盘数，与 processed 的差别 = 被拒数） */
  files: number;
  /** 已写出字节 */
  bytes: number;
  /** 中央目录声明的解压后总字节（权威值），用于字节口径的百分比 */
  totalBytes: number;
  /** 当前条目名（最后一条为空串，表示收尾） */
  current: string;
}

/**
 * 解压到目录（等价 `unzip -o` / `tar -xf`）。
 *
 * 保留归档内的目录层级：`platform-tools/adb.exe` 会落到 `<destDir>/platform-tools/adb.exe`，
 * 与之前 tar 的行为一致，调用方的路径探测逻辑无需改动。
 *
 * ⚠️ **为什么是 async**（A-1038）：解压是纯 CPU/IO 密集，若一口气跑完，主进程事件循环
 * 会被独占十几秒 —— 渲染层的 IPC 全排队，进度条只会在**结束时跳一次**（等于没有进度），
 * 并且直接踩中 `main-freeze-guard` 的卡死判据。所以每 `yieldEvery` 个条目让出一次事件循环，
 * 让已发出的进度事件真正落到界面上。让出的是**条目之间**，单个大条目（如 300MB 的 DLL）
 * 的解压仍是原子的 —— 这是可接受的上限，换来的是每 1~2 秒必有一次刷新。
 *
 * ⚠️ 进度口径（A-1038）：
 * - `total` 取**非目录条目数**（含将被拒的），`processed` 覆盖写出与被拒两类 ——
 *   否则含 Zip-Slip 条目的包进度会永久卡在 99%（A-1034 的 evil.zip 就是这种包）。
 * - 回调**逐条目触发**、不做节流：节流属于 IPC 层（谁推送谁负责压频），
 *   zip 层只保证"报得准"。把节流塞进这里会让单元测试必须等时钟。
 * - 无论成功失败，**最后一条**回调都会在返回前发出（`current` 为空串），
 *   调用方据此收尾，不必自己猜是否已跑完。
 */
export async function extractZipTo(
  buf: Buffer,
  destDir: string,
  opts: { entries?: ZipEntry[]; onProgress?: (p: ExtractProgress) => void; yieldEvery?: number } = {},
): Promise<ExtractResult> {
  const list = opts.entries ?? listZip(buf);
  mkdirSync(destDir, { recursive: true });
  const result: ExtractResult = { files: 0, bytes: 0, skipped: [] };
  const planned = list.filter((e) => !e.isDir);
  const totalBytes = planned.reduce((n, e) => n + e.size, 0);
  const yieldEvery = Math.max(1, Math.floor(opts.yieldEvery ?? 4));
  let processed = 0;
  for (const e of planned) {
    const target = safeTarget(destDir, e.name);
    processed += 1;
    if (!target) {
      result.skipped.push(e.name);
    } else {
      const data = readEntry(buf, e);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      result.files += 1;
      result.bytes += data.length;
    }
    opts.onProgress?.({ processed, total: planned.length, files: result.files, bytes: result.bytes, totalBytes, current: e.name });
    // 让出事件循环：把已推的进度真正送达界面（见上方 async 说明）
    if (processed % yieldEvery === 0) {
      await new Promise<void>((done) => { setImmediate(done); });
    }
  }
  opts.onProgress?.({ processed, total: planned.length, files: result.files, bytes: result.bytes, totalBytes, current: "" });
  return result;
}

/** 归档内所有条目名（调试/守卫用）。 */
export function zipEntryNames(buf: Buffer): string[] {
  return listZip(buf).map((e) => e.name);
}

/* ══ A-1133：ZIP **写入**（生成 .docx / .xlsx / .pptx 用） ══════════════════════════════
   为什么写在本文件（而不是新开一个模块）：本文件就是「ZIP 容器格式」的**唯一产地**
   （读的四个函数就在上面）。写到别处就成了"同一格式两套实现"——CRC 或中央目录字段
   一处不合，产物就是「自家能读、Office 判为损坏」的**假成功**文件（比直接报错更坏）。
   ⚠️ 日期字段写死 1980-01-01（ZIP 的最早合法 DOS 日期）：用"当前时间"会让同一份内容
   **每次生成字节都不同** —— 测试无法逐字节比对，也让"内容没变但文件变了"的 diff 噪声永存。 */

const FLAG_UTF8 = 0x0800;
const DOS_DATE_1980 = 33;

/** CRC32 查表（IEEE 802.3 多项式 0xEDB88320），首次使用时构建。 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) { return crcTable; }
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/**
 * 计算 CRC32（ZIP 每条目必需）。
 * 为什么自己写：解压端（含 Windows 资源管理器、Office）拿 CRC 校验完整性，缺了或写错，
 * 文件能打开但内容被判「损坏」；而 `node:zlib` 的 `crc32` 是 Node 20+ 才有的新 API。
 */
export function crc32(buf: Buffer): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 写入用的部件（名字 + 内容） */
export interface ZipFile {
  name: string;
  data: Buffer;
}

/**
 * 打包成 ZIP（deflate；UTF-8 文件名）。
 *
 * @param files 部件列表；**同名后者覆盖前者**（与 Map 语义一致，避免同部件写两份）
 * @returns 完整 ZIP 字节（本地头 + 数据 + 中央目录 + EOCD）
 */
export function writeZip(files: readonly ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for (const f of files) {
    const nameBytes = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const comp = deflateRawSync(f.data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);       // flags
    local.writeUInt16LE(8, 8);               // method = deflate
    local.writeUInt16LE(0, 10);              // mod time
    local.writeUInt16LE(DOS_DATE_1980, 12);  // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);              // extra len
    nameBytes.copy(local, 30);
    locals.push(local, comp);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);            // version made by
    central.writeUInt16LE(20, 6);            // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);            // extra len
    central.writeUInt16LE(0, 32);            // comment len
    central.writeUInt16LE(0, 34);            // disk start
    central.writeUInt16LE(0, 36);            // internal attrs
    central.writeUInt32LE(0, 38);            // external attrs
    central.writeUInt32LE(offset, 42);       // local header offset
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + comp.length;
    count += 1;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);                  // disk num
  eocd.writeUInt16LE(0, 6);                  // cd start disk
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);            // cd offset
  eocd.writeUInt16LE(0, 20);                 // comment len

  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}
