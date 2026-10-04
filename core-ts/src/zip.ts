














import { deflateRawSync, inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;


const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export interface ZipEntry {
  
  name: string;
  isDir: boolean;
  
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  
  localOffset: number;
}


export function isZip(buf: Buffer): boolean {
  return buf.length >= 4
    && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}


function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { return i; }
  }
  return -1;
}


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


export function readZipText(buf: Buffer, name: string, entries?: ZipEntry[]): string | null {
  const b = readZipEntry(buf, name, entries);
  return b ? b.toString("utf8") : null;
}












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
  
  skipped: string[];
}


export interface ExtractProgress {
  
  processed: number;
  
  total: number;
  
  files: number;
  
  bytes: number;
  
  totalBytes: number;
  
  current: string;
}





















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
    
    if (processed % yieldEvery === 0) {
      await new Promise<void>((done) => { setImmediate(done); });
    }
  }
  opts.onProgress?.({ processed, total: planned.length, files: result.files, bytes: result.bytes, totalBytes, current: "" });
  return result;
}


export function zipEntryNames(buf: Buffer): string[] {
  return listZip(buf).map((e) => e.name);
}








const FLAG_UTF8 = 0x0800;
const DOS_DATE_1980 = 33;


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






export function crc32(buf: Buffer): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}


export interface ZipFile {
  name: string;
  data: Buffer;
}







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
    local.writeUInt16LE(20, 4);              
    local.writeUInt16LE(FLAG_UTF8, 6);       
    local.writeUInt16LE(8, 8);               
    local.writeUInt16LE(0, 10);              
    local.writeUInt16LE(DOS_DATE_1980, 12);  
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);              
    nameBytes.copy(local, 30);
    locals.push(local, comp);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);            
    central.writeUInt16LE(20, 6);            
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);            
    central.writeUInt16LE(0, 32);            
    central.writeUInt16LE(0, 34);            
    central.writeUInt16LE(0, 36);            
    central.writeUInt32LE(0, 38);            
    central.writeUInt32LE(offset, 42);       
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + comp.length;
    count += 1;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);                  
  eocd.writeUInt16LE(0, 6);                  
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);            
  eocd.writeUInt16LE(0, 20);                 

  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}
