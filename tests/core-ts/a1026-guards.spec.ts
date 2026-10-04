
























import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerCtxWindow } from "../../gui/src/main/providers.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const PROVIDERS = join(ROOT, "gui/src/main/providers.ts");
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");


const read = (p: string): string => readFileSync(p, "utf8").replace(/\r\n/g, "\n");



function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}


function tsFilesOf(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { out.push(...tsFilesOf(p)); }
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) { out.push(p); }
  }
  return out;
}








function fnBody(src: string, header: string): string {
  const at = src.indexOf(header);
  expect(at, `找不到 ${header}`).toBeGreaterThan(-1);
  
  const paren = src.indexOf("(", at);
  let pd = 0;
  let paramEnd = -1;
  for (let i = paren; i < src.length; i += 1) {
    if (src[i] === "(") { pd += 1; }
    else if (src[i] === ")") { pd -= 1; if (pd === 0) { paramEnd = i; break; } }
  }
  expect(paramEnd, `${header} 的参数表括号不配对`).toBeGreaterThan(-1);
  
  const open = src.indexOf("{", paramEnd);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") { depth += 1; }
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) { return src.slice(open, i + 1); }
    }
  }
  throw new Error(`${header} 的大括号不配对`);
}

describe("① providerCtxWindow：本地端点不吃家族表兜底（A-1018 ③ 的喂入口）", () => {
  





  const DOTS_TRAINING_512K = 512000;
  
  const QWEN_FAMILY = 131072;

  it("★ 远端模型：家族表兜底照旧生效（不能把远端的功能一起删掉）", () => {
    expect(providerCtxWindow({ baseUrl: "https://api.deepseek.com/v1", modelId: "dots3-note-prev" }))
      .toBe(DOTS_TRAINING_512K);
    expect(providerCtxWindow({ baseUrl: "https://api.deepseek.com/v1", modelId: "qwen3-235b" }))
      .toBe(QWEN_FAMILY);
  });

  it("★ 本地端点（127.0.0.1）：**不返回**训练窗口——本地窗口只能问服务器", () => {
    
    
    for (const base of [
      "http://127.0.0.1:8800/v1",
      "http://127.0.0.1:18082",
      "http://localhost:8800/v1",
    ]) {
      expect(providerCtxWindow({ baseUrl: base, modelId: "dots3-note-prev" }), `本地端点 ${base} 不该吃到家族兜底`)
        .toBeUndefined();
    }
  });

  it("★ 内网端点（192.168 / 10.x）同样不吃家族兜底（共享判据 isLocalEndpoint 的口径）", () => {
    expect(providerCtxWindow({ baseUrl: "http://192.168.1.9:8800/v1", modelId: "dots3-note-prev" })).toBeUndefined();
    expect(providerCtxWindow({ baseUrl: "http://10.0.0.5:8800/v1", modelId: "dots3-note-prev" })).toBeUndefined();
  });

  it("★ 旧正则启发式对本地端点也必须闭嘴（qwen → 131072 是同一个病的小号版本）", () => {
    
    expect(providerCtxWindow({ baseUrl: "https://api.example.com/v1", modelId: "qwen2.5-7b-instruct-zzz" }))
      .toBeGreaterThan(0);
    expect(providerCtxWindow({ baseUrl: "http://127.0.0.1:8800/v1", modelId: "qwen2.5-7b-instruct-zzz" }))
      .toBeUndefined();
  });

  it("★ 保存值对本地端点也要丢（否则旧代码写坏的 512K 会被永久继承 —— 「错值自杀锁」）", () => {
    expect(providerCtxWindow({ baseUrl: "http://127.0.0.1:8800/v1", modelId: "dots3-note-prev", savedCtx: 512000 }))
      .toBeUndefined();
    expect(providerCtxWindow({ baseUrl: "http://127.0.0.1:8800/v1", modelId: "qwen3-235b", savedCtx: 131072 }))
      .toBeUndefined();
  });

  it("上游服务自报优先于一切（本地端点也认——那正是「问服务器」的同一个来源）", () => {
    expect(providerCtxWindow({ baseUrl: "http://127.0.0.1:8800/v1", modelId: "dots3-note-prev", upstreamCtx: 8192 }))
      .toBe(8192);
    expect(providerCtxWindow({ baseUrl: "https://api.deepseek.com/v1", modelId: "dots3-note-prev", upstreamCtx: 8192 }))
      .toBe(8192);
  });

  it("远端优先级不变：上游 > 家族表 > 保存值 > 旧正则", () => {
    const base = "https://api.deepseek.com/v1";
    expect(providerCtxWindow({ baseUrl: base, modelId: "dots3-note-prev", savedCtx: 999 })).toBe(DOTS_TRAINING_512K);
    
    expect(providerCtxWindow({ baseUrl: base, modelId: "totally-unknown-zzz", savedCtx: 999 })).toBe(999);
    
    expect(providerCtxWindow({ baseUrl: base, modelId: "qwen2.5-7b-instruct-zzz" })).toBeGreaterThan(0);
  });
});





describe("② 结构：写进 provider 配置的窗口只有一个决策点", () => {
  const code = () => stripComments(read(PROVIDERS));

  it("★ providerCtxWindow 必须复用共享的 isLocalEndpoint（再写一份正则会与计费口径分裂）", () => {
    const body = fnBody(code(), "export function providerCtxWindow(");
    expect(body, "本地判据必须来自共享层").toContain("isLocalEndpoint(");
    
    expect(body, "不得自己写一份本地端点正则").not.toMatch(/127\\?\.0\\?\.0\\?\.1/);
  });

  it("★ 家族表的 `.context` 在 gui/src/main 下只许出现在 providerCtxWindow 里", () => {
    const hits: string[] = [];
    for (const f of tsFilesOf(join(ROOT, "gui/src/main"))) {
      if (/inferModelCapabilities\([^)]*\)\.context/.test(stripComments(read(f)))) {
        hits.push(f.replace(ROOT, "").replace(/\\/g, "/"));
      }
    }
    expect(hits, `窗口兜底出现了第二产地：${hits.join(", ")}`).toEqual(["gui/src/main/providers.ts"]);
    
    const p = stripComments(read(PROVIDERS));
    expect(p.split("inferModelCapabilities(input.modelId).context").length - 1, "家族表在 providers 里被读了不止一处")
      .toBe(1);
  });

  it("★ 旧的 ctxFromFamily / ctxFromInference 就地链路不得复活", () => {
    const s = code();
    for (const banned of ["ctxFromFamily", "ctxFromInference", "ctxFromUpstream"]) {
      expect(s, `回到了就地拼链路（多个产地）：${banned}`).not.toContain(banned);
    }
    expect(s, "窗口决策必须走 providerCtxWindow()").toContain("providerCtxWindow({");
  });
});





describe("③ 跨进程契约：done 载荷的 windowCap（注释不会变红，所以必须断言）", () => {
  const MAIN = stripComments(read(MAIN_INDEX));

  it("★ 两条 done 路径（stream / retry）都必须下发 windowCap", () => {
    


    const sends = [...MAIN.matchAll(/send\("slime:chat:done",\s*\{/g)];
    expect(sends.length, `done 载荷应当恰好 2 条（stream/retry），实测 ${sends.length} 条 —— 若新增一条，本守卫要同步扩到它`)
      .toBe(2);
    for (const [i, m] of sends.entries()) {
      const from = m.index ?? 0;
      const payload = MAIN.slice(from, from + 900);
      expect(payload, `第 ${i + 1} 条 done 载荷缺 windowCap（渲染层会退回本地预设）`).toContain("windowCap:");
    }
  });

  it("★ 每处 windowCap 都必须由唯一决策函数定（引擎请求 2 处 + done 载荷 2 处，一处都不能少）", () => {
    










    const reqs = [...MAIN.matchAll(/:\s*ChatRequest\s*=\s*\{/g)];
    expect(
      reqs.length,
      `引擎请求应当恰好 2 条（stream / retry），实测 ${reqs.length} 条 —— 新增发送路径请同步本守卫`,
    ).toBe(2);
    for (const [i, m] of reqs.entries()) {
      const from = m.index ?? 0;
      expect(
        MAIN.slice(from, from + 1400),
        `第 ${i + 1} 条引擎请求缺 windowCap（保险门会永远放行 = 等于没做，且界面看不出来）`,
      ).toContain("windowCap:");
    }

    
    const withCap = [...MAIN.matchAll(/windowCap:\s*([^\n]+)/g)].map((m) => m[1].trim());
    expect(
      withCap.length,
      `windowCap 产地数应为 4（2 引擎请求 + 2 done 载荷），实测 ${withCap.length} —— 增删任一载体都要回到本行同步`,
    ).toBe(4);
    for (const expr of withCap) {
      expect(expr, `windowCap 的来源不是唯一决策函数：${expr}`).toContain("resolveSessionWindowCap(");
    }
  });

  it("★ 渲染层必须真的读它（写了不读 = 又一条静默失效的字段）", () => {
    const r = stripComments(read(CHAT_PANEL));
    expect(r, "渲染层没有消费 windowCap").toContain("m.windowCap");
    expect(r, "windowCap 必须能覆盖本地预设（否则显示了也不生效）").toMatch(/setCtxCap\(m\.windowCap\)/);
  });

  it("★ 渲染层不得再用家族能力表兜底窗口（那是主进程的职责，另开一份就是双份真相源）", () => {
    const r = stripComments(read(CHAT_PANEL));
    
    expect(r, "渲染层又去读家族能力表的窗口兜底").not.toMatch(/inferModelCapabilities\([^)]*\)\.context\b/);
  });
});
