/**
 * tests/core-ts/a1024-guards.spec.ts — 计划 S3「模型配置与清单单一化」结构守卫。
 *
 * 背景：同一个约定散落成多份副本，**且没有一方会抱怨**。本轮盘点到的三处：
 *
 *  ① **模板与实况配置漂移**（gui/template/slime.toml vs 根 slime.toml）
 *     模板 `ctx_len = 8192`（旧值）且**缺 `kv_type`**，而实况已是 32768 + q8_0。
 *     → 新装用户默认踩 A-1018（8192 装不下 13811 tokens 的对话，被上游 400 顶回）；
 *       而只把 ctx_len 提到 32768 却不给 kv_type，就会复现 A-1021 的
 *       `failed to allocate buffer for kv cache`（f16 KV 在 8GB 卡上差 22MiB）。
 *     **这两项必须成对**，所以守卫盯的是"成对关系"而不是各自的绝对值
 *     （绝对值由用户决定：他把 ctx 调到 16384 是合法的，不该假红）。
 *
 *  ② **清单键名与条目形状有四个产地**（core-ts engine / gui providers / shared ipc /
 *     gateway-ts llmGateway），实测**已经漂移**：engine 那份 interface 缺 `vision`，
 *     providers 那份把 `label` 写成必填（而磁盘上的历史条目可能没有 label），
 *     gateway-ts 那份干脆重写了字符串字面量。
 *     键名改名时这几处会静默失效 → "UI 里明明有这个模型，一发消息报『未注册』"
 *     或"清单被当成真供应商去建路由"。现在四处一律 import `LOCAL_MODELS_KEY`。
 *
 *  ③ **配置文件副本**：全盘 8 份 slime.toml，其中 6 份是构建/解包残渣
 *     （`gui/dist-v9/win-unpacked`、`gui/release-final/win-unpacked`、
 *      `scripts/extracted-{app,latest,v2,v3}/template`）。
 *     它们体积巨大且会被误读成"发行版配置"，所以守卫要求：**被 git 跟踪的 slime.toml
 *     只许 1 份**（模板）。残渣留在磁盘上不报错，一旦有人把它 `git add` 就红。
 *
 * ⚠️ 本守卫的验收标准是**变异测试**（见 gui/scripts/mut-a1024-config.mjs）：
 *    写完必须逐条把源码改坏、确认它变红。A-1022 的实锤：断言串若在注释里也出现，
 *    改坏代码后守卫**依然全绿** —— "通过但锁错对象"比没有守卫更糟。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = join(ROOT, "gui/template/slime.toml");
const LIVE = join(ROOT, "slime.toml");
const LOCAL_MODELS = join(ROOT, "core-ts/src/local_models.ts");
const ENGINE = join(ROOT, "core-ts/src/services/engine.ts");
const PROVIDERS = join(ROOT, "gui/src/main/providers.ts");
const IPC = join(ROOT, "gui/src/shared/ipc.ts");
const GATEWAY = join(ROOT, "gateway-ts/src/llmGateway.ts");

/** 读文本并统一换行 —— 本仓库检出是 CRLF，`\n` 字面量断言会全线假红。 */
const read = (p: string): string => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** 去注释：守卫必须盯**代码**。对注释敏感会把"写了解释"误判成"改了行为"。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 极简 TOML 键扫描：只取 `[section].key` 的键名与原始字面量（不做类型转换）。
 * 够用且可验证 —— 守卫只需要"哪些键存在、原始值长什么样"。
 */
function tomlKeys(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) { continue; }
    if (line.startsWith("[[") && line.endsWith("]]")) {
      section = `${line.slice(2, -2).trim()}[]`;   // 数组表：只记段名，不取下标
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) { continue; }
    const key = line.slice(0, eq).trim();
    if (!key) { continue; }
    out.set(section ? `${section}.${key}` : key, line.slice(eq + 1).trim());
  }
  return out;
}

/** 取 TS interface 的字段（名 + 是否可选），用于跨文件比对形状。 */
function interfaceFields(src: string, name: string): Array<{ field: string; optional: boolean }> {
  const re = new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(src);
  expect(m, `找不到 interface ${name}`).not.toBeNull();
  const out: Array<{ field: string; optional: boolean }> = [];
  for (const line of m![1].split("\n")) {
    const f = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\??)\s*:/.exec(line);
    if (f) { out.push({ field: f[1], optional: f[2] === "?" }); }
  }
  return out;
}

/* ── ① 模板与实况：键集合一致 + ctx/kv 成对 ─────────────────────────── */

/** 引导期由 boot.ts 填充的路径键：模板里**必须为空**，实况里是绝对路径 —— 差异是设计如此。 */
const BOOTSTRAP_PATH_KEYS = ["model_server.llama_bin", "model_server.embedding.model_path", "model_server.chat.models_dir"];

describe("A-1024 ①：模板与实况的 [model_server] 配置不许漂移", () => {
  const tpl = tomlKeys(read(TEMPLATE));
  const live = tomlKeys(read(LIVE));

  it("模板不得缺 [model_server] 段里的任何键（新装用户拿不到就白改了）", () => {
    const missing = [...live.keys()]
      .filter((k) => k.startsWith("model_server.") && !k.endsWith("[]"))
      .filter((k) => !tpl.has(k));
    expect(missing, `模板缺这些键（新增配置项时必须同步到 gui/template/slime.toml）：\n${missing.join("\n")}`).toEqual([]);
  });

  it("路径键在模板里必须为空（不许把开发机路径写进发行模板）", () => {
    for (const k of BOOTSTRAP_PATH_KEYS) {
      expect(tpl.get(k), `${k} 在模板里必须是空串`).toBe('""');
    }
  });

  it("模板不含任何绝对路径（防开发机路径泄漏进发行包）", () => {
    for (const [k, v] of tpl) {
      expect(v, `${k} 的值看起来是绝对路径：${v}`).not.toMatch(/[A-Za-z]:\\\\|\/home\/|\/Users\//);
    }
  });

  it("★ ctx_len 必须够大：8192 装不下实测的 13811 tokens（A-1018 的 400 就出在这）", () => {
    const raw = tpl.get("model_server.chat.ctx_len");
    expect(raw, "模板必须显式给出 chat.ctx_len").toBeDefined();
    expect(Number(raw)).toBeGreaterThanOrEqual(16384);
  });

  it("★ ctx 与 KV 量化必须成对：大 ctx + f16 KV 会在 8GB 卡上 OOM（A-1021）", () => {
    const ctx = Number(tpl.get("model_server.chat.ctx_len"));
    const kv = (tpl.get("model_server.chat.kv_type") ?? '""').replace(/"/g, "");
    expect(kv, "模板必须显式给出 chat.kv_type（缺省虽也是 q8_0，但少了发现性）").not.toBe("");
    expect(["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1", "none"])
      .toContain(kv);
    // ctx ≥ 32768 时 KV 已达 3.5GB(f16) —— 必须量化，否则权重+KV 撑爆 8GB 显存
    if (ctx >= 32768) {
      expect(["f16", "none"], `ctx=${ctx} 配 kv_type=${kv} 会在 8GB 卡上 failed to allocate buffer for kv cache`).not.toContain(kv);
    }
  });

  it("实况配置自身也必须满足同一个成对关系（不能只守模板）", () => {
    const ctx = Number(live.get("model_server.chat.ctx_len") ?? 0);
    const kv = (live.get("model_server.chat.kv_type") ?? "").replace(/"/g, "");
    expect(ctx).toBeGreaterThanOrEqual(16384);
    if (ctx >= 32768) {
      expect(["f16", "none"], `实况 ctx=${ctx} 配 kv_type=${kv || "(缺省 q8_0)"} 会 OOM`).not.toContain(kv || "q8_0");
    }
  });
});

/* ── ② 清单：键名与条目形状只有一个来源 ─────────────────────────────── */

describe("A-1024 ②：本地模型清单的键名与形状只有一个来源", () => {
  it("字符串字面量 \"_local_models\" 在**所有**生产层里只许出现 1 次（常量定义处）", () => {
    // ⚠️ 扫描集必须覆盖**每一个**跨层消费者，否则断言串在说谎：
    //    初版只扫了 core-ts + gui 四处，漏掉 gateway-ts/src/llmGateway.ts 里
    //    `k !== "_local_models"` 这个第 2 产地 —— 断言写"只许 1 次"却扫不到它，
    //    属于"A-1019 式通过但锁错对象"。网关是独立进程，漏掉它 = 改键名时
    //    清单被当成真供应商去建路由（静默）。
    const files = [ENGINE, PROVIDERS, LOCAL_MODELS, IPC, GATEWAY, join(ROOT, "gui/src/main/index.ts")];
    // ⚠️ 取 basename 必须同时认 `/` 与 `\` —— fileURLToPath 在 Windows 返回反斜杠路径，
    //    只写 lastIndexOf("/") 会得到 -1，切片后变成整条绝对路径（断言随之假红）。
    const base = (p: string): string => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
    const hits: Array<{ file: string; count: number }> = [];
    for (const f of files) {
      const code = stripComments(read(f));
      const n = (code.match(/"_local_models"/g) ?? []).length;
      if (n > 0) { hits.push({ file: base(f), count: n }); }
    }
    expect(hits, `键名必须是唯一产地 core-ts/src/local_models.ts 的 LOCAL_MODELS_KEY，实际命中：${JSON.stringify(hits)}（每一层都必须 import，不许就地重写字符串）`)
      .toEqual([{ file: "local_models.ts", count: 1 }]);
  });

  it("★ 网关侧必须 import 常量而不是重写字符串（独立进程也要认同一个来源）", () => {
    const gw = stripComments(read(GATEWAY));
    expect(gw).toContain('from "../../core-ts/src/local_models.js"');
    expect(gw, "网关不许再硬编码清单键名").not.toMatch(/"_local_models"/);
  });

  it("engine / providers 不再自定义 LocalModelSpec（只许是导入）", () => {
    const eng = stripComments(read(ENGINE));
    const prov = stripComments(read(PROVIDERS));
    expect(eng, "engine.ts 不许再写 interface LocalModelSpec").not.toMatch(/interface\s+LocalModelSpec/);
    expect(prov, "providers.ts 不许再写 interface LocalModelSpec").not.toMatch(/interface\s+LocalModelSpec/);
    expect(eng).toContain('from "../local_models.js"');
    expect(prov).toContain('from "../../../core-ts/src/local_models.js"');
  });

  it("键名常量只在 local_models.ts 里定义，且被 engine/providers 引用", () => {
    const lm = stripComments(read(LOCAL_MODELS));
    expect(lm).toContain('export const LOCAL_MODELS_KEY = "_local_models";');
    expect(lm).toContain("export interface LocalModelSpec {");
    expect(stripComments(read(PROVIDERS))).not.toMatch(/const\s+LOCAL_MODELS_KEY/);
  });

  it("★ shared/ipc.ts 的类型投影必须与唯一来源逐字段一致（含可选性）", () => {
    const canonical = interfaceFields(read(LOCAL_MODELS), "LocalModelSpec");
    const projection = interfaceFields(read(IPC), "LocalModelSpec");
    expect(canonical.length).toBeGreaterThan(0);
    expect(projection, "ipc.ts 的 LocalModelSpec 字段集合与 core-ts 不一致（含可选性）")
      .toEqual(canonical);
  });

  it("清单解析的唯一实现在 local_models.ts（engine 不许再自己摸私有键）", () => {
    const lm = stripComments(read(LOCAL_MODELS));
    expect(lm).toContain("export function findLocalModelSpec(");
    expect(lm).toContain("export function localModelSpecs(");
    const eng = stripComments(read(ENGINE));
    expect(eng).toContain("findLocalModelSpec(");
    expect(eng, "engine 不许再直接下标取清单").not.toMatch(/\[LOCAL_MODELS_KEY\]/);
  });
});

/* ── ③ 配置文件副本：跟踪的只许 1 份 ───────────────────────────────── */

describe("A-1024 ③：被跟踪的 slime.toml 只许 1 份（模板）", () => {
  it("git 跟踪的 slime.toml 恰好 1 份，且必须是 gui/template/", () => {
    let tracked: string[] = [];
    try {
      const out = execFileSync("git", ["ls-files", "--", "*slime.toml"], { cwd: ROOT, encoding: "utf8" });
      tracked = out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      // git 不可用（如从 tarball 跑测试）→ 跳过而非假红
      return;
    }
    expect(tracked, `被跟踪的 slime.toml 只许 gui/template/slime.toml（其余是构建/解包残渣，会在排查时被误读成发行版配置）`).toEqual(["gui/template/slime.toml"]);
  });

  it("模板文件真的存在（防路径写错导致上一条扫了个空气）", () => {
    expect(existsSync(TEMPLATE)).toBe(true);
    expect(existsSync(LIVE)).toBe(true);
  });
});
