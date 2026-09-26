#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095s7.mjs — A-1095 #8′「思考历程里穿插的正文」守卫的变异验证。
 *
 * 用户原话：「我要的思考期间穿插的正文总结呢？……还可以在思考历程中穿插正文输出，
 * 然后再在**所有思考工作做完后，整理思考历程中的正文部分**。」
 * 属**静默失效**类（过 tsc / 过构建 / 过逻辑测试，只在用户眼里翻车）。各变异锁一条判据：
 *   ① 删掉数据层的 body 支 ⇒ 正文节点根本不存在，会话半段
 *      （真实后果：`{kind:"body"}` 事件掉进 `appendTimelineStep` 的工具兜底，被渲染成"一个叫 undefined 的工具"）；
 *   ② 合并规则放宽成"末尾是谁都合并"⇒ 两段正文糊成一坨，还吃掉中间的工具节点
 *      （"这段正文属于哪个工作阶段"的判据当场丢失 = 用户说的③"整理"无从谈起）；
 *   ③ `groupTimeline` 把 body 当组边界 ⇒ 每段正文自成一组、套上组头折叠壳，正文被藏起来；
 *   ④⑤ 两个产地各删一个（前台 onChunk / 后台镜像）⇒ 用户体感"时有时无"，而门禁全绿；
 *   ⑥ 删掉 TimelineNode 的 body 渲染支 ⇒ 正文掉进工具卡兜底；
 *   ⑦ `sessionCtxMeta` 的 kind 联合去掉 body ⇒ 重启 / 切会话后穿插正文整段丢失。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）；模板字面量里的 `${` 在**双引号字符串**里无需转义。
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
  "tests/gui/a1095-body-steps.spec.ts",
  "tests/gui/a1095-timeline-groups.spec.ts",
];

const F_PANO = "gui/src/renderer/pages/todoPanorama.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_META = "gui/src/renderer/pages/sessionCtxMeta.ts";
const TARGETS = [F_PANO, F_PANEL, F_META];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095s7");

/* ── 多行锚点（**拼接字面量**书写）：`check-mut-anchors.mjs` 的 constMap 能解析这种形态，
 *    而 `subLines(...)` 写法会被判成「锚点写法未识别」= 未核验 = 没人核验。 ───────────── */
const A_BODY_BRANCH =
  "  if (ev.kind === \"body\") {\n" +
  "    if (!ev.text) { return steps; }\n" +
  "    const last = steps[steps.length - 1];\n" +
  "    if (last && last.kind === \"body\") {\n" +
  "      return [...steps.slice(0, -1), { kind: \"body\", text: (last.text ?? \"\") + ev.text }];\n" +
  "    }\n" +
  "    return [...steps, { kind: \"body\", text: ev.text }];\n" +
  "  }";
const A_MERGE_RULE =
  "    if (last && last.kind === \"body\") {\n" +
  "      return [...steps.slice(0, -1), { kind: \"body\", text: (last.text ?? \"\") + ev.text }];\n" +
  "    }";
const A_GROUP_BOUNDARY = "    const boundary = i === steps.length || steps[i].kind === \"think\";";
const A_FOREGROUND_WRITE =
  "        const bodyChunk = c.data?.content ?? \"\";\n" +
  "        if (bodyChunk) {\n" +
  "          timelineStepsRef.current = appendTimelineStep(timelineStepsRef.current, { kind: \"body\", text: bodyChunk });\n" +
  "        }";
const A_BACKGROUND_WRITE =
  "            if (content) {\n" +
  "              snap.timeline = appendTimelineStep(snap.timeline, { kind: \"body\", text: content });\n" +
  "            }";
const A_RENDER_BRANCH =
  "  if (step.kind === \"body\") {\n" +
  "    const bodyText = step.text ?? \"\";\n" +
  "    if (!bodyText.trim()) { return <span style={{ display: \"none\" }} />; }\n" +
  "    return (\n" +
  "      <div className=\"think-step\">\n" +
  "        <span className=\"think-step-mark body-step-mark\" />\n" +
  "        <div className=\"think-step-text body-step-text\" data-body-step=\"1\">\n" +
  "          {streamingTail ? <StreamFadeText text={bodyText} /> : <Markdown text={bodyText} />}\n" +
  "        </div>\n" +
  "      </div>\n" +
  "    );\n" +
  "  }";
const A_META_KIND = "  kind: \"think\" | \"body\" | \"tool\" | \"plan\" | \"todo\" | \"steer\";";

const MUTATIONS = [
  {
    name: "1 删掉数据层 body 支（正文不进时间线 → 节点掉进工具卡兜底）",
    file: F_PANO,
    mutate: (t) => sub(t, A_BODY_BRANCH, ""),
  },
  {
    name: "2 合并规则放宽成「末尾是谁都合并」（两段正文糊成一坨、吃掉中间工具节点）",
    file: F_PANO,
    mutate: (t) => sub(
      t,
      A_MERGE_RULE,
      "    if (last) {\n"
      + "      return [...steps.slice(0, -1), { kind: last.kind, text: (last.text ?? \"\") + ev.text }];\n"
      + "    }",
    ),
  },
  {
    name: "3 groupTimeline 把 body 当组边界（每段正文自成一组、被折叠壳藏起来）",
    file: F_PANO,
    mutate: (t) => sub(
      t,
      A_GROUP_BOUNDARY,
      "    const boundary = i === steps.length || steps[i].kind === \"think\" || steps[i].kind === \"body\";",
    ),
  },
  {
    name: "4 前台 chunk 分支不再写 body（主路径丢正文）",
    file: F_PANEL,
    mutate: (t) => sub(t, A_FOREGROUND_WRITE, ""),
  },
  {
    name: "5 后台镜像不再写 body（流式期间切走会话即丢正文）",
    file: F_PANEL,
    mutate: (t) => sub(t, A_BACKGROUND_WRITE, ""),
  },
  {
    name: "6 删掉 TimelineNode 的 body 渲染支（正文掉进工具卡兜底）",
    file: F_PANEL,
    mutate: (t) => sub(t, A_RENDER_BRANCH, ""),
  },
  {
    name: "7 持久化 kind 联合去掉 body（重启/切会话后穿插正文全丢）",
    file: F_META,
    mutate: (t) => sub(t, A_META_KIND, "  kind: \"think\" | \"tool\" | \"plan\" | \"todo\" | \"steer\";"),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095s7")) { process.exit(1); }
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
