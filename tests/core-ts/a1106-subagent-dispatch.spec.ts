























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubAgentManager, DEFAULT_EXEC_BUDGET_MS, type SubAgentRun } from "../../core-ts/src/services/subagent.js";
import { __SUBAGENT_BUDGETS } from "../../core-ts/src/tools/builtin.js";
import { DELEGATION_GUIDANCE } from "../../core-ts/src/services/subagentCatalog.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

const MAIN = stripComments(readSrc("gui/src/main/index.ts"));
const SUB = stripComments(readSrc("core-ts/src/services/subagent.ts"));
const LOOP = stripComments(readSrc("core-ts/src/tool_loop.ts"));
const BUILTIN = stripComments(readSrc("core-ts/src/tools/builtin.ts"));














function handlerBody(src: string, channelMarker: string): string {
  const at = src.indexOf(channelMarker);
  if (at < 0) { return ""; }
  const rest = src.slice(at + channelMarker.length);
  const next = rest.search(/\n {2}(?:handleTrusted|handle|ipcMain\.)\s*[<(A-Za-z]/);
  return src.slice(at, next >= 0 ? at + channelMarker.length + next : at + 4000);
}



describe("A-1106 P 组 — 可派发清单随 Agent 增删改刷新（否则「刚建的子代理调不动」）", () => {
  it("P1 刷新函数必须是**模块级**的（惰性块内的局部箭头 = 只有启动期那一份会跑）", () => {
    expect(MAIN, "syncDispatchableSubagents 必须能在启动期之外被调用").toContain("function syncDispatchableSubagents(");
    
    expect(MAIN, "刷新函数又缩进进某个块里了 —— 块外调不到它").toContain("\nfunction syncDispatchableSubagents(");
  });

  it("P2 ⚠️ 管理器未装配时必须**出声**（静默跳过会被误读成「没有可派发的 Agent」）", () => {
    expect(MAIN).toContain("可派发清单」刷新被跳过");
    expect(MAIN).toContain("console.warn");
  });

  it("P3 ⚠️ 启动期那次必须**显式传**管理器（`subagentsRef` 此刻还是 null ⇒ 静默「改了但没生效」）", () => {
    expect(MAIN, "启动期不显式传管理器 ⇒ 只读 subagentsRef 会拿到 null，清单从未被登记").toContain("syncDispatchableSubagents(subagents);");
  });

  it("P4 ⚠️ 新建 / 分裂 / 删除 / 改设置 / 导入 —— 五个入口都必须刷新清单", () => {
    
    
    const wiring: Array<[string, string, RegExp]> = [
      ["slime:agents:create", "新建的 Agent 立刻可派发", /createAgent\(/],
      ["slime:agents:fork", "分裂出的子 Agent 立刻可派发", /forkAgent\(/],
      ["slime:agents:remove", "被删的 Agent 必须从清单里摘掉（否则点名派发必失败）", /removeAgent\(/],
      ["slime:agents:update", "改了「同意被派发」开关 / 描述，清单必须重算", /updateAgent\(/],
      ["slime:agents:import", "导入的 Agent 在派发侧必须可见", /importAgent\(/],
    ];
    for (const [ch, why, positive] of wiring) {
      const body = handlerBody(MAIN, `("${ch}"`);
      
      expect(body, `${ch} 的处理体没取到（窗口右界失效）`).toMatch(positive);
      
      expect(
        body.includes("syncDispatchableSubagents("),
        `${ch} 的处理体里没有刷新可派发清单 —— ${why}`,
      ).toBe(true);
    }
  });
});



describe("A-1106 Q 组 — 子代理前台等待必须可中断（「停止按钮没反应」的根因）", () => {
  it("Q1 wait 必须有第三参 signal（没有它 ⇒ 这条 await 永远不可打断）", () => {
    expect(SUB).toContain("async wait(id: string, timeoutMs = 300_000, signal?: AbortSignal)");
  });

  it("Q2 abort 监听必须真的注册（`{ once: true }` 只在 abort 路径自动摘除，超时路径手动摘）", () => {
    expect(SUB).toContain('signal?.addEventListener("abort", done, { once: true });');
    expect(SUB, "不手动摘 → 监听器残留（每次调用泄一个）").toContain('signal?.removeEventListener("abort", done);');
  });

  it("Q3 已中断 ⇒ 不进等待（否则「按了停止还要等满上限」）", () => {
    expect(SUB).toContain("if (signal?.aborted) { return this.status(id); }");
  });

  it("Q4 等待上限必须**严格大于**执行预算（相等 ⇒ 两者在同一毫秒竞争，归因被搞乱）", () => {
    expect(__SUBAGENT_BUDGETS.waitDefault).toBeGreaterThan(__SUBAGENT_BUDGETS.execBudget);
    expect(__SUBAGENT_BUDGETS.waitMax).toBeGreaterThan(__SUBAGENT_BUDGETS.waitDefault);
    
    expect(BUILTIN).toContain("const SUBAGENT_WAIT_DEFAULT = DEFAULT_EXEC_BUDGET_MS + 60_000;");
    expect(__SUBAGENT_BUDGETS.execBudget).toBe(DEFAULT_EXEC_BUDGET_MS);
  });

  it("Q5 工具循环必须**注入** `_signal`，且**先 delete** 覆盖模型伪造的同名参数", () => {
    expect(LOOP).toContain('if (tc.name === "delegate_subagent" || tc.name === "subagent_result") {');
    expect(LOOP, "不 delete ⇒ 模型传一个假 _signal 就能污染中断语义").toContain("delete args._signal;");
    expect(LOOP, "不注入 ⇒ 工具侧永远拿不到中断通路（等于没修）").toContain("if (signal) { args._signal = signal; }");
  });

  it("Q6 工具侧必须**校验**注入值（`instanceof`）—— 受信注入不许信任入参", () => {
    expect(BUILTIN).toContain("raw instanceof AbortSignal ? raw : undefined");
    expect(BUILTIN).toContain("const signal = injectedSignal(args);");
    
    expect(countOf(BUILTIN, "injectedSignal(args)"), "delegate_subagent 与 subagent_result 各一处").toBe(2);
    expect(BUILTIN).toContain("await subagentManagerRef.wait(run.id, waitMs, signal)");
    expect(BUILTIN).toContain("await subagentManagerRef.wait(id, waitMs, signal)");
  });

  it("Q7 wait 的**接口契约**必须带 signal（装配侧的类型镜像要同步）", () => {
    expect(BUILTIN).toContain("wait?: (id: string, timeoutMs?: number, signal?: AbortSignal) => Promise<SubAgentRunLike | undefined>;");
  });

  it("Q8 ⚠️ 中断后必须**如实归因**，并说清子代理仍在跑（否则主 Agent 会去重派一个用户已不想等的任务）", () => {
    expect(countOf(BUILTIN, "if (signal?.aborted) {"), "两个子代理工具都要有中断优先归因").toBe(2);
    expect(countOf(BUILTIN, "[已停止等待]"), "三处归因文案（单发派发 / 批量派发 / 结果收取）").toBe(3);
    expect(countOf(BUILTIN, "仍在后台继续执行"), "必须告知子代理没有被取消").toBe(3);
  });

  

  
  function neverEnding(): { mgr: SubAgentManager; run: SubAgentRun } {
    const mgr = new SubAgentManager(() => new Promise<string>(() => {  }));
    
    const run = mgr.delegate("永不结束的审计任务", { timeoutMs: 5_000 });
    if (!run) { throw new Error("delegate 不该返回 null（无匹配定义时应走兜底合成）"); }
    return { mgr, run };
  }

  it("Q9 行为：abort **立刻**结束等待（不等到超时上限）", async () => {
    const { mgr, run } = neverEnding();
    await new Promise((r) => setTimeout(r, 0)); 
    const ac = new AbortController();
    const t0 = Date.now();
    const p = mgr.wait(run.id, 1_500, ac.signal);
    setTimeout(() => ac.abort(), 10);
    const snap = await p;
    const elapsed = Date.now() - t0;
    expect(elapsed, `abort 没有打断等待 —— 用户点「停止生成」后仍会等满上限（实测 ${elapsed}ms）`).toBeLessThan(300);
    expect(snap, "等待结束必须交回当前快照（不能 undefined）").toBeTruthy();
  });

  it("Q10 行为：abort **只结束等待、不取消子代理**（保守取舍：保住已跑出的产出）", async () => {
    const { mgr, run } = neverEnding();
    await new Promise((r) => setTimeout(r, 0));
    const ac = new AbortController();
    const p = mgr.wait(run.id, 1_500, ac.signal);
    setTimeout(() => ac.abort(), 10);
    const snap = await p;
    expect(["pending", "running"], `abort 把子代理也杀了（快照状态=${snap?.status}）—— 那会白白丢掉它已经跑出来的部分`)
      .toContain(snap?.status);
    expect(mgr.status(run.id)?.status, "子代理不该因为「停止等待」被标成 cancelled").not.toBe("cancelled");
  });

  it("Q11 行为：已中断的 signal ⇒ 立即返回，不进入等待", async () => {
    const { mgr, run } = neverEnding();
    await new Promise((r) => setTimeout(r, 0));
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const snap = await mgr.wait(run.id, 1_500, ac.signal);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(snap).toBeTruthy();
  });
});














describe("A-1106/5b R 组 — 力度预算分档（按复杂度给量，而非硬门槛）", () => {
  const CATALOG = stripComments(readSrc("core-ts/src/services/subagentCatalog.ts"));
  const BUILTIN = stripComments(readSrc("core-ts/src/tools/builtin.ts"));

  it("R1 规范必须给出三档 effort budget（1 / 2–4 / 10+）——否则「默认派发」会退化成「简单问题派一堆」", () => {
    const G = DELEGATION_GUIDANCE;
    expect(G).toContain("力度预算按复杂度伸缩");
    expect(G, "缺第 1 档（简单事实查找 → 1 个）").toContain("简单事实查找");
    expect(G, "缺第 2 档（直接对比 → 2–4 个）").toContain("直接对比");
    expect(G, "缺第 3 档（复杂研究 → 10+ 个）").toContain("复杂研究");
    
    expect(G).toContain("2–4");
    expect(G).toContain("10+");
  });

  it("R2 分档必须是**启发式**，不许写成硬门槛（官方点名反对 rigid rules）", () => {
    expect(DELEGATION_GUIDANCE).toContain("启发式的上下限");
    expect(
      DELEGATION_GUIDANCE.includes("不是「预计超过") && DELEGATION_GUIDANCE.includes("那种硬门槛"),
      "必须显式声明「这不是硬门槛」——否则模型会把它读成一条准入规则（判错即不派）",
    ).toBe(true);
  });

  it("R3 「必须自己做」的④不许与预算分档自相矛盾（「一两步就能做完」 vs 「简单事实查找派 1 个」）", () => {
    
    expect(DELEGATION_GUIDANCE).toContain("一次工具调用就能拿到答案的");
    expect(DELEGATION_GUIDANCE, "旧措辞「一两步就能做完的」与新分档自相矛盾，不许回归").not.toContain("一两步就能做完的");
  });

  it("R4 工具描述不许再抄第二份分档文本（第二产地 = 迟早漂移）", () => {
    expect(BUILTIN, "工具描述里应把「何时不用」收敛到「一次工具调用就能拿到答案」").toContain("一次工具调用就能拿到答案的");
    expect(BUILTIN, "工具描述里又抄了一份分档 ⇒ 与规范漂移").not.toContain("力度预算按复杂度伸缩");
    
    expect(countOf(CATALOG, "力度预算按复杂度伸缩")).toBe(1);
    expect(countOf(CATALOG, "简单事实查找 / 单个小改动")).toBe(1);
  });
});

describe("A-1106/5b S 组 — 子代理「派发即出声」（面板事件驱动，不靠轮询）", () => {
  it("S1 SubAgentHooks 必须有 onSpawn（否则 pending 阶段永远不会广播）", () => {
    expect(SUB).toContain("onSpawn?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;");
  });

  it("S2 spawn() 必须在**执行之前**触发 onSpawn（不是只在 onStart = 拿到槽位时才出声）", () => {
    expect(SUB, "spawn 里没触发 onSpawn ⇒ pending 阶段事件缺失（面板只能轮询）")
      .toContain("void this.fireHook(this.hooks.onSpawn, run, def);");
    
    const iSpawn = SUB.indexOf("void this.fireHook(this.hooks.onSpawn, run, def);");
    const iExec = SUB.indexOf("void this.execute(run, effectiveModel ? { ...def, model: effectiveModel } : def);");
    expect(iSpawn).toBeGreaterThan(-1);
    expect(iExec).toBeGreaterThan(-1);
    expect(iSpawn, "onSpawn 触发点跑到 execute 之后了（= 又变成 onStart 语义）").toBeLessThan(iExec);
  });

  it("S3 装配层必须把 onSpawn 接到 slime:resident:update（否则钩子形同虚设）", () => {
    const at = MAIN.indexOf("onSpawn: (run) => {");
    expect(at, "装配层没有 onSpawn 钩子").toBeGreaterThan(-1);
    
    const next = MAIN.indexOf("onStart:", at);
    const body = MAIN.slice(at, next >= 0 ? next : at + 300);
    expect(body, "onSpawn 没有广播事件 ⇒ 面板收不到「已派发」").toContain('mainWindow?.webContents.send("slime:resident:update", null);');
    
    expect((MAIN.match(/onSpawn:/g) ?? []).length, "onSpawn 钩子只能有一处").toBe(1);
  });

  it("S4 取消「排队中」的子代理必须补广播 + 落盘（唯一不触发钩子的状态变化）", () => {
    


    const at = MAIN.indexOf('("slime:resident:subagent:cancel"');
    expect(at, "cancel 通道没取到").toBeGreaterThan(-1);
    const next = MAIN.indexOf("ipcMain.handle(", at + 40);
    const body = MAIN.slice(at, next >= 0 ? next : at + 4000);
    expect(body, "cancel 处理体没取到").toMatch(/subagents\.cancel\(/);
    expect(body, "排队中取消不广播 ⇒ 面板要等 3 秒轮询").toContain('mainWindow?.webContents.send("slime:resident:update", null);');
    expect(body, "排队中取消不落盘 ⇒ 重启后这条记录消失").toContain("syncSubagentRuns(subagents.list());");
    
    expect(body).not.toContain('("slime:resident:subagent:clear"');
  });

  
  it("S5 行为：spawn 即在 pending 触发 onSpawn（并发槽位被占满时也必须出声）", async () => {
    const seen: Array<{ status: string }> = [];
    const mgr = new SubAgentManager(
      () => new Promise<string>(() => {  }),
      { concurrency: 1, hooks: { onSpawn: (run) => { seen.push({ status: run.status }); } } },
    );
    
    const a = mgr.spawn({ name: "占位", task: "x" });
    const b = mgr.spawn({ name: "排队中", task: "y" });
    await new Promise((r) => setTimeout(r, 0));
    
    expect(seen.length, "onSpawn 没在 spawn 时触发").toBe(2);
    expect(seen[0]?.status).toBe("pending");
    expect(seen[1]?.status).toBe("pending");
    expect(mgr.status(b.id)?.status, "b 应当还在排队（pending）").toBe("pending");
    
    mgr.cancel(a.id);
    mgr.cancel(b.id);
  });
});
