#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-contrib-write.mjs — A-1197「贡献目录写入解封 + 拒绝消息可读」的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 * ② 「扩展在 Agent 刚编写完成后，在扩展栏内不能使用，说是风险项，被禁止了，
 *     但是我重启 slime 程序就好了」
 * ③ 「怎么总是会显示这种被拒绝的情况？给我优化一下」
 *
 * ## 根因（两者同源）
 * protected_dirs 里有 `config`（本意保护源码侧的 agents.json / providers.enc.json），
 * 但打包形态下 slime 根 == **运行时数据根**，于是 `config/skills`、`config/plugins`
 * 一并被封 —— 创造模式导引让 Agent 往这两个目录写，写入却是 **block 级硬规则**，
 * 任何开关都批不了；模型只拿到一句面向审计的短句，不知道该怎么办，只能原地重试 ⇒ 刷屏拒绝。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | classifier 丢弃豁免清单 | ②③ 原样复发（Agent 造不了插件/技能） | a1197 ①②③④ |
 * | 2 | 豁免改成裸前缀匹配 | config/skills-2 这类邻居被误放行（过度放开） | a1197「前缀邻居」 |
 * | 3 | Python 侧不读共享豁免（改成手写第二份） | 双产地漂移：主链路能写、Python 侧仍拦（或反之） | a1197「Python 侧同口径」|
 * | 4 | Python 侧把目录边界换成裸前缀 | 外溢到前缀邻居（config/skills-2 被误认成子路径） | a1197「带目录边界」 |
 * | 5 | 受保护目录不再标 hard | 模型以为能重试 ⇒ 又刷三遍「被拒绝」 | a1197「受保护源码目录」 |
 * | 6 | 敏感文件不再标 hard | 同上（换了种截图形态的同一个毛病） | a1197「敏感文件」 |
 * | 7 | 未知原因返回空指引 | 静默失效：用户看到的又是干巴巴一句「被拒绝」 | a1197「原因缺失时」 |
 * | 8 | 超出工作目录被标成 hard | 可审批的被说成没救 ⇒ 用户以为必须改配置 | a1197「超出工作目录」 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-contrib-write.mjs`
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-contrib-write.spec.ts",
];

const F_CLASSIFIER = "core-ts/src/tools/classifier.ts";
const F_POLICY = "core-ts/src/tools/policy.ts";
const F_PY = "tools/builtin.py";
const TARGETS = [F_CLASSIFIER, F_POLICY, F_PY];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197");

const MUTATIONS = [
  /* ── ① 豁免清单失效（②③ 直接复发）────────────────────────────── */
  {
    name: "1 classifier 丢弃豁免清单（Agent 又写不进技能/插件目录）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      "    if (EXEMPT_REL_PATHS.length > 0) {",
      "    if (false) {",
    ),
  },
  /* ── ② 边界：裸前缀匹配 ⇒ 外溢到邻居目录 ──────────────────────── */
  {
    name: "2 豁免改成裸前缀匹配（config/skills-2 被误放行）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      '        if (ex && (relPosix === ex || relPosix.startsWith(`${ex}/`))) return false;',
      "        if (ex && relPosix.startsWith(ex)) return false;",
    ),
  },
  /* ── ③ Python 第二产地漂移 ─────────────────────────────────────── */
  /* ⚠️⚠️ 2026-10-07 重打锚点（B0「跨插件写入收紧」重构之后）。**原锚点已作废**，
     且不是「挪个位置」就行的邻接问题 —— 原变异点**已被证明是死代码**：

     原锚点落在 `_is_blocked_write_path` 尾部的 `for ex in _WRITE_DIR_EXEMPTIONS:`
     那一段。B0 之后，前面插入了 `asset_rel = _contribution_asset_dir(rel_posix)`
     分支，凡「尾部循环会命中」的路径都已在那条分支里 return 了。
     实测（29668 条路径穷举 + 随机采样）：`trail(p)` 与 `_contribution_asset_dir(p) 非空`
     **完全等价**（不一致 0 条）⇒ 尾部那段 `return False` 永不执行 ⇒ **改它行为不变**。
     所以「删掉尾部循环」表达不了「Python 侧不读共享豁免」—— 删了也不红（=假存活）。

     意图仍可实现，但**必须换到真正被读的那一行**：豁免清单的**唯一来源**是
     `_load(mod, "PROTECTED_PATH_EXEMPTIONS", ())`（builtin.py:140）。
     这里改成手写第二份字面量 = 经典的「双产地漂移」：改 yaml 忘了改 Python，
     或改 Python 忘了改 yaml，两边悄悄不一致 —— 而共享源不再是唯一产地。
     守卫 a1197「必须真的从共享源取豁免清单」正是判这一点（它同时断言
     `PROTECTED_PATH_EXEMPTIONS` 这个名字还在 ⇒ 本变异体把它删掉即被抓）。 */
  {
    name: "3 Python 侧不读共享豁免（改成手写第二份，双产地漂移重演）",
    file: F_PY,
    mutate: (t) => sub(
      t,
      '                _load(mod, "PROTECTED_PATH_EXEMPTIONS", ()),',
      '                ("config/skills", "config/plugins"),',
    ),
  },
  /* ── ③b 边界：Python 侧把「带 / 的目录边界」换成裸前缀 ─────────── */
  /* ⚠️⚠️ 2026-10-07 第二次重打锚点。**原锚点已作废**（`--apply` 失败，非存活）：

     原锚点落在 `_is_blocked_write_path` 尾部那段 `for ex in _WRITE_DIR_EXEMPTIONS:`
     的循环体上（`if ex and (rel_posix == ex or rel_posix.startswith(ex + "/")):`）。
     那段**已被实测证明是死代码并随后删除**：前面 `asset_rel = _contribution_asset_dir(rel_posix)`
     分支的 `if asset_rel is not None: … return …` 已把它所有命中路径提前 return 掉
     （515,718 条路径穷举零反例）。⇒ 锚点连字符串都找不到了。

     但**意图仍然成立**，且落点更准：`_contribution_asset_dir`（builtin.py:194-210）就是
     Python 侧真正生效的目录边界判定 —— 它的三件套是
       ① `if rel_posix == ex: return ex`      （恰好等于豁免根）
       ② `prefix = ex + "/"`                  （边界 = 斜杠）
       ③ `if not rel_posix.startswith(prefix): continue`（前缀必须带边界）
     把 ③ 的 `prefix` 换成裸 `ex`，就是「Python 侧把目录边界换成裸前缀」：
     `config/skills-2`、`config/skillsfoo` 这类**前缀邻居**会被误认成
     `config/skills` 的子路径 ⇒ 双端（TS 侧仍带边界）漂移 ⇒ 过度放开。
     守卫 a1197「豁免判定必须带目录边界（不是裸前缀）」与
     「裸前缀形态一律不许重新长出来」两条正是判这一点（前一位子代理实测判红 2 条）。 */
  {
    name: "4 Python 侧把目录边界换成裸前缀（前缀邻居一并外溢）",
    file: F_PY,
    mutate: (t) => sub(
      t,
      "        if not rel_posix.startswith(prefix):",
      "        if not rel_posix.startswith(ex):",
    ),
  },
  /* ── ④ 拒绝消息的可读性 ───────────────────────────────────────── */
  {
    name: "5 受保护目录不再标 hard（模型继续重试 ⇒ 拒绝刷屏）",
    file: F_POLICY,
    mutate: (t) => sub(
      t,
      '  if (/受保护源码目录禁止写入/.test(r)) {\n    return {\n      hard: true,',
      '  if (/受保护源码目录禁止写入/.test(r)) {\n    return {\n      hard: false,',
    ),
  },
  {
    name: "6 敏感文件不再标 hard（换种形态的同一个刷屏毛病）",
    file: F_POLICY,
    mutate: (t) => sub(
      t,
      '  if (/敏感文件禁止写入/.test(r)) {\n    return {\n      hard: true,',
      '  if (/敏感文件禁止写入/.test(r)) {\n    return {\n      hard: false,',
    ),
  },
  {
    name: "7 未知原因返回空指引（用户只看得到干巴巴一句被拒绝）",
    file: F_POLICY,
    mutate: (t) => subAll(
      t,
      '    advice: "该操作未获授权。请向用户说明被拒的原因与你想达成的目的，并尝试其它方案；不要反复重试同一个调用。",',
      '    advice: "",',
    ),
  },
  {
    name: "8 超出工作目录被标成 hard（可审批的被说成没救）",
    file: F_POLICY,
    mutate: (t) => sub(
      t,
      '  if (/超出工作目录范围/.test(r)) {\n    return {\n      hard: false,',
      '  if (/超出工作目录范围/.test(r)) {\n    return {\n      hard: true,',
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
if (reportEolProblems(eolFound, "mut-a1197")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-contrib-write.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 3) { process.exit(1); }
process.exit(1);
