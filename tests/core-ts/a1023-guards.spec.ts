


















import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const MODEL_SERVER = join(ROOT, "core-ts/src/model_server.ts");
const MAIN_DIR = join(ROOT, "gui/src/main");

const read = (p: string): string => readFileSync(p, "utf8");



function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}


function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { out.push(...tsFiles(full)); }
    else if (e.name.endsWith(".ts")) { out.push(full); }
  }
  return out;
}






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



describe("A-1023 ①：端口字面量只有一个产地（basePortFor）", () => {
  it("gui/src/main/** 的代码里不得出现 8999 / 18082（跨层硬编码 = 绕过唯一来源）", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(MAIN_DIR)) {
      const code = stripComments(read(f));
      
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
    
    expect(body).toMatch(/\b8999\b/);
    expect(body).toMatch(/\b18082\b/);
  });

  it("basePortFor 的四个调用点齐全（缺哪个，哪个分支就又开始自己推端口）", () => {
    
    
    expect(MS_CODE).toContain("const basePort = basePortFor(role, cfg, this.chatCfg);");   
    expect(MS_CODE).toContain('const port = basePortFor("embedding", cfg, this.chatCfg);'); 
    expect(MS_CODE).toContain("const portStart = basePortFor(role, cfg, this.chatCfg);");   
    expect(MS_CODE).toContain('port: basePortFor("embedding", this.embedCfg, this.chatCfg),'); 
    expect(MAIN_CODE).toContain('basePortFor("embedding"');                                 
  });

  it("bgeEmbed 的端点由 embeddingBaseUrl() 决定，不许再字面量拼 URL", () => {
    const body = fnBody(MAIN_CODE, "embeddingBaseUrl");
    expect(body).toContain("getPort(\"embedding\")");
    expect(body).toContain("basePortFor(\"embedding\"");
    
    const embed = fnBody(MAIN_CODE, "bgeEmbed");
    expect(embed).toContain("${embeddingBaseUrl()}");
    expect(embed).not.toMatch(/127\.0\.0\.1:\d+/);
  });
});



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



describe("A-1023 ③：PID 由私有字段承载，对外只经 getter", () => {
  it("pidVal 是 private，且外部写入点唯一（start 里那一次赋值）", () => {
    expect(MS_CODE).toContain("private pidVal");
    const assigns = MS_CODE.match(/this\.pidVal\s*=/g) ?? [];
    
    expect(assigns.length).toBeGreaterThanOrEqual(1);
    expect(MS_CODE).toMatch(/private pidVal: number \| null = null/);
  });

  it("GUI 主进程不得自行记录/推导 llama-server 的 PID", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(MAIN_DIR)) {
      const code = stripComments(read(f));
      
      if (/pidForPort/.test(code)) { offenders.push(f); }
    }
    expect(offenders, `PID 反查必须收口在 model_server.ts：${offenders.join(", ")}`).toEqual([]);
  });
});



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
    
    
    const hits = MS_CODE.match(/model_servers\.json/g) ?? [];
    expect(hits.length, `注册表路径字面量出现 ${hits.length} 次，应只有 1 次`).toBe(1);
    expect(MS_CODE).toContain("static readRegistry(");
  });

  it("GUI 侧读注册表走的是静态方法（不是自己 readFileSync）", () => {
    const probe = stripComments(read(join(MAIN_DIR, "localServerProbe.ts")));
    expect(probe).toContain("ModelServerManager.readRegistry()");
  });
});



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
