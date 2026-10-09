#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-model-search.mjs — 「供应商模型列表搜索栏」的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 * 「供应商内，模型加载出来后，模型的查找，在模型列表的正上方加一个搜索栏，
 *   专门搜索该供应商模型列表的模型」
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 过滤后重排下标（i: j） | **静默改错模型**：开关一拨改到另一行 | ① 「不许重排下标」 |
 * | 2 | tbody 遍历回全量 | 搜索栏形同虚设（筛了但不显示筛的结果） | ② 「tbody 遍历 visibleModelRows」 |
 * | 3 | 删「换目标时重置」 | 下一个供应商「莫名没有模型」（其实是被上个词筛掉） | ④ 重置 + ③ 清除入口 |
 * | 4 | 删空结果提示 | 空白表格被误读成「该供应商没有模型」 | ④ 空结果说明 |
 * | 5 | 匹配改大小写敏感 | 搜 `gpt` 搜不到 `GPT-4o` 这类上游大写 ID | ④ toLowerCase |
 * | 6 | 搜索栏不再独占一行 | 与表头挤在一行、长列表下被挤没 | ③ flexBasis 100% |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-model-search.mjs`
 * ⚠️ 注释里**不放反引号**（核验器的 STR 扫描器会被它截断）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-model-search.spec.ts",
];

const F_PANEL = "gui/src/renderer/pages/ProvidersPanel.tsx";
const TARGETS = [F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-model-search");

const MUTATIONS = [
  /* ── ① 索引错位（最危险：界面看不出来）──────────────────────────── */
  {
    name: "1 过滤后重排下标（开关会改到另一个模型上）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      return id.includes(q) || label.includes(q);\n    });\n  }, [edit, modelQuery]);",
      "      return id.includes(q) || label.includes(q);\n    }).map((x, j) => ({ ...x, i: j }));\n  }, [edit, modelQuery]);",
    ),
  },
  /* ── ② 表格不再消费过滤结果 ─────────────────────────────────────── */
  {
    name: "2 tbody 遍历回全量（搜索栏形同虚设）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "                        <tbody>\n                          {visibleModelRows.map(({ m, i }) => (",
      "                        <tbody>\n                          {edit.models.map((m, i) => (",
    ),
  },
  /* ── ③ 清除入口与独占一行 ─────────────────────────────────────── */
  {
    name: "3 删掉换编辑目标时的搜索词重置",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "  React.useEffect(() => {\n    setModelQuery(\"\");\n  }, [edit?.key, edit?.mode]);\n\n",
      "",
    ),
  },
  {
    name: "4 搜索栏不再独占一行（与表头挤在一起）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '                        <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>',
      '                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>',
    ),
  },
  /* ── ④ 边界情形 ──────────────────────────────────────────────── */
  {
    name: "5 删掉空结果提示（空白表格被当成没有模型）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "                          {visibleModelRows.length === 0 && (",
      "                          {false && (",
    ),
  },
  {
    name: "6 匹配改成大小写敏感（搜不到上游的大写 ID）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      const id = String(m.id ?? \"\").toLowerCase();\n      const label = String((m as { label?: string }).label ?? \"\").toLowerCase();",
      "      const id = String(m.id ?? \"\");\n      const label = String((m as { label?: string }).label ?? \"\");",
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
if (reportEolProblems(eolFound, "mut-a1197-model-search")) { process.exit(1); }

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
  if (!existsSync(backup)) {
    console.error(`❌ 备份缺失（${backup}）—— 无法自动还原 ${man.file}，请用 git 恢复该文件。`);
    process.exit(1);
  }
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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-model-search.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 1) { process.exit(1); }
process.exit(1);
