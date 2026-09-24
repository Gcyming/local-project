/**
 * tests/core-ts/a1026-guards.spec.ts — S5「上下文窗口上限：家族能力表退出 + 跨进程契约」守卫。
 *
 * ── 病根（A-1018 ③）──────────────────────────────────────────
 * 「这次会话的窗口上限是多少」曾经是一条 6 级级联**推断**，最后回落到
 * `shared/gen/model-capabilities.ts` 的**家族能力表**。那张表存的是模型**训练时**的窗口
 * （qwen3 / dots = 524K），而本机 llama-server 只按启动参数 `-c 8192` 分配 KV →
 * 界面显示"还剩 480K"、请求被上游 400 顶回 `exceeds the available context size (8192 tokens)`。
 *
 * S1 已经把**决策**收口到 `core-ts/src/model_introspect.ts` 的 `resolveWindowCap`
 * （唯一决策函数；见 a1022-guards.spec.ts）。S5 补的是**剩下的两个漏洞**：
 *
 *   ① **喂进来的那条**：`gui/src/main/providers.ts` 仍然拿家族表给 provider 配置填
 *      `context_window`。本地端点被填上训练窗口后，渲染层在"第一次 done 之前"就按它显示 ——
 *      换了个位置重演同一个 bug。现在本地/内网端点在「上游回传」之后**一律不兜底**。
 *
 *   ② **没人守的跨进程契约**：`windowCap` 靠 done 载荷从主进程送到渲染层，
 *      主进程有 **stream / retry 两条** done 路径。此前**全仓没有一个测试提到过 `windowCap`**
 *      （grep 实测 0 命中）—— 也就是说"每条 done 载荷都带它"只是一句注释。
 *      注释不会变红，所以它迟早会像 A-933 那样漏掉一条：当时**只**在 retry 路径下发，
 *      正常发送的 done 里没有 → 渲染层退回本地预设（512K 模型显示成 128K）、压缩阈值跟着算错。
 *
 * ⚠️ 验收标准是**变异测试**（gui/scripts/mut-a1026-wincap.mjs）：
 *    逐条把源码改坏、确认本文件变红。只写不断言对象，就是"绿着但没用"。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerCtxWindow } from "../../gui/src/main/providers.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const PROVIDERS = join(ROOT, "gui/src/main/providers.ts");
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");

/** 读文本并统一换行 —— 本仓库检出是 CRLF，`\n` 字面量断言会全线假红。 */
const read = (p: string): string => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** 去注释：守卫必须盯**代码**。对注释敏感会把"写了解释"误判成"改了行为"，
 *  更糟的是诱导后来者删注释而不是改代码。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 递归列出目录下的 .ts（排除 .d.ts） */
function tsFilesOf(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { out.push(...tsFilesOf(p)); }
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) { out.push(p); }
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// ① 行为：本地端点不得吃家族表的训练窗口
// ══════════════════════════════════════════════════════════

/** 取函数体（大括号配对）。
 *  ⚠️ 不能直接找 header 之后的第一个 `{` —— 参数是内联对象类型时会先撞上**参数表**的那个
 *  `{ baseUrl: string; … }`（实测就是这么假红的）。必须先跳过参数表。 */
function fnBody(src: string, header: string): string {
  const at = src.indexOf(header);
  expect(at, `找不到 ${header}`).toBeGreaterThan(-1);
  // ① 跳过参数表的右括号
  const paren = src.indexOf("(", at);
  let pd = 0;
  let paramEnd = -1;
  for (let i = paren; i < src.length; i += 1) {
    if (src[i] === "(") { pd += 1; }
    else if (src[i] === ")") { pd -= 1; if (pd === 0) { paramEnd = i; break; } }
  }
  expect(paramEnd, `${header} 的参数表括号不配对`).toBeGreaterThan(-1);
  // ② 函数体 = 参数表之后的第一个 `{` 起，按大括号配对
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
  /* dots（小红书点点笔记）在家族表里是 vendor 级 `context: 512000`（官方公布 512K）。
     这正是用户实测过的那条：界面按 512K 显示、llama-server 实际只给了 8192。
     ⚠️ A-1054：表内值由 `524288` 改为 `512000`；
     ⚠️ A-1087：当时给的理由（显示层 ÷1000 → 写 2^19 会读成 524K）**已作废** —— 显示层改成
       按上限自适进制后 524288 也读作 512K。此常量仍随之同步，因为它钉的是**表内值本身**，
       表内值变了这条守卫就该跟着动，否则会钉住旧值、对真实行为假绿。 */
  const DOTS_TRAINING_512K = 512000;
  /** qwen 家族兜底（同一类病的小号版本：131072 vs 实际 -c 8192） */
  const QWEN_FAMILY = 131072;

  it("★ 远端模型：家族表兜底照旧生效（不能把远端的功能一起删掉）", () => {
    expect(providerCtxWindow({ baseUrl: "https://api.deepseek.com/v1", modelId: "dots3-note-prev" }))
      .toBe(DOTS_TRAINING_512K);
    expect(providerCtxWindow({ baseUrl: "https://api.deepseek.com/v1", modelId: "qwen3-235b" }))
      .toBe(QWEN_FAMILY);
  });

  it("★ 本地端点（127.0.0.1）：**不返回**训练窗口——本地窗口只能问服务器", () => {
    // 本机 llama-server 的实际窗口由 `-c` 决定，问得到（/props.n_ctx）；
    // 在这里塞 512K 就是"界面按训练窗口显示、请求被 8192 顶回"。
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
    // 家族表未收录、但旧正则命中的 id：远程给正值，本地必须仍然 undefined
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
    // 家族表未收录 → 保存值
    expect(providerCtxWindow({ baseUrl: base, modelId: "totally-unknown-zzz", savedCtx: 999 })).toBe(999);
    // 都没有 → 旧正则
    expect(providerCtxWindow({ baseUrl: base, modelId: "qwen2.5-7b-instruct-zzz" })).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════
// ② 结构：窗口决策只有一条链路
// ══════════════════════════════════════════════════════════

describe("② 结构：写进 provider 配置的窗口只有一个决策点", () => {
  const code = () => stripComments(read(PROVIDERS));

  it("★ providerCtxWindow 必须复用共享的 isLocalEndpoint（再写一份正则会与计费口径分裂）", () => {
    const body = fnBody(code(), "export function providerCtxWindow(");
    expect(body, "本地判据必须来自共享层").toContain("isLocalEndpoint(");
    // 不许就地写 loopback 正则（那会立刻出现"计费说免费、窗口说 512K"式的双份真相源）
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
    // 且在 providers.ts 内部只出现一次（函数体里那一处）
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

// ══════════════════════════════════════════════════════════
// ③ 跨进程契约：每条 done 载荷都带 windowCap
// ══════════════════════════════════════════════════════════

describe("③ 跨进程契约：done 载荷的 windowCap（注释不会变红，所以必须断言）", () => {
  const MAIN = stripComments(read(MAIN_INDEX));

  it("★ 两条 done 路径（stream / retry）都必须下发 windowCap", () => {
    /* 两条路径各自 `webContents.send("slime:chat:done", {…})`。
     * A-933 的实锤：当时**只**在 retry 路径下发，正常发送的 done 里没有 →
     * 渲染层退回本地预设（512K 模型显示成 128K）、压缩阈值跟着算错。 */
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
    /* ── A-1084 迁移（本用例的**原意逐字保留**，只是把"产地"从 2 处扩到 4 处）──
     * 原判据是「windowCap 出现次数应与 **done 路径数**一致（=2）」——因为当时 windowCap
     * **只有一个用途**：done 载荷把它送回渲染层。
     *
     * A-1084 给它加了第二个用途：`ChatRequest.windowCap` → 引擎侧保险门（`planEngineSend`）
     * 靠它判"装不装得下、发不发"。**缺了这一处，保险门永远放行 = 等于没做**（而界面上
     * 完全看不出来，只是又回到"发出去才知道超"）。⇒ 产地从 2 变 4。
     *
     * ⚠️ 本用例锁的是**集合的完整性**（每个应存在的产地都在），不是"数量够"：
     *    只数个数的话「done 丢一处 + 请求多一处」也能凑够 4 —— 而那正是 A-933 的形态
     *    （当时 retry 有、stream 没有）。所以两组各自按**载体**枚举，再锁总数做绊线。 */
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

    // 产地总数 = 2 引擎请求 + 2 done 载荷（done 那两条的"是否在载荷内"由上一用例负责）
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
    // 兜底只许来自「provider 规格 / agent.max_context」，不许来自家族能力表
    expect(r, "渲染层又去读家族能力表的窗口兜底").not.toMatch(/inferModelCapabilities\([^)]*\)\.context\b/);
  });
});
