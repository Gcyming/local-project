
















import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  parseGgufHeader,
  readGgufMeta,
  kvCacheBytes,
  estimateGpuFootprintGb,
  KV_CACHE_BYTES_PER_ELEMENT,
  KV_PADDING_SLACK,
  SUPPORTED_KV_TYPES,
  type GgufKvGeometry,
} from "../../core-ts/src/gguf_meta.js";
import { buildLlamaArgv, sanitizeAlias, type BackendArgs } from "../../core-ts/src/model_server.js";



const GT = { U32: 4, STR: 8, U64: 10, ARR: 9 } as const;


function writeGguf(kvs: Array<[string, number, unknown]>, opts: { version?: number; magic?: string } = {}): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
  const u64 = (v: bigint | number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; };
  const str = (s: string): Buffer => {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([u64(body.length), body]);
  };
  const val = (type: number, v: unknown): Buffer => {
    if (type === GT.U32) return u32(v as number);
    if (type === GT.U64) return u64(v as number);
    if (type === GT.STR) return str(v as string);
    if (type === GT.ARR) {
      const list = v as Array<[number, unknown]>;
      return Buffer.concat([u32(list.length ? list[0][0] : GT.U32), u64(list.length), ...list.map((e) => val(e[0], e[1]))]);
    }
    throw new Error("unsupported fixture type " + type);
  };
  parts.push(Buffer.from(opts.magic ?? "GGUF", "latin1"));
  parts.push(u32(opts.version ?? 3));
  parts.push(u64(0)); 
  parts.push(u64(kvs.length));
  for (const [k, t, v] of kvs) {
    parts.push(str(k), u32(t), val(t, v));
  }
  return Buffer.concat(parts);
}


const QWEN3_KVS: Array<[string, number, unknown]> = [
  ["general.architecture", GT.STR, "qwen3"],
  ["general.name", GT.STR, "Qwen3 1.7B Instruct"],
  ["qwen3.block_count", GT.U32, 28],
  ["qwen3.embedding_length", GT.U32, 2048],
  ["qwen3.attention.head_count", GT.U32, 16],
  ["qwen3.attention.head_count_kv", GT.U32, 8],
  ["qwen3.attention.key_length", GT.U32, 128],
  ["qwen3.attention.value_length", GT.U32, 128],
  ["qwen3.context_length", GT.U32, 40960],
  
  ["tokenizer.ggml.tokens", GT.ARR, [[GT.STR, "a"], [GT.STR, "b"], [GT.STR, "c"]]],
];

const tmp = (): string => mkdtempSync(join(tmpdir(), "slime-gguf-"));
const QWEN3_GEOM = (fileSizeBytes = 0): GgufKvGeometry => ({
  architecture: "qwen3",
  blockCount: 28,
  headCount: 16,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
  embeddingLength: 2048,
  nativeContextLength: 40960,
  fileSizeBytes,
});

describe("parseGgufHeader：几何参数解析", () => {
  it("按 general.architecture 拼前缀读取（不是写死 llama.）", () => {
    const g = parseGgufHeader(writeGguf(QWEN3_KVS));
    expect(g).not.toBeNull();
    expect(g!.architecture).toBe("qwen3");
    expect(g!.blockCount).toBe(28);
    expect(g!.headCount).toBe(16);
    expect(g!.headCountKv).toBe(8);
    expect(g!.keyLength).toBe(128);
    expect(g!.valueLength).toBe(128);
    expect(g!.nativeContextLength).toBe(40960);
  });

  it("写死 llama. 前缀会读不到（回退用 general.architecture 才是对的）", () => {
    
    const kvs = QWEN3_KVS.map(([k, t, v]) => [k.replace(/^qwen3\./, "llama."), t, v] as [string, number, unknown]);
    const g = parseGgufHeader(writeGguf(kvs.map((e) => (e[0] === "general.architecture" ? ["general.architecture", GT.STR, "llama"] as [string, number, unknown] : e))));
    expect(g).not.toBeNull();
    expect(g!.architecture).toBe("llama");
    expect(g!.blockCount).toBe(28);
  });

  it("truncation：截断在尾部大数组中间，但所需键已读齐 → 仍然成功", () => {
    const full = writeGguf([...QWEN3_KVS, ["tokenizer.ggml.merges", GT.ARR, Array.from({ length: 400 }, (_, i) => [GT.STR, "m" + i] as [number, unknown])]]);
    
    const cut = full.subarray(0, Math.max(0, full.length - 200));
    const g = parseGgufHeader(cut);
    expect(g).not.toBeNull();
    expect(g!.blockCount).toBe(28);
    expect(g!.headCountKv).toBe(8);
  });

  it("truncation：几何键本身缺失/被截断 → 返回 null（调用方据此回退，而不是拒绝启动）", () => {
    const kvs = QWEN3_KVS.filter(([k]) => !k.startsWith("qwen3.block_count"));
    expect(parseGgufHeader(writeGguf(kvs))).toBeNull();
    
    expect(parseGgufHeader(writeGguf(QWEN3_KVS).subarray(0, 8))).toBeNull();
  });

  it("拒非法输入：错 magic / 不支持的 v1 / 空 buffer", () => {
    expect(parseGgufHeader(writeGguf(QWEN3_KVS, { magic: "GGML" }))).toBeNull();
    expect(parseGgufHeader(writeGguf(QWEN3_KVS, { version: 1 }))).toBeNull();
    expect(parseGgufHeader(Buffer.alloc(0))).toBeNull();
  });

  it("缺 attention.head_count_kv 时回退到 head_count（非 GQA 模型）", () => {
    const kvs = QWEN3_KVS.filter(([k]) => k !== "qwen3.attention.head_count_kv" && !k.startsWith("qwen3.attention.key_length") && !k.startsWith("qwen3.attention.value_length"));
    const g = parseGgufHeader(writeGguf(kvs));
    expect(g).not.toBeNull();
    expect(g!.headCountKv).toBe(16);                 
    expect(g!.keyLength).toBe(2048 / 16);            
    expect(g!.valueLength).toBe(128);
  });
});

describe("readGgufMeta：从磁盘读头部（含 fileSizeBytes）", () => {
  it("只读文件头就能拿到几何 + 文件大小", () => {
    const dir = tmp();
    const p = join(dir, "m.gguf");
    writeFileSync(p, writeGguf(QWEN3_KVS));
    const g = readGgufMeta(p);
    expect(g).not.toBeNull();
    expect(g!.blockCount).toBe(28);
    expect(g!.fileSizeBytes).toBeGreaterThan(0);
  });

  it("文件不存在 / 不是 GGUF → null（绝不抛异常）", () => {
    expect(readGgufMeta(join(tmp(), "nope.gguf"))).toBeNull();
    const dir = tmp();
    const p = join(dir, "bad.gguf");
    writeFileSync(p, Buffer.from("not a gguf at all"));
    expect(readGgufMeta(p)).toBeNull();
  });
});

describe("KV cache 显存换算：必须对得上实测表", () => {
  





  it("f16 KV @ctx=32768 ≈ 3.50 GiB（实测 3.53 GiB）", () => {
    const bytes = kvCacheBytes(QWEN3_GEOM(), 32768, "f16", "f16")!;
    expect(bytes / 1024 ** 3).toBeCloseTo(3.5, 1);
  });

  it("q8_0 KV @ctx=32768 ≈ 1.86 GiB（实测 1.98 GiB）", () => {
    const bytes = kvCacheBytes(QWEN3_GEOM(), 32768, "q8_0", "q8_0")!;
    expect(bytes / 1024 ** 3).toBeCloseTo(1.86, 1);
  });

  it("KV 正比于 ctx（ctx 减半 → KV 减半）", () => {
    const a = kvCacheBytes(QWEN3_GEOM(), 32768, "f16", "f16")!;
    const b = kvCacheBytes(QWEN3_GEOM(), 16384, "f16", "f16")!;
    expect(a / b).toBeCloseTo(2, 6);
  });

  it("KV 正比于 head_count_kv（GQA 的价值：8 KV头 = 全注意力16头的一半）", () => {
    const g8 = QWEN3_GEOM();
    const g16 = { ...g8, headCountKv: 16 };
    const a = kvCacheBytes(g8, 32768, "f16", "f16")!;
    const b = kvCacheBytes(g16, 32768, "f16", "f16")!;
    expect(b / a).toBeCloseTo(2, 6);
  });

  it("量化档位单调：f16 > q8_0 > q5_1 > q4_0", () => {
    const f = (t: string): number => kvCacheBytes(QWEN3_GEOM(), 32768, t, t)!;
    expect(f("f16")).toBeGreaterThan(f("q8_0"));
    expect(f("q8_0")).toBeGreaterThan(f("q5_1"));
    expect(f("q5_1")).toBeGreaterThan(f("q4_0"));
  });

  it("非法 KV 类型 / 非法 ctx → null（而不是算出个假数）", () => {
    expect(kvCacheBytes(QWEN3_GEOM(), 32768, "qwen", "q8_0")).toBeNull();
    expect(kvCacheBytes(QWEN3_GEOM(), 32768, "q8_0", "")).toBeNull();
    expect(kvCacheBytes(QWEN3_GEOM(), 0, "q8_0", "q8_0")).toBeNull();
    expect(kvCacheBytes(QWEN3_GEOM(), -1, "q8_0", "q8_0")).toBeNull();
  });
});

describe("estimateGpuFootprintGb：预检必须能拦住实测失败的那组配置", () => {
  const FILE_GIB = 1834426016 / 1024 ** 3; 

  it("q8_0 @32768 的估算**不小于**实测总占用（必须保守，否则预检又放行一个会 OOM 的配置）", () => {
    const gb = estimateGpuFootprintGb(QWEN3_GEOM(1834426016), 32768, "q8_0", "q8_0")!;
    const measuredTotal = (5062 - 1300) / 1024; 
    expect(gb).toBeGreaterThanOrEqual(measuredTotal);
    
    expect(gb).toBeLessThan(measuredTotal * 1.35);
  });

  it("f16 @32768 的估算**高于** q8_0（差的就是 KV 那一半，这是量化的收益来源）", () => {
    const f16 = estimateGpuFootprintGb(QWEN3_GEOM(1834426016), 32768, "f16", "f16")!;
    const q8 = estimateGpuFootprintGb(QWEN3_GEOM(1834426016), 32768, "q8_0", "q8_0")!;
    expect(f16 - q8).toBeGreaterThan(1.5); 
    expect(f16 - q8).toBeLessThan(2.5);
  });

  it("估算 = 权重 + KV×slack + 运行时开销（公式自洽）", () => {
    const g = QWEN3_GEOM(1834426016);
    const kv = kvCacheBytes(g, 32768, "q8_0", "q8_0")!;
    const expectGb = FILE_GIB + (kv * KV_PADDING_SLACK) / 1024 ** 3 + 0.2;
    expect(estimateGpuFootprintGb(g, 32768, "q8_0", "q8_0")!).toBeCloseTo(expectGb, 6);
  });

  it("KV 类型非法 → null（调用方回退到常量，绝不因此拒绝启动）", () => {
    expect(estimateGpuFootprintGb(QWEN3_GEOM(1834426016), 32768, "bogus", "bogus")).toBeNull();
  });
});

describe("buildLlamaArgv：KV 量化参数下发（本地模型能否起来的关键开关）", () => {
  const base: BackendArgs = { llamaBin: "x", modelPath: "m.gguf", port: 18082, gpuLayers: 99, ctxLen: 32768 };

  it("chat + q8_0 → 下发 -ctk/-ctv q8_0（本轮 OOM 的解药）", () => {
    const argv = buildLlamaArgv({ ...base, kvTypeK: "q8_0", kvTypeV: "q8_0" });
    expect(argv).toContain("-ctk");
    expect(argv).toContain("-ctv");
    expect(argv[argv.indexOf("-ctk") + 1]).toBe("q8_0");
    expect(argv[argv.indexOf("-ctv") + 1]).toBe("q8_0");
  });

  it("不开量化（f16/none）→ 不下发任何 -ctk/-ctv（保持 llama.cpp 默认）", () => {
    for (const v of [undefined, ""]) {
      const argv = buildLlamaArgv({ ...base, kvTypeK: v, kvTypeV: v });
      expect(argv).not.toContain("-ctk");
      expect(argv).not.toContain("-ctv");
    }
  });

  it("非法 KV 类型 → **静默不下发**，而不是把非法值传给 llama-server（否则会 exit 1 起不来）", () => {
    
    for (const bad of ["qwen", "Q8_0", "int8", "q3_k"]) {
      const argv = buildLlamaArgv({ ...base, kvTypeK: bad, kvTypeV: bad });
      expect(argv).not.toContain("-ctk");
      expect(argv).not.toContain(bad);
    }
  });

  it("K/V 类型可以不同", () => {
    const argv = buildLlamaArgv({ ...base, kvTypeK: "q8_0", kvTypeV: "q4_0" });
    expect(argv[argv.indexOf("-ctk") + 1]).toBe("q8_0");
    expect(argv[argv.indexOf("-ctv") + 1]).toBe("q4_0");
  });

  it("embedding 角色不下发 KV 参数（ctx 只有 2048，KV 可忽略，不引入新变量）", () => {
    const argv = buildLlamaArgv({ ...base, embedding: true, kvTypeK: "q8_0", kvTypeV: "q8_0" });
    expect(argv).toContain("--embedding");
    expect(argv).not.toContain("-ctk");
  });

  it("基础参数与 ctx 仍然正确下发（防止重构 argv 时把 -ngl/-c 弄丢）", () => {
    const argv = buildLlamaArgv({ ...base, kvTypeK: "q8_0", kvTypeV: "q8_0" });
    expect(argv[argv.indexOf("-m") + 1]).toBe("m.gguf");
    expect(argv[argv.indexOf("-ngl") + 1]).toBe("99");
    expect(argv[argv.indexOf("-c") + 1]).toBe("32768");
    expect(argv[argv.indexOf("--port") + 1]).toBe("18082");
    expect(argv[argv.indexOf("--reasoning-format") + 1]).toBe("deepseek");
  });
});

describe("S4-A：--alias 具名身份（身份不再依赖路径字符串）", () => {
  const base: BackendArgs = { llamaBin: "x", modelPath: "models/chat/qwen3.gguf", port: 18082, gpuLayers: 99, ctxLen: 8192 };

  it("下发 -a <id>（llama-server 收到后 /props.model_alias 与 /v1/models.data[].id 都等于它）", () => {
    const argv = buildLlamaArgv({ ...base, alias: "qwen3" });
    expect(argv[argv.indexOf("-a") + 1]).toBe("qwen3");
    
    expect(argv[argv.indexOf("-m") + 1]).toBe("models/chat/qwen3.gguf");
  });

  it("★ 逗号必须被清洗：--alias 的取值是**逗号分隔的列表**，含逗号会让 id 被拆成两个", () => {
    
    const argv = buildLlamaArgv({ ...base, alias: "qwen3,1.7b" });
    const got = argv[argv.indexOf("-a") + 1];
    expect(got).not.toContain(",");
    expect(got.split(",")).toHaveLength(1);
    expect(got).toBe("qwen3_1.7b");
  });

  it("空 / 纯空白 / 纯逗号 → **完全不下发 -a**（「没有别名」只有一种表达）", () => {
    for (const v of [undefined, "", "   ", ",", " , "]) {
      const argv = buildLlamaArgv({ ...base, alias: v });
      expect(argv, `alias=${JSON.stringify(v)} 不该下发 -a`).not.toContain("-a");
    }
  });

  it("embedding 角色同样下发别名（它的请求体本来就写 model:bge-m3，此前与端口上的身份不符）", () => {
    const argv = buildLlamaArgv({ ...base, embedding: true, alias: "bge-m3" });
    expect(argv).toContain("--embedding");
    expect(argv[argv.indexOf("-a") + 1]).toBe("bge-m3");
  });
});

describe("sanitizeAlias：别名清洗的唯一出处", () => {
  it("替换逗号、去首尾空白", () => {
    expect(sanitizeAlias("  qwen3,1.7b  ")).toBe("qwen3_1.7b");
  });

  it("无信息量（空/空白/纯逗号）→ 空串", () => {
    for (const v of [undefined, null, "", "   ", ",,,", " , , "]) {
      expect(sanitizeAlias(v)).toBe("");
    }
  });

  it("普通 id 原样保留（不许顺手做小写化/去空格等「看起来更干净」的加工 —— 那会让别名与 UI 里的 id 不一致）", () => {
    expect(sanitizeAlias("Qwen3-1.7B Q8_0")).toBe("Qwen3-1.7B Q8_0");
    expect(sanitizeAlias("本地:我的模型")).toBe("本地:我的模型");
  });
});

describe("常量自洽 / 与 llama-server 契约一致", () => {
  it("SUPPORTED_KV_TYPES 与 KV_CACHE_BYTES_PER_ELEMENT 完全对齐", () => {
    
    
    for (const t of SUPPORTED_KV_TYPES) {
      expect(typeof KV_CACHE_BYTES_PER_ELEMENT[t], `缺少 ${t} 的字节宽`).toBe("number");
      expect(KV_CACHE_BYTES_PER_ELEMENT[t]).toBeGreaterThan(0);
    }
    expect(Object.keys(KV_CACHE_BYTES_PER_ELEMENT).sort()).toEqual([...SUPPORTED_KV_TYPES].sort());
  });

  it("SUPPORTED_KV_TYPES 逐字等于 llama-server --help 的 allowed values", () => {
    
    expect(SUPPORTED_KV_TYPES).toEqual(["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"]);
  });

  it("量化确实省显存（q8_0 的每元素字节数 < f16 的一半以上）", () => {
    expect(KV_CACHE_BYTES_PER_ELEMENT["q8_0"]).toBeLessThan(KV_CACHE_BYTES_PER_ELEMENT["f16"] * 0.6);
  });
});





describe("真实模型文件交叉验证（不存在则跳过）", () => {
  const dir = resolve(process.cwd(), "models", "chat");
  const ggufs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".gguf")) : [];
  const target = ggufs.length ? join(dir, ggufs[0]) : "";

  it.skipIf(!target)("几何参数与 qwen3 家族一致，且估算保守", () => {
    const g = readGgufMeta(target);
    expect(g).not.toBeNull();
    expect(g!.architecture).toBe("qwen3");
    expect(g!.blockCount).toBe(28);
    expect(g!.headCountKv).toBe(8);
    expect(g!.keyLength).toBe(128);
    expect(g!.fileSizeBytes).toBeGreaterThan(1024 ** 3); 
    
    const gb = estimateGpuFootprintGb(g!, 32768, "q8_0", "q8_0")!;
    expect(gb).toBeGreaterThanOrEqual(3.67);
    expect(gb).toBeLessThan(5);
  });
});
