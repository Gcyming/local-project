#!/usr/bin/env node
/**
 * gui/scripts/mut-a1131-session-model.mjs — A-1131（同 Agent 不同会话可用不同模型）的变异验证。
 *
 *   1  `effectiveModelChoice` 忽略会话值（恒返回 Agent 值 ⇒ 用户报的 bug 原样复发）
 *   2  会话值为空时不回落 Agent（老会话全变成"没有模型"）
 *   3  不 trim（界面传来的带空格值会让路由失败）
 *   4  `runAgentFor` 不覆盖（收口点在、判据没了）
 *   5  `chat()` 绕过收口点（回退 findAgent）
 *   6  `stream()` 绕过收口点
 *   7  渲染层 `currentModel` 不看会话覆盖（切会话看到的还是同一个模型）
 *   8  切模型**只写 Agent**（= 原来那个"改一个会话、另一个会话跟着变"）
 *   9  切模型**只写会话**（新建会话会继承很久以前的陈旧模型）
 *   10 正常发送不带走会话级模型（req 少这一项）
 *   11 窗口上限用回 Agent 默认值（选了小窗口模型时贴着旧阈值照发）
 *   12 重试通路不带会话级模型（重试时模型被悄悄换掉）
 *   13 preload 通道名打错（静默失效）
 *   14 sessions 列表不带出 modelChoice（渲染层拿不到）
 *   15 清空覆盖时写成空串而不是 delete
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环：
 *      for i in $(seq 1 15); do node gui/scripts/mut-a1131-session-model.mjs --apply $i \
 *        && node node_modules/vitest/vitest.mjs run tests/core-ts/a1131-session-model.spec.ts \
 *             --config vitest.config.ts --reporter=dot; node gui/scripts/mut-a1131-session-model.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行。
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1131-session-model.spec.ts";
const F_SESSIONS = "core-ts/src/services/sessions.ts";
const F_CHAT = "core-ts/src/services/chat.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_APP = "gui/src/renderer/App.tsx";
const F_PRELOAD = "gui/src/preload/index.ts";
const TARGETS = [F_SESSIONS, F_CHAT, F_MAIN, F_APP, F_PRELOAD];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1131");

const MUTATIONS = [
  {
    name: "1 effectiveModelChoice 忽略会话值（用户报的 bug 原样复发）",
    file: F_SESSIONS,
    mutate: (t) => sub(t, "  if (s) { return s; }", "  if (false) { return s; }"),
  },
  {
    name: "2 会话值为空时不回落 Agent（老会话全变成没有模型）",
    file: F_SESSIONS,
    mutate: (t) => sub(t, "  return (agentChoice ?? \"\").trim();", "  return \"\";"),
  },
  {
    name: "3 不 trim（界面传来的带空格值会让路由失败）",
    file: F_SESSIONS,
    mutate: (t) => sub(t, "  const s = (sessionChoice ?? \"\").trim();", "  const s = sessionChoice ?? \"\";"),
  },
  {
    name: "4 runAgentFor 不覆盖（收口点在、判据没了）",
    file: F_CHAT,
    mutate: (t) => sub(t, "    return { ...agent, model_choice: override };", "    return agent;"),
  },
  {
    name: "5 chat() 绕过收口点（回退 findAgent）",
    file: F_CHAT,
    /* ⚠️ 锚点必须含 `this.registerSkillVisibility(agent);`（chat 独有）——
       chat() 与 stream() 的「runAgentFor → 空判 → 抛 404」三行**逐字节相同**，
       原本靠其后紧跟的那行区分；2026-10-05 注释剥离把中间那行注释变成了空行，
       而 stream() 那一侧根本没有 registerSkillVisibility ⇒ 少这一行就命中 2 次。
       实测：不含它 = 0 次（剥离后 systemPromptFor 前多了一个空行）；含它 = 1 次。 */
    mutate: (t) => sub(
      t,
      "    const agent = await this.runAgentFor(agentId, req.modelChoice);\n    if (!agent) {\n      throw new ChatServiceError(404, \"Agent 不存在\");\n    }\n    this.registerSkillVisibility(agent);\n    const systemPrompt = await this.systemPromptFor(agent);",
      "    const agent = await this.registry.findAgent(agentId);\n    if (!agent) {\n      throw new ChatServiceError(404, \"Agent 不存在\");\n    }\n    this.registerSkillVisibility(agent);\n    const systemPrompt = await this.systemPromptFor(agent);",
    ),
  },
  {
    name: "6 stream() 绕过收口点",
    file: F_CHAT,
    mutate: (t) => sub(
      t,
      "    const agent = await this.runAgentFor(agentId, req.modelChoice);\n    if (!agent) {\n      throw new ChatServiceError(404, \"Agent 不存在\");\n    }\n    const session = createStreamSession();",
      "    const agent = await this.registry.findAgent(agentId);\n    if (!agent) {\n      throw new ChatServiceError(404, \"Agent 不存在\");\n    }\n    const session = createStreamSession();",
    ),
  },
  {
    name: "7 渲染层 currentModel 不看会话覆盖（切会话看到的还是同一个模型）",
    file: F_APP,
    mutate: (t) => sub(t, "  const currentModel = (selectedSession?.modelChoice ?? \"\").trim()\n    || (agentConfig[selectedAgentId ?? \"\"]?.model_choice ?? \"inherit\");", "  const currentModel = agentConfig[selectedAgentId ?? \"\"]?.model_choice ?? \"inherit\";"),
  },
  {
    name: "8 切模型只写 Agent（= 改一个会话、另一个会话跟着变）",
    file: F_APP,
    mutate: (t) => sub(t, "        void apiSetSessionModel(selectedSession.sessionId, v);\n", ""),
  },
  {
    name: "9 切模型只写会话（新建会话会继承陈旧模型）",
    file: F_APP,
    mutate: (t) => sub(t, "        void updateAgentConfig({ model_choice: v });", "        void 0;"),
  },
  {
    name: "10 正常发送不带走会话级模型（req 少这一项）",
    file: F_MAIN,
    mutate: (t) => sub(t, "      modelChoice: brainMeta?.modelChoice,", "      modelChoice: undefined,"),
  },
  {
    name: "11 窗口上限用回 Agent 默认值（选了小窗口模型时贴着旧阈值照发）",
    file: F_MAIN,
    mutate: (t) => sub(t, "await resolveSessionWindowCap(agentId, runModelChoice)", "await resolveSessionWindowCap(agentId, loadingAgent?.model_choice ?? \"\")"),
  },
  {
    name: "12 重试通路不带会话级模型（重试时模型被悄悄换掉）",
    file: F_MAIN,
    mutate: (t) => sub(t, "      modelChoice: retryMeta?.modelChoice,", "      modelChoice: undefined,"),
  },
  {
    name: "13 preload 通道名打错（静默失效）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, '"slime:sessions:setModelChoice"', '"slime:sessions:setModelChoise"'),
  },
  {
    /* ⚠️ 这是**计数闸门**：守卫要求 sessions 的 list 与 load 两处都带出 modelChoice
       （少一处渲染层就拿不到）。所以用 `subAll` **两处一起撤** + 显式声明 `all: true` ——
       只撤一处会让核验器报「不唯一（命中 2 次，无法确定改的是哪一处）」。 */
    name: "14 列表与详情都不带出 modelChoice（渲染层拿不到）",
    file: F_MAIN,
    all: true,
    mutate: (t) => subAll(t, "        modelChoice: meta.modelChoice,\n", ""),
  },
  {
    name: "15 清空覆盖时写成空串而不是 delete",
    file: F_SESSIONS,
    mutate: (t) => sub(t, "    if (next) { meta.modelChoice = next; } else { delete meta.modelChoice; }", "    meta.modelChoice = next;"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

function runSpec() {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply" : "full";

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
    if (existsSync(manifestPath)) {
      console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore。"); process.exit(1);
    }
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
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1131")) { process.exit(1); }
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
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); console.error(res.out); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
