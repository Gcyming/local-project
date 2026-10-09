#!/usr/bin/env node
/**
 * mut-a1198-git-tools.mjs — A-1198 git_* 工具层（D1 三闸）的变异验证。
 *
 * ## 这一层在防什么
 * AGENTS.md 的 Git 契约从文档层接到工具层：身份铁律（author=slime-{id}，缺身份拒）+
 * commit 门禁（QA 不绿不让提交）+ diff 评审（人点头才落库）+ 无合并权（受保护分支拒写）+
 * Lint Gate（800/30）+ Windows 斜杠 ref 兜底。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 保护分支 glob 删 main | Agent 直接往主干提交 | G ①保护分支 |
 * | 2 | 分支名空串反转为「不保护」 | 判不了就放行（fail-open） | G ①保护分支 |
 * | 3 | Lint Gate 上限 800 改 8000 | 巨型提交闸失效 | G ①Lint Gate |
 * | 4 | numstat 漏算删除行 | 行数统计少一半（巨型提交漏网） | G ①numstat |
 * | 5 | subject 空校验删 | 空标题提交进库 | G ①参数校验 |
 * | 6 | paths 的 .. 校验删 | 暂存可以爬出仓库 | G ①路径校验 |
 * | 7 | 分支段 2 校验删 | 可蹭别人 id 的分支前缀 | G ①分支名校验 |
 * | 8 | 身份头删（chore(meta) 例外扩大成全部） | commit 丢「我是 X，Y」溯源行 | G ①消息拼装 |
 * | 9 | Agent-Origin trailer 删 | 溯源链断一环 | G ①消息拼装 |
 * | 10 | 评审：approved 不检查 | 用户点了拒绝照样落库 | G ②评审闸 |
 * | 11 | 评审通道缺失时放行 | 无弹窗环境静默提交 | G ②评审闸 |
 * | 12 | QA runner 调用删（恒绿） | 质量门禁失效 | G ②质量门禁 |
 * | 13 | skip_qa 源码豁免 | 源码改动可以跳过门禁 | G ②质量门禁 |
 * | 14 | 评审详情删受保护模块高亮 | 人看不到「改了治理层」 | G ①评审详情 |
 * | 15 | classifyGate 恒 skip-docs | 所有提交都免门禁 | G ①门禁分类 |
 * | 16 | commit 后不做 ref 真值校验 | Windows 斜杠 ref 缺陷静默吞提交 | G ③接线 |
 * | 17 | tool_loop 注入 role 置空 | 身份头缺 role（trailers 失源） | G ③注入 |
 * | 18 | engine runStream 不传 agentRole | 流式路径身份失源 | G ③注入 |
 * | 19 | main 不注入评审通道 | 桌面端 commit 一律被拒（功能死） | G ③接线 |
 * | 20 | 子代理护栏文案删 | 后台子代理也能走评审（无人可确认） | G ③接线 |
 * | 21 | 弹窗不渲染 detail | diff 评审看不到 diff | G ③弹窗 |
 * | 22 | ipc 类型删 detail 字段 | 长文本详情传不到渲染层 | G ③弹窗 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-git-tools.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1198-git-tools.spec.ts",
];

const F_GIT = "core-ts/src/tools/git.ts";
const F_LOOP = "core-ts/src/tool_loop.ts";
const F_ENGINE = "core-ts/src/services/engine.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_IPC = "gui/src/shared/ipc.ts";
const TARGETS = [F_GIT, F_LOOP, F_ENGINE, F_MAIN, F_PANEL, F_IPC];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-git");

const MUTATIONS = [
  /* ── ① 判据层（git.ts 纯函数）──────────────────────────────────── */
  {
    name: "1 保护分支 glob 删 main（Agent 直接往主干提交）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "export const PROTECTED_BRANCH_GLOBS = [\"main\", \"master\", \"production\", \"release/*\", \"hotfix/*\"] as const;",
      "export const PROTECTED_BRANCH_GLOBS = [\"master\", \"production\", \"release/*\", \"hotfix/*\"] as const;",
    ),
  },
  {
    name: "2 分支名空串反转为「不保护」（fail-open）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  if (!b) { return true; } // 解析不出分支名 = 判不了 ⇒ 按最坏情况处理（fail-closed）",
      "  if (!b) { return false; } // 变异：fail-open",
    ),
  },
  {
    name: "3 Lint Gate 上限 800 改 8000（巨型提交闸失效）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "export const MAX_CHANGED_LINES_PER_COMMIT = 800;",
      "export const MAX_CHANGED_LINES_PER_COMMIT = 8000;",
    ),
  },
  {
    name: "4 numstat 漏算删除行（行数统计少一半）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "      lines += add + del;",
      "      lines += add;",
    ),
  },
  {
    name: "5 subject 空校验删（空标题进库）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  if (!input.subject.trim()) {",
      "  if (false) {",
    ),
  },
  {
    name: "6 paths 的 .. 校验删（暂存可爬出仓库）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "    if (p.split(\"/\").some((seg) => seg === \"..\")) {",
      "    if (false) {",
    ),
  },
  {
    name: "7 分支段 2 校验删（可蹭别人 id 的分支前缀）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  const allowed = seg === agentId || seg === \"swarm\" || seg === \"tmp\";",
      "  const allowed = true;",
    ),
  },
  {
    name: "8 身份头删（溯源行「我是 X，Y」消失）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  if (!isMeta) {",
      "  if (false) {",
    ),
  },
  {
    name: "9 Agent-Origin trailer 删（溯源链断一环）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "    \"Agent-Origin: slime/v1\",",
      "",
    ),
  },
  {
    name: "10 评审：approved 不检查（拒绝也落库）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  if (!reviewDecision.approved) {",
      "  if (false) {",
    ),
  },
  {
    name: "11 评审通道缺失时放行（无弹窗环境静默提交）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  const cb = reviewCallback;\n  if (!cb) {",
      "  const cb = reviewCallback ?? (async () => ({ approved: true }));\n  if (false) {",
    ),
  },
  {
    name: "12 QA runner 调用删（质量门禁恒绿）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "    qa = await qaRunner({ repoRoot: repo.root, changedPaths: staged, timeoutMs: QA_TIMEOUT_MS });",
      "    qa = { kind: \"ts\", ok: true, detail: { bypass: true } };",
    ),
  },
  {
    name: "13 skip_qa 源码豁免（源码改动可跳过门禁）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  if (args.skip_qa === true && !pureMeta) {",
      "  if (false) {",
    ),
  },
  {
    name: "14 评审详情删受保护模块高亮（人看不到改了治理层）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  if (req.protectedModules.length > 0) {",
      "  if (false) {",
    ),
  },
  {
    name: "15 classifyGate 恒 skip-docs（所有提交免门禁）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  if (pureDocs) { return \"skip-docs\"; }",
      "  if (true) { return \"skip-docs\"; }",
    ),
  },
  {
    name: "16 commit 后不做 ref 真值校验（斜杠缺陷静默吞提交）",
    file: F_GIT,
    mutate: (t) => sub(
      t,
      "  const refCheck = await verifyAndRepairRef(repo.root, branch);",
      "  const refCheck = { checked: false, mismatch: false, repaired: false, note: \"\" };",
    ),
  },

  /* ── ③ 接线层（注入 / 通道 / 弹窗）────────────────────────────── */
  {
    name: "17 tool_loop 注入 role 置空（身份头缺 role）",
    file: F_LOOP,
    mutate: (t) => sub(
      t,
      "      args._agent_role = agentRole;",
      "      args._agent_role = \"\";",
    ),
  },
  {
    name: "18 engine runStream 不传 agentRole（流式路径身份失源）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "          agentName: opts.agent.name,\n          agentRole: opts.agent.role,\n",
      "          agentName: opts.agent.name,\n",
    ),
  },
  {
    name: "19 main 不注入评审通道（桌面端 commit 一律被拒——功能死）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  setGitReviewCallback(requestGitReview);",
      "  /* 变异：评审通道不注入 */",
    ),
  },
  {
    name: "20 子代理护栏文案删（后台子代理也走评审——无人可确认）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "        reason: \"后台子代理无人可交互确认 —— commit 差异评审不适用（请在主对话里发起提交）\",",
      "        reason: \"变异：子代理直接放行\",",
    ),
  },
  {
    name: "21 弹窗不渲染 detail（diff 评审看不到 diff）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "              {pendingPerm.detail && (",
      "              {false && (",
    ),
  },
  {
    name: "22 ipc 类型删 detail 字段（长文本详情传不到渲染层）",
    file: F_IPC,
    mutate: (t) => sub(
      t,
      "  /** A-1198：可选长文本详情（git_commit 差异评审的 diff stat + 关键片段；弹窗内滚动展示）。 */\n  detail?: string;\n",
      "",
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
if (reportEolProblems(eolFound, "mut-a1198-git-tools")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-git-tools.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);
