#!/usr/bin/env node
/**
 * gui/scripts/mut-a1195-debts.mjs — A-1195「交接欠账补齐」的变异验证。
 *
 * ## 本批修的欠账（源：docs/HANDOFF-plugin-system.md §6 + 10-06 日志）
 * · A1  PluginHost.load 覆盖式重装不撤销上一轮 scope（核心层永久泄漏句柄）
 * · A2  creator 模式落地：少量只读管控工具（plugin_status，creator-only 可见）+ 自验四步
 * · B5  chromiumFetch 的 net.fetch 是否透传 UA（实测结案 → 无变异；探针 probe-ua-transmission.mjs）
 * · B6  5 处供应商探测请求无 UA（与模型请求指纹不一致）→ 统一 identityHeaders
 * · B7  内层重试 ×3 的叠加疑点 → 落档 + 有界性守卫
 * · B8  「provider 态 gate 是构造时快照」→ 实测为**请求时实时查询**，守卫钉住
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | load 不再前置撤销旧 scope | 重装后旧技能撤不掉（永久泄漏） | plugin-host ① |
 * | 2 | 撤销不逆序 | 依赖者后撤 ⇒ 撤销顺序与装配镜像关系失守 | plugin-host ② |
 * | 3 | 撤销失败改成 throw | 一条撤不掉就中断重建（半世界） | plugin-host ③ |
 * | 4 | 删 CREATOR_ONLY 过滤 | plugin_status 泄漏进 default/custom 工具面 | a1195-creator ② |
 * | 5 | creatorGuide 删 plugin_status 自验步 | 自验退回「只查 skill_search」 | a1195-creator ③ |
 * | 6 | detectApiFormat 探测撤掉 identityHeaders | 探测请求匿名（指纹自相矛盾） | a1195-ua-probes ①+③ |
 * | 7 | FETCH_RETRY_ATTEMPTS 3 → 10 | 叠加分析失效（重审） | a1195-bounds ② |
 * | 8 | rateLimitGateOpen 恒开 | 无闸门也排队（压测误伤） | a1195-gate-live ②③ |
 *
 * ⚠️ `name` 开头数字必须 == 数组位置序号（check-mut-anchors.mjs 逐条核对）。
 * ⚠️ 锚必须是**唯一多行长锚**（A-1194 事故：首匹配恢复改错位置 ⇒ 唯一性 = 硬要求）。
 * ⚠️ 变异体保持语法合法；跑批走 `bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1195-debts.mjs`。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* 判据 spec 唯一产地：A1 的用例落在 plugin-host.spec（A-1195 describe）。 */
const SPECS = [
  "tests/core-ts/plugin-host.spec.ts",
  "tests/core-ts/a1195-creator-tools.spec.ts",
  "tests/gui/a1195-ua-probes.spec.ts",
  "tests/gui/a1195-chromiumfetch-bounds.spec.ts",
  "tests/core-ts/a1195-gate-live.spec.ts",
];

const F_HOST = "core-ts/src/plugin/host.ts";
const F_AGENTTOOLS = "core-ts/src/services/agentTools.ts";
const F_PROVIDERS = "gui/src/main/providers.ts";
const F_CLIENT = "core-ts/src/llm/client.ts";
const TARGETS = [F_HOST, F_AGENTTOOLS, F_PROVIDERS, F_CLIENT];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1195");

const MUTATIONS = [
  /* ── A1：覆盖式重装先撤销（host.ts）────────────────────────────── */
  {
    name: "1 load 不再前置撤销旧 scope（重装后旧句柄永久泄漏）",
    file: F_HOST,
    mutate: (t) => sub(
      t,
      "    await this.disposeAllEntries();\n    this.entries.clear();",
      "    this.entries.clear();",
    ),
  },
  {
    name: "2 撤销不逆序（依赖者先装却后撤）",
    file: F_HOST,
    mutate: (t) => sub(
      t,
      "const names = [...this.order].reverse();",
      "const names = [...this.order];",
    ),
  },
  {
    name: "3 撤销失败改成 throw（一条失败中断重建，留半世界）",
    file: F_HOST,
    mutate: (t) => sub(
      t,
      "        console.error(\n          `[plugin-host] 插件 '${name}' 的贡献撤销失败（第 ${f.index} 个）：${f.error instanceof Error ? f.error.message : String(f.error)}`,\n        );",
      "        throw f.error;",
    ),
  },

  /* ── A2：creator 专用管控工具（agentTools.ts）──────────────────── */
  {
    name: "4 删 CREATOR_ONLY 过滤（plugin_status 泄漏进所有工具面）",
    file: F_AGENTTOOLS,
    mutate: (t) => sub(
      t,
      "    if (CREATOR_ONLY_TOOL_NAMES.has(name)) {\n      return profile.mode === \"creator\";\n    }\n",
      "",
    ),
  },
  {
    name: "5 creatorGuide 删 plugin_status 自验步（自验退回只查 skill_search）",
    file: F_AGENTTOOLS,
    mutate: (t) => sub(
      t,
      "    \"  1. `plugin_status` 复核插件**真的被装载**（出现在清单里且 status=loaded）—— 文件存在不等于装载成功；\",",
      "    \"  1. `skill_search` 复核（变异：plugin_status 步骤被删）\",",
    ),
  },

  /* ── B6：探测请求带统一身份（providers.ts）────────────────────── */
  {
    name: "6 detectApiFormat 探测撤掉 identityHeaders（探测侧匿名）",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "headers: identityHeaders(headers), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });\n        if (res.ok) { return openai ? \"openai\" : \"anthropic\"; }",
      "headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });\n        if (res.ok) { return openai ? \"openai\" : \"anthropic\"; }",
    ),
  },

  /* ── B7：重试有界（providers.ts）──────────────────────────────── */
  {
    name: "7 FETCH_RETRY_ATTEMPTS 3→10（叠加分析的档位被悄悄调整）",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "const FETCH_RETRY_ATTEMPTS = 3;",
      "const FETCH_RETRY_ATTEMPTS = 10;",
    ),
  },

  /* ── B8：gate 实时判定（client.ts）────────────────────────────── */
  {
    name: "8 rateLimitGateOpen 恒开（无闸门也去排队）",
    file: F_CLIENT,
    mutate: (t) => sub(
      t,
      "    return getSharedRpmLimiter().resolve(identity.key, identity.model).rpm !== null;",
      "    return true;",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1195")) { process.exit(1); }

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
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
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

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1195-debts.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 4) { process.exit(1); }
process.exit(1);
