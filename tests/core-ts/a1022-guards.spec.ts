

















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



function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}


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



describe("① 上限决策唯一：家族能力表退出链路", () => {
  it("resolveSessionWindowCap 内不得出现家族能力表标识", () => {
    for (const banned of ["inferModelCapabilities", "MODEL_CAPABILITIES", "model-capabilities"]) {
      expect(WINDOW_CAP, `上限决策里出现了 ${banned}`).not.toContain(banned);
    }
  });

  it("上限必须由 resolveWindowCap（唯一决策函数）定，而不是就地 return 某个候选", () => {
    expect(WINDOW_CAP).toContain("resolveWindowCap(");
    
    expect(MAIN_CODE).toMatch(/import\s*\{[^}]*resolveWindowCap[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/core-ts\/src\/model_introspect\.js"/);
  });

  it("★ 不许在「问服务器」之前提前 return 配置值（这就是原来的级联病灶）", () => {
    const askAt = WINDOW_CAP.indexOf("probeManagedChatCapability(");
    expect(askAt, "必须调用 probeManagedChatCapability").toBeGreaterThan(-1);
    const beforeAsking = WINDOW_CAP.slice(0, askAt);
    
    const earlyReturns = [...beforeAsking.matchAll(/return\s+([^;]+);/g)].map((m) => m[1].trim());
    for (const r of earlyReturns) {
      const ok = r.includes("agent.max_context") || r === "undefined";
      expect(ok, `探测前的提前 return 只许是显式覆盖或无值，实际是「${r}」`).toBe(true);
    }
    
    expect(beforeAsking).not.toMatch(/return\s+local\??\.ctx_len/);
    expect(beforeAsking).not.toMatch(/return\s+chatCtx/);
  });

  it("★ 同域兜底的取值顺序：模型条目 ctx_len 优先于 slime.toml（与 ModelServerManager.ensure 一致）", () => {
    
    const planned = WINDOW_CAP.match(/plannedCtx\s*=\s*([\s\S]*?);/);
    expect(planned, "必须有 plannedCtx 的赋值").not.toBeNull();
    const expr = planned![1];
    expect(expr).toContain("localSpec?.ctx_len");
    expect(expr).toContain("chatCfgCtx");
    expect(expr.indexOf("localSpec?.ctx_len"), "模型条目 ctx_len 必须在 chat.ctx_len 之前").toBeLessThan(expr.indexOf("chatCfgCtx"));
  });

  it("★ 数量守恒：`[model_server.chat].ctx_len` 在 gui/src/main 下恰好 1 个读取点", () => {
    
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



describe("② 先问服务器（两类本地模型都要覆盖）", () => {
  it("托管实例（local:<id>）走 probeManagedChatCapability", () => {
    expect(WINDOW_CAP).toContain("probeManagedChatCapability(");
  });

  it("★ 指向本机的普通 provider 也要问（用户自己拉起的 llama-server 不在我们的启动记录里）", () => {
    
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
    
    expect(WINDOW_CAP).toMatch(/probeManagedChatCapability\([^)]*\)\s*\.catch\(/);
    expect(WINDOW_CAP).toMatch(/getLocalCapability\([^)]*\)\s*\.catch\(/);
  });
});



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
    
    expect(code).toContain("export function normalizeModelPath");
    expect(code).toContain('replace(/\\\\/g, "/")');
    


  });

  it("托管端口来源含**跨进程 registry** 兜底（开发模式下内存里没有实例记录）", () => {
    expect(stripComments(read(PROBE_SRC))).toContain("ModelServerManager.readRegistry()");
  });
});



describe("④ 分层：纯逻辑不碰 IO，IO 不碰 UI", () => {
  it("core-ts/src/model_introspect.ts 是纯函数模块（无 fs/fetch/electron/process）", () => {
    const code = stripComments(read(INTROSPECT));
    for (const banned of ["node:fs", "node:child_process", "node:http", "from \"electron\"", "globalThis.fetch", "AbortSignal", "process.env"]) {
      expect(code, `纯逻辑层出现了 ${banned}`).not.toContain(banned);
    }
    
    expect(code).not.toMatch(/^\s*import\s/m);
  });

  it("IO 层不引 React/DOM（它跑在主进程）", () => {
    const code = stripComments(read(PROBE_SRC));
    for (const banned of ["react", "document.", "window.", ".tsx"]) {
      expect(code.toLowerCase()).not.toContain(banned);
    }
  });

  it("本地服务状态有**读取者**（项目铁律：开关必须有读取者）", () => {
    
    expect(MAIN_CODE).toContain("logLocalCapGap(");
    expect(MAIN_CODE).toContain("function logLocalCapGap");
  });
});



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
