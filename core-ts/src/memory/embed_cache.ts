/**
 * core-ts/src/memory/embed_cache.ts — embedding 结果 LRU + 磁盘持久化缓存（独立小任务）。
 *
 * 收益前提：embedding 收益依赖「重复查询」——同一条文本（记忆内容 / 检索 query / 知识向量化文本）
 * 跨会话、跨 Agent 重复出现时，直接命中缓存，避免再次调用 BGE-M3 HTTP 嵌入。
 *
 * 设计：
 * - LRU：Map 插入序即访问序；命中移到尾部，超上限淘汰最久未用（对齐 knowledgeCache A-970 同款）。
 * - 磁盘持久化：去抖后整表快照原子落盘（临时文件 + rename），进程重启后预热恢复。
 * - 只缓存「真实嵌入」结果；哈希占位向量（hashEmbed 降级）不缓存（本身零成本，缓存反而污染）。
 * - 键：文本的 sha256（防长文本占用内存；同文本哈希稳定，跨 Agent 共享）。
 * - 向量以 Float32 原始字节 base64 编码压缩（BGE 输出本身即 float32），显著缩小磁盘体积。
 *
 * 线程模型：TS 单线程事件循环内同步段天然原子；落盘用同步 writeFileSync，简单可靠。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export interface EmbedCacheOptions {
  /** 内存 LRU 上限（条），默认 1024。 */
  maxEntries?: number;
  /** 磁盘快照路径，默认 data/embed_cache.json。 */
  filePath?: string;
  /** 落盘去抖间隔（ms），默认 2000。 */
  flushIntervalMs?: number;
}

interface EmbedCacheFile {
  version: 1;
  dim: number;
  /** LRU 序数组：[sha256, base64(Float32 bytes)]。 */
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

  /**
   * 命中返回向量副本（防调用方原地改坏缓存）；未命中或维度不符返回 undefined。
   * expectedDim 用于维度配置变更时自动失效旧缓存（BUG-025：可配置维度）。
   */
  get(text: string, expectedDim?: number): number[] | undefined {
    const key = this.keyOf(text);
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    if (expectedDim !== undefined && hit.length !== expectedDim) {
      // 维度配置变更：旧向量作废
      this.map.delete(key);
      return undefined;
    }
    // LRU 刷新：移到尾部
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

  /** 命中条数（诊断 / 测试用）。 */
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

  /** 同步落盘（整表快照 + 原子替换）。 */
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
          /* 单条损坏跳过 */
        }
      }
      // 预热后超上限 → 从头部（最久未用）淘汰
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

/** 进程内共享单例：跨 Agent / 跨 MemoryStore 复用同一文本的嵌入结果，最大化命中率。 */
export const embeddingCache = new EmbedCache();

// 进程退出前尽力同步落盘（Electron 主进程 / 单测退出路径）。
if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("exit", () => {
    try {
      embeddingCache.flush();
    } catch {
      /* 尽力而为 */
    }
  });
}
