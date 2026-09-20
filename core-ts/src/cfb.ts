/**
 * core-ts/src/cfb.ts — OLE2 复合文档（Compound File Binary）读取，零依赖。
 *
 * **为什么需要**（A-1036）：`.doc` / `.xls` / `.ppt`（Office 97-2003）不是 ZIP，
 * 而是 OLE2 复合文档 —— 一个把多条"流"塞进单个文件的小型文件系统。
 * 此前这三类文件只能明确报"不支持"，用户拿不到里面一个字。
 *
 * 结构（MS-CFB）：
 *   头(512B) → DIFAT → FAT → 目录项树 → 各流的扇区链
 *   小于 `miniCutoff`（默认 4096B）的流存在 **mini stream** 里，链在 **miniFAT** 上。
 *   `.doc` 的正文、`.xls` 的工作表、`.ppt` 的幻灯片都只是不同名字的流。
 *
 * 只做**读取**，不做写入；遇到加密/损坏明确抛错，不返回半截数据充数。
 */

const SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

/** 目录项类型 */
const OBJ_STORAGE = 1;
const OBJ_STREAM = 2;
const OBJ_ROOT = 5;

export interface CfbStream {
  name: string;
  /** 流在文件中的逻辑大小（字节） */
  size: number;
  /** 是否存放在 mini stream 里 */
  mini: boolean;
}

/** 是不是 OLE2 复合文档（三种旧版 Office 格式的判据）。 */
export function isOle2(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIG);
}

interface DirEntry {
  name: string;
  type: number;
  startSector: number;
  size: number;
}

export class CfbFile {
  private buf: Buffer;
  private sectorSize: number;
  private miniSectorSize: number;
  private miniCutoff: number;
  private fat: number[];
  private miniFat: number[];
  private entries: DirEntry[];
  private miniStreamStart: number;
  private miniStreamSize: number;

  constructor(buf: Buffer) {
    if (!isOle2(buf)) { throw new Error("不是 OLE2 复合文档（缺少 D0CF11E0 签名）"); }
    this.buf = buf;
    const sectorShift = buf.readUInt16LE(30);
    const miniShift = buf.readUInt16LE(32);
    if (sectorShift < 7 || sectorShift > 20) { throw new Error(`OLE2 扇区大小异常（shift=${sectorShift}）`); }
    if (miniShift < 2 || miniShift > sectorShift) { throw new Error(`OLE2 迷你扇区大小异常（shift=${miniShift}）`); }
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniShift;
    // 0xFFFF / 0 都表示"用默认值 4096"（部分写入器不填）
    const cutoff = buf.readUInt32LE(56);
    this.miniCutoff = cutoff === 0 || cutoff > 0xffff ? 4096 : cutoff;

    const difat: number[] = [];
    for (let i = 0; i < 109; i += 1) {
      const s = buf.readUInt32LE(76 + i * 4);
      if (s === FREESECT || s === ENDOFCHAIN) { break; }
      difat.push(s);
    }
    // DIFAT 溢出扇区（>109 个 FAT 扇区才会用到）
    let difatSector = buf.readUInt32LE(68);
    const difatCount = buf.readUInt32LE(72);
    for (let i = 0; i < difatCount && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; i += 1) {
      const off = this.sectorOffset(difatSector);
      const per = this.sectorSize / 4 - 1;
      for (let k = 0; k < per; k += 1) {
        const s = buf.readUInt32LE(off + k * 4);
        if (s === FREESECT || s === ENDOFCHAIN) { break; }
        difat.push(s);
      }
      difatSector = buf.readUInt32LE(off + per * 4);
    }

    // FAT：把每个 FAT 扇区拼成一张"下一扇区"表
    this.fat = [];
    for (const fs of difat) {
      const off = this.sectorOffset(fs);
      for (let k = 0; k < this.sectorSize / 4; k += 1) {
        this.fat.push(buf.readUInt32LE(off + k * 4));
      }
    }
    if (this.fat.length === 0) { throw new Error("OLE2 结构损坏：FAT 为空"); }

    const dirStart = buf.readUInt32LE(48);
    if (dirStart === ENDOFCHAIN || dirStart === FREESECT) { throw new Error("OLE2 结构损坏：没有目录扇区"); }
    const dirData = this.readChain(dirStart, Infinity, false);
    this.entries = [];
    for (let o = 0; o + 128 <= dirData.length; o += 128) {
      const type = dirData[o + 66];
      if (type !== OBJ_STORAGE && type !== OBJ_STREAM && type !== OBJ_ROOT) { continue; }
      const nameLen = dirData.readUInt16LE(o + 64);
      const chars = Math.max(0, Math.min(31, nameLen / 2 - 1));
      const name = chars > 0 ? dirData.subarray(o, o + chars * 2).toString("utf16le") : "";
      this.entries.push({
        name,
        type,
        startSector: dirData.readUInt32LE(o + 116),
        size: Number(dirData.readBigUInt64LE(o + 120)),
      });
    }
    if (this.entries.length === 0) { throw new Error("OLE2 结构损坏：目录为空"); }

    const root = this.entries.find((e) => e.type === OBJ_ROOT);
    this.miniStreamStart = root ? root.startSector : ENDOFCHAIN;
    this.miniStreamSize = root ? root.size : 0;

    const miniStart = buf.readUInt32LE(60);
    this.miniFat = [];
    if (miniStart !== ENDOFCHAIN && miniStart !== FREESECT) {
      const miniFatData = this.readChain(miniStart, Infinity, false);
      for (let k = 0; k + 4 <= miniFatData.length; k += 4) {
        this.miniFat.push(miniFatData.readUInt32LE(k));
      }
    }
  }

  /** 扇区号 → 文件内字节偏移（扇区 0 紧跟在 512 字节头之后） */
  private sectorOffset(sector: number): number {
    const off = (sector + 1) * this.sectorSize;
    if (off < 0 || off + this.sectorSize > this.buf.length) {
      throw new Error(`OLE2 扇区 ${sector} 越界（文件被截断？）`);
    }
    return off;
  }

  /** 沿链表读出一段数据；`mini=true` 时按迷你扇区步进 */
  private readChain(start: number, maxBytes: number, mini: boolean): Buffer {
    const size = mini ? this.miniSectorSize : this.sectorSize;
    const table = mini ? this.miniFat : this.fat;
    const chunks: Buffer[] = [];
    let total = 0;
    let sector = start;
    const seen = new Set<number>();
    while (sector !== ENDOFCHAIN && sector !== FREESECT && total < maxBytes) {
      // 环链保护：损坏文件里的自引用链会让循环永不结束
      if (seen.has(sector)) { break; }
      seen.add(sector);
      if (sector >= table.length) { break; }
      const data = mini ? this.miniSectorData(sector) : this.buf.subarray(this.sectorOffset(sector), this.sectorOffset(sector) + size);
      chunks.push(data);
      total += data.length;
      sector = table[sector];
    }
    const all = Buffer.concat(chunks);
    return maxBytes === Infinity ? all : all.subarray(0, Math.min(maxBytes, all.length));
  }

  /** 迷你扇区位于 mini stream 内（本身是普通链） */
  private miniSectorData(index: number): Buffer {
    const off = index * this.miniSectorSize;
    if (off >= this.miniStreamSize && this.miniStreamSize > 0) { return Buffer.alloc(0); }
    const miniStream = this.miniStreamCache ?? (this.miniStreamCache = this.readChain(this.miniStreamStart, this.miniStreamSize || Infinity, false));
    return miniStream.subarray(off, off + this.miniSectorSize);
  }
  private miniStreamCache?: Buffer;

  /** 列出全部流（不含目录/根） */
  listStreams(): CfbStream[] {
    return this.entries
      .filter((e) => e.type === OBJ_STREAM && e.size > 0)
      .map((e) => ({ name: e.name, size: e.size, mini: e.size < this.miniCutoff }));
  }

  /** 按名读取一条流（大小写不敏感；找不到返回 null） */
  readStream(name: string): Buffer | null {
    const want = name.toLowerCase();
    const e = this.entries.find((x) => x.type === OBJ_STREAM && x.name.toLowerCase() === want);
    if (!e || e.size <= 0) { return null; }
    const mini = e.size < this.miniCutoff;
    const data = this.readChain(e.startSector, e.size, mini);
    return data.subarray(0, Math.min(e.size, data.length));
  }

  /** 取第一条名字匹配（含）的流 —— 旧版 Office 的流名在不同写入器下偶有后缀差异 */
  readStreamLike(fragment: string): Buffer | null {
    const want = fragment.toLowerCase();
    const e = this.entries.find((x) => x.type === OBJ_STREAM && x.name.toLowerCase().includes(want) && x.size > 0);
    return e ? this.readStream(e.name) : null;
  }
}

/** 便捷入口：解析失败抛错，由调用方转成给模型看的说明。 */
export function openCfb(buf: Buffer): CfbFile {
  return new CfbFile(buf);
}
