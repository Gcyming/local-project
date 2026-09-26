#!/usr/bin/env node
/**
 * gui/scripts/mut-a1114.mjs — A-1114（临时子代理 / inline spec，用户点名的需求 #306）的变异验证。
 *
 * ## 修的是
 *
 * 用户原话：「主 Agent 会派子代理吗？如果没有多余预设的 Agent，slime 可以自己临时编辑需要的
 * Agent 作为临时子代理派发吗？这些都是要写进 Agent-Loop 中的环节啊。」
 *
 * 落地语义四条边界：**不落盘 · 不进清单 · 不参与路由 · 跑完即弃**。
 * 顺带堵掉两个**真缺陷**（不是顺手重构，都是"内联 spec 让新数据第一次由模型决定"暴露出来的）：
 *   ① `gui/src/main/index.ts` 里 `def.toolsOnly` 是**原样直通**给引擎的（`??` 左边直接透传）
 *      ⇒ 内联 `tools` 只要写 ["delegate_subagent"]，A-980-R30 的深度守卫（子代理不得再派子代理）
 *      当场失效（每层 3 并发 → 指数级套娃）；
 *   ② 产物文件名里第一次出现**模型可控**的一段 ⇒ `a/b` 会多一层目录、`..` 会逃出 data/generated，
 *      两者都让 `writeFileSync` 抛异常，而报错只指向路径，看不出是名字的问题。
 *
 * ## 覆盖的条目（每条都在问：动了哪一条判据会**静默退化**）
 *
 *   1  adhoc 判据挪到路由之后（现场人设被清单里语义相近的人顶替 —— 派给了别人）
 *   2  判据漏掉 toolsOnly（只给 tools 的现场定义被当成"没定义"）
 *   3  判据去掉「必须有定义内容」（只给 name 也变临时代理 ⇒ 绕开点名/自动路由）
 *   4  合成时不带 adhoc 标记（审计里假归因）
 *   5  spawn 里 definitionName 守卫去掉（临时代理名字撞上注册定义 ⇒ 记成用了那个定义）
 *   6  自动名前缀不区分（临时代理与通用兜底混成一个名字）
 *   7  偷懒实现：adhoc 时先 register 一个临时定义（清单被污染 + 不是「不落盘」）
 *   8  工具层不置 adhoc 标记（能力存在但走不到）
 *   9  工具层 name 无条件透传（改展示名不该有副作用）
 *  10  工具层判据漏掉 tools（与 2 同族，另一处产地）
 *  11  工具 schema 少 systemPrompt 入参（模型根本传不进来 = 死功能）
 *  12  深度守卫回到直通（内联 tools 可绕开套娃防护）
 *  13  深度守卫只过滤一条分支（两条分支两个口径）
 *  14  落盘名不过 sanitize（模型给个 `a/b` 就把整个子代理判失败）
 *  15  sanitize 少了 `..` 收敛（路径逃逸口）
 *  16  sanitize 少了空名兜底（写出 `subagent--stamp.md` 这种不可归因的文件）
 *  17  sanitize 不截断（模型给两千字的名字 ⇒ 超长文件名）
 *  18  委派规范删掉「临时子代理」段（能力存在但模型不知道 = 死开关）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）—— 本文件里的 ASCII 引号只用于**代码字面量**。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ `core-ts/src/tools/builtin.ts` 实测是 **CRLF**，其余三个是 LF ⇒ 多行锚点必须走 `sub`
 *    （行尾无关，见 `_mut-eol.mjs`；`subLines` 同理）。
 * ⚠️ **判据 = exit≠0 且输出里真有 `Tests` 汇总行**（只有 exit≠0 时，
 *    「vitest 启动失败 / 配置加载失败」会被误当成「变异被捕获」—— 本仓 §26 实测踩过）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1114.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1114.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1114.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1114.mjs --restore   # 按 manifest 逐字节还原
 *
 * 本环境禁止 node→node 孙进程（spawnSync 报 EBUSY）⇒ 全量模式跑不了，改用 shell 循环：
 *
 *   for i in $(seq 1 18); do
 *     node gui/scripts/mut-a1114.mjs --apply $i || exit 1
 *     node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *       tests/core-ts/a1114-adhoc-subagent.spec.ts --reporter=dot > /tmp/m$i.txt 2>&1
 *     echo "M$i exit=$?"; grep -E 'Tests +[0-9]' /tmp/m$i.txt
 *     node gui/scripts/mut-a1114.mjs --restore
 *   done
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1114-adhoc-subagent.spec.ts";

const F_SUB = "core-ts/src/services/subagent.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_GUIDE = "core-ts/src/services/subagentCatalog.ts";
const TARGETS = [F_SUB, F_BUILTIN, F_MAIN, F_GUIDE];

/* ── 复用的锚点常量（抽出来避免手抄漂移；核验器能解析 `sub(t, CONST, …)`）── */
const A_COND = '    const adhoc = overrides.adhoc === true\n      && (!!overrides.systemPrompt?.trim() || (overrides.toolsOnly?.length ?? 0) > 0);';
const A_IF = "    if (!adhoc) {";
const A_AUTONAME = '    const autoName = `${adhoc ? "临时代理" : "通用助手"}（${task.slice(0, 12).replace(/\\s+/g, " ").trim()}）`;';
const A_TAG = "      ...(adhoc ? { adhoc: true } : {}),";
const A_DEFNAME = "    if (!def.adhoc && this.defs.has(def.name)) {";
const A_SAN_DOTS = '    .replace(/\\.\\.+/g, "_")\n    .trim()';
const A_SAN_RET = '  return cleaned.slice(0, 64) || "unnamed";';
const A_TOOLS_SET = "        const subToolsOnly = def.toolsOnly\n          ? def.toolsOnly.filter((n) => !dispatchTools.has(n))\n          : (allToolNames.length > 0 ? allToolNames.filter((n) => !dispatchTools.has(n)) : undefined);";
const A_WRITE = '        writeFileSync(join(dir, `subagent-${sanitizeSubagentRunName(def.name)}-${stamp}.md`), body, "utf8");';
const A_GUIDE_LINE = '  "\\n- **临时子代理（现场定义，不必先建）**：清单里没有合适的人时，**不要退回自己全做**——直接在 `delegate_subagent` 里现场给出 `systemPrompt`（角色 + 约束），" +';

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1114");

const MUTATIONS = [
  {
    name: "1 adhoc 判据被绕过（路由照跑 ⇒ 现场人设被清单里语义相近的人顶替）",
    file: F_SUB,
    mutate: (t) => sub(t, A_IF, "    if (true) {"),
  },
  {
    name: "2 判据漏掉 toolsOnly（只给 tools 的现场定义被当成「没定义」）",
    file: F_SUB,
    mutate: (t) => sub(t, A_COND, "    const adhoc = overrides.adhoc === true\n      && !!overrides.systemPrompt?.trim();"),
  },
  {
    name: "3 判据去掉「必须有定义内容」（只给 name 也算 ⇒ 绕开点名/自动路由）",
    file: F_SUB,
    mutate: (t) => sub(t, A_COND, "    const adhoc = overrides.adhoc === true;"),
  },
  {
    name: "4 合成时不带 adhoc 标记（审计里出现假归因）",
    file: F_SUB,
    mutate: (t) => sub(t, A_TAG, "      ...(adhoc ? {} : {}),"),
  },
  {
    name: "5 spawn 里 definitionName 守卫去掉（临时代理被记成用了同名注册定义）",
    file: F_SUB,
    mutate: (t) => sub(t, A_DEFNAME, "    if (this.defs.has(def.name)) {"),
  },
  {
    name: "6 自动名前缀不区分（临时代理与通用兜底混成一个名字）",
    file: F_SUB,
    mutate: (t) => sub(
      t,
      A_AUTONAME,
      '    const autoName = `通用助手（${task.slice(0, 12).replace(/\\s+/g, " ").trim()}）`;',
    ),
  },
  {
    name: "7 偷懒实现：adhoc 时先 register 一个临时定义（污染并发清单 + 不是「不落盘」）",
    file: F_SUB,
    mutate: (t) => sub(
      t,
      A_IF,
      '    if (adhoc) { this.register({ name: overrides.name ?? "临时", description: "临时" }); }\n    if (!adhoc) {',
    ),
  },
  {
    name: "8 工具层不置 adhoc 标记（能力存在但走不到）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, "overrides.adhoc = true;", "overrides.adhoc = false;"),
  },
  {
    name: "9 工具层 name 无条件透传（改展示名不该有副作用）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, "if (adhocName) { overrides.name = adhocName; }", "overrides.name = adhocName;"),
  },
  {
    name: "10 工具层判据漏掉 tools（与 2 同族，另一处产地）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, "if (adhocSystem || adhocTools.length > 0) {", "if (adhocSystem) {"),
  },
  {
    name: "11 工具 schema 少 systemPrompt 入参（模型根本传不进来 = 死功能）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, 'systemPrompt: { type: "string"', 'prompt_system: { type: "string"'),
  },
  {
    name: "12 深度守卫回到直通（内联 tools 可绕开套娃防护）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      A_TOOLS_SET,
      "        const subToolsOnly = def.toolsOnly\n          ?? (allToolNames.length > 0 ? allToolNames.filter((n) => !dispatchTools.has(n)) : undefined);",
    ),
  },
  {
    name: "13 深度守卫只过滤一条分支（两条分支两个口径）",
    file: F_MAIN,
    mutate: (t) => sub(t, "? def.toolsOnly.filter((n) => !dispatchTools.has(n))", "? def.toolsOnly"),
  },
  {
    name: "14 落盘名不过 sanitize（模型给个 `a/b` 就把整个子代理判失败）",
    file: F_MAIN,
    mutate: (t) => sub(t, A_WRITE, '        writeFileSync(join(dir, `subagent-${def.name}-${stamp}.md`), body, "utf8");'),
  },
  {
    name: "15 sanitize 少了 `..` 收敛（路径逃逸口）",
    file: F_SUB,
    mutate: (t) => sub(t, A_SAN_DOTS, "    .trim()"),
  },
  {
    name: "16 sanitize 少了空名兜底（写出 `subagent--stamp.md` 这种不可归因的文件）",
    file: F_SUB,
    mutate: (t) => sub(t, A_SAN_RET, "  return cleaned.slice(0, 64);"),
  },
  {
    name: "17 sanitize 不截断（模型给两千字的名字 ⇒ 超长文件名）",
    file: F_SUB,
    mutate: (t) => sub(t, A_SAN_RET, '  return cleaned || "unnamed";'),
  },
  {
    name: "18 委派规范删掉「临时子代理」段（能力存在但模型不知道 = 死开关）",
    file: F_GUIDE,
    mutate: (t) => sub(t, A_GUIDE_LINE, '  "" +'),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * 跑守卫 spec，返回 `{ ok }` / `{ measurementFailed, out }` / `{ spawnBlocked }`。
 *
 * ⚠️ **不能只看 exit code**：vitest 启动失败（配置加载不了）也返回非 0，
 * 那样一批「变异」会被报成「全被捕获」，而实际一条测试都没跑 —— 本仓踩过（§26）。
 * ⇒ 判据 = exit≠0 **且** 输出里真有 `Tests <数字>` 汇总行。
 */
function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1500) }; }
  return { ok: r.status === 0, spawnBlocked: false };
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
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (base.measurementFailed) {
  console.error("⚠️ 测量工具本身坏了（spec 的输出里没有 Tests 汇总行）—— 判据不成立，先修工具。");
  console.error(base.out);
  process.exit(1);
}
if (!base.ok) {
  console.error("基线未通过 —— 先修好守卫再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1114")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) {
      console.error("⚠️  测量工具本身坏了（输出无 Tests 汇总行），本轮判据不成立，中止。");
      console.error(res.out);
      missed.push(m.name);
      break;
    }
    if (res.ok) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
