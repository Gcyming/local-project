/**
 * tests/core-ts/a1022-guards.spec.ts — S1「能力问询替换推断」结构守卫。
 *
 * 背景（A-1018 ③ / 计划 S1）：上下文窗口上限此前靠一条 6 级级联**推断**，
 * 最后回落到 `shared/model-capabilities` 的家族能力表（qwen3 = 524K 训练窗口），
 * 而 llama-server 实际只按 `-c 8192` 分配 KV → 界面显示"还剩 480K"、请求被上游 400 顶回。
 *
 * 本文件钉住四件事（都是**结构性**的，改坏了必须红）：
 *  ① 决策**唯一**：上限由 `resolveWindowCap` 定，家族能力表不得参与
 *  ② 顺序**正确**：先问服务器，再回落同域兜底；**不许**在问服务器之前提前 return 配置值
 *  ③ 身份**校验**：托管实例一次只服务一个模型，取它的窗口前必须确认服务的就是这个模型
 *  ④ 分层**干净**：纯逻辑（core-ts）不得引入 IO；IO 层不得引入 Electron/UI
 *
 * ⚠️ 本守卫的验收标准是**变异测试**（见 gui/scripts/mut-a1022-capability.mjs）：
 *    守卫写完后必须逐条把源码改坏、确认它变红，否则它会"通过但锁错对象"。
 *    A-1019 的实锤：`.app \{` 正则命中了文件开头的 `body, #root, .app {` 块；
 *    `src.indexOf(ln)` 定位到同名行的第一处 —— 两条都是"绿着但没用"。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const PROBE_SRC = join(ROOT, "gui/src/main/localServerProbe.ts");
const INTROSPECT = join(ROOT, "core-ts/src/model_introspect.ts");
const FIXTURES = join(ROOT, "tests/fixtures/llama");
const SPEC = join(ROOT, "tests/core-ts/model-introspect.spec.ts");

const read = (p: string): string => readFileSync(p, "utf8");

/** 去注释：守卫必须盯**代码**。对注释敏感会把"写了解释"误判成"改了行为"，
 *  更糟的是会诱导后来者删注释而不是改代码。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 取出 `resolveSessionWindowCap` 的函数体（用大括号配对，不用正则贪婪 —— 贪婪会吃掉文件后半）。 */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `找不到 function ${name}`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") { depth += 1; }
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) { return src.slice(open, i + 1); }
    }
  }
  throw new Error(`function ${name} 的大括号不配对`);
}

const MAIN_CODE = stripComments(read(MAIN_INDEX));
const WINDOW_CAP = fnBody(MAIN_CODE, "resolveSessionWindowCap");

// ── ① 决策唯一：家族能力表不得参与 ───────────────────────────

describe("① 上限决策唯一：家族能力表退出链路", () => {
  it("resolveSessionWindowCap 内不得出现家族能力表标识", () => {
    for (const banned of ["inferModelCapabilities", "MODEL_CAPABILITIES", "model-capabilities"]) {
      expect(WINDOW_CAP, `上限决策里出现了 ${banned}`).not.toContain(banned);
    }
  });

  it("上限必须由 resolveWindowCap（唯一决策函数）定，而不是就地 return 某个候选", () => {
    expect(WINDOW_CAP).toContain("resolveWindowCap(");
    // 决策函数必须来自 model_introspect（纯逻辑层），不许在 main 里就地重写一份优先级
    expect(MAIN_CODE).toMatch(/import\s*\{[^}]*resolveWindowCap[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/core-ts\/src\/model_introspect\.js"/);
  });

  it("★ 不许在「问服务器」之前提前 return 配置值（这就是原来的级联病灶）", () => {
    const askAt = WINDOW_CAP.indexOf("probeManagedChatCapability(");
    expect(askAt, "必须调用 probeManagedChatCapability").toBeGreaterThan(-1);
    const beforeAsking = WINDOW_CAP.slice(0, askAt);
    // 探测之前只允许两种提前返回：agent.max_context（显式覆盖）、undefined（"没有模型"的守门）
    const earlyReturns = [...beforeAsking.matchAll(/return\s+([^;]+);/g)].map((m) => m[1].trim());
    for (const r of earlyReturns) {
      const ok = r.includes("agent.max_context") || r === "undefined";
      expect(ok, `探测前的提前 return 只许是显式覆盖或无值，实际是「${r}」`).toBe(true);
    }
    // 具体旧病灶：`if (local?.ctx_len > 0) { return local.ctx_len; }` / `if (chatCtx > 0) { return chatCtx; }`
    expect(beforeAsking).not.toMatch(/return\s+local\??\.ctx_len/);
    expect(beforeAsking).not.toMatch(/return\s+chatCtx/);
  });

  it("★ 同域兜底的取值顺序：模型条目 ctx_len 优先于 slime.toml（与 ModelServerManager.ensure 一致）", () => {
    // ensure() 里是 `opts.ctxLen ?? cfg.ctx_len`，所以结算口径必须同序
    const planned = WINDOW_CAP.match(/plannedCtx\s*=\s*([\s\S]*?);/);
    expect(planned, "必须有 plannedCtx 的赋值").not.toBeNull();
    const expr = planned![1];
    expect(expr).toContain("localSpec?.ctx_len");
    expect(expr).toContain("chatCfgCtx");
    expect(expr.indexOf("localSpec?.ctx_len"), "模型条目 ctx_len 必须在 chat.ctx_len 之前").toBeLessThan(expr.indexOf("chatCfgCtx"));
  });

  it("★ 数量守恒：`[model_server.chat].ctx_len` 在 gui/src/main 下恰好 1 个读取点", () => {
    // 两个读取点 = 两条可以各自漂移的口径；这正是"混乱"的度量单位（见计划 S3 的同款判据）
    const dir = join(ROOT, "gui/src/main");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    let hits = 0;
    for (const f of files) {
      const code = stripComments(read(join(dir, f)));
      hits += [...code.matchAll(/readModelServerConfig\(\)\s*\??\.\s*chat/g)].length;
    }
    expect(hits).toBe(1);
  });
});

// ── ② 先问服务器 ────────────────────────────────────────────

describe("② 先问服务器（两类本地模型都要覆盖）", () => {
  it("托管实例（local:<id>）走 probeManagedChatCapability", () => {
    expect(WINDOW_CAP).toContain("probeManagedChatCapability(");
  });

  it("★ 指向本机的普通 provider 也要问（用户自己拉起的 llama-server 不在我们的启动记录里）", () => {
    // 实测场景：provider api_base = http://127.0.0.1:8800/v1，data/model_servers.json 里没有它
    expect(WINDOW_CAP).toContain("isLoopbackBaseUrl(");
    expect(WINDOW_CAP).toContain("getLocalCapability(");
    const loop = WINDOW_CAP.slice(WINDOW_CAP.indexOf("isLoopbackBaseUrl("));
    expect(loop).toContain("getLocalCapability(");
  });

  it("远端 provider 规格是最后一档（在本地探测之后）", () => {
    expect(WINDOW_CAP.indexOf("probeManagedChatCapability("))
      .toBeLessThan(WINDOW_CAP.indexOf("providerSpecCtx"));
  });

  it("两个探测都带 catch → 问服务器失败不得让 done 载荷构造抛异常", () => {
    // 抛出去会让整轮对话的 done 事件发不出去，比"上限算错"严重得多
    expect(WINDOW_CAP).toMatch(/probeManagedChatCapability\([^)]*\)\s*\.catch\(/);
    expect(WINDOW_CAP).toMatch(/getLocalCapability\([^)]*\)\s*\.catch\(/);
  });
});

// ── ③ 身份校验 ──────────────────────────────────────────────

describe("③ 取窗口前必须确认服务的就是这个模型", () => {
  it("托管实例的探测结果要过 capabilityMatchesModel（带 path/ids）", () => {
    const seg = WINDOW_CAP.slice(WINDOW_CAP.indexOf("probeManagedChatCapability("));
    const guard = seg.slice(0, seg.indexOf("serverCtx = cap.effectiveCtx"));
    expect(guard).toContain("capabilityMatchesModel(");
    expect(guard).toMatch(/path:\s*localSpec\?\.path/);
    expect(guard).toMatch(/ids:\s*candidates/);
  });

  it("loopback provider 用 trustedEndpoint（provider 配置本身即身份证据）", () => {
    expect(WINDOW_CAP).toMatch(/capabilityMatchesModel\(cap,\s*\{\s*trustedEndpoint:\s*true\s*\}\)/);
  });

  it("★ 探针模块必须实现身份匹配（不只是调用一下）", () => {
    const code = stripComments(read(PROBE_SRC));
    expect(code).toContain("export function capabilityMatchesModel");
    // Windows 路径归一（裸字符串比较是这个仓库已删代码的旧病：isChatReady）
    expect(code).toContain("export function normalizeModelPath");
    expect(code).toContain('replace(/\\\\/g, "/")');
    /* ⚠️ 这里刻意**不**断言"问不出身份 → return false"的源码文本：
       文本断言太容易变成"锁注释"而不是"锁行为"。那条语义由行为测试兜底 ——
       `local-server-probe.spec.ts` 的「问不出身份 → 判否」会在实现被改成默认放行时直接红。 */
  });

  it("托管端口来源含**跨进程 registry** 兜底（开发模式下内存里没有实例记录）", () => {
    expect(stripComments(read(PROBE_SRC))).toContain("ModelServerManager.readRegistry()");
  });
});

// ── ④ 分层 ──────────────────────────────────────────────────

describe("④ 分层：纯逻辑不碰 IO，IO 不碰 UI", () => {
  it("core-ts/src/model_introspect.ts 是纯函数模块（无 fs/fetch/electron/process）", () => {
    const code = stripComments(read(INTROSPECT));
    for (const banned of ["node:fs", "node:child_process", "node:http", "from \"electron\"", "globalThis.fetch", "AbortSignal", "process.env"]) {
      expect(code, `纯逻辑层出现了 ${banned}`).not.toContain(banned);
    }
    // 「纯逻辑层」的判据：一个 import 都没有（它连 core-ts 内部的兄弟模块都不依赖）
    expect(code).not.toMatch(/^\s*import\s/m);
  });

  it("IO 层不引 React/DOM（它跑在主进程）", () => {
    const code = stripComments(read(PROBE_SRC));
    for (const banned of ["react", "document.", "window.", ".tsx"]) {
      expect(code.toLowerCase()).not.toContain(banned);
    }
  });

  it("本地服务状态有**读取者**（项目铁律：开关必须有读取者）", () => {
    // 就绪却解析不出 n_ctx 是回归信号；没有读取者它就被静默吞掉
    expect(MAIN_CODE).toContain("logLocalCapGap(");
    expect(MAIN_CODE).toContain("function logLocalCapGap");
  });
});

// ── ⑤ 夹具 ──────────────────────────────────────────────────

describe("⑤ 真实夹具齐备且被 spec 真的用上", () => {
  it("六个端点响应 + 六个状态码文件都在", () => {
    for (const n of ["props.ready", "models.ready", "health.ready", "props.loading", "models.loading", "health.loading"]) {
      expect(existsSync(join(FIXTURES, `${n}.json`)), `缺夹具 ${n}.json`).toBe(true);
      expect(existsSync(join(FIXTURES, `${n}.status`)), `缺状态码 ${n}.status`).toBe(true);
    }
  });

  it("就绪/加载两态的状态码分别是 200 / 503（夹具没被手改坏）", () => {
    for (const n of ["props.ready", "models.ready", "health.ready"]) {
      expect(read(join(FIXTURES, `${n}.status`)).trim()).toBe("200");
    }
    for (const n of ["props.loading", "models.loading", "health.loading"]) {
      expect(read(join(FIXTURES, `${n}.status`)).trim()).toBe("503");
    }
  });

  it("加载态夹具就是那个 unavailable_error 信封（三个端点同体）", () => {
    const body = JSON.parse(read(join(FIXTURES, "props.loading.json"))) as { error?: { type?: string; code?: number; message?: string } };
    expect(body.error?.type).toBe("unavailable_error");
    expect(body.error?.code).toBe(503);
    expect(body.error?.message).toBe("Loading model");
    expect(JSON.parse(read(join(FIXTURES, "health.loading.json")))).toEqual(body);
    expect(JSON.parse(read(join(FIXTURES, "models.loading.json")))).toEqual(body);
  });

  it("★ spec 真的引用了这些夹具（而不是自己内联一份假的）", () => {
    const spec = read(SPEC);
    expect(spec).toContain("fixtures/llama");
    for (const n of ["props.ready", "models.ready", "props.loading", "models.loading", "health.loading"]) {
      expect(spec, `spec 没用到 ${n}`).toContain(`fixture("${n}")`);
    }
  });

  it("抓取脚本存在（夹具可以被任何人从真实服务重新生成）", () => {
    expect(existsSync(join(ROOT, "gui/scripts/capture-llama-fixtures.sh"))).toBe(true);
  });
});
