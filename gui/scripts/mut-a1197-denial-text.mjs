#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-denial-text.mjs — A-1197「拒绝文案没跟上实现」的变异验证。
 *
 * ## 这一轮补的是什么漏
 *   explainDenial(reason) 只匹配 /受保护源码目录禁止写入/ 与 /敏感文件禁止写入/ 两条，
 *   而**执行层真正回给模型的那一句**是 core-ts/src/tools/builtin.ts:348/508 的
 *     [错误] 敏感文件/目录禁止写入: ${path}
 *   口径是「敏感文件 + 目录」，上面两条正则都匹配不上，落到函数末尾的**通用兜底**，
 *   而兜底是 hard: false 加「尝试其它方案」。
 *   对一个**不可审批的硬规则**说「可以换个做法」是误导：模型会改写法反复重试同一个目标，
 *   聊天里于是又刷出同一句「被拒绝」（与 mut-a1197-contrib-write 的第 5/6 条同族、换了形态）。
 *   本脚本同时覆盖 tools/builtin.py 那段「由 test_security_policy.py 断言」的回退镜像
 *   （此前**只有注释没有断言**）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 执行层那条判成 hard:false | 不可审批的硬规则被说成「换个做法即可」，诱导重试 | A1 / A2 |
 * | 2 | 删掉整条执行层分支 | 落通用兜底 ⇒ 原缺陷原样复发 | A1 / A2 / A4 |
 * | 3 | 分支挪到兜底**之后** | 顺序错 ⇒ 仍是死代码、仍落兜底（形状断言看不出，行为断言看得出） | A1 / A4 |
 * | 4 | 分支正则去掉「/目录」 | 与既有那条同键，执行层那句再也匹配不上 ⇒ 复发 | A1 / A6 |
 * | 5 | 硬规则分支开始劝「尝试其它方案」 | 抄兜底文案 ⇒ 硬规则被说成可换做法 | A2 |
 * | 6 | 既有「受保护源码目录」不再标 hard | 回归：换形态的刷屏毛病 | B1 |
 * | 7 | 既有「敏感文件」不再标 hard | 回归：新分支正则变宽后两条同键，分类器口径那条失守 | B2 / B3 |
 * | 8 | 兜底指引改成空串 | 静默失效：用户只剩干巴巴一句「被拒绝」 | C1 / C2 / C3 |
 * | 9 | Python 回退镜像少一个保留资产目录 | 共享源不可达时，内置插件目录被当自建目录放行 | pytest 镜像守卫（**不在这批里**，见下） |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 第 9 条变异的是 Python 侧，而 _run-mut-batch.sh **只跑 vitest** ⇒ 判据在
 *    tests/test_security_policy.py（pytest）。本脚本的 SPECS 只列 TS 判据；第 9 条要在
 *    报告里**另跑 pytest** 核验，别把「vitest 绿」读成「它被抓住了」。
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-denial-text.spec.ts",
];

const F_POLICY = "core-ts/src/tools/policy.ts";
const F_PY = "tools/builtin.py";
const TARGETS = [F_POLICY, F_PY];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-denial");

/* ⚠️ 这两个锚抽成**模块级字面量常量**（而不是写在闭包里）：check-mut-anchors.mjs 静态
 *   只认 `from:` 与 `sub(t, <字面量|常量>)` 两种形态，锚点藏在 `mutate:` 闭包的局部变量里
 *   会被判「未核验」，而**未核验 = 没人核验 = 没有保护**（该脚本文件头 §8.5）。
 *   `sub` 行尾无关（多行锚点的行间用 \r?\n 匹配），所以字面量里的 \n 是安全的。 */

/** policy.ts 里执行层那条分支的整块原文（M2 删它、M3 挪它，共用同一份以免两处漂移）。 */
const EXEC_BLOCK_LITERAL = '  if (/敏感文件\\/目录禁止写入/.test(r)) {\n    return {\n      hard: true,\n      advice:\n        "写入在执行层就被拦下了：目标命中 slime 的敏感文件/受保护目录黑名单，这是硬规则，"\n        + "「设置 → 权限」里任何开关与审批档位都放行不了。"\n        + "**不要换个写法重试同一个目标**（改大小写、加 ./、换绝对路径或换工具一律同样被拒）。"\n        + "请改为写到会话工作目录内的路径；若要落的是自己的插件/技能，写进 config/skills 或 "\n        + "config/plugins 下**你自己新建**的目录（内置插件目录是保留资产，永不放行）。",\n    };\n  }';

/** policy.ts 里通用兜底那一段的尾部（M3 往它**后面**塞分支 ⇒ 新分支成死代码）。
 *  ⚠️ **刻意不含函数末尾那个 `}`** —— 含了就把分支插到函数**外面**去了，
 *  变异体变成语法错误（实测：批脚本判「无 Tests 汇总行」，不算抓住，白跑一条）。 */
const FALLBACK_TAIL_LITERAL = '    advice: "该操作未获授权。请向用户说明被拒的原因与你想达成的目的，并尝试其它方案；不要反复重试同一个调用。",\n  };';

/* ⚠️ 下面两个锚**必须写成 `sub(t, "…")` 里的单行字面量**（而不是抽成常量）——
 *   check-mut-anchors.mjs 静态只认这两种形态（from: 与 sub(t, <字面量>)）；
 *   锚点写在 `mutate:` 闭包里或引用一个数组拼出来的常量，都会被判「未核验」，
 *   而**未核验 = 没人核验 = 没有保护**（见该脚本文件头 §8.5）。
 *   `sub` 本身行尾无关（多行锚点的行间用 \r?\n 匹配），所以字面量里的 \n 是安全的。 */
const MUTATIONS = [
  /* ── ① 执行层那条文案：判成可审批，就成了诱导重试 ────────────────── */
  {
    name: "1 执行层「敏感文件/目录禁止写入」不再标 hard（硬规则被说成换个做法即可）",
    file: F_POLICY,
    mutate: (t) => sub(
      t,
      '  if (/敏感文件\\/目录禁止写入/.test(r)) {\n    return {\n      hard: true,',
      '  if (/敏感文件\\/目录禁止写入/.test(r)) {\n    return {\n      hard: false,',
    ),
  },
  /* ── ② 整条分支删掉，落回通用兜底（原缺陷原样复发）──────────────── */
  {
    name: "2 删掉执行层那条的分支（落回通用兜底，硬规则被劝「尝试其它方案」）",
    file: F_POLICY,
    mutate: (t) => sub(t, EXEC_BLOCK_LITERAL, ""),
  },
  /* ── ③ 顺序错：分支挪到兜底之后，落兜底（死代码）─────────────────── */
  {
    name: "3 执行层那条的分支排到通用兜底之后（顺序错，落兜底）",
    file: F_POLICY,
    /* 两步都写成 `sub(t, "…")` 的嵌套形态（而不是把锚点抽成变量）：
     * check-mut-anchors.mjs 静态只认字面量首参，抽成变量会被判「未核验」。 */
    mutate: (t) => sub(
      sub(t, EXEC_BLOCK_LITERAL, ""),
      FALLBACK_TAIL_LITERAL,
      FALLBACK_TAIL_LITERAL + "\n" + EXEC_BLOCK_LITERAL,
    ),
  },
  /* ── ④ 正则去掉「/目录」，与既有那条同键，执行层那句匹配不上 ──────── */
  {
    name: "4 执行层那条的正则去掉「/目录」（执行层文案再也匹配不上，复发）",
    file: F_POLICY,
    mutate: (t) => sub(
      t,
      "  if (/敏感文件\\/目录禁止写入/.test(r)) {",
      "  if (/敏感文件禁止写入/.test(r)) {",
    ),
  },
  /* ── ⑤ 把兜底那句抄进硬规则分支 ───────────────────────────────────── */
  {
    name: "5 硬规则分支开始劝模型「尝试其它方案」（抄兜底文案，硬规则被说成可换做法）",
    file: F_POLICY,
    /* ⚠️ 替换体必须是**一段合法源码**：早先写成
     *   + "请改为…config/skills 或 "\n  + "实在不行就尝试其它方案。",
     * 会在原句收尾的 `"` 之后多出一个 `"` ⇒ 字符串未闭合、变异体编译不过
     *  ⇒ 批脚本判「无 Tests 汇总行」，不算抓住（等于白跑一条）。 */
    mutate: (t) => sub(
      t,
      '        + "config/plugins 下**你自己新建**的目录（内置插件目录是保留资产，永不放行）。",',
      '        + "config/plugins 下**你自己新建**的目录（内置插件目录是保留资产）。实在不行就尝试其它方案。",',
    ),
  },
  /* ── ⑥⑦ 回归：既有两条分支 ──────────────────────────────────────── */
  {
    name: "6 既有「受保护源码目录」不再标 hard（回归：换形态的刷屏毛病）",
    file: F_POLICY,
    mutate: (t) => sub(
      t,
      '  if (/受保护源码目录禁止写入/.test(r)) {\n    return {\n      hard: true,',
      '  if (/受保护源码目录禁止写入/.test(r)) {\n    return {\n      hard: false,',
    ),
  },
  {
    name: "7 既有「敏感文件」不再标 hard（回归：新分支变宽后两条同键，分类器口径那条失守）",
    file: F_POLICY,
    mutate: (t) => sub(
      t,
      '  if (/敏感文件禁止写入/.test(r)) {\n    return {\n      hard: true,\n      advice:\n        "该文件名/后缀在 slime 的敏感清单里（凭据、主配置、审计日志等），写操作一律阻断且不可审批。"',
      '  if (/敏感文件禁止写入/.test(r)) {\n    return {\n      hard: false,\n      advice:\n        "该文件名/后缀在 slime 的敏感清单里（凭据、主配置、审计日志等），写操作一律阻断且不可审批。"',
    ),
  },
  /* ── ⑧ 静默失效：兜底指引改成空串 ────────────────────────────────── */
  {
    name: "8 通用兜底指引改成空串（静默失效，用户只剩干巴巴一句「被拒绝」）",
    file: F_POLICY,
    mutate: (t) => subAll(
      t,
      '    advice: "该操作未获授权。请向用户说明被拒的原因与你想达成的目的，并尝试其它方案；不要反复重试同一个调用。",',
      '    advice: "",',
    ),
  },
  /* ── ⑨ Python 侧回退镜像漂移（判据在 pytest，不在本批）───────────── */
  {
    name: "9 Python 回退镜像漏一个保留资产目录（共享源不可达时内置插件目录被当自建放行）",
    file: F_PY,
    mutate: (t) => sub(
      t,
      '                "observability", "model-routing", "mcp-bridge", "plugin-management",',
      '                "observability", "model-routing", "mcp-bridge",',
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1197-denial")) { process.exit(1); }

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
    console.error(`还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-denial-text.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 2) { process.exit(1); }
process.exit(1);
