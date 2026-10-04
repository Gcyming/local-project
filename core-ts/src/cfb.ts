














const SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;


const OBJ_STORAGE = 1;
const OBJ_STREAM = 2;
const OBJ_ROOT = 5;

export interface CfbStream {
  name: string;
  
  size: number;
  
  mini: boolean;
}


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
    
    const cutoff = buf.readUInt32LE(56);
    this.miniCutoff = cutoff === 0 || cutoff > 0xffff ? 4096 : cutoff;

    const difat: number[] = [];
    for (let i = 0; i < 109; i += 1) {
      const s = buf.readUInt32LE(76 + i * 4);
      if (s === FREESECT || s === ENDOFCHAIN) { break; }
      difat.push(s);
    }
    
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

  
  private sectorOffset(sector: number): number {
    const off = (sector + 1) * this.sectorSize;
    if (off < 0 || off + this.sectorSize > this.buf.length) {
      throw new Error(`OLE2 扇区 ${sector} 越界（文件被截断？）`);
    }
    return off;
  }

  
  private readChain(start: number, maxBytes: number, mini: boolean): Buffer {
    const size = mini ? this.miniSectorSize : this.sectorSize;
    const table = mini ? this.miniFat : this.fat;
    const chunks: Buffer[] = [];
    let total = 0;
    let sector = start;
    const seen = new Set<number>();
    while (sector !== ENDOFCHAIN && sector !== FREESECT && total < maxBytes) {
      
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

  
  private miniSectorData(index: number): Buffer {
    const off = index * this.miniSectorSize;
    if (off >= this.miniStreamSize && this.miniStreamSize > 0) { return Buffer.alloc(0); }
    const miniStream = this.miniStreamCache ?? (this.miniStreamCache = this.readChain(this.miniStreamStart, this.miniStreamSize || Infinity, false));
    return miniStream.subarray(off, off + this.miniSectorSize);
  }
  private miniStreamCache?: Buffer;

  
  listStreams(): CfbStream[] {
    return this.entries
      .filter((e) => e.type === OBJ_STREAM && e.size > 0)
      .map((e) => ({ name: e.name, size: e.size, mini: e.size < this.miniCutoff }));
  }

  
  readStream(name: string): Buffer | null {
    const want = name.toLowerCase();
    const e = this.entries.find((x) => x.type === OBJ_STREAM && x.name.toLowerCase() === want);
    if (!e || e.size <= 0) { return null; }
    const mini = e.size < this.miniCutoff;
    const data = this.readChain(e.startSector, e.size, mini);
    return data.subarray(0, Math.min(e.size, data.length));
  }

  
  readStreamLike(fragment: string): Buffer | null {
    const want = fragment.toLowerCase();
    const e = this.entries.find((x) => x.type === OBJ_STREAM && x.name.toLowerCase().includes(want) && x.size > 0);
    return e ? this.readStream(e.name) : null;
  }
}


export function openCfb(buf: Buffer): CfbFile {
  return new CfbFile(buf);
}
