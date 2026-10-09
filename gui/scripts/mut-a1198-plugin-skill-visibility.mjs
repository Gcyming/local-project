#!/usr/bin/env node
/**
 * mut-a1198-plugin-skill-visibility.mjs — 审计发现的两处「插件技能对 Agent 不可用」的变异验证。
 *
 * ## 这一层在防什么（用户口径：「扩展能否被 Agent 检测到并正常使用」）
 * 审计实证出两个真 bug（都不是推测，是跑出来的）：
 *   ① **全量重载抹掉插件技能**：`loadSkills()` 先 clear 再只重扫
 *      `scanRoots()`（= skillDir + extraDirs），插件技能根从来不在那个列表里
 *      ⇒ 任何一次全量重载都把它们抹掉且不再扫回来。
 *      而 `refreshAgentSkills()`（内即 `loadAllSkills` → `loadSkills()`）**每次发消息都会跑**
 *      ⇒ 用户装好扩展、发第一条消息之后，扩展技能就从 `skill_search` 消失了。
 *   ② **插件技能对 Agent 不可见**：默认模式的白名单只有内置推荐集；
 *      创造模式的 `allowAgentAuthored` 只放行 `origin=agent`，而 `origin` 只从
 *      manifest.yaml/json 读（SKILL.md frontmatter 不解析）
 *      ⇒ 照《创造模式导引》写的插件技能两种模式都搜不到。
 *      直接违反设计文档 §判断标准：「能写但看不见…算陷阱」。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | scanRoots 去掉 assembledSources | 全量重载抹掉插件技能（原 bug①） | 存活①④ |
 * | 2 | loadFromSource 不登记来源根 | 同上（登记缺了 ⇒ 扫描根里没有它） | 存活①④ |
 * | 3 | 撤销时不移出 assembledSources | 撤销后集合留残条目（语义含糊/无限增长） | 存活④ |
 * | 4 | search 不放行插件技能 | 插件技能搜不到（原 bug②） | 可见① |
 * | 5 | callSkill 不放行插件技能 | 能搜到但读不了正文（半截可用） | 可见③⑥ |
 * | 6 | isPluginContributed 恒真 | 连带放开全部技能 ⇒ P4 白名单强制力作废 | 可见④ |
 * | 7 | isPluginContributed 恒假 | 等于没修（原 bug②） | 可见① |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-skill-visibility.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/plugin-unload-scope.spec.ts",
];

const F_SKILLS = "core-ts/src/skills.ts";
const TARGETS = [F_SKILLS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-skillvis");

const MUTATIONS = [
  {
    name: "1 scanRoots 去掉 assembledSources（全量重载抹掉插件技能）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "    return [this.skillDir, ...this.extraDirs, ...this.assembledSources].filter(",
      "    return [this.skillDir, ...this.extraDirs].filter(",
    ),
  },
  {
    name: "2 loadFromSource 不登记来源根（扫描根里没有它）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "    /* 登记为「已装配来源」⇒ 之后的任何全量重载（refreshAgentSkills）都会把它扫回来。 */\n    this.assembledSources.add(root);\n",
      "",
    ),
  },
  {
    name: "3 撤销时不记 unloadedSources（卸载的来源会被重载扫回来）",
    file: F_SKILLS,
    /* ⚠️ 2026-10-09 等价变异 triage（首轮实测存活）：原拟「撤销时不移出 assembledSources」——
       那是**等价变异**：该来源此刻已在 unloadedSources 里，scanRoots 照样把它滤掉；
       且技能已从表里删净，isPluginContributed 无技能可放行 ⇒ 行为零差异（不可观测的纯清理）。
       换成真正有行为差异的点：不记 unloadedSources ⇒ 「卸载不复活」这条既有语义被破坏。 */
    mutate: (t) => sub(
      t,
      "        this.unloadedSources.add(key);\n",
      "        /* mutated: 不记 unloadedSources */\n",
    ),
  },
  {
    name: "4 search 不放行插件技能（搜不到 = 原 bug②）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "      if (scope && !isSkillNameVisible(s.name, scope, s.isAgentAuthored()) && !this.isPluginContributed(s)) {",
      "      if (scope && !isSkillNameVisible(s.name, scope, s.isAgentAuthored())) {",
    ),
  },
  {
    name: "5 callSkill 不放行插件技能（能搜到但读不了正文）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "    if (scope && !isSkillNameVisible(skill.name, scope, skill.isAgentAuthored()) && !this.isPluginContributed(skill)) {",
      "    if (scope && !isSkillNameVisible(skill.name, scope, skill.isAgentAuthored())) {",
    ),
  },
  {
    name: "6 isPluginContributed 恒真（连带放开全部技能 ⇒ 白名单作废）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "    for (const root of this.assembledSources) {\n      if (skillBelongsToSource(skill.path, root)) { return true; }\n    }\n    return false;",
      "    void skill;\n    return true;",
    ),
  },
  {
    name: "7 isPluginContributed 恒假（等于没修）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "    for (const root of this.assembledSources) {\n      if (skillBelongsToSource(skill.path, root)) { return true; }\n    }\n    return false;",
      "    void skill;\n    return false;",
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
if (reportEolProblems(eolFound, "mut-a1198-skillvis")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-skill-visibility.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);