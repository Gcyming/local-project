/**
 * core-ts/src/gguf_meta.ts — GGUF 头部元数据读取 + KV cache 显存换算（A-1021）。
 *
 * 为什么单独成文件：这是**纯逻辑**（无 JSX、无副作用编排），按项目铁律不许塞进
 * `model_server.ts` 那种编排层里；而且它需要一个**可脱离真实模型文件测试**的入口
 * （见 `parseGgufHeader`），否则测试就得依赖一个 1.7GB 的 gguf 才能跑。
 *
 * ── 为什么需要它（本文件的存在理由）──────────────────────────
 * 用户症状：本地模型（qwen3-1.7b-q8_0 + ctx_len=32768）起不来，llama-server 报
 *   `failed to allocate buffer for kv cache` / `cudaMalloc failed: out of memory`。
 * 而 GUI 侧的**显存预检却放行了** —— 因为预检用的是常量 `chat_est_gb = 4.0`，
 * 而 ctx=32768 的真实占用约 5.4GB（权重 1.8 + KV cache 3.5）。常量低估 → 预检形同虚设
 * → 失败只在 cudaMalloc 处暴露，且报错是 CUDA 术语（用户看到的是一串乱码般的数字）。
 *
 * 正确做法是**从模型文件本身推出 KV cache 大小**（唯一真值来源），而不是维护一个
 * 与模型无关的魔数：KV 占用 = block_count × ctx × head_count_kv × (key_length + value_length) × 字节宽。
 *
 * ── GGUF 编码要点（v3，实测自本机 qwen3-1.7b-q8_0.gguf）──────
 *   magic("GGUF") · version(u32) · tensor_count(u64) · metadata_kv_count(u64)
 *   随后是 metadata_kv_count 个：key(u64长度+字节) · value_type(u32) · value
 * ⚠️ 元数据键**带架构前缀**：现代转换脚本写的是 `<arch>.block_count`（本机是 `qwen3.block_count`），
 *    而不是老文档里的 `llama.block_count`。所以必须先从 `general.architecture` 取前缀，
 *    再拼 `<arch>.…` 去查 —— 写死 `llama.` 会一个都读不到（本实现第一版就栽在这里，
 *    表现为"解析成功但 geometry 全是 NaN"）。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** GGUF 元数据值类型（规范 v3 的 `gguf_metadata_value_type`） */
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

/** 模型几何参数（KV cache 显存换算所需的最小集合） */
export interface GgufKvGeometry {
  /** 架构名（`general.architecture`），也是元数据键的前缀 */
  architecture: string;
  /** 层数 */
  blockCount: number;
  /** 注意力头数（query 头） */
  headCount: number;
  /** KV 头数（GQA 下 < headCount；决定 KV cache 规模） */
  headCountKv: number;
  /** K 的每头维度 */
  keyLength: number;
  /** V 的每头维度（多数模型与 keyLength 相同，MLA 类模型不同） */
  valueLength: number;
  /** 隐藏层宽度 */
  embeddingLength: number;
  /** 模型原生最大上下文（仅作参考/上界提示，不代表本机可用配置） */
  nativeContextLength: number | null;
  /** 文件字节数（权重显存的下界近似：mmap 常驻部分 ≈ 文件大小） */
  fileSizeBytes: number;
}

/** 元数据里"没读到 / 文件被截断"时抛这个（调用方据此回退到旧常量估算） */
export class GgufMetaUnavailableError extends Error {}

/** 顺序读 Buffer，越界即标记 exhausted（不抛异常：截断是预期情况，见 parseGgufHeader） */
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

  /** 读出第 n 个字节并前进（用于跳过不需要的值，读不到就停在原地并置 exhausted） */
  skip(n: number): boolean {
    if (!this.fits(n)) return false;
    this.off += n;
    return true;
  }

  /** 带长度前缀的字符串 */
  str(): string {
    const len = Number(this.u64());
    if (this.exhausted) return "";
    return this.bytes(len);
  }

  /**
   * 读一个值并返回（只对需要保留的键调用；其余类型用 skipValue 跳过）。
   * 读不全时返回 undefined —— 与"值就是 undefined"不冲突，因为 GGUF 没有 undefined 值。
   */
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
        // ARRAY 与未知类型不由 value() 处理（数组可能极大，必须用 skipValue 跳过）
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

  /** 按类型跳过值（数组元素逐个递归跳过；不需保留内容） */
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
        // 元素个数可能有上百亿（损坏文件/截断）→ 一旦 exhausted 立刻停，避免空转
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

/**
 * 解析 GGUF 头部字节流 → 几何参数。
 *
 * **纯函数**（只吃 Buffer），因此可以用合成的 GGUF 做单测，无需真实模型。
 *
 * 截断语义：tokenizer 的大数组（`tokenizer.ggml.tokens` 十几万元素）会排在
 * `general.*` / `<arch>.*` 之后。因此当 buffer 被截断时，只要**所需键已全部读齐**，
 * 仍算成功 —— 这正是"只读文件头几 MB 也能拿到几何参数"的实现基础。
 * 反之若所需键缺失/截断 → 返回 null，由调用方回退到旧常量估算（绝不因此拒绝启动）。
 */
export function parseGgufHeader(buf: Buffer): GgufKvGeometry | null {
  const r = new BufReader(buf);
  const magic = r.bytes(4);
  if (magic !== "GGUF") return null;
  const version = r.u32();
  if (r.exhausted || version < 1 || version > 3) return null;
  // v1 的字符串长度是 u32（长度前缀宽度不同）。本实现只支持 v2/v3（2023 年后的实际产物）。
  if (version === 1) return null;
  r.u64(); // tensor_count（用不到）
  const kvCount = Number(r.u64());
  if (r.exhausted || !Number.isFinite(kvCount) || kvCount <= 0 || kvCount > 100000) return null;

  const found: Record<string, string | number | boolean> = {};
  for (let i = 0; i < kvCount; i++) {
    const key = r.str();
    if (r.exhausted) break;
    const type = r.u32();
    if (r.exhausted) break;
    // 只保留小标量键；其余（含巨型数组）整段跳过 —— 这决定了"读几 MB 头就够"
    if (type === T_ARRAY || type === T_STRING) {
      // 字符串键里只有 general.architecture 有用
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
  // key/value 维度：优先显式声明；缺失则按 embedding/head_count 推导（等维模型）
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
    fileSizeBytes: 0, // 由 readGgufMeta 填
  };
}

/** 只读取 GGUF **文件头**（默认前 8MiB）即可拿到几何参数；读不到返回 null */
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
      try { closeSync(fd); } catch { /* 忽略 */ }
    }
  }
}

// ── KV cache 显存换算 ──────────────────────────────────────

/**
 * 每种 KV 缓存类型的**每元素字节数**。
 * 取值来自 llama.cpp 的块量化定义（`ggml` 块结构）：
 *   q8_0 = 32 个元素 → 32×1B 量化值 + 2B 缩放 = 34B  → 34/32
 *   q5_1 = 32 → 20 + 4 = 24B ；q5_0 = 32 → 20 + 2 = 22B
 *   q4_1 = 32 → 16 + 4 = 20B ；q4_0 = 32 → 16 + 2 = 18B ；iq4_nl = 32 → 18B
 * （不与 llama.cpp 的 `-ctk/--cache-type-k` 允许取值集合脱钩：见 `SUPPORTED_KV_TYPES`。）
 */
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

/**
 * llama-server 的 `-ctk/-ctv` 允许取值（**逐字抄自本机二进制 `--help`**，
 * 见 llama-server --help 的 "allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1"）。
 * ⚠️ 改这里之前先重跑 `llama-server --help` 核对 —— 不允许凭印象写参数（A-1018 的教训）。
 */
export const SUPPORTED_KV_TYPES: readonly string[] = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];

/** KV 显存换算的**整体放大系数**（块对齐/KV 分块填充导致实测略大于理论值） */
export const KV_PADDING_SLACK = 1.1;

/**
 * 权重之外的**运行时开销**（CUDA 上下文、compute buffer、mmap 表）估算，GiB。
 * 实测依据（RTX 4070 Laptop 8G）：文件 1.708 GiB，KV 全部放内存时 GPU 占用 1851 MiB
 * → 权重+开销 ≈ 1.81 GiB，即开销 ≈ 0.10 GiB。取 0.2 是**故意保守**（多估不闯祸）。
 */
export const WEIGHTS_RUNTIME_OVERHEAD_GB = 0.2;

/** KV cache 总字节数；参数非法返回 null */
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
  // 每层每 token：K 有 headCountKv × keyLength 个元素，V 有 headCountKv × valueLength 个
  const perTokenPerLayer = geom.headCountKv * (geom.keyLength * bk + geom.valueLength * bv);
  return perTokenPerLayer * geom.blockCount * ctxLen;
}

/**
 * 预估 chat 模型的 GPU 显存占用（GiB）= 权重 + KV cache × slack + 运行时开销。
 *
 * 用途：替代"与模型无关的常量 `chat_est_gb`"做启动前预检。
 * 读不到几何参数（或 KV 类型非法）返回 null → 调用方**回退到旧常量**，绝不因估算失败而拒绝启动。
 */
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
