/**
 * tests/core-ts/a1023-guards.spec.ts — S2「进程与端口所有权收口」结构守卫。
 *
 * 背景（计划 S2）：本地模型运行时（llama-server）的**进程所有权**必须只存在于一层
 * （`core-ts/src/model_server.ts` 的 `ModelBackend` + `ModelServerManager`），
 * 调用方只许通过 HTTP 契约与它交互。同一件事（进程 / 端口 / PID / 注册表）有多个产地时，
 * 就会出现 A-1018 那一类错误：一边按事实走、另一边按旧副本走，且**两边都不报错**。
 *
 * 本轮实锤的缺口（§①，已修）：embedding 端口有 **4 个产地** ——
 *   `basePortFor()`（唯一来源）+ `probeLive()` 里 `(cfg.port) ?? 8999`
 *   + `status()` 里 `(this.embedCfg.port) ?? 8999` + **`gui/src/main/index.ts` 的 `bgeEmbed`
 *   直接 fetch `http://127.0.0.1:8999`（跨层硬编码）**。
 *   后果：用户一旦在 `slime.toml [model_server.embedding].port` 改端口，管理器在新端口起服务，
 *   而 `bgeEmbed` 仍问旧端口 → 嵌入永远失败 → `MemoryStore` **静默降级成哈希**
 *   （用户无感，只是记忆检索质量悄悄变差）。原先"恰好一致"只是因为配置从没改过。
 *
 * ⚠️ 本守卫的验收标准是**变异测试**（见 gui/scripts/mut-a1023-ports.mjs）：
 *    写完必须逐条把源码改坏、确认它变红。守卫只是"声明了意图"，变异才证明它**真的**在拦。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const MODEL_SERVER = join(ROOT, "core-ts/src/model_server.ts");
const MAIN_DIR = join(ROOT, "gui/src/main");

const read = (p: string): string => readFileSync(p, "utf8");

/** 去注释：守卫必须盯**代码**。对注释敏感会把"写了解释"误判成"改了行为"，
 *  更糟的是会诱导后来者删注释而不是改代码。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 递归收集目录下的 .ts 源码（守卫只扫生产代码，不含 tests 自身）。 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { out.push(...tsFiles(full)); }
    else if (e.name.endsWith(".ts")) { out.push(full); }
  }
  return out;
}

/** 取出具名顶层函数的函数体（大括号配对，不用贪婪正则 —— 贪婪会吃掉文件后半）。
 *
 *  ⚠️ 起点取**签名行的最后一个 `{`**，不能取 `indexOf("{", at)`：
 *  `function bgeEmbed(): { embed: … } {` 的**返回类型里也有花括号**，直接找第一个 `{`
 *  会拿到类型注解、切出一个空壳（守卫就"绿着但锁错对象"）。多行签名时回退到签名行之后第一个 `{`。 */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `找不到 function ${name}`).toBeGreaterThan(-1);
  const lineEnd = src.indexOf("\n", at);
  const sigLine = src.slice(at, lineEnd === -1 ? src.length : lineEnd);
  const inLine = sigLine.lastIndexOf("{");
  const open = inLine >= 0 ? at + inLine : src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") { depth += 1; }
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) { return src.slice(open, i + 1); }
    }
  }
  throw new Error(`function ${name} 大括号不配对`);
}

const MAIN_CODE = stripComments(read(MAIN_INDEX));
const MS_CODE = stripComments(read(MODEL_SERVER));

/* ── ① 端口：字面量只许出现在 basePortFor 里 ───────────────────────── */

describe("A-1023 ①：端口字面量只有一个产地（basePortFor）", () => {
  it("gui/src/main/** 的代码里不得出现 8999 / 18082（跨层硬编码 = 绕过唯一来源）", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(MAIN_DIR)) {
      const code = stripComments(read(f));
      // 剥掉 URL 里的端口是**字面量**用法：`127.0.0.1:8999`
      if (/\b8999\b/.test(code)) { offenders.push(`${f}: 8999`); }
      if (/\b18082\b/.test(code)) { offenders.push(`${f}: 18082`); }
    }
    expect(offenders, `嵌入/对话端口必须在 model_server 的 basePortFor 里推导，不许在 GUI 层写死：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("model_server.ts 的 8999 / 18082 只许出现在 basePortFor 函数体内", () => {
    const body = fnBody(MS_CODE, "basePortFor");
    const outside = MS_CODE.replace(body, "");
    expect(outside).not.toMatch(/\b8999\b/);
    expect(outside).not.toMatch(/\b18082\b/);
    // 而函数体里必须**真的**有这两个默认值（否则守卫会因为"函数被掏空"而变绿）
    expect(body).toMatch(/\b8999\b/);
    expect(body).toMatch(/\b18082\b/);
  });

  it("basePortFor 的四个调用点齐全（缺哪个，哪个分支就又开始自己推端口）", () => {
    // ⚠️ 不能只数 `match(/basePortFor\(/g)` 的个数 —— **函数定义本身**也会被计入，
    //    删掉一个调用点后计数仍然达标（守卫假绿）。逐个钉死，才真的锁住每一个分支。
    expect(MS_CODE).toContain("const basePort = basePortFor(role, cfg, this.chatCfg);");   // ensure()：启动基址
    expect(MS_CODE).toContain('const port = basePortFor("embedding", cfg, this.chatCfg);'); // probeLive embedding
    expect(MS_CODE).toContain("const portStart = basePortFor(role, cfg, this.chatCfg);");   // probeLive chat 扫描起点
    expect(MS_CODE).toContain('port: basePortFor("embedding", this.embedCfg, this.chatCfg),'); // status() 展示值
    expect(MAIN_CODE).toContain('basePortFor("embedding"');                                 // GUI 嵌入端点
  });

  it("bgeEmbed 的端点由 embeddingBaseUrl() 决定，不许再字面量拼 URL", () => {
    const body = fnBody(MAIN_CODE, "embeddingBaseUrl");
    expect(body).toContain("getPort(\"embedding\")");
    expect(body).toContain("basePortFor(\"embedding\"");
    // bgeEmbed 里必须是模板串调用，而不是 `http://127.0.0.1:数字`
    const embed = fnBody(MAIN_CODE, "bgeEmbed");
    expect(embed).toContain("${embeddingBaseUrl()}");
    expect(embed).not.toMatch(/127\.0\.0\.1:\d+/);
  });
});

/* ── ② 进程：llama-server 只许由 model_server.ts 拉起 ───────────────── */

describe("A-1023 ②：llama-server 进程只许由运行时那一层创建/终止", () => {
  it("GUI 主进程不得 spawn llama-server（否则启动/回收逻辑出现第二个产地）", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(MAIN_DIR)) {
      const code = stripComments(read(f));
      if (/spawn\([^)]*llama/i.test(code)) { offenders.push(f); }
    }
    expect(offenders, `llama-server 的 spawn 必须收口在 model_server.ts：${offenders.join(", ")}`).toEqual([]);
  });

  it("model_server.ts 是唯一的 llama-server spawn 点", () => {
    const spawns = MS_CODE.match(/spawn\(this\.llamaBin/g) ?? [];
    expect(spawns.length).toBe(1);
  });

  it("GUI 主进程不得 taskkill（进程树回收属于运行时的内部事务）", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(MAIN_DIR)) {
      const code = stripComments(read(f));
      if (/taskkill/.test(code)) { offenders.push(f); }
    }
    expect(offenders, `taskkill 必须收口在 model_server.ts：${offenders.join(", ")}`).toEqual([]);
  });
});

/* ── ③ PID：只许有一个私有字段承载 ─────────────────────────────────── */

describe("A-1023 ③：PID 由私有字段承载，对外只经 getter", () => {
  it("pidVal 是 private，且外部写入点唯一（start 里那一次赋值）", () => {
    expect(MS_CODE).toContain("private pidVal");
    const assigns = MS_CODE.match(/this\.pidVal\s*=/g) ?? [];
    // 一处来自 child.pid 赋值，其余是清理（置 null）；关键是**没有** `pidVal = <外部来源>`
    expect(assigns.length).toBeGreaterThanOrEqual(1);
    expect(MS_CODE).toMatch(/private pidVal: number \| null = null/);
  });

  it("GUI 主进程不得自行记录/推导 llama-server 的 PID", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(MAIN_DIR)) {
      const code = stripComments(read(f));
      // pidForPort 是"从端口反查 PID"的旁路 —— 只许运行时内部用
      if (/pidForPort/.test(code)) { offenders.push(f); }
    }
    expect(offenders, `PID 反查必须收口在 model_server.ts：${offenders.join(", ")}`).toEqual([]);
  });
});

/* ── ④ 注册表：读写实现只在 model_server.ts ─────────────────────────── */

describe("A-1023 ④：实例注册表（data/model_servers.json）读写实现唯一", () => {
  it("GUI 主进程不得直接碰注册表文件（必须经 ModelServerManager.readRegistry()）", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(MAIN_DIR)) {
      const code = stripComments(read(f));
      if (/model_servers\.json/.test(code)) { offenders.push(f); }
    }
    expect(offenders, `注册表路径只许在 model_server.ts 里解析：${offenders.join(", ")}`).toEqual([]);
  });

  it("注册表路径只解析一次（两份路径可以各自漂移）", () => {
    // ⚠️ 不能断言 `DEFAULT_REGISTRY_PATH = resolve(` 出现 1 次 —— 再加一个别名常量时它仍是 1 次，
    //    守卫会假绿。要盯的是**路径字面量本身**只出现一次（注释已 strip，剩下的就是代码）。
    const hits = MS_CODE.match(/model_servers\.json/g) ?? [];
    expect(hits.length, `注册表路径字面量出现 ${hits.length} 次，应只有 1 次`).toBe(1);
    expect(MS_CODE).toContain("static readRegistry(");
  });

  it("GUI 侧读注册表走的是静态方法（不是自己 readFileSync）", () => {
    const probe = stripComments(read(join(MAIN_DIR, "localServerProbe.ts")));
    expect(probe).toContain("ModelServerManager.readRegistry()");
  });
});

/* ── ⑤ 守卫自身：这些文件真的存在（防"路径写错所以扫了个空气"） ────── */

describe("A-1023 ⑤：守卫扫的是真文件", () => {
  it("关键文件都在，且 basePortFor 已导出（跨层复用前提）", () => {
    for (const p of [MAIN_INDEX, MODEL_SERVER, join(MAIN_DIR, "localServerProbe.ts")]) {
      expect(existsSync(p), `缺文件 ${p}`).toBe(true);
    }
    expect(MS_CODE).toContain("export function basePortFor(");
  });

  it("扫到的生产文件数是个合理数量（太少=扫错目录，守卫会假绿）", () => {
    const n = tsFiles(MAIN_DIR).length;
    expect(n).toBeGreaterThan(10);
  });
});
