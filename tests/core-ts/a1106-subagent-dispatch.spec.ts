/**
 * tests/core-ts/a1106-subagent-dispatch.spec.ts — A-1106 续：子代理派发的两条残留缺陷。
 *
 * 用户原话：「子代理的派发是绝对不能马虎的，一定要以极高规格设定的」。
 *
 * ## ① 可派发清单**不随 Agent 创建/修改刷新**（`syncDispatchableSubagents` 只活在启动期）
 *
 *   清单此前只在两处算过：启动期一次、设置页勾选一次。此后**新建 / fork / 删除 / 改设置 /
 *   导入** Agent 都不会刷新它 ⇒ 用户「刚建的子代理主 Agent 调不动」——清单里根本没有它。
 *   更隐蔽的一层：改设置后清单里留的是**旧描述**（描述 = 自动路由的依据），
 *   模型仍按旧描述选人，派给一个能力已经变了的执行者。
 *   ⚠️ 而这一切**过 tsc、过构建、过所有既有测试**，只在用户眼里翻车。
 *
 * ## ② 前台等待**不可中断**（`SubAgentManager.wait` 没有 signal 通路）
 *
 *   前台委派默认 `await` 到子代理终态，等待上限 960s（= 执行预算 900s + 60s 收尾余量，
 *   **必须** > 预算，见 `__SUBAGENT_BUDGETS`）。这条 await 此前**没有任何中断通路**
 *   ⇒ 用户点「停止生成」只停住主 Agent 的模型流，工具仍会等满全程（≈16 分钟），
 *   界面上表现为「停止按钮没反应」。
 *   修复后：abort **只结束等待、不取消子代理**（保守取舍 —— 子代理可能已跑了几分钟、
 *   只差最后一步，回杀会白白丢掉它的产出）。上层据此如实回执。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubAgentManager, DEFAULT_EXEC_BUDGET_MS, type SubAgentRun } from "../../core-ts/src/services/subagent.js";
import { __SUBAGENT_BUDGETS } from "../../core-ts/src/tools/builtin.js";
import { DELEGATION_GUIDANCE } from "../../core-ts/src/services/subagentCatalog.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再断言（注释里会**故意**写出旧写法/新写法的说明，不剥就是假红或假绿） */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
/** 出现次数 —— 断言「唯一产地」时必须先证明它唯一，`toContain` 对同名多产地恒绿 */
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

const MAIN = stripComments(readSrc("gui/src/main/index.ts"));
const SUB = stripComments(readSrc("core-ts/src/services/subagent.ts"));
const LOOP = stripComments(readSrc("core-ts/src/tool_loop.ts"));
const BUILTIN = stripComments(readSrc("core-ts/src/tools/builtin.ts"));

/**
 * 取「某个 IPC 入口的**处理体**」—— 右界 = **下一个 IPC 注册**（结构性，与注释长度无关）。
 *
 * ⚠️ **为什么不用固定字符窗口**（A-1106 变异 47 实测撞上 ── 这条是**变异测试抓出来的真缺陷**）：
 *    原写法是 `hasCallWithin(MAIN, marker, needle, 1500)`，`1500` 是**估的**。
 *    `create` 入口后面隔约 900 字符就是 `fork` 入口，而它**也有**一次
 *    `syncDispatchableSubagents();` ⇒ 把 create 那处删掉，窗口里仍有 fork 那处
 *    ⇒ **守卫照样绿**（假守卫）。窗口宽度是估算值时，相邻入口会互相「冒充接线」。
 *    （同族教训见 `ref-engineering §25`「守卫窗口硬编码宽度」：A-1095 S6 已被它咬过一次。）
 *
 * ⚠️ 取到空串时**必须响亮失败**：`not` 类 / `includes` 类断言在空串上**恒绿**。
 *    所以调用方一律**先**用正例断言证明这个块取对了（见 P4 的第三列）。
 */
function handlerBody(src: string, channelMarker: string): string {
  const at = src.indexOf(channelMarker);
  if (at < 0) { return ""; }
  const rest = src.slice(at + channelMarker.length);
  const next = rest.search(/\n {2}(?:handleTrusted|handle|ipcMain\.)\s*[<(A-Za-z]/);
  return src.slice(at, next >= 0 ? at + channelMarker.length + next : at + 4000);
}

/* ═════════════════ P 组：可派发清单必须随 Agent 生命周期刷新 ═════════════════ */

describe("A-1106 P 组 — 可派发清单随 Agent 增删改刷新（否则「刚建的子代理调不动」）", () => {
  it("P1 刷新函数必须是**模块级**的（惰性块内的局部箭头 = 只有启动期那一份会跑）", () => {
    expect(MAIN, "syncDispatchableSubagents 必须能在启动期之外被调用").toContain("function syncDispatchableSubagents(");
    // 模块级函数：缩进为 0（缩进的 = 又回到某个块里的局部实现）
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
    // 第三列 = **正例锚点**：用来证明「我取到的确实是那个入口的处理体」。
    // 没有它，窗口一旦取空，下面的断言会在空串上恒绿（§25 的假守卫形态）。
    const wiring: Array<[string, string, RegExp]> = [
      ["slime:agents:create", "新建的 Agent 立刻可派发", /createAgent\(/],
      ["slime:agents:fork", "分裂出的子 Agent 立刻可派发", /forkAgent\(/],
      ["slime:agents:remove", "被删的 Agent 必须从清单里摘掉（否则点名派发必失败）", /removeAgent\(/],
      ["slime:agents:update", "改了「同意被派发」开关 / 描述，清单必须重算", /updateAgent\(/],
      ["slime:agents:import", "导入的 Agent 在派发侧必须可见", /importAgent\(/],
    ];
    for (const [ch, why, positive] of wiring) {
      const body = handlerBody(MAIN, `("${ch}"`);
      // ① 先证明块取对了（否则下面那条在空串上恒绿）
      expect(body, `${ch} 的处理体没取到（窗口右界失效）`).toMatch(positive);
      // ② 再断形态：这个入口自己的处理体里必须刷清单
      expect(
        body.includes("syncDispatchableSubagents("),
        `${ch} 的处理体里没有刷新可派发清单 —— ${why}`,
      ).toBe(true);
    }
  });
});

/* ═════════════════ Q 组：前台等待可被「停止生成」中断 ═════════════════ */

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
    // 真源只有一个：上限从预算常量**推导**，不许各写一个字面量
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
    // 两处调用点都要把 signal 传下去（漏一处 = 那一个工具仍不可中断）
    expect(countOf(BUILTIN, "injectedSignal(args)"), "delegate_subagent 与 subagent_result 各一处").toBe(2);
    expect(BUILTIN).toContain("await subagentManagerRef.wait(run.id, waitMs, signal)");
    expect(BUILTIN).toContain("await subagentManagerRef.wait(id, waitMs, signal)");
  });

  it("Q7 wait 的**接口契约**必须带 signal（装配侧的类型镜像要同步）", () => {
    expect(BUILTIN).toContain("wait?: (id: string, timeoutMs?: number, signal?: AbortSignal) => Promise<SubAgentRunLike | undefined>;");
  });

  it("Q8 ⚠️ 中断后必须**如实归因**，并说清子代理仍在跑（否则主 Agent 会去重派一个用户已不想等的任务）", () => {
    expect(countOf(BUILTIN, "if (signal?.aborted) {"), "两个子代理工具都要有中断优先归因").toBe(2);
    expect(countOf(BUILTIN, "[已停止等待]"), "两处归因文案").toBe(2);
    expect(countOf(BUILTIN, "仍在后台继续执行"), "必须告知子代理没有被取消").toBe(2);
  });

  /* ── 行为：真跑一遍 wait，不看源码看结果 ── */

  /** 造一个「永不结束」的子代理（runner 返回永不 settle 的 Promise） */
  function neverEnding(): { mgr: SubAgentManager; run: SubAgentRun } {
    const mgr = new SubAgentManager(() => new Promise<string>(() => { /* 永不 settle */ }));
    // timeoutMs 给短值，避免测试进程里留下一个 15 分钟的长定时器
    const run = mgr.delegate("永不结束的审计任务", { timeoutMs: 5_000 });
    if (!run) { throw new Error("delegate 不该返回 null（无匹配定义时应走兜底合成）"); }
    return { mgr, run };
  }

  it("Q9 行为：abort **立刻**结束等待（不等到超时上限）", async () => {
    const { mgr, run } = neverEnding();
    await new Promise((r) => setTimeout(r, 0)); // 让 execute 真正起跑
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

/* ═════════ R 组：力度预算分档 + 派发即出声（A-1106/5b）═════════════════
 *
 * 用户原话：「我怎么还是没怎么看到子代理的出现？……是不是 Agent-Loop 还是没设定好？
 * 还是说那个监测悬浮按钮有问题？无法实时返回正确的数据？……有没有为了防止 Agent
 * 肆意派发子代理而出现**过度设计**。」
 *
 * 两条都要锁：
 *  ① **预算分档**：只写「默认派发」不写「派多少」= Anthropic 记录的早期失效（简单问题派 50 个）。
 *     但分档必须是**启发式上下限**，不能退化成「预计超过 N 步才可派」那种官方点名反对的硬门槛。
 *  ② **派发即出声**：`onStart` 只在拿到并发槽位时触发；并发满时新派发的子代理停在 pending
 *     且不发事件 ⇒ 面板只能靠 3 秒轮询（用户说的「无法实时返回正确的数据」的直接形状）。
 */

describe("A-1106/5b R 组 — 力度预算分档（按复杂度给量，而非硬门槛）", () => {
  const CATALOG = stripComments(readSrc("core-ts/src/services/subagentCatalog.ts"));
  const BUILTIN = stripComments(readSrc("core-ts/src/tools/builtin.ts"));

  it("R1 规范必须给出三档 effort budget（1 / 2–4 / 10+）——否则「默认派发」会退化成「简单问题派一堆」", () => {
    const G = DELEGATION_GUIDANCE;
    expect(G).toContain("力度预算按复杂度伸缩");
    expect(G, "缺第 1 档（简单事实查找 → 1 个）").toContain("简单事实查找");
    expect(G, "缺第 2 档（直接对比 → 2–4 个）").toContain("直接对比");
    expect(G, "缺第 3 档（复杂研究 → 10+ 个）").toContain("复杂研究");
    // 三档都必须在（只写一句「按复杂度伸缩」= 等于没给量）
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
    // ④ 收敛到真正浪费的形状：一次工具调用即可（单文件读取 / 单文件精确查找）
    expect(DELEGATION_GUIDANCE).toContain("一次工具调用就能拿到答案的");
    expect(DELEGATION_GUIDANCE, "旧措辞「一两步就能做完的」与新分档自相矛盾，不许回归").not.toContain("一两步就能做完的");
  });

  it("R4 工具描述不许再抄第二份分档文本（第二产地 = 迟早漂移）", () => {
    expect(BUILTIN, "工具描述里应把「何时不用」收敛到「一次工具调用就能拿到答案」").toContain("一次工具调用就能拿到答案的");
    expect(BUILTIN, "工具描述里又抄了一份分档 ⇒ 与规范漂移").not.toContain("力度预算按复杂度伸缩");
    // 规范本体只在唯一出处里出现一次（计数型断言必须配变异 M76）
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
    // 触发点必须在 execute 之前（否则又会退化成「拿到槽位才出声」）
    const iSpawn = SUB.indexOf("void this.fireHook(this.hooks.onSpawn, run, def);");
    const iExec = SUB.indexOf("void this.execute(run, effectiveModel ? { ...def, model: effectiveModel } : def);");
    expect(iSpawn).toBeGreaterThan(-1);
    expect(iExec).toBeGreaterThan(-1);
    expect(iSpawn, "onSpawn 触发点跑到 execute 之后了（= 又变成 onStart 语义）").toBeLessThan(iExec);
  });

  it("S3 装配层必须把 onSpawn 接到 slime:resident:update（否则钩子形同虚设）", () => {
    const at = MAIN.indexOf("onSpawn: (run) => {");
    expect(at, "装配层没有 onSpawn 钩子").toBeGreaterThan(-1);
    // 右界取**下一个钩子**（结构性）—— 固定宽度窗口会把 onStart 里的 send 误当成本块的（假绿）
    const next = MAIN.indexOf("onStart:", at);
    const body = MAIN.slice(at, next >= 0 ? next : at + 300);
    expect(body, "onSpawn 没有广播事件 ⇒ 面板收不到「已派发」").toContain('mainWindow?.webContents.send("slime:resident:update", null);');
    // 只应有一处 onSpawn（第二产地 = 两个钩子各说各话）
    expect((MAIN.match(/onSpawn:/g) ?? []).length, "onSpawn 钩子只能有一处").toBe(1);
  });

  it("S4 取消「排队中」的子代理必须补广播 + 落盘（唯一不触发钩子的状态变化）", () => {
    /* ⚠️ 右界取**下一个 `ipcMain.handle(`**（结构性）——resident 的通道在惰性块里缩进 6 空格，
       而 a1106-subagent-dispatch 的 `handlerBody` 认的是 2 空格缩进的入口，这里会对不上、
       退化成 4000 字窗口，从而把**后继 clear 通道里的 send** 误当成 cancel 自己的（假守卫）。 */
    const at = MAIN.indexOf('("slime:resident:subagent:cancel"');
    expect(at, "cancel 通道没取到").toBeGreaterThan(-1);
    const next = MAIN.indexOf("ipcMain.handle(", at + 40);
    const body = MAIN.slice(at, next >= 0 ? next : at + 4000);
    expect(body, "cancel 处理体没取到").toMatch(/subagents\.cancel\(/);
    expect(body, "排队中取消不广播 ⇒ 面板要等 3 秒轮询").toContain('mainWindow?.webContents.send("slime:resident:update", null);');
    expect(body, "排队中取消不落盘 ⇒ 重启后这条记录消失").toContain("syncSubagentRuns(subagents.list());");
    // 反例锚点：右界之后（下一个通道）不应被算进本块
    expect(body).not.toContain('("slime:resident:subagent:clear"');
  });

  /* ── 行为：真跑一遍 spawn，确认 pending 阶段就出声 ── */
  it("S5 行为：spawn 即在 pending 触发 onSpawn（并发槽位被占满时也必须出声）", async () => {
    const seen: Array<{ status: string }> = [];
    const mgr = new SubAgentManager(
      () => new Promise<string>(() => { /* 永不 settle：占住槽位 */ }),
      { concurrency: 1, hooks: { onSpawn: (run) => { seen.push({ status: run.status }); } } },
    );
    // ⚠️ 不传 timeoutMs：避免在测试进程里留下一个长定时器把整个 spec 拖住。
    const a = mgr.spawn({ name: "占位", task: "x" });
    const b = mgr.spawn({ name: "排队中", task: "y" });
    await new Promise((r) => setTimeout(r, 0));
    // a 与 b **都在 spawn 时**触发过 onSpawn；b 此刻仍应是 pending（并发=1，槽位被 a 占住）
    expect(seen.length, "onSpawn 没在 spawn 时触发").toBe(2);
    expect(seen[0]?.status).toBe("pending");
    expect(seen[1]?.status).toBe("pending");
    expect(mgr.status(b.id)?.status, "b 应当还在排队（pending）").toBe("pending");
    // 收尾：把两个都取消，避免测试进程里留悬空任务（cancel 是同步受理）
    mgr.cancel(a.id);
    mgr.cancel(b.id);
  });
});
