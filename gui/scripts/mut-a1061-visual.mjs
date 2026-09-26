/**
 * A-1061⑨/⑬/⑭ 变异测试：本轮"看得见"的改动（字号层级 / markdown 代码块 / 流式渐入 / 激励语）。
 *
 * 这一组全是**静默失效**类：改坏了 tsc 照样过、构建照样过、逻辑测试照样过，
 * 只有用户眼里翻车（"字还是那么细" / "还是一整块蹦出来" / "正文和思考混成一个样"）。
 * 所以必须靠变异脚本证明守卫真的锁住了它们。
 *
 * 守卫：tests/gui/a1061-visual.spec.ts（纯逻辑 + CSS/TSX 静态判据）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1061-visual.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/a1061-visual.spec.ts";

const CSS = "gui/src/renderer/index.css";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const FADE = "gui/src/renderer/pages/streamFade.ts";
const TARGETS = [CSS, PANEL, FADE];

const RAW_MUTATIONS = [
  // ── 字号 / 代码块 / 激励语 ────────────────────────────────────────────────
  {
    name: "1 正文字号退回 14px（与注释宣称的 15px 又不符）",
    file: PANEL,
    from: '<div className="msg-body-text" style={{ lineHeight: 1.75, fontSize: 15,',
    to: '<div className="msg-body-text" style={{ lineHeight: 1.75, fontSize: 14,',
  },
  {
    name: "2 markdown 代码块字号退回 14px（用户点名的「这么细」）",
    file: CSS,
    from: "  font-size: 14.5px;\n  font-weight: 600;\n  font-family: Consolas, \"Cascadia Code\", \"Courier New\", \"Microsoft YaHei\", \"微软雅黑\", monospace;",
    to: "  font-size: 14px;\n  font-weight: 600;\n  font-family: Consolas, \"Cascadia Code\", \"Courier New\", \"Microsoft YaHei\", \"微软雅黑\", monospace;",
  },
  {
    name: "3 markdown 代码块字重退回 500（块内明显发虚）",
    file: CSS,
    from: "  font-size: 14.5px;\n  font-weight: 600;\n  font-family: Consolas, \"Cascadia Code\", \"Courier New\", \"Microsoft YaHei\", \"微软雅黑\", monospace;",
    to: "  font-size: 14.5px;\n  font-weight: 500;\n  font-family: Consolas, \"Cascadia Code\", \"Courier New\", \"Microsoft YaHei\", \"微软雅黑\", monospace;",
  },
  {
    name: "4 代码块丢掉中文黑体 fallback（中文注释回退到极细的宋体）",
    file: CSS,
    from: "  font-family: Consolas, \"Cascadia Code\", \"Courier New\", \"Microsoft YaHei\", \"微软雅黑\", monospace;\n  line-height: 1.7;",
    to: "  font-family: Consolas, \"Cascadia Code\", \"Courier New\", monospace;\n  line-height: 1.7;",
  },
  {
    name: "5 🐛 思考历程跟着正文一起放大（上一回就是这两者被改混）",
    file: CSS,
    from: "  font-size: 12.5px; /* 视觉降级：正文 15px → 思考 12.5px */",
    to: "  font-size: 15px; /* 视觉降级：正文 15px → 思考 12.5px */",
  },
  {
    name: "6 激励语退回 11.5px（又细又小看不清）",
    file: PANEL,
    /* A-1095 S0 迁移：激励语从"与主句同行"改成"独占最后一行"，属性行因此换行
       并加了 `minWidth: 0`。判据（退回 11.5px = 又细又小）不变，锚点更新到实际形态。
       A-1106（问题 3）再迁移：激励语 13 → **14px**（用户："正在思考下面那一块字体看着好小"），
       锚点跟随，判据不变。 */
    from: '<span style={{ color: "var(--text-secondary)", fontSize: 14, fontWeight: 500, minWidth: 0 }}>',
    to: '<span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 500, minWidth: 0 }}>',
  },

  // ── 流式渐入：CSS ─────────────────────────────────────────────────────────
  {
    name: "7 渐入 keyframes 起点不透明（等于没有渐入）",
    file: CSS,
    /* A-1076 迁移：位移机制从 `transform` 换成 `left`（尾巴单元是 `.stream-partial` 里的
       inline `<span>`，而 inline 盒子的 transform 会被规范静默忽略 → 位移从未发生）。
       锚点跟着走；变异意图不变（起点不透明 = 没有渐入）。 */
    from: "  from { opacity: 0; left: 3px; }",
    to: "  from { opacity: 1; left: 3px; }",
  },
  {
    name: "7b 渐入方向改回从左滑入（#225 用户原话：要的是从右到左）",
    file: CSS,
    from: "  from { opacity: 0; left: 3px; }",
    to: "  from { opacity: 0; left: -3px; }",
  },
  {
    name: "7c 位移退回 transform（inline 盒子上 transform 被静默忽略 → 「从右滑入」根本没发生）",
    file: CSS,
    from: "  from { opacity: 0; left: 3px; }",
    to: "  from { opacity: 0; transform: translate3d(3px, 0, 0); }",
  },
  {
    name: "7d 去掉 position: relative（`left` 不再生效 → 只剩淡入，位移静默丢失）",
    file: CSS,
    from: ".stream-fade-unit {\n  position: relative;\n",
    to: ".stream-fade-unit {\n",
  },
  {
    name: "8 尾巴单元不挂动画（切了也没效果）",
    file: CSS,
    from: ".stream-fade-unit {\n  position: relative;\n  animation: streamUnitIn 260ms cubic-bezier(0.22, 0.61, 0.36, 1) both;\n}",
    to: ".stream-fade-unit {\n  position: relative;\n  opacity: 1;\n}",
  },
  {
    name: "9 减动效退回 animation: none（一个开关同时关掉「思考 + 正文」全部渐入 —— 用户实测问题 c）",
    file: CSS,
    /* A-1124 迁移：旧判据是「**必须存在** `.stream-fade-unit { animation: none; }` 降级」，
       配套变异是「把整块降级删掉」。用户实测问题 c 之后判据**反转**了 ——
       降级的正确形态是「**只去位移、留不透明度渐入**」（`animation-name: streamUnitFadeIn`），
       而 `animation: none` 恰恰是要拦的回归（它一个开关同时关掉思考 + 正文两处渐入，
       且完全静默：过 tsc / 过构建 / 过逻辑测试，只在用户眼里消失）。
       ⇒ 变异点跟着反转：把新降级改回 `animation: none`。 */
    from: "  .stream-fade-unit { animation-name: streamUnitFadeIn; }",
    to: "  .stream-fade-unit { animation: none; }",
  },

  // ── 流式渐入：切分判据 ───────────────────────────────────────────────────
  {
    name: "10 🐛 未闭合代码围栏不再退让（尾行会被渲染到 </pre> 外面）",
    file: FADE,
    from: "  if (inUnclosedFence(shown)) { return noFade; }",
    to: "  if (false && inUnclosedFence(shown)) { return noFade; }",
  },
  {
    name: "11 🐛 行内 code 未闭合不再退让（反引号被当字面量切开）",
    file: FADE,
    /* A-1070 同步锚点：切分改成先取 `line` 再判，原锚点 `shown.slice(nl + 1)` 已不存在。 */
    from: "  if (inUnclosedInlineCode(line)) { return noFade; }",
    to: "  if (false) { return noFade; }",
  },
  {
    name: "12 🐛 拉丁按单字符切（浏览器会在任意字符断行 → configu ration）",
    file: FADE,
    from: "  const re = /[A-Za-z0-9_.,;:!?'\"()[\\]{}<>/\\\\+\\-*=@#$%^&|~`]+|\\s+|[\\s\\S]/g;",
    to: "  const re = /[\\s\\S]/g;",
  },
  {
    name: "13 🐛 尾巴起点退回**按字符截断**（A-1070 的回归：切到单元中间 → key 每帧变号 → 闪烁）",
    file: FADE,
    /* A-1070 同步锚点：起点现在是「首单元的绝对索引」。把它换回旧实现的按字符截断，
       同时破坏两件事：① 尾巴会夹换行（起点不再落在最后一行之后）；
       ② 窗口边界不再对齐单元 → tail / settled / units 三者不同源。 */
    from: "  const tailStart = units.length > 0 ? units[0].at : shown.length;",
    to: "  const tailStart = Math.max(0, shown.length - maxTail);",
  },
  {
    name: "13b A-1080 回归：接缝切回**行中间**（Markdown 块以半行结尾 → 尾端留空白 + 整段往上挤着重排）",
    file: FADE,
    from: "    settled: shown.slice(0, lineStart),\n    linePrefix: shown.slice(lineStart, tailStart),",
    to: "    settled: shown.slice(0, tailStart),\n    linePrefix: \"\",",
  },
  {
    name: "13c 最后半行不再渲染（linePrefix 丢掉 → 那段字直接消失，接缝也失去行内连续性）",
    file: PANEL,
    /* A-1095 S6 迁移：渲染块从"正文内联那段"抽成了 `StreamFadeText` 组件，
       缩进由 24 空格变 6 空格。判据（丢掉 linePrefix ⇒ 最后半行整段消失）不变。 */
    from: "      {fade.linePrefix}\n",
    to: "",
  },
  {
    name: "14 单元 key 退回**相对**索引（前缀推移后老单元 key 变号 → 动画整段重播）",
    file: FADE,
    from: "    out.push({ text: m[0], at: base + m.index });",
    to: "    out.push({ text: m[0], at: m.index });",
  },

  // ── 接线 ─────────────────────────────────────────────────────────────────
  {
    name: "15 已定型前缀不再走 Markdown（整段退回纯文本，丢语法高亮）",
    file: PANEL,
    from: "{fade.settled ? <Markdown text={fade.settled} streaming /> : null}",
    to: "{fade.settled ? <Markdown text={fade.tail} streaming /> : null}",
  },
];

const MUTATIONS = RAW_MUTATIONS.map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

const originals = new Map();
for (const t of TARGETS) { originals.set(t, readFileSync(join(ROOT, t), "utf8")); }
const hashes = new Map([...originals.keys()].map((t) => [t, hash(join(ROOT, t))]));

if (!runSpec()) { console.error("基线未通过 —— 先修好守卫再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1061-visual")) { process.exit(1); }
console.log("行尾检测器自检 + 锚点自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）: ${m.from.slice(0, 60)}…`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpec();
    writeFileSync(path, src);
    if (green) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  for (const [t, src] of originals) { writeFileSync(join(ROOT, t), src); }
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
