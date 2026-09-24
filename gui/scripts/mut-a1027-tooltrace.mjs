/*
 * 变异测试：A-1027「`marker@0` 工具留痕整条不可见」守卫的**取证**。
 *
 * 缺陷链三环节（① 产地写成整段 reasoning ② 渲染层正则砍到文末 ③ 历史无 stages → 面板不渲染），
 * 每一环都有"改回去不报错、跑起来也不崩、只是留痕悄悄消失"的写法，逐一验红。
 *
 * ⚠️ 为什么必须有这一步（项目铁律）：守卫写完只是**声明**了意图，变异测试才证明它**真的**在拦。
 *    本脚本专门覆盖三类"守卫也可能瞎"的情形：
 *      ② 解析结果**没接到渲染上**（解析对了但不渲染 = 最常见的假修）
 *      ④⑤ 解析器自身退化成"吞内容 / 块永不结束"（正是这个 bug 的原始形态）
 *      ⑧ 去重逻辑消失（同一工具显示两遍）—— 只有**多重集**语义才抓得到
 *      ③⑪⑫ 反查：短路 / 缺一步 / 被搬回 `.tsx` 复写（前两条只能靠**行为**测，
 *           故反查本体已从 `.tsx` 搬进 `thinkingText.ts` 纯模块 —— 住在 `.tsx` 时
 *           ③ 曾实测漏网，守卫只能断言"那几行在不在"）
 *
 * ⚠️ 换行符**逐文件**判定（见下方 eol）：本仓库检出并不统一。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const THINK = path.join(ROOT, "gui", "src", "renderer", "pages", "thinkingText.ts");
const PANEL = path.join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx");

/* 兜底路径的两条关键语句（缩进是现场形态，用它保证打在真代码上）。
 * ⚠️ A-1034 之后这两处形态变了：`trace` 的所在层级左移（10 空格 → 2 空格），
 *    `tracedTools` 的接线又补了 `result` / `diffTrimmed`（写入卡片展 diff 用）。
 *    锚点必须跟着现场走，否则脚本只报"锚点未命中"、守卫却照旧全绿（= 假绿）。 */
const TRACE_CALL = "  const trace = splitToolTrace(m.reasoning ?? \"\");\n";
const TRACED_WIRE =
  "        ...tracedTools.map((t) => ({ kind: \"tool\" as const, name: t.name, label: t.label, result: t.result, diffTrimmed: t.diffTrimmed })),\n";

const variants = [
  // ── ① 消费端：解析结果的接线 ─────────────────────────────
  {
    name: "① ★ 兜底路径退回『砍到文末』的内联正则（marker@0 时整段推理被砍空 = 原病灶）",
    file: PANEL,
    from: TRACE_CALL,
    to: "  const trace = { text: (m.reasoning ?? \"\").replace(/### 工具调用记录[\\s\\S]*$/g, \"\"), traces: [] };\n",
  },
  {
    name: "② ★ 解析出来了但不接入 timeline（解析正确、界面依旧空白 = 假修）",
    file: PANEL,
    from: TRACED_WIRE,
    to: "",
  },
  {
    name: "③ ★ 反查被短路（永远返回 null → 工具名拿不回来、图标全退化）",
    file: THINK,
    from: "  const t = (entry ?? \"\").trim();\n  if (!t) { return null; }\n",
    to: "  const t = (entry ?? \"\").trim();\n  if (!t) { return null; }\n  return null; // 变异：短路\n",
  },

  // ── ② 解析器：无损性与边界 ───────────────────────────────
  {
    name: "④ ★ 解析器改成『块内非列表行也吞掉』（吞内容 = 这个 bug 的原始形态）",
    file: THINK,
    from:
      "      if (line.trim() === \"\") { continue; }  // 块内空行丢弃\n" +
      "      // 非列表行（含下一个行首同级 `###` 标题）→ 块到此结束，**本行保留在正文里**\n" +
      "      // （宁可少解析，不可吞内容）\n" +
      "      inBlock = false;\n" +
      "      kept.push(line);\n" +
      "      continue;\n",
    to: "      if (line.trim() === \"\") { continue; }\n      continue; // 变异：吞掉非列表行\n",
  },
  {
    name: "⑤ ★ 块终点不再复位（`inBlock` 永远为真 → 后面章节自己的列表项被吃进留痕）",
    file: THINK,
    from:
      "      // 非列表行（含下一个行首同级 `###` 标题）→ 块到此结束，**本行保留在正文里**\n" +
      "      // （宁可少解析，不可吞内容）\n" +
      "      inBlock = false;\n" +
      "      kept.push(line);\n",
    to: "      kept.push(line); // 变异：块永不结束\n",
  },
  {
    name: "⑥ ★ 条目不再剥 `⟳ ` 前缀（标签带上箭头字符，反查也就全 miss）",
    file: THINK,
    from: "        const entry = m[1].replace(/^⟳\\s*/, \"\").trim();\n",
    to: "        const entry = m[1].trim();\n",
  },
  {
    name: "⑦ ★ 标题常量与 core-ts 组装器不一致（core-ts 写的块，渲染层认不出来）",
    file: THINK,
    from: "export const TOOL_TRACE_HEADING = \"### 工具调用记录\";\n",
    to: "export const TOOL_TRACE_HEADING = \"### 工具调用记录 \";\n",
  },

  // ── ③ 去重与格式产地 ────────────────────────────────────
  {
    name: "⑧ ★ 去重逻辑消失（结构化来源 + 文本块 → 同一工具显示两遍）",
    file: THINK,
    from:
      "    const hit = pool.indexOf(entry);\n" +
      "    if (hit >= 0) { pool.splice(hit, 1); continue; }\n",
    to: "",
  },
  {
    name: "⑨ ★ composeToolTrace 多加一层 `⟳ `（与 core-ts 输出不再逐字节一致；label 已带前缀 → 双箭头）",
    file: THINK,
    from: "  return `${TOOL_TRACE_HEADING}\\n${rows.map((e) => `- ${e}`).join(\"\\n\")}`;\n",
    to: "  return `${TOOL_TRACE_HEADING}\\n${rows.map((e) => `- ⟳ ${e}`).join(\"\\n\")}`;\n",
  },
  {
    name: "⑩ ★ 空条目也产出块（历史里会留下光秃秃的标题行）",
    file: THINK,
    from: "  if (rows.length === 0) { return \"\"; }\n",
    to: "",
  },
  {
    name: "⑪ ★ 反查丢掉『按展示名』那一步（core-ts 写的展示名反查不到 → 工具图标全退化）",
    file: THINK,
    from:
      "  for (const [name, v] of Object.entries(table)) {\n" +
      "    if (v.label === t) { return { name, label: v.label }; }\n" +
      "  }\n",
    to: "",
  },
  {
    name: "⑫ ★ 反查逻辑被搬回 `.tsx` 复写一份（唯一实现被破坏 → 两处各说各话）",
    file: PANEL,
    from: "  return resolveToolEntry(entry, TOOL_LABELS);\n",
    to:
      "  const t = (entry ?? \"\").trim();\n" +
      "  for (const [name, v] of Object.entries(TOOL_LABELS)) {\n" +
      "    if (v.label === t) { return { name, label: v.label }; }\n" +
      "  }\n" +
      "  return resolveToolEntry(entry, TOOL_LABELS);\n",
  },
];

const files = [THINK, PANEL];
const GUARDS = ["tests/core-ts/a1027-guards.spec.ts"];

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));

/** 从 vitest 输出里取一条**有信息量**的失败原因。
 *  ⚠️ 别用 `includes("→")` 之类宽松匹配：测试名里就有箭头，会把 `stdout | …` 噪音当成原因。 */
function reasonOf(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const pick =
    lines.find((l) => l.includes("AssertionError")) ||
    lines.find((l) => l.startsWith("×")) ||
    lines.find((l) => l.includes("FAIL")) ||
    "";
  return pick.replace(/\s+/g, " ").slice(0, 175);
}

function runGuards() {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...GUARDS],
      { cwd: ROOT, timeout: 300000, encoding: "utf8" },
    );
    return { code: 0, text: out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, text: `${e.stdout || ""}\n${e.stderr || ""}` };
  }
}

const results = [];
for (const v of variants) {
  const orig = fs.readFileSync(v.file, "utf8");
  /* ⚠️ 换行符**逐文件**判定：本仓库检出并不统一（实测 `gui/src/main/providers.ts` 是 CRLF，
     而 `index.ts` / `ChatPanel.tsx` 是 LF）。锚点里写死 `\n` 会在 CRLF 文件上全部"未命中"，
     而脚本只会报"锚点未命中（脚本失效）"—— 看起来像脚本坏了，其实是锚点没适配换行。 */
  const eol = orig.includes("\r\n") ? "\r\n" : "\n";
  const from = v.from.replace(/\n/g, eol);
  const to = v.to.replace(/\n/g, eol);
  if (!orig.includes(from)) { results.push({ name: v.name, error: "变异锚点未命中（脚本失效）" }); continue; }
  fs.writeFileSync(v.file, orig.replace(from, to), "utf8");
  const r = runGuards();
  results.push({ name: v.name, code: r.code, reason: reasonOf(r.text), red: r.code !== 0 });
  fs.writeFileSync(v.file, orig, "utf8");
}

const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const restored = files.every((f) => before[f] === after[f]);

console.log("\n================ A-1027（工具留痕 marker@0）变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 两文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
