/**
 * A-1069 变异测试（#226 收口）：「Agent 启动的后台进程」面板，逐环改坏要求守卫变红。
 *
 * 覆盖 `tests/core-ts/a1069-agentprocs.spec.ts`。用户原话：「请把 Agent 停下时的后台进程
 * 做一个……在输入栏上方的按钮，而且点击后可以展开」，范围是「仅 Agent 启动的进程」。
 *
 * A 组：纯模块判据（范围 / 三类真源 / 终态过滤 / 排序 / 时长 / 状态词 / 停止请求校验）
 * B 组：接线事实（面板在输入框上方 / 判据不在渲染层 / 订阅不轮询 /
 *       主进程现算 + 先校验 / 取数范围 / 回合结束广播 / 三处通道名一致）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 * ⚠️ B 组改的是 `.tsx` / `index.ts` 的**文本**（守卫按文本读，不 import），
 *   所以那些变异只在文本层生效 —— 这正是要锁的东西。
 *
 * 用法：node gui/scripts/mut-a1069.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, nlOf, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1069-agentprocs.spec.ts";
const MODULE = "core-ts/src/services/agentProcs.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const MAIN = "gui/src/main/index.ts";
const PRELOAD = "gui/src/preload/index.ts";
const TARGETS = [MODULE, PANEL, MAIN, PRELOAD];

/** 把 `[start, end)` 那段搬到 `afterMarker` 之后 —— 只有「搬位置」类变异需要它。
 *  `sub` 只认字面量，70 行的 JSX 块逐字写进锚点不现实（且一改缩进就失效）。
 *  ⚠️ 三个锚点都必须是**能唯一命中的字面量**；命中不了就原样返回（主流程按"未命中"报错）。 */
function moveAfter(text, startMarker, endMarker, afterMarker) {
  const p = text.indexOf(startMarker);
  const e = text.indexOf(endMarker);
  if (p < 0 || e < 0 || p >= e) { return text; }
  const block = text.slice(p, e);
  const rest = text.slice(0, p) + text.slice(e);
  const at = rest.indexOf(afterMarker);
  if (at < 0) { return text; }
  const cut = at + afterMarker.length;
  return rest.slice(0, cut) + nlOf(text) + block + rest.slice(cut);
}

const MUTATIONS = [
  // ── A 纯模块判据 ───────────────────────────────────────────────────────────
  {
    name: "A1 范围判据放开（应用自身服务也被当成 Agent 启动的 → 用户以为关掉只是停个任务）",
    file: MODULE,
    mutate: (t) => sub(t, "  return (AGENT_PROC_KINDS as readonly string[]).includes(kind);", "  return true;"),
  },
  {
    name: "A2 图形控制宿主那一段不产出条目（Agent 起过的那个常驻进程永远看不见）",
    file: MODULE,
    mutate: (t) => sub(t, "  const host = src.screenHost;\n  if (host) {", "  const host = src.screenHost;\n  if (false) {"),
  },
  {
    name: "A3 本地服务那一路整段不产出（http_serve 起的服务在面板上消失）",
    file: MODULE,
    mutate: (t) => sub(t, "  for (const s of src.httpServers ?? []) {", "  for (const s of [] as HttpServerSource[]) {"),
  },
  {
    name: "A4 子代理终态不过滤（点停止却什么都没发生 —— 它早就结束了）",
    file: MODULE,
    mutate: (t) => sub(t, "    if (!isSubagentLive(a.status)) { continue; }", "    if (false) { continue; }"),
  },
  {
    name: "A5 isSubagentLive 恒真（终态与未知状态都算「还在跑」）",
    file: MODULE,
    mutate: (t) => sub(t, '  return status === "running" || status === "pending";', "  return true;"),
  },
  {
    name: "A6 排序忽略类别（顺序随机 → 同一类的东西被拆散，用户扫不动）",
    file: MODULE,
    mutate: (t) => sub(t, "    const d = rank(x.kind) - rank(y.kind);", "    const d = 0;"),
  },
  {
    name: "A7 类别排序反了（面板分组顺序与声明的顺序相反）",
    file: MODULE,
    mutate: (t) => sub(t, "  const rank = (k: AgentProcKind): number => AGENT_PROC_KINDS.indexOf(k);", "  const rank = (k: AgentProcKind): number => -AGENT_PROC_KINDS.indexOf(k);"),
  },
  {
    name: "A8 负时长照实显示（时钟回拨时面板出现「-10 秒」）",
    file: MODULE,
    mutate: (t) => sub(t, '  if (ms < 1000) { return "刚刚"; }', '  if (ms < 1000 && ms >= 0) { return "刚刚"; }'),
  },
  {
    name: "A9 拿不到启动时刻时不返回空串（面板上出现 NaN 小时 NaN 分）",
    file: MODULE,
    mutate: (t) => sub(t, '  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(now)) { return ""; }', "  if (false) { return \"\"; }"),
  },
  {
    name: "A10 状态词映射说反话（已完成的子代理被显示成「运行中」）",
    file: MODULE,
    mutate: (t) => sub(t, '    case "done": return "已完成";', '    case "done": return "运行中";'),
  },
  {
    name: "A11 未知类别不再拒绝（手改的 IPC 参数会走到不存在的分支，而界面已乐观划掉）",
    file: MODULE,
    mutate: (t) => sub(t, "  if (!isAgentStartedKind(kind)) {", "  if (false) {"),
  },
  {
    name: "A12 需要 id 的类别不再校验 id（停哪个无从谈起，却返回成功）",
    file: MODULE,
    mutate: (t) => sub(t, "  if (!id) {\n    return { ok: false, reason: `${AGENT_PROC_KIND_LABELS[kind]}缺少 id（无法确定要停哪一个）` };", "  if (false) {\n    return { ok: false, reason: `${AGENT_PROC_KIND_LABELS[kind]}缺少 id（无法确定要停哪一个）` };"),
  },
  {
    name: "A13 id 不再 trim（界面传来的带空格 id 会导致停不掉）",
    file: MODULE,
    mutate: (t) => sub(t, '  const id = typeof req.id === "string" ? req.id.trim() : "";', '  const id = typeof req.id === "string" ? req.id : "";'),
  },
  {
    name: "A14 全局唯一的宿主也接受 id（调用方搞错了对象却照样通过）",
    file: MODULE,
    mutate: (t) => sub(t, '    return { ok: true, action: AGENT_PROC_STOP_ACTIONS[kind], id: "" };', '    return { ok: true, action: AGENT_PROC_STOP_ACTIONS[kind], id: typeof req.id === "string" ? req.id : "" };'),
  },
  {
    name: "A15 视图按真源做记忆化（面板 pop 一下就把下一次派生的条目也吃掉了 → 视图与真源共享可变结构）",
    file: MODULE,
    mutate: (t) => sub(
      sub(
        t,
        "export function buildAgentProcView(src: AgentProcSources, now: number): AgentProcView {",
        "const __MEMO = new Map<object, AgentProcView>();\nexport function buildAgentProcView(src: AgentProcSources, now: number): AgentProcView {\n  const __hit = __MEMO.get(src as object); if (__hit) { return __hit; }",
      ),
      "  return { count: entries.length, any: entries.length > 0, entries };",
      "  const __out = { count: entries.length, any: entries.length > 0, entries }; __MEMO.set(src as object, __out); return __out;",
    ),
  },

  // ── B 接线事实 ────────────────────────────────────────────────────────────
  {
    name: "B1 坞被搬到输入框**下方**（用户要的是「输入栏上方」—— 位置错了等于没做）",
    file: PANEL,
    /* A-1074 迁移：搬的对象从"通栏按钮块"变成**整个坞**（坞是输入框的前一个兄弟）。
       只搬 `{agentProcs?.any && (` 那段会把坞的容器留在原地 → 搬完是一段坏 JSX（假红：解析失败）。 */
    mutate: (t) => moveAfter(
      t,
      /* A-1078：坞已移出输入框圆角框并多包了一层条件/fragment → 缩进变了。
         锚点**不带缩进**（§6.1：别依赖装饰性空白）。 */
      '<div className="float-dock">',
      "<textarea ref={inputRef}",
      '          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 10px" }}>',
    ),
  },
  {
    name: "B2 渲染条件不再绑 `any`（没有后台资源时输入框上方照样多一条空壳）",
    file: PANEL,
    mutate: (t) => sub(t, "{agentProcs?.any && (", "{agentProcs && ("),
  },
  {
    name: "B3 展开态丢失（点击展不开 —— 用户明确要「点击后可以展开」）",
    file: PANEL,
    /* A-1074 迁移：展开态从局部布尔 `setProcsOpen` 改为坞的单值判据 `toggleDockSlot("procs")`。 */
    mutate: (t) => sub(t, 'onClick={() => toggleDockSlot("procs")}', "onClick={() => void 0}"),
  },
  {
    name: "B4 条目循环丢失（展不开也等于没有）",
    file: PANEL,
    mutate: (t) => sub(t, "                    {agentProcs.entries.map((e, i) => (", "                    {([] as never[]).map((e: never, i: number) => ("),
  },
  {
    name: "B5 类别判据搬进渲染层（组件里出现 screen-host 字面量 → 显示的与主进程认为的会漂移）",
    file: PANEL,
    /* A-1074 迁移：原锚点（`<div style={{ padding: "8px 12px 0" }}>` 那个通栏块）已随坞重构消失。
       改锚到坞面板卡片的标题行 —— 判据"渲染层不许出现类别字面量"与锚点位置无关，意图不变。 */
    mutate: (t) => sub(t, "                      }}>Agent 启动的后台资源</div>", '                      }}>{void "screen-host"}Agent 启动的后台资源</div>'),
  },
  {
    name: "B6 类别名不再取自主进程（面板上的类别标签消失）",
    file: PANEL,
    mutate: (t) => sub(t, ">{e.kindLabel}</span>", '>{""}</span>'),
  },
  {
    name: "B7 时长不再取自主进程（看不到「跑了多久」）",
    file: PANEL,
    mutate: (t) => sub(t, ">{e.elapsed}</span>", '>{""}</span>'),
  },
  {
    name: "B8 状态词不再取自主进程（看不到「监听中 / 运行中」）",
    file: PANEL,
    mutate: (t) => sub(t, ">{e.status}</span>", '>{""}</span>'),
  },
  {
    name: "B9 条目的停止入口没接线（面板只能看不能收，等于半成品）",
    file: PANEL,
    mutate: (t) => sub(t, "                          onClick={() => stopAgentProc(e.kind, e.id || undefined)}", "                          onClick={() => void 0}"),
  },
  {
    name: "B10 停止没走主进程 IPC（界面自己划掉，与真实状态分家）",
    file: PANEL,
    /* ⚠️ 首版写成 `if (false) void api.agentProcs.stop(...)` —— 那是**诱饵**：被锁的字串还在，
       守卫照样绿。变异必须**真的把它删掉**（同 mut-a1068 A1 的教训）。 */
    mutate: (t) => sub(t, "    void api.agentProcs.stop(kind, id).then((r: AgentProcsStopResult) => {", '    void Promise.resolve({ ok: true, detail: "stub" } as AgentProcsStopResult).then((r: AgentProcsStopResult) => {'),
  },
  {
    name: "B11 停止后不再重新取视图（面板停在乐观猜测的状态）",
    file: PANEL,
    mutate: (t) => sub(t, "      return api.agentProcs.list().then((l: AgentProcsListResult) => {", "      return Promise.resolve({ ok: true, view: { count: 0, any: false, entries: [] } } as unknown as AgentProcsListResult).then((l: AgentProcsListResult) => {"),
  },
  {
    name: "B12 不再订阅广播（起了新服务面板不会自己更新）",
    file: PANEL,
    mutate: (t) => sub(t, "api.agentProcs.onChanged(load)", "void load"),
  },
  {
    name: "B13 加了轮询（本项目明确要求事件驱动；轮询把「实时」变成「最多晚 N 秒」）",
    file: PANEL,
    mutate: (t) => sub(t, "    load();\n    const off = typeof api.agentProcs.onChanged", "    load();\n    setInterval(load, 3000);\n    const off = typeof api.agentProcs.onChanged"),
  },
  {
    name: "B14 主进程 list 不再现算（返回空视图 → 面板永远空）",
    file: MAIN,
    mutate: (t) => sub(t, "      const view = buildAgentProcView(await collectAgentProcSources(), Date.now());", "      const view = { count: 0, any: false, entries: [] };"),
  },
  {
    name: "B15 stop 不再校验（手改的 IPC 参数走到不存在的分支，静默什么都不做）",
    file: MAIN,
    mutate: (t) => sub(t, '    const plan = planAgentProcStop({ kind: p?.kind ?? "", id: p?.id });', '    const plan = { ok: true, action: p?.kind, id: p?.id ?? "" } as unknown as ReturnType<typeof planAgentProcStop>;'),
  },
  {
    name: "B16 校验了却不据此拒绝（等于没校验）",
    file: MAIN,
    mutate: (t) => sub(t, "    if (!plan.ok) { return { ok: false, error: plan.reason }; }", "    if (false) { return { ok: false, error: plan.reason }; }"),
  },
  {
    name: "B17 stop 不按动作分派（自己 switch 类别 → 判据又长回主进程里）",
    file: MAIN,
    mutate: (t) => sub(t, '      if (plan.action === "dispose-screen-host") {', '      if (plan.id === "") {'),
  },
  {
    name: "B18 取数少了一路（本地服务那一类在面板上永远为 0）",
    file: MAIN,
    mutate: (t) => sub(t, "      httpServer.list().catch(() => []),", "      Promise.resolve([]),"),
  },
  {
    name: "B19 取数里混进了应用自身服务（用户会以为关掉它只是停个任务，实际是把应用拆了）",
    file: MAIN,
    mutate: (t) => sub(t, "    return {\n      screenHost: desktopBackend.residentHost?.() ?? null,", "    const llamaPid = 0; void llamaPid;\n    return {\n      screenHost: desktopBackend.residentHost?.() ?? null,"),
  },
  {
    name: "B20 回合结束不广播（用户「停下 Agent」后看到的是上一帧的旧列表）",
    file: MAIN,
    mutate: (t) => sub(t, "        broadcastAgentProcs();\n      }", "        void 0;\n      }"),
  },
  {
    name: "B21 通道名一端打错（tsc 不报、构建不报 —— 静默失效）",
    file: PRELOAD,
    mutate: (t) => sub(t, '"slime:agentprocs:changed"', '"slime:agentprocs:change"'),
  },
];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(join(ROOT, t))]));

if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1069")) { process.exit(1); }

/** 引号自伤自检（A-1056）：**剥注释后**仍出现「CJK + ASCII 双引号 + CJK」才算坏。
 *  ⚠️ 判据必须**两侧都 CJK**（单侧命中是合法的 `it("中文…")`），且必须**先剥注释**。
 *  ⚠️ 只扫**本次写的东西**（新守卫 + 新纯模块 + 本脚本）：整文件扫 `main/index.ts` 会把
 *     一堆**早就在那儿**的模板串（`…"进行中"但…`）报出来 —— 那是既有代码，不属于本次改动，
 *     强行改它等于范围蔓延。自检要挡的是"我新写的锚点/断言会不会自伤"。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of [SPEC, MODULE, "gui/scripts/mut-a1069.mjs"]) {
  const bad = quoteSelfHarm(readFileSync(join(ROOT, rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 引号自伤自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpec();
    writeFileSync(path, src);
    if (green) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  for (const [t, src] of originals) { writeFileSync(join(ROOT, t), src); }
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
