#!/usr/bin/env node
/**
 * gui/scripts/mut-a1096.mjs — A-1096/A-1097「子代理派发授权 + 执行模型池」守卫的变异验证。
 *
 * 要证的事（用户诉求）：「让主 Agent 可以自如地派发子代理，而不是独自工作」+
 *   「子代理模型只能指定一个太少，开个窗口让模型可以多选」。
 * 这两条链路的失效**全是静默的**：过 tsc、过构建、过全部逻辑测试，只在用户眼里表现为
 * 「主 Agent 还是什么都自己干」或「设置里选了模型但没人用」。所以逐条把判据改坏，要求守卫变红：
 *
 *   ① 三态判据塌成两态（`!== false` → `=== true`）⇒ 缺省被当成拒绝，开箱即用的人一个都派不出去；
 *   ② 预算退回 300s 字面量 ⇒ A-983 那个「把 4/4 步的工作掐掉」的元凶复活；
 *   ③ 分组标题改回硬编码旧文案 ⇒ 「用户选定」在实际语义下是**假描述**；
 *   ④ 提示段去掉「可点名换用」⇒ 池子只剩兜底档，「多选」变成摆设；
 *   ⑤ 规范化不再剔 `inherit` ⇒ 占位符混进档位表（A-975 修过的"能设置却不生效"同形）；
 *   ⑥ 规范化不再去重 ⇒ 同一档位重复列出，优先级语义错乱；
 *   ⑦ spawn 不再用池首 ⇒ 兜底档整个失效；
 *   ⑧ 工具层自建一套清单渲染 ⇒ 系统提示与工具回执两套说法（正是要消灭的"两个产地"）；
 *   ⑨ 装配层不再按 Agent 授权注册 ⇒ 回到"自建 Agent 永远派不到"；
 *   ⑩ Agent 详情用 `?? true` 兜住 ⇒ 三态塌成一态，用户看不到"未设置"；
 *   ⑪ 三处内置预算又写回字面量（**整组**：计数闸门，必须一起改才是那个缺陷）；
 *   ⑫ chat.ts 把编译期恒假的清单判据加回来 ⇒ 回到"清单可用性判断永远为假"；
 *   ⑬ Agent 设置不落库开关 / resident 面板退回单值下拉；
 *   ⑭ preload 通道名改坏 ⇒ 渲染层调用永远静默失败（只有类型声明是真的）。
 *
 * ⚠️ 中文句子里不夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原走**字节**；还原后比 sha256，带 SIGINT 保险。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环 + `--restore`。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1096-subagent-dispatch.spec.ts"];

const F_CATALOG = "core-ts/src/services/subagentCatalog.ts";
const F_SUBAGENT = "core-ts/src/services/subagent.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_CHAT = "core-ts/src/services/chat.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_AGENTS_PANEL = "gui/src/renderer/pages/AgentsPanel.tsx";
const F_RESIDENT_PANEL = "gui/src/renderer/pages/ResidentPanel.tsx";
const F_PRELOAD = "gui/src/preload/index.ts";
const TARGETS = [F_CATALOG, F_SUBAGENT, F_BUILTIN, F_CHAT, F_MAIN, F_AGENTS_PANEL, F_RESIDENT_PANEL, F_PRELOAD];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1096");

/* ── 锚点（多行用**拼接字面量**：`check-mut-anchors.mjs` 的 constMap 能解析；
 *    写成函数调用会被判「未核验」= 没人核验）。 ─────────────────────────── */
const ALLOW_JUDGE = "  return agent.subagent_dispatch !== false;";
const DEF_TIMEOUT = "    timeoutMs: DEFAULT_EXEC_BUDGET_MS,";
const LABEL_LINE = "    lines.push(`${SUBAGENT_CATALOG_LABELS.agents}：`);";
const POOL_BRANCH =
  "  if (pool.length > 1) {\n"
  + "    lines.push(`可点名换用：${pool.slice(1).join(\" / \")}`);";
const POOL_INHERIT = "    if (!v || v === \"inherit\") { continue; }";
const POOL_DEDUPE = "    if (out.includes(v)) { continue; }";
const FALLBACK_TIER = "    const fallbackTier = this.defaultModels[0] ?? \"\";";
/* ⚠️ 本锚点**必须跨过中间那 4 行 A-1096 修复注释**（L511–514 夹在 `outputSchema` 与
   `networkEnabled` 之间）。旧版把这两行直接拼起来 ⇒ 恒「未命中」= 那条守卫**从未被变异过**，
   而核验器只会说"源码漂移了"（指向错误对象）。
   收尾用函数之后那两行 banner（`// 派发 / 查询 / 取消 / 等待` 在本文件**仅 1 处**；
   分隔线那行不能省 —— 省了就落到 `spawn()` 尾部那段**同形**代码上，实测 count=0）。
   ⚠️ 分隔线本身在文件里出现多次，**唯一性来自整体组合**，不是来自单行。 */
const SPAWNFROM_NET =
  "      networkEnabled: overrides.networkEnabled,\n"
  + "    });\n"
  + "  }\n"
  + "\n"
  + "  // -------------------------------------------------------------------------\n"
  + "  // 派发 / 查询 / 取消 / 等待";
const BUILTIN_SHARED = "  return renderSubagentCatalogLines(groupSubagentCatalog(cat)).join(\"\\n\");";
const BUILTIN_LOCAL =
  "  const user = cat.filter((c) => c.source === \"user\");\n"
  + "  return [\"用户选定的子代理（优先）：\", ...user.map((c) => `- ${c.name}：${c.description}`)].join(\"\\n\");";
/* ⚠️ **A-1106 迁移（2026-09-25）**：登记逻辑被收进唯一的模块级 `syncDispatchableSubagents(mgr)`，
   该行的缩进由 **8 空格变成 2 空格** ⇒ 旧锚点（含前导空白）「未命中」= 这条守卫**静默失去保护**
   （本轮 `check-mut-anchors` **全量**实测抓出来的，报「未命中 1」）。
   **修法：锚点去掉装饰性空白**，只锚内容 —— 从此与缩进无关（铁律：「锚点不依赖装饰性空白」）。
   迁移后必须**实测复跑**证明仍能捕获（见文件尾部 README 的复跑记录）。 */
const MAIN_DISPATCHABLE = "const defs = dispatchableSubagentDefinitions(agentRegistry?.loadedAgents ?? []);";
/* ⚠️ 必须带上类型断言后缀 `as boolean | undefined`（真源码 L5187 就是这一行）——
   少写后缀即恒「未命中」。 */
const MAIN_DETAIL_FIELD = "      subagent_dispatch: a.subagent_dispatch as boolean | undefined,";
const MAIN_REGISTER_BUDGET = "        timeoutMs: DEFAULT_EXEC_BUDGET_MS,";
/* A-1106 迁移：原 `CHAT_TAIL`（chat.ts 里委派规范的最后一句）随规范一起搬到了
 * `core-ts/src/services/subagentCatalog.ts::DELEGATION_GUIDANCE`，chat.ts 已无此字面
 * ⇒ 该常量成死代码，删掉（留着会让下一个人以为它还在保护什么）。 */
const PANEL_SECONDS_SAVE =
  "      if (detail.subagent_dispatch !== undefined) { patch.subagent_dispatch = detail.subagent_dispatch; }";
/* ⚠️ A-1098 迁移（2026-09-24）：`subagentSetModels` 的**实参**由 `defaultModels`（已保存池）
   改成 `draftModels`（弹层草稿池）—— 因为 4s 轮询会用服务端快照覆盖 `defaultModels`，
   弹层里未保存的勾选会被回滚（用户实测「过几秒就自动取消勾选了」）。
   **守卫的意图没变**：resident 面板必须走**多选**通道 `subagentSetModels`，
   不许退回单值 `subagentSetDefaultModel`（那就是 A-1097 之前的"两套真相源"）。
   故只同步实参名；M14b 的 `to` 侧仍写 `defaultModels` 也成立（它要证明的是**通道错了**，
   而不是实参错了 —— 实参归 A-1098 的 `mut-a1098.mjs` M7 管）。

   ⚠️ **A-1100 再迁移（2026-09-24）**：那次提交调用改走**安全口** `tryInvoke`
   （`const r: any = asReply(await tryInvoke(() => api.resident?.subagentSetModels?.(draftModels)));`）。
   本锚点**必须跟着改**：不改的话它"未命中"，14b 这条变异从此**静默失去保护**
   （核验器报红是对的 —— 它正是为此存在的；实测这次就是被 `check-mut-anchors` 抓出来的）。
   ⚠️ 同时也让 `to` 侧**保留安全口形态**：只改通道名，把"通道错了"这一个变量单独隔离出来
   （若顺手退回裸 await，红的原因就变成 A-1100 那条了 —— **弱化变异体**：
   红了，却不是因为这条变异名字要证明的那件事）。 */
const RESIDENT_SETMODELS = "const r: any = asReply(await tryInvoke(() => api.resident?.subagentSetModels?.(draftModels)));";
const PRELOAD_CHANNEL = "      ipcRenderer.invoke(\"slime:resident:subagent:setModels\", { models })";

const MUTATIONS = [
  {
    name: "1 三态塌成两态（缺省被当成拒绝 ⇒ 开箱即用一个子代理都派不出去）",
    file: F_CATALOG,
    mutate: (t) => sub(t, ALLOW_JUDGE, "  return agent.subagent_dispatch === true;"),
  },
  {
    name: "2 定义预算退回 300s 字面量（A-983「把 4/4 步的工作掐掉」的元凶复活）",
    file: F_CATALOG,
    mutate: (t) => sub(t, DEF_TIMEOUT, "    timeoutMs: 300_000,"),
  },
  {
    name: "3 分组标题硬编码回旧文案（「用户选定」在实际语义下是假描述）",
    file: F_CATALOG,
    mutate: (t) => sub(t, LABEL_LINE, "    lines.push(\"用户选定的子代理（优先用）：\");"),
  },
  {
    name: "4 提示段去掉「可点名换用」（池子只剩兜底档，多选变摆设）",
    file: F_CATALOG,
    mutate: (t) => sub(t, POOL_BRANCH, "  if (false) {"),
  },
  {
    name: "5 规范化不再剔 inherit（占位符混进档位表）",
    file: F_SUBAGENT,
    mutate: (t) => sub(t, POOL_INHERIT, "    if (!v) { continue; }"),
  },
  {
    name: "6 规范化不再去重（同一档位重复列出，优先级语义错乱）",
    file: F_SUBAGENT,
    mutate: (t) => sub(t, POOL_DEDUPE, "    if (false) { continue; }"),
  },
  {
    name: "7 spawn 不再用池首（兜底档整个失效）",
    file: F_SUBAGENT,
    mutate: (t) => sub(t, FALLBACK_TIER, "    const fallbackTier = \"\";"),
  },
  {
    name: "8 spawnFromDef 漏传 networkEnabled（关了联网的子代理照样联网）",
    file: F_SUBAGENT,
    mutate: (t) => sub(t, SPAWNFROM_NET, "    });\n  }\n\n  // -------------------------------------------------------------------------\n  // 派发 / 查询 / 取消 / 等待"),
  },
  {
    name: "9 工具层自建一套清单渲染（系统提示与工具回执两套说法）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, BUILTIN_SHARED, BUILTIN_LOCAL),
  },
  {
    name: "10 装配层不再按 Agent 授权注册（自建 Agent 永远派不到）",
    file: F_MAIN,
    mutate: (t) => sub(t, MAIN_DISPATCHABLE, "const defs = [];"),
  },
  {
    name: "11 Agent 详情用 ?? true 兜住三态（用户看不到「未设置」）",
    file: F_MAIN,
    mutate: (t) => sub(t, MAIN_DETAIL_FIELD, "      subagent_dispatch: a.subagent_dispatch ?? true,"),
  },
  {
    name: "12 三处内置预算又写回 300_000 字面量（整组：计数闸门必须一起改）",
    file: F_MAIN,
    all: true,
    mutate: (t) => subAll(t, MAIN_REGISTER_BUDGET, "        timeoutMs: 300_000,"),
  },
  {
    name: "13 chat.ts 把编译期恒假的清单判据加回来（清单可用性判断永远为假）",
    file: F_CHAT,
    // A-1106 锚点迁移：委派规范整段迁到 `services/subagentCatalog.ts::DELEGATION_GUIDANCE`
    //（单一出处，与 `Engine.buildSystem` 共用），chat.ts 里只剩一行 `sys += ... DELEGATION_GUIDANCE`。
    // 原意图「把编译期恒假的清单可用性判据加回来」逐字保留 —— 恒假判据仍是
    // `sys.includes("## 可用子代理")`，仍写进 chat.ts（被 a1096 spec 的 not.toContain 锁住）。
    mutate: (t) => sub(
      t,
      'sys += "\\n\\n" + DELEGATION_GUIDANCE;',
      'sys += "\\n\\n" + DELEGATION_GUIDANCE + (sys.includes("## 可用子代理") ? "" : "（没有清单就留空）");',
    ),
  },
  {
    name: "14a Agent 设置不落库派发开关（开关只是本地态，重启即失效）",
    file: F_AGENTS_PANEL,
    mutate: (t) => sub(t, PANEL_SECONDS_SAVE, ""),
  },
  {
    name: "14b resident 面板退回单值下拉入口（两套写法 = 两套真相源）",
    file: F_RESIDENT_PANEL,
    mutate: (t) => sub(t, RESIDENT_SETMODELS, "const r: any = asReply(await tryInvoke(() => api.resident?.subagentSetDefaultModel?.(defaultModels)));"),
  },
  {
    name: "14c preload 通道名改坏（渲染层调用永远静默失败）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, PRELOAD_CHANNEL, "      ipcRenderer.invoke(\"slime:resident:subagent:setModelsTYPO\", { models })"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
  return { ok: true, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) { console.error("上一轮的变异还没还原 —— 先跑 --restore。"); process.exit(1); }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，全量模式跑不了。"); process.exit(1); }
if (!base.ok) { console.error(`基线未通过（${base.spec}）。`); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败。"); process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1096")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
