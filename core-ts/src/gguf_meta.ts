
























import { closeSync, fstatSync, openSync, readSync } from "node:fs";


const T_UINT8 = 0;
const T_INT8 = 1;
const T_UINT16 = 2;
const T_INT16 = 3;
const T_UINT32 = 4;
const T_INT32 = 5;
const T_FLOAT32 = 6;
const T_BOOL = 7;
const T_STRING = 8;
const T_ARRAY = 9;
const T_UINT64 = 10;
const T_INT64 = 11;
const T_FLOAT64 = 12;


export interface GgufKvGeometry {
  
  architecture: string;
  
  blockCount: number;
  
  headCount: number;
  
  headCountKv: number;
  
  keyLength: number;
  
  valueLength: number;
  
  embeddingLength: number;
  
  nativeContextLength: number | null;
  
  fileSizeBytes: number;
}


export class GgufMetaUnavailableError extends Error {}


class BufReader {
  private off = 0;
  exhausted = false;

  constructor(private readonly buf: Buffer) {}

  private fits(n: number): boolean {
    if (this.off + n > this.buf.length) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  u32(): number {
    if (!this.fits(4)) return 0;
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }

  u64(): bigint {
    if (!this.fits(8)) return 0n;
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }

  bytes(n: number): string {
    if (!this.fits(n)) return "";
    const v = this.buf.toString("utf8", this.off, this.off + n);
    this.off += n;
    return v;
  }

  
  skip(n: number): boolean {
    if (!this.fits(n)) return false;
    this.off += n;
    return true;
  }

  
  str(): string {
    const len = Number(this.u64());
    if (this.exhausted) return "";
    return this.bytes(len);
  }

  



  value(type: number): string | number | boolean | undefined {
    switch (type) {
      case T_UINT8: return this.u8();
      case T_INT8: { const b = this.i8(); return b; }
      case T_UINT16: case T_INT16: { const v = this.u32() & 0xffff; return v; }
      case T_UINT32: case T_FLOAT32: return this.u32();
      case T_INT32: return this.u32() | 0;
      case T_BOOL: return this.u8() !== 0;
      case T_UINT64: return Number(this.u64());
      case T_INT64: return Number(this.u64() as unknown as bigint);
      case T_FLOAT64: {
        if (!this.fits(8)) return undefined;
        const v = this.buf.readDoubleLE(this.off);
        this.skip(8);
        return v;
      }
      case T_STRING: return this.str();
      default:
        
        this.exhausted = true;
        return undefined;
    }
  }

  private u8(): number {
    if (!this.fits(1)) return 0;
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }

  private i8(): number {
    if (!this.fits(1)) return 0;
    const v = this.buf.readInt8(this.off);
    this.off += 1;
    return v;
  }

  
  skipValue(type: number): void {
    switch (type) {
      case T_UINT8: case T_INT8: case T_BOOL: this.skip(1); return;
      case T_UINT16: case T_INT16: this.skip(2); return;
      case T_UINT32: case T_INT32: case T_FLOAT32: this.skip(4); return;
      case T_UINT64: case T_INT64: case T_FLOAT64: this.skip(8); return;
      case T_STRING: { const len = Number(this.u64()); if (!this.exhausted) { this.skip(len); } return; }
      case T_ARRAY: {
        const et = this.u32();
        if (this.exhausted) return;
        const n = Number(this.u64());
        if (this.exhausted) return;
        
        for (let i = 0; i < n; i++) {
          this.skipValue(et);
          if (this.exhausted) return;
        }
        return;
      }
      default:
        this.exhausted = true;
    }
  }
}











export function parseGgufHeader(buf: Buffer): GgufKvGeometry | null {
  const r = new BufReader(buf);
  const magic = r.bytes(4);
  if (magic !== "GGUF") return null;
  const version = r.u32();
  if (r.exhausted || version < 1 || version > 3) return null;
  
  if (version === 1) return null;
  r.u64(); 
  const kvCount = Number(r.u64());
  if (r.exhausted || !Number.isFinite(kvCount) || kvCount <= 0 || kvCount > 100000) return null;

  const found: Record<string, string | number | boolean> = {};
  for (let i = 0; i < kvCount; i++) {
    const key = r.str();
    if (r.exhausted) break;
    const type = r.u32();
    if (r.exhausted) break;
    
    if (type === T_ARRAY || type === T_STRING) {
      
      if (type === T_STRING && key === "general.architecture") {
        const v = r.str();
        if (!r.exhausted && typeof v === "string") found[key] = v;
      } else {
        r.skipValue(type);
      }
    } else {
      const v = r.value(type);
      if (r.exhausted) break;
      if (v !== undefined) found[key] = v;
    }
  }

  const arch = typeof found["general.architecture"] === "string" ? (found["general.architecture"] as string) : "";
  if (!arch) return null;
  const num = (k: string): number | null => {
    const v = found[`${arch}.${k}`];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const blockCount = num("block_count");
  const embeddingLength = num("embedding_length");
  const headCount = num("attention.head_count");
  const headCountKv = num("attention.head_count_kv") ?? headCount;
  
  const derived = headCount && embeddingLength ? Math.floor(embeddingLength / headCount) : null;
  const keyLength = num("attention.key_length") ?? derived;
  const valueLength = num("attention.value_length") ?? derived;
  if (!blockCount || !embeddingLength || !headCount || !headCountKv || !keyLength || !valueLength) {
    return null;
  }

  return {
    architecture: arch,
    blockCount,
    headCount,
    headCountKv,
    keyLength,
    valueLength,
    embeddingLength,
    nativeContextLength: num("context_length"),
    fileSizeBytes: 0, 
  };
}


export function readGgufMeta(filePath: string, maxHeaderBytes = 8 * 1024 * 1024): GgufKvGeometry | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const want = Math.min(size, maxHeaderBytes);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    const meta = parseGgufHeader(got === want ? buf : buf.subarray(0, got));
    if (!meta) return null;
    return { ...meta, fileSizeBytes: size };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {  }
    }
  }
}











export const KV_CACHE_BYTES_PER_ELEMENT: Readonly<Record<string, number>> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
  iq4_nl: 18 / 32,
};






export const SUPPORTED_KV_TYPES: readonly string[] = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];


export const KV_PADDING_SLACK = 1.1;






export const WEIGHTS_RUNTIME_OVERHEAD_GB = 0.2;


export function kvCacheBytes(
  geom: GgufKvGeometry,
  ctxLen: number,
  kType: string,
  vType: string,
): number | null {
  const bk = KV_CACHE_BYTES_PER_ELEMENT[kType];
  const bv = KV_CACHE_BYTES_PER_ELEMENT[vType];
  if (bk === undefined || bv === undefined) return null;
  if (!Number.isFinite(ctxLen) || ctxLen <= 0) return null;
  
  const perTokenPerLayer = geom.headCountKv * (geom.keyLength * bk + geom.valueLength * bv);
  return perTokenPerLayer * geom.blockCount * ctxLen;
}







export function estimateGpuFootprintGb(
  geom: GgufKvGeometry,
  ctxLen: number,
  kType: string,
  vType: string,
): number | null {
  const kv = kvCacheBytes(geom, ctxLen, kType, vType);
  if (kv === null) return null;
  const weights = geom.fileSizeBytes / 1024 ** 3;
  const kvGb = (kv * KV_PADDING_SLACK) / 1024 ** 3;
  return weights + kvGb + WEIGHTS_RUNTIME_OVERHEAD_GB;
}
