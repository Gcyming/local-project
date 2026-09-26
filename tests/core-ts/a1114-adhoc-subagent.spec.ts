/**
 * tests/core-ts/a1114-adhoc-subagent.spec.ts — 「临时子代理（inline spec）」的守卫。
 *
 * 用户诉求原话（#306）：
 *   「主 Agent 会派子代理吗？如果没有多余预设的 Agent，slime 可以自己临时编辑需要的 Agent
 *     作为临时子代理派发吗？这些都是要写进 Agent-Loop 中的环节啊。」
 *
 * 落地语义（四条边界，缺一条就不是"临时"）：
 *   ① 不落盘：绝不写 `config/agents.json`；
 *   ② 不进清单：`catalog()` / `listDefinitions()` 里看不到它（**也不是"先注册再删"**）；
 *   ③ 不参与路由：`delegate()` 见到内联 spec **直接合成派发**，跳过 `findByName` / `matchDefinition`；
 *   ④ 跑完即弃：除 `runs` 里那条记录外无痕。
 *
 * 这些失效**全是静默的**：tsc 过、构建过、逻辑测试全过，但功能在真实运行里不存在或行为错位：
 *   - 内联 spec 若不跳过路由，模型给的"现场人设"会被清单里某个语义相近的人顶替（派给了别人）；
 *   - 若实现成"注册一个临时定义再删掉"，并发派发期间**清单会被污染**（别的派发看到不存在的人）；
 *   - `name` 若单独出现也判 adhoc，模型随手填个名字就绕过点名/自动路由（变成说不清的第三种行为）；
 *   - `def.name` 第一次由模型决定 ⇒ 落盘名含 `a/b` / `..` / `报告:1` 时 writeFileSync 抛 ENOENT
 *     或写出 data/generated 之外，而报错只指向路径，看不出是名字的问题；
 *   - 内联 `tools` 若能自带 `delegate_subagent`，A-980-R30 的深度守卫（子代理不得再派子代理）当场失效。
 *
 * 因此分两层锁：**纯模块层**（行为断言，可精确定位）+ **源码接线层**（入口约定，写错也编译通过）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { SubAgentManager, sanitizeSubagentRunName } from "../../core-ts/src/services/subagent.js";
import type { SubAgentDef, SubAgentRunContext } from "../../core-ts/src/services/subagent.js";

/** 去掉注释行后的可执行源码（修复说明会引用旧写法做对照，不剥会误伤） */
function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const BUILTIN = codeOf("core-ts/src/tools/builtin.ts");
const SUBAGENT = codeOf("core-ts/src/services/subagent.ts");
const MAIN = codeOf("gui/src/main/index.ts");
const CATALOG = codeOf("core-ts/src/services/subagentCatalog.ts");

/** 截取 src 中 [startMark, endMark) 之间的一段（两端标记自身不含在内）。标记不存在即失败。 */
function sliceBetween(src: string, startMark: string, endMark: string): string {
  const i = src.indexOf(startMark);
  expect(i, `锚点未命中：${startMark}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(endMark, i + startMark.length);
  expect(j, `结束锚点未命中：${endMark}`).toBeGreaterThan(i);
  return src.slice(i + startMark.length, j);
}

/** 建一个可控的管理器；runner 里记录它实际收到的 def / ctx。 */
function makeManager(
  onRun?: (def: SubAgentDef, ctx?: SubAgentRunContext) => void | Promise<void>,
): { mgr: SubAgentManager; seen: Array<{ def: SubAgentDef; ctx?: SubAgentRunContext }> } {
  const seen: Array<{ def: SubAgentDef; ctx?: SubAgentRunContext }> = [];
  const mgr = new SubAgentManager(async (def, ctx) => {
    seen.push({ def, ctx });
    if (onRun) { await onRun(def, ctx); }
    return "子代理产出";
  }, { concurrency: 4 });
  return { mgr, seen };
}

describe("A-1114 — 内联 spec 必须绕过路由（派给现场定义的那个人）", () => {
  it("给了 systemPrompt ⇒ 不做描述匹配，也不记成命中了注册定义", async () => {
    const { mgr, seen } = makeManager();
    // 一个语义上"很像"的注册定义：若实现忘了跳过路由，它一定会被选中
    mgr.register({ name: "CSV 清洗专家", description: "csv 数据清洗 统计 表格", systemPrompt: "注册档人设" });

    const run = mgr.delegate("把这个 csv 清洗并统计", {
      adhoc: true,
      name: "一次性清洗工",
      systemPrompt: "你是只读 CSV 做统计的清洗工。",
    });
    expect(run).not.toBeNull();
    await mgr.awaitIdle();

    expect(run!.name).toBe("一次性清洗工");
    expect(run!.definitionName).toBeUndefined();
    expect(seen[0]!.def.adhoc).toBe(true);
    expect(seen[0]!.def.systemPrompt).toBe("你是只读 CSV 做统计的清洗工。");
    expect(seen[0]!.def.name).toBe("一次性清洗工");
  });

  it("只给 tools（没有 systemPrompt）同样算现场定义，且人设回退到通用兜底（不能是空系统提示）", async () => {
    const { mgr, seen } = makeManager();
    mgr.register({ name: "文件工", description: "文件 读取 列表", systemPrompt: "注册档人设" });

    const run = mgr.delegate("文件读取 列表", {
      adhoc: true,
      toolsOnly: ["file_read", "file_list"],
    });
    await mgr.awaitIdle();

    const def = seen[0]!.def;
    expect(def.adhoc).toBe(true);
    expect(def.toolsOnly).toEqual(["file_read", "file_list"]);
    expect((def.systemPrompt ?? "").trim().length).toBeGreaterThan(0);
    expect(run!.definitionName).toBeUndefined();
  });

  it("只给 name **不构成**现场定义（否则随手填个名字就绕过点名/自动路由）", async () => {
    const { mgr, seen } = makeManager();
    mgr.register({ name: "统计员", description: "统计 清洗 数据", systemPrompt: "注册档人设" });

    mgr.delegate("统计 清洗 数据", { adhoc: true, name: "随手起的名" });
    await mgr.awaitIdle();

    // 仍走正常路由 ⇒ 实际执行的是**注册定义**（人设来自它），而不是被 name 变成临时代理
    expect(seen[0]!.def.adhoc).toBeUndefined();
    expect(seen[0]!.def.systemPrompt).toBe("注册档人设");
  });

  it("没有内联 spec 时路由行为**不变**（防止把整块路由删掉也照样「全绿」）", async () => {
    const { mgr } = makeManager();
    mgr.register({ name: "调研员", description: "联网搜索 资料 调研 汇总", systemPrompt: "注册档人设" });

    const run = mgr.delegate("联网搜索 资料 调研 汇总");
    await mgr.awaitIdle();

    expect(run!.definitionName).toBe("调研员");
    expect(run!.name).toBe("调研员");
  });

  it("名字撞上已注册定义名，也不得被记成用了那个定义（假归因比没有字段更坏）", async () => {
    const { mgr } = makeManager();
    mgr.register({ name: "代码审查员", description: "代码 审查 质量", systemPrompt: "注册档人设" });

    const run = mgr.delegate("审一下这段代码", {
      adhoc: true,
      name: "代码审查员",
      systemPrompt: "你是一次性审查员，只输出问题清单。",
    });
    await mgr.awaitIdle();

    expect(run!.name).toBe("代码审查员");
    expect(run!.definitionName).toBeUndefined();
  });

  it("未给名字时自动名走「临时代理（…）」前缀，与「通用助手（…）」兜底区分开", async () => {
    const { mgr } = makeManager();
    const adhocRun = mgr.delegate("清洗数据", { adhoc: true, systemPrompt: "你是清洗工" });
    const fallbackRun = mgr.delegate("随便做点什么那件复杂的事情");
    await mgr.awaitIdle();

    expect(adhocRun!.name.startsWith("临时代理（")).toBe(true);
    expect(fallbackRun!.name.startsWith("通用助手（")).toBe(true);
  });
});

describe("A-1114 — 临时子代理不得进清单、不得被注册（不是「先注册再删」）", () => {
  it("派发期间与派发之后，catalog() / listDefinitions() 都看不到它", async () => {
    let duringCatalog: string[] = [];
    let duringDefs: string[] = [];
    const mgr = new SubAgentManager(async () => {
      duringCatalog = mgr.catalog().map((c) => c.name);
      duringDefs = mgr.listDefinitions().map((d) => d.name);
      return "ok";
    }, { concurrency: 4 });
    mgr.register({ name: "常驻专家", description: "任何事都能干" });

    const run = mgr.delegate("干活", { adhoc: true, name: "临时工", systemPrompt: "你是临时工" });
    await mgr.awaitIdle();

    expect(run!.name).toBe("临时工");
    expect(duringCatalog).toEqual(["常驻专家"]);
    expect(duringDefs).toEqual(["常驻专家"]);
    expect(mgr.catalog().map((c) => c.name)).toEqual(["常驻专家"]);
  });

  it("派发路径**完全不碰 register()**（「先注册再删」会污染并发派发看到的清单）", async () => {
    const { mgr } = makeManager();
    const registered: string[] = [];
    const orig = mgr.register.bind(mgr);
    mgr.register = (d) => { registered.push(d.name); orig(d); };

    mgr.delegate("干活", { adhoc: true, name: "临时工", systemPrompt: "你是临时工" });
    await mgr.awaitIdle();

    expect(registered).toEqual([]);
  });
});

describe("A-1114 — 现场定义沿既有通道透传（不新增第二条派发入口）", () => {
  it("toolsOnly / model / 联网开关都落到 runner 实收的 def 与 ctx 上", async () => {
    const { mgr, seen } = makeManager();
    const run = mgr.delegate("干活", {
      adhoc: true,
      name: "只读工",
      systemPrompt: "只读",
      toolsOnly: ["file_read", "file_list"],
      model: "api:somewhere:cheap",
      networkEnabled: false,
    });
    await mgr.awaitIdle();

    expect(seen[0]!.def.toolsOnly).toEqual(["file_read", "file_list"]);
    expect(seen[0]!.ctx?.networkEnabled).toBe(false);
    expect(run!.model).toBe("api:somewhere:cheap");
  });
});

describe("A-1114 — 产物文件名收敛（sanitizeSubagentRunName）", () => {
  it("路径分隔符 / Windows 保留字符 / 上跳点 / 控制字符一律被替换，且不产生空名", () => {
    const bad = [
      "a/b", "a\\b", "..\\..\\etc", "报告:1", "x*y?", 'q"w<e>r|t', "..", ".", "   ",
      "\u0000\u0001x", "../../config/agents.json",
    ];
    for (const s of bad) {
      const r = sanitizeSubagentRunName(s);
      expect(r.length, `空名：${JSON.stringify(s)}`).toBeGreaterThan(0);
      expect(r).not.toMatch(/[\\/:*?"<>|]/);
      expect(r).not.toContain("..");
      expect(r.startsWith(".")).toBe(false);
      expect(r.length).toBeLessThanOrEqual(64);
      // 落盘拼接后不允许出现新目录层级（`/` 与 `\` 都已被替换）
      expect(`subagent-${r}-stamp.md`).not.toMatch(/[\\/]/);
    }
  });

  it("正常名字不被误伤（中文 / 连字符 / 下划线 / 数字原样保留）", () => {
    expect(sanitizeSubagentRunName("代码审查员")).toBe("代码审查员");
    expect(sanitizeSubagentRunName("csv-cleaner_2")).toBe("csv-cleaner_2");
    expect(sanitizeSubagentRunName("  调研员  ")).toBe("调研员");
    expect(sanitizeSubagentRunName("")).toBe("unnamed");
    expect(sanitizeSubagentRunName("x".repeat(200)).length).toBe(64);
  });
});

describe("A-1114 — 源码接线层（写错也编译通过的那部分）", () => {
  const DELEGATE_TOOL = sliceBetween(BUILTIN, 'name: "delegate_subagent",', 'name: "subagent_result",');

  it("工具 schema 声明了内联 spec 的三个入参（少一个模型就用不到）", () => {
    expect(DELEGATE_TOOL).toContain('systemPrompt: { type: "string"');
    expect(DELEGATE_TOOL).toContain('tools: { type: "array"');
    expect(DELEGATE_TOOL).toContain('name: { type: "string"');
  });

  it("工具层：有「定义内容」才置 adhoc 标记，且 name 只在 adhoc 时透传", () => {
    expect(BUILTIN).toContain("if (adhocSystem || adhocTools.length > 0) {");
    expect(BUILTIN).toContain("overrides.adhoc = true;");
    expect(BUILTIN).toContain("overrides.toolsOnly = adhocTools.length > 0 ? adhocTools : undefined;");
    expect(BUILTIN).toContain("if (adhocName) { overrides.name = adhocName; }");
  });

  it("管理器层：adhoc 判据在**路由之前**，且只看 systemPrompt / toolsOnly", () => {
    const body = sliceBetween(SUBAGENT, "delegate(task: string", "private spawnFromDef(def: SubagentDefinition");
    const iAdhoc = body.indexOf("const adhoc =");
    const iFind = body.indexOf("this.findByName(wanted)");
    const iMatch = body.indexOf("this.matchDefinition(task)");
    expect(iAdhoc).toBeGreaterThanOrEqual(0);
    expect(iFind).toBeGreaterThan(iAdhoc);
    expect(iMatch).toBeGreaterThan(iAdhoc);
    expect(body).toContain("overrides.adhoc === true");
    expect(body).toContain("overrides.systemPrompt?.trim()");
    expect(body).toContain("overrides.toolsOnly?.length");
  });

  it("管理器层：adhoc 记录不得被标成命中的声明式定义名", () => {
    expect(SUBAGENT).toContain("if (!def.adhoc && this.defs.has(def.name)) {");
  });

  it("装配层：任何来源的工具白名单都先剔掉派发/收取工具（内联 tools 不许绕开深度守卫）", () => {
    const i = MAIN.indexOf("const subToolsOnly =");
    expect(i).toBeGreaterThanOrEqual(0);
    const stmt = MAIN.slice(i, MAIN.indexOf(";", i) + 1);
    expect(stmt).toContain("def.toolsOnly.filter((n) => !dispatchTools.has(n))");
    // 旧写法是 `def.toolsOnly ?? ...`（直通、不过滤）——正是内联 spec 能绕开守卫的那条路
    expect(stmt).not.toContain("??");
    // 两条分支共用同一判据（只有一个产地）
    expect((MAIN.match(/dispatchTools\.has\(n\)/g) ?? []).length).toBe(2);
  });

  it("装配层：产物落盘名必须过 sanitizeSubagentRunName，且只有这一处拼接", () => {
    expect(MAIN).toContain("`subagent-${sanitizeSubagentRunName(def.name)}-${stamp}.md`");
    expect((MAIN.match(/sanitizeSubagentRunName\(/g) ?? []).length).toBe(1);
  });

  it("委派规范里必须声明「临时子代理」，否则能力存在但模型不知道（死开关）", () => {
    const i = CATALOG.indexOf("export const DELEGATION_GUIDANCE");
    expect(i).toBeGreaterThanOrEqual(0);
    const G = CATALOG.slice(i);
    expect(G).toContain("临时子代理");
    expect(G).toContain("不写盘");
    expect(G).toContain("跑完即弃");
    expect(G).toContain("不要再填 `agent`");
  });
});
