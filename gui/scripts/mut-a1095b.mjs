#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095b.mjs — A-1095③（返工②）「装配可见性 + 工具面」守卫的变异验证。
 *
 * 用户原话：「顺手看一下子代理派发还在不在 Agent-Loop 循环，好久没看见了」。
 * 本组变异要证的是**「能不能核对」这件事本身有守卫**（属静默失效家族：
 * 过 tsc / 过构建 / 过全部逻辑测试，只在用户眼里表现为"某个能力悄悄没了"）：
 *   ① 删掉接线点 `setSubagentManager(subagents)` ⇒ `delegate_subagent` 恒回"未就绪"，
 *      而工具还在、提示词还在 —— 最典型的"少一条腿"；
 *   ② 删掉装配成功日志 ⇒ 回到"成功一声不响"，下次再问"派发还在不在"只能靠猜；
 *   ③ catch 文案退回「不影响主流程」⇒ 归因指向**错误对象**（把"Agent-Loop 少一条腿"
 *      报成"定时任务没起来"，用户看不到任何线索）；
 *   ④ 删掉判假分支的出声 ⇒ 回到"整块被静默跳过、一个日志都不打"；
 *   ⑤ 工具面收紧（把委派工具从白名单里摘掉）⇒ 模型永远拿不到 `delegate_subagent`，
 *      "子代理派发好像消失了"，而既有测试（用**合成名单**验 agentToolsOnly）**照样全绿** ——
 *      第 5 条正是要证明"组合"那一层现在也有人守着了。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原走**字节**；还原后比 sha256，带 SIGINT 保险。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环 + `--restore`。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/subagent-wiring.spec.ts",
  "tests/core-ts/agent-tools.spec.ts",
];

const F_MAIN = "gui/src/main/index.ts";
const F_TOOLS = "core-ts/src/services/agentTools.ts";
const TARGETS = [F_MAIN, F_TOOLS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095b");

/* ── 锚点（多行用**拼接字面量**：`check-mut-anchors.mjs` 的 constMap 能解析，
 *    写成 `subLines(...)` 会被判「锚点写法未识别」= 未核验 = 没人核验）。 ─────────── */
const WIRE_LINE = "      setSubagentManager(subagents);";
/* ⚠️ A-1096 迁移（2026-09-24）：装配日志文案随「第二真相源退役」改写。
 *    原锚点打的是 `…（可用定义 ${…} 个；用户选定项随后异步补登）`——
 *    「随后异步补登」那个语义已不存在（现在是 `setUserSelected(全部被授权的 Agent)` 一次性注册），
 *    故锚点同步成新文案。**守卫的意图没变**：这条日志必须存在（=「成功要出声」，见 §8.6 迁移规矩）。 */
const WIRE_LOG =
  "      console.log(`[subagent] 装配完成：SubAgentManager 已接线 delegate_subagent"
  + "（可用定义 ${subagents.catalog().length} 个 = 内置 3 + 被授权派发的自建 Agent）`);";
const CATCH_HEAD =
  "      \"[scheduler] 定时唤醒装配失败 —— ⚠️ 同块内的子代理装配 / 事件端点 / 后台任务 IPC 一并被跳过\"";
const ELSE_WARN =
  "        \"[scheduler] data/schedules.json 不是数组且无运行态快照 —— 跳过定时唤醒装配\"";
const TOOLFACE_GUARD =
  "    if (!name.startsWith(\"mcp_\")) {\n"
  + "      return true; // 内置工具 + skill 入口全保留\n"
  + "    }";

const MUTATIONS = [
  {
    name: "1 删掉接线点 setSubagentManager（delegate_subagent 恒回「未就绪」，工具与提示词却都在）",
    file: F_MAIN,
    mutate: (t) => sub(t, WIRE_LINE, "      /* 变异：接线点被删 */"),
  },
  {
    name: "2 删掉装配成功日志（回到「成功一声不响」）",
    file: F_MAIN,
    mutate: (t) => sub(t, WIRE_LOG, ""),
  },
  {
    name: "3 catch 文案退回「不影响主流程」假安慰（归因指向错误对象）",
    file: F_MAIN,
    mutate: (t) => sub(t, CATCH_HEAD, "      \"[scheduler] 启动失败（不影响主流程）\""),
  },
  {
    name: "4 删掉判假分支的出声（回到整块被静默跳过、一个日志都不打）",
    file: F_MAIN,
    mutate: (t) => sub(t, ELSE_WARN, ""),
  },
  {
    name: "5 工具面收紧：把委派工具从白名单摘掉（模型永远拿不到 delegate_subagent）",
    file: F_TOOLS,
    mutate: (t) => sub(
      t,
      TOOLFACE_GUARD,
      "    if (!name.startsWith(\"mcp_\")) {\n"
      + "      return name !== \"delegate_subagent\" && name !== \"subagent_result\";\n"
      + "    }",
    ),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095b")) { process.exit(1); }
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
