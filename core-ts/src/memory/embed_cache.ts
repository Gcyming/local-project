















import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export interface EmbedCacheOptions {
  
  maxEntries?: number;
  
  filePath?: string;
  
  flushIntervalMs?: number;
}

interface EmbedCacheFile {
  version: 1;
  dim: number;
  
  entries: Array<[string, string]>;
}

function encodeVec(v: number[]): string {
  const f = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) f[i] = v[i];
  return Buffer.from(f.buffer).toString("base64");
}

function decodeVec(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const out: number[] = new Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i];
  return out;
}

export class EmbedCache {
  private map = new Map<string, number[]>();
  private readonly maxEntries: number;
  private readonly filePath: string;
  private readonly flushIntervalMs: number;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: EmbedCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 1024;
    this.filePath = opts.filePath ?? resolve(PROJECT_ROOT, "data", "embed_cache.json");
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.load();
  }

  private keyOf(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  



  get(text: string, expectedDim?: number): number[] | undefined {
    const key = this.keyOf(text);
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    if (expectedDim !== undefined && hit.length !== expectedDim) {
      
      this.map.delete(key);
      return undefined;
    }
    
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.slice();
  }

  set(text: string, vec: number[]): void {
    const key = this.keyOf(text);
    this.map.delete(key);
    this.map.set(key, vec);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.scheduleFlush();
  }

  
  get size(): number {
    return this.map.size;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushIntervalMs);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  
  flush(): void {
    if (this.map.size === 0) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const entries: Array<[string, string]> = [];
      let dim = 0;
      for (const [k, v] of this.map) {
        entries.push([k, encodeVec(v)]);
        if (v.length > dim) dim = v.length;
      }
      const payload: EmbedCacheFile = { version: 1, dim, entries };
      const tmp = this.filePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(payload), "utf8");
      renameSync(tmp, this.filePath);
    } catch (e) {
      console.warn(`[embed-cache] 落盘失败: ${e}`);
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as EmbedCacheFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
      for (const [k, b64] of parsed.entries) {
        if (typeof k !== "string" || typeof b64 !== "string") continue;
        try {
          const vec = decodeVec(b64);
          if (vec.length === 0) continue;
          this.map.set(k, vec);
        } catch {
          
        }
      }
      
      while (this.map.size > this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.map.delete(oldest);
      }
    } catch (e) {
      console.warn(`[embed-cache] 加载失败: ${e}`);
    }
  }
}


export const embeddingCache = new EmbedCache();


if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("exit", () => {
    try {
      embeddingCache.flush();
    } catch {
      
    }
  });
}
