#!/usr/bin/env node
/**
 * gui/scripts/mut-a1125.mjs — A-1125（设置左栏重排 + 分组）的变异验证。
 *
 * 守卫 `tests/gui/a1125-settings-order.spec.ts` 锁的四件事**全属静默失效类**：
 * 改坏了 `tsc` 照样过、构建照样过、搜索照样"能搜"（只是搜不到那个功能）。
 * 所以每一条变异都要证明"守卫真的锁住了那件事"：
 *
 *   ① 13 项一项不少（掉一项 = 那个板块从界面上消失）
 *      M1  删掉整条「使用统计」条目（`SECTIONS` 少一项）
 *   ② 顺序 === 「频率 × 重要性」排序结果（乱序 = 用户报的「很混乱」原样复发）
 *      M2  把「技能库」与「MCP 接入」两块对调位置 —— **唯一能抓到它的就是 ②**
 *   ③ 每项 group 归属正确（改错组 = 用户去错的组里找）
 *      M3  「运行环境」从 `ops` 改挂 `agent`
 *   ④ 四个组都非空、顺序正确（空组 = 一个栏目从不显示）
 *      M4  删掉 `SECTION_GROUPS` 里的 `ops` 声明（该组三个栏目**永远不渲染**：filter 永不命中）
 *      M5  对调 `common` 与 `agent` 的声明（组顺序 = 用户看到的先后，不再是"常用"在最上）
 *      M6  「实验性」从 `advanced` 改挂 `common`（`advanced` 组变空壳）
 *   ⑤ keywords / features 条数不缩水（重排搬漏一行不报错，只会让搜索搜不到）
 *      M7  从「后台任务」的 features 里搬漏一项（`选拔派发`）
 *      M8  从「运行环境」的 keywords 里搬漏一项（`venv`）
 *   ⑥ 分组渲染接线 + 搜索态仍扁平 + 空组不画标题
 *      M9  分组渲染没接上（`SECTION_GROUPS.map` → `filtered.map`：左栏整列渲染为空）
 *     M10  搜索态也走分组（命中结果里插进组标题）
 *     M11  空组会画出光秃秃的组标题（去掉 `length === 0 → null` 的闸门）
 *     M12  分组标题的类名改了（`index.css` 那条样式当场失效）
 *   ⑦ 分组标题样式：存在 / 弱色 / 不可选中 / 首标题吃掉上间距 / **唯一产地**
 *     M13  `.settings-group-title` 主规则缺失（渲染成裸文字，视觉上没有分层）
 *     M14  组标题退回强色（抢可点条目的视觉权重）
 *     M15  去掉 `user-select: none`（用户会以为它是可点的）
 *     M16  首个组标题不再吃掉上间距（搜索框下方空出一道）
 *     M17  分组标题样式出现**第二个产地**（同语义两处定义 ⇒ 迟早漂移）
 *
 * 用法：`--list` / `--specs N` / `--apply N` / `--restore` / 全量。
 * 本环境禁止 node→node 孙进程 ⇒ **全量模式跑不了**，用 shell 顶层循环
 * （同 a1115 / a1116 / a1122 / a1123 的跑法）：
 *
 *   for i in $(seq 1 17); do
 *     node gui/scripts/mut-a1125.mjs --apply $i || break
 *     node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *       $(node gui/scripts/mut-a1125.mjs --specs $i) --reporter=dot > /tmp/m$i.txt 2>&1
 *     echo "M$i exit=$?"; grep -aE 'Tests +[0-9]' /tmp/m$i.txt
 *     node gui/scripts/mut-a1125.mjs --restore
 *   done
 *
 * ⚠️ 判据 = `exit≠0` **且**输出里真有 `Tests N` 汇总行（没有汇总行 = 测量工具本身坏了）。
 * ⚠️ `--specs $i` 别手写 spec 名：spec 清单由变异自己声明（`specs` 字段），
 *    手写会漏掉跨文件的守卫 ⇒ **假存活**（a1115 §3.1 的教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A-1125 的唯一守卫（顺序 / 分组 / 字段完整性 / 渲染接线 / 样式）。 */
const SPEC = "tests/gui/a1125-settings-order.spec.ts";

const F_SD = "gui/src/renderer/pages/SettingsDialog.tsx";
const F_CSS = "gui/src/renderer/index.css";

const TARGETS = [F_SD, F_CSS];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1125");

/** 每条 = 一条变异的锚点对（`from` 在目标文件里必须**命中且唯一**，由 `check-mut-anchors.mjs` 核验）。 */
const MUTATIONS = [
  // ── ① 13 项一项不少 ─────────────────────────────────────────────────────
  {
    name: "1 掉一整个栏目（「使用统计」从 SECTIONS 里消失 ⇒ 界面上没了）",
    file: F_SD, specs: [SPEC],
    from:
      '  {\n' +
      '    id: "usage", label: "使用统计", group: "ops",\n' +
      '    keywords: ["统计", "消耗", "token", "费用", "用量", "调用", "usage", "stats"],\n' +
      '    features: ["请求明细", "Token 消耗", "费用统计", "导出 CSV", "分页", "调用记录", "用量统计", "计费"],\n' +
      '  },\n',
    to: "",
  },

  // ── ② 顺序 ───────────────────────────────────────────────────────────────
  {
    name: "2 顺序：「技能库」与「MCP 接入」对调（唯一能抓到它的是 ②）",
    file: F_SD, specs: [SPEC],
    from:
      '  {\n    id: "skills", label: "技能库", group: "agent",\n' +
      '    keywords: ["技能", "skills", "skill"],\n' +
      '    features: ["技能市场", "GitHub 授权", "安装技能", "删除技能", "启用", "停用", "搜索技能", "技能目录", "自定义技能", "SKILL.md"],\n' +
      '  },\n' +
      '  {\n    id: "mcp", label: "MCP 接入", group: "agent",\n' +
      '    keywords: ["mcp", "工具", "服务器", "连接"],\n' +
      '    features: ["新增服务器", "启用", "停用", "删除服务器", "OAuth", "令牌", "工具权限", "远程 MCP", "stdio", "配置示例"],\n' +
      '  },',
    to:
      '  {\n    id: "mcp", label: "MCP 接入", group: "agent",\n' +
      '    keywords: ["mcp", "工具", "服务器", "连接"],\n' +
      '    features: ["新增服务器", "启用", "停用", "删除服务器", "OAuth", "令牌", "工具权限", "远程 MCP", "stdio", "配置示例"],\n' +
      '  },\n' +
      '  {\n    id: "skills", label: "技能库", group: "agent",\n' +
      '    keywords: ["技能", "skills", "skill"],\n' +
      '    features: ["技能市场", "GitHub 授权", "安装技能", "删除技能", "启用", "停用", "搜索技能", "技能目录", "自定义技能", "SKILL.md"],\n' +
      '  },',
  },

  // ── ③ 分组归属 ───────────────────────────────────────────────────────────
  {
    name: "3 分组归属改错（「运行环境」从 ops 挂到 agent）",
    file: F_SD, specs: [SPEC],
    from: '    id: "runtime", label: "运行环境", group: "ops",',
    to: '    id: "runtime", label: "运行环境", group: "agent",',
  },

  // ── ④ 组非空 + 组顺序 ────────────────────────────────────────────────────
  {
    name: "4 删掉 ops 组的声明（runtime/usage/status 三个栏目**永远不渲染**）",
    file: F_SD, specs: [SPEC],
    from: '  { id: "ops", label: "运行与维护" },\n',
    to: "",
  },
  {
    name: "5 组顺序对调（「常用」不再在最上；只 sort 后比集合是抓不到的）",
    file: F_SD, specs: [SPEC],
    from: '  { id: "common", label: "常用" },\n  { id: "agent", label: "Agent 与能力" },',
    to: '  { id: "agent", label: "Agent 与能力" },\n  { id: "common", label: "常用" },',
  },
  {
    name: "6 「实验性」改挂 common（advanced 组变空壳、组标题还挂在那里）",
    file: F_SD, specs: [SPEC],
    from: '    id: "experimental", label: "实验性", group: "advanced",',
    to: '    id: "experimental", label: "实验性", group: "common",',
  },

  // ── ⑤ 字段完整性（搬漏一行 = 搜索搜不到那个功能，**不报错**）────────────
  {
    name: "7 搬漏一个 feature（后台任务少的「选拔派发」⇒ 搜不到它）",
    file: F_SD, specs: [SPEC],
    from: ', "子代理默认模型", "选拔派发"],',
    to: ', "子代理默认模型"],',
  },
  {
    name: "8 搬漏一个 keyword（运行环境少的 venv）",
    file: F_SD, specs: [SPEC],
    from: '    keywords: ["node", "python", "git", "运行时", "附件", "配套", "runtime", "venv", "环境"],',
    to: '    keywords: ["node", "python", "git", "运行时", "附件", "配套", "runtime", "环境"],',
  },

  // ── ⑥ 渲染接线 ───────────────────────────────────────────────────────────
  {
    name: "9 分组渲染没接上（改用 filtered 迭代 ⇒ 左栏整列渲染为空）",
    file: F_SD, specs: [SPEC],
    from: "                return SECTION_GROUPS.map((g) => {",
    to: "                return filtered.map((g) => {",
  },
  {
    name: "10 搜索态也走分组（精准命中的结果里被插进组标题）",
    file: F_SD, specs: [SPEC],
    from: "                if (tokens.length > 0) { return filtered.map(renderItem); }",
    to: "                if (false) { return filtered.map(renderItem); }",
  },
  {
    name: "11 空组会画出光秃秃的组标题（去掉 length===0 → null 的闸门）",
    file: F_SD, specs: [SPEC],
    from: "                  if (items.length === 0) { return null; }",
    to: "                  if (false) { return null; }",
  },
  {
    name: "12 分组标题类名改了（index.css 那条样式当场失效）",
    file: F_SD, specs: [SPEC],
    from: '<div className="settings-group-title">{g.label}</div>',
    to: '<div className="settings-group-head">{g.label}</div>',
  },

  // ── ⑦ 分组标题样式 ───────────────────────────────────────────────────────
  {
    name: "13 样式主规则缺失（渲染成裸文字，视觉上没分层）",
    file: F_CSS, specs: [SPEC],
    from: ".settings-group-title {",
    to: ".settings-group-head {",
  },
  {
    name: "14 组标题退回强色（抢可点条目的视觉权重）",
    file: F_CSS, specs: [SPEC],
    from: "  font-weight: 700;\n  color: var(--text-dim);\n  padding: 10px 12px 5px;",
    to: "  font-weight: 700;\n  color: var(--text);\n  padding: 10px 12px 5px;",
  },
  {
    name: "15 去掉 user-select: none（用户会以为组标题是可点的）",
    file: F_CSS, specs: [SPEC],
    from: "  color: var(--text-dim);\n  padding: 10px 12px 5px;\n  user-select: none;\n",
    to: "  color: var(--text-dim);\n  padding: 10px 12px 5px;\n",
  },
  {
    name: "16 首个组标题不再吃掉上间距（搜索框下方空出一道）",
    file: F_CSS, specs: [SPEC],
    from: ".settings-group-title:first-child { padding-top: 2px; }",
    to: ".settings-group-title:first-child { padding-top: 10px; }",
  },
  {
    name: "17 分组标题样式出现第二个产地（同语义两处定义 ⇒ 迟早漂移）",
    file: F_CSS, specs: [SPEC],
    from: ".settings-group-title:first-child { padding-top: 2px; }",
    to: ".settings-group-title:first-child { padding-top: 2px; }\n.settings-group-title { color: var(--accent); }",
  },
].map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** 跑一组 spec（`specs` 由变异自己声明 —— **唯一出处**，别在 shell 里手写） */
function runSpecs(specs) {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...specs, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const specsOf = (m) => (m.specs && m.specs.length ? m.specs : [SPEC]);

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--specs") ? "specs"
    : argv.includes("--restore") ? "restore"
      : argv.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

/** 打印第 i 条变异该跑的守卫文件（shell 循环用） */
if (mode === "specs") {
  const idx = Number(argv[argv.indexOf("--specs") + 1]);
  const m = MUTATIONS[idx - 1];
  if (!m) { console.error(`--specs 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
  console.log(specsOf(m).join(" "));
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore。"); process.exit(1);
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs([SPEC]);
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1125")) { process.exit(1); }
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
    const res = runSpecs(specsOf(m));
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); console.error(res.out); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
