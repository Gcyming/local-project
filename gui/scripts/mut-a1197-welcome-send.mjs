#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-welcome-send.mjs — A-1197①「初始欢迎页点了没反应」的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 * 「初始界面没用 —— 下面快捷按钮没用，上面输入栏也没用，点了没反应，
 *   输入回车没反应 —— 这是老毛病了」
 *
 * ## 根因（两条叠加，都在 gui/src/renderer/App.tsx）
 *   ① **全链路静默返回**：handleWelcomeSend 在「api 缺失 / create 抛错 / 主进程返回
 *      失败」三处都是裸 return（或 catch 里 return null），任何失败用户都看不到。
 *   ② **会话创建成功但界面没反映**：旧代码 setSelectedSessionId 后只 void loadSessions()，
 *      selectedSession = sessions.find(...) 要等全量 loadSessions 回来才非空，期间渲染
 *      分支仍判 hasNoSession → 继续挂 WelcomeChat，「点了以后界面毫无变化」。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住（守卫在 tests/core-ts/a1197-welcome-send.spec.ts）
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | api 缺失退回静默 return | 后端没就绪时点了没反应（老毛病原样） | I1-test1 |
 * | 2 | ok:false 分支退回静默 return | 主进程返回失败被静默吞掉 | I1-test3 / I1-test4 |
 * | 3 | create 抛错的 catch 退回 return null | create 失败不再上抛（老写法原样） | I1-test2 |
 * | 4 | 删掉乐观 setSessions | 会话建成功但界面不切走（根因②原样） | I2-test1 / I2-test2 |
 * | 5 | 删掉 handleSend 里的 showNotice | reject 被静默吞掉（点了没反应的另一半） | I3-test1 |
 * | 6 | notice 渲染条件改成恒 false | notice 接了也画不出来（I3 接了没人看） | I4-test1 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-welcome-send.mjs`
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-welcome-send.spec.ts",
];

const F_APP = "gui/src/renderer/App.tsx";
const TARGETS = [F_APP];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-welcome-send");

const MUTATIONS = [
  /* ── ① api 缺失退回静默 return（老毛病原样：后端没就绪 = 点了没反应）────────── */
  {
    name: "1 api 缺失退回静默 return（点了没反应）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '    if (!api) { throw new Error("后端接口未就绪，无法创建会话"); }',
      "    if (!api) { return; }",
    ),
  },
  /* ── ② ok:false 分支退回静默 return（主进程失败被静默吞）───────────────────── */
  {
    name: "2 ok:false 分支退回静默 return（主进程失败被静默吞掉）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '      throw new Error("会话创建未成功，请稍后重试");',
      "      return;",
    ),
  },
  /* ── ③ create 抛错的 catch 退回 return null（老写法原样：不抛、上面裸 return）── */
  {
    name: "3 create 抛错的 catch 退回 return null（create 失败不再上抛）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '      throw new Error("会话创建失败，请稍后重试");',
      "      return null;",
    ),
  },
  /* ── ④ 删掉乐观 setSessions（根因②原样：会话建成功但界面不切走）────────────── */
  {
    name: "4 删掉乐观 setSessions（会话建成功但界面没反映）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '    setSessions((prev) => (prev.some((s) => s.sessionId === sessionId) ? prev : [res.session, ...prev]));\n',
      "",
    ),
  },
  /* ── ⑤ 删掉 handleSend 里的 showNotice（reject 被静默吞掉）──────────────────── */
  {
    name: "5 删掉 handleSend 的 showNotice（reject 被静默吞掉）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '      showNotice(false, e instanceof Error ? `发送失败：${e.message}` : "发送失败，请稍后重试");\n',
      "",
    ),
  },
  /* ── ⑥ notice 渲染条件改恒 false（接了也画不出来）────────────────────────── */
  {
    name: "6 notice 渲染条件改恒 false（接了也画不出来）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      {notice && (",
      "      {false && (",
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
if (reportEolProblems(eolFound, "mut-a1197-welcome-send")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-welcome-send.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 1) { process.exit(1); }
process.exit(1);
