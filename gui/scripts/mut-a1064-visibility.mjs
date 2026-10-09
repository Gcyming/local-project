/**
 * A-1064 变异测试（二）：把「引导在界面上的可见性与完整性」逐个改坏，要求守卫变红。
 *
 * 与 `mut-a1064.mjs` 的分工：
 *   · `mut-a1064.mjs`        —— 改坏**中继兜底**（引擎事件必须穿过 ChatService.stream）；
 *   · 本文件（visibility）    —— 改坏**界面上引导的形态**（一等节点 / 契约类型 / 渲染分支 / 编排指令）。
 * 两者是**不同的产地**：中继修好了而界面仍折成 think，用户照样看不到卡片（且历程完整性照旧坏）。
 *
 * 红不出来 = 守卫锁错了对象。故变异是**验收标准**，不是可选步骤。
 *
 * ⚠️ 本文件里**不许**在中文句子中夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 *
 * 用法：node gui/scripts/mut-a1064-visibility.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1064-steer-visibility.spec.ts";
const PANORAMA = "gui/src/renderer/pages/todoPanorama.ts";
const CTX_META = "gui/src/renderer/pages/sessionCtxMeta.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const LOOP = "core-ts/src/tool_loop.ts";
const TARGETS = [PANORAMA, CTX_META, PANEL, LOOP];

/* ⚠️ 2026-10-08：`steerRenderRange` / `inSteerRender` / `COLLAPSE_CLS` **已删除**。
 * 它们只服务于第 5/6/7 条，而那三条的锚点现已提成下方模块级字面量常量。
 * ⇒ 删掉的理由不是「没人用了」而是**两个真相来源**：
 *   范围规则（`indexOf` 两个标记）留在脚本里、锚点常量又另抄一份，
 *   两者一旦漂移，核验器数的是常量、运行期切的是范围 ⇒ 两边结论打架而错的那边不响。
 *   删掉之后「steer 块在哪」只有常量这一个出处。 */

/* ── ⑤⑥⑦ 的锚点常量（2026-10-08 补：把「`from` 藏在 `mutate:` 闭包里」改成可静态核验）──
 *
 * 这三条原先靠 `steerRenderRange(t)` 在**闭包里**indexOf 两个标记、切出中间那一块，
 * 再对它做删除 / 搬移 / 换类名。核验器看不到闭包里的切片 ⇒ 报「未核验」。
 * 按铁律「没人核验 = 没有保护」，这三条守卫的保护强度是 0，
 * 且比「未命中」更隐蔽（未命中会响，未核验是静默的 —— 运行期它们显示「解析不了」，
 * 也就是说这三条**从未被运行验证过**，而静态那边显示的是「未核验」，不是红）。
 *
 * ⇒ 正解不是把范围规则硬塞给核验器（它只认证据），而是**把那一整块提成模块级字面量**：
 *   · ⑤「整支删掉」= from =整块，to = 空串；
 *   · ⑥「挪到工具卡兜底之后」= from = 整块 + 工具卡那两行，to = 工具卡那两行 + 整块
 *     （**一次替换**表达搬移；长度相等 = 1245 = 1245，已自检）。
 *     ⚠️⚠️ **不能**写成 `sub(BLK, BLK + 工具卡那两行)` 之类 —— 那会把工具卡那段**复制**一份
 *       （原文不复制），变成另一种缺陷（重复声明）⇒ 弱化/走偏的变异体。
 *   · ⑦「另造第二种动画」= from = 带`steer-card-text` 的那三行（收窄到唯一），
 *     to = 同三行但类名换成 `steer-anim`。
 *
 * ⚠️ 每个常量都是**逐字节抄自当前源码**的连续片段，且各自**唯一命中**（已实测）。
 * ⚠️ 都是**单个**双引号字面量、**不许 `+` 拼接**：拼接会让 `constMap`
 *   落到「常量字面量解析失败」⇒ 又变回未核验（实测）。
 * ⚠️ `${…}` 在双引号字面量里**不是插值**（那是模板字面量的语法），所以锚点里的
 *   `${expanded ? …}` 不需要转义 `$`，也不会被核验器的「拒绝插值」规则吃掉。
 *
 * ⑤⑥ 用的是**同一段范围规则**切出来的（起点 `if (step.kind === "steer") {`、
 * 终点 `// 工具调用：小型行`）—— 与下面 `steerRenderRange` 的两个标记**逐字一致**，
 * 所以「删掉整块」与「把它搬到别处」表达的是同一件事实。 */
const A1064_STEER_BLOCK = "if (step.kind === \"steer\") {\n    const text = step.text ?? \"\";\n    if (!text) { return <span style={{ display: \"none\" }} />; }\n    return (\n      <div className=\"think-step\">\n        <span className=\"think-step-mark steer-step-mark\" />\n        <div className=\"steer-card\">\n          <button\n            className=\"steer-card-head\"\n            onClick={() => setExpanded((v) => !v)}\n            title={expanded ? \"收起这条引导\" : \"展开这条引导（全文）\"}\n          >\n            <ChevronIcon size={12} rotate={expanded ? 90 : 0} style={{ flexShrink: 0, color: \"var(--text-dim)\" }} />\n            <SendIcon size={12} style={{ flexShrink: 0, color: \"var(--accent-hover)\" }} />\n            <span className=\"steer-card-title\">引导</span>\n            {!expanded && <span className=\"steer-card-preview\" title={text}>{stripMarkdown(text).slice(0, 80)}</span>}\n          </button>\n          {/* A-1015：常驻挂载 + 只切 is-open（与思考段/规划卡同一套展开节奏，不新增第二种动画） */}\n          <div className={`collapse${expanded ? \" is-open\" : \"\"}`}>\n            <div>\n              <div className=\"steer-card-text\">{text}</div>\n            </div>\n          </div>\n        </div>\n      </div>\n    );\n  }\n  ";
/** ⑥ 的 from：steer 整块 **+** 其后紧邻的工具卡那两行（到`const tool = …` 为止）。 */
const A1064_STEER_AFTER_TOOLPAIR = "if (step.kind === \"steer\") {\n    const text = step.text ?? \"\";\n    if (!text) { return <span style={{ display: \"none\" }} />; }\n    return (\n      <div className=\"think-step\">\n        <span className=\"think-step-mark steer-step-mark\" />\n        <div className=\"steer-card\">\n          <button\n            className=\"steer-card-head\"\n            onClick={() => setExpanded((v) => !v)}\n            title={expanded ? \"收起这条引导\" : \"展开这条引导（全文）\"}\n          >\n            <ChevronIcon size={12} rotate={expanded ? 90 : 0} style={{ flexShrink: 0, color: \"var(--text-dim)\" }} />\n            <SendIcon size={12} style={{ flexShrink: 0, color: \"var(--accent-hover)\" }} />\n            <span className=\"steer-card-title\">引导</span>\n            {!expanded && <span className=\"steer-card-preview\" title={text}>{stripMarkdown(text).slice(0, 80)}</span>}\n          </button>\n          {/* A-1015：常驻挂载 + 只切 is-open（与思考段/规划卡同一套展开节奏，不新增第二种动画） */}\n          <div className={`collapse${expanded ? \" is-open\" : \"\"}`}>\n            <div>\n              <div className=\"steer-card-text\">{text}</div>\n            </div>\n          </div>\n        </div>\n      </div>\n    );\n  }\n  // 工具调用：小型行 + 折叠详情（含结果：成功显示访问/编辑内容，失败显示失败原因）\n  const tool = step as TimelineStep & { kind: \"tool\" };";
/** ⑥ 的 to：**交换**后（工具卡那两行在前、steer 整块在后）—— 长度与 from 完全相同。 */
const A1064_TOOLPAIR_STEER = "// 工具调用：小型行 + 折叠详情（含结果：成功显示访问/编辑内容，失败显示失败原因）\n  const tool = step as TimelineStep & { kind: \"tool\" };if (step.kind === \"steer\") {\n    const text = step.text ?? \"\";\n    if (!text) { return <span style={{ display: \"none\" }} />; }\n    return (\n      <div className=\"think-step\">\n        <span className=\"think-step-mark steer-step-mark\" />\n        <div className=\"steer-card\">\n          <button\n            className=\"steer-card-head\"\n            onClick={() => setExpanded((v) => !v)}\n            title={expanded ? \"收起这条引导\" : \"展开这条引导（全文）\"}\n          >\n            <ChevronIcon size={12} rotate={expanded ? 90 : 0} style={{ flexShrink: 0, color: \"var(--text-dim)\" }} />\n            <SendIcon size={12} style={{ flexShrink: 0, color: \"var(--accent-hover)\" }} />\n            <span className=\"steer-card-title\">引导</span>\n            {!expanded && <span className=\"steer-card-preview\" title={text}>{stripMarkdown(text).slice(0, 80)}</span>}\n          </button>\n          {/* A-1015：常驻挂载 + 只切 is-open（与思考段/规划卡同一套展开节奏，不新增第二种动画） */}\n          <div className={`collapse${expanded ? \" is-open\" : \"\"}`}>\n            <div>\n              <div className=\"steer-card-text\">{text}</div>\n            </div>\n          </div>\n        </div>\n      </div>\n    );\n  }\n  ";
/** ⑦ 的锚点：引导卡里那处 `collapse` 类名（**带两行下文**收窄到唯一 —— 裸类名在文件里出现 4 次）。 */
const A1064_STEER_COLLAPSE = "          <div className={`collapse${expanded ? \" is-open\" : \"\"}`}>\n            <div>\n              <div className=\"steer-card-text\">{text}</div>";
/** ⑦ 的目标：另造第二种动画类名 `steer-anim`（不复用既有 collapse 机制）。 */
const A1064_STEER_ANIM = "          <div className={`steer-anim${expanded ? \" is-open\" : \"\"}`}>\n            <div>\n              <div className=\"steer-card-text\">{text}</div>";

const MUTATIONS = [
  {
    name: "1 引导节点退回折成 think 文本（旧形态：与相邻思考段糊成一坨，卡片彻底消失）",
    file: PANORAMA,
    mutate: (t) => sub(
      t,
      'return [...steps, { kind: "steer", text: ev.text }];',
      'return [...steps, { kind: "think", text: "引导：" + ev.text }];',
    ),
  },
  {
    name: "2 引导分支丢掉空文本守卫（产出零宽度空卡片）",
    file: PANORAMA,
    mutate: (t) => sub(
      t,
      'if (ev.kind === "steer") {\n    if (!ev.text) { return steps; }',
      'if (ev.kind === "steer") {',
    ),
  },
  {
    /* A-1095 #8′ 迁移：时间线新增 `body`（该轮正文片段）成员，联合已变为
       `"think" | "body" | "tool" | "plan" | "todo" | "steer"`。变异意图逐字保留：
       让**持久化镜像**的联合少认一个成员 ⇒ 重启回看时该种节点静默丢失。 */
    name: "3 持久化镜像 TimelineStepLite 不认 steer（重启回看时引导节点静默丢失）",
    file: CTX_META,
    mutate: (t) => sub(
      t,
      'kind: "think" | "body" | "tool" | "plan" | "todo" | "steer";',
      'kind: "think" | "body" | "tool" | "plan" | "todo";',
    ),
  },
  {
    name: "4 onChunk 又把引导折成 think（新写法被回退 → 卡片与历程完整性一起丢）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      '{ kind: "steer", text: steerText },',
      "{ kind: \"think\", text: `引导：${steerText}` },",
    ),
  },
  {
    name: "5 steer 渲染分支被整支删掉（引导掉进工具卡兜底 → 变成长着 undefined 名字的工具）",
    file: PANEL,
    /* ⚠️ 2026-10-08：锚点提成模块级字面量常量 + 补显式的 from 字段（见上方常量区注释）。
       语义完全没变：删掉 [起点标记, 终点标记) 这一段（与旧 `steerRenderRange` 同一对标记）。 */
    from: A1064_STEER_BLOCK,
    to: "",
    mutate: (t) => sub(t, A1064_STEER_BLOCK, ""),
  },
  {
    name: "6 steer 渲染分支被挪到工具卡兜底**之后**（顺序断言必须独立锁住）",
    file: PANEL,
    /* ⚠️ 2026-10-08：改成**一次替换的交换**（见上方常量区注释）。
       语义与旧写法一致（把steer 整块搬到工具卡那两行之后），
       但**没有把工具卡那段复制一份** —— 长度 1245 = 1245，可证是干净的重排。 */
    from: A1064_STEER_AFTER_TOOLPAIR,
    to: A1064_TOOLPAIR_STEER,
    mutate: (t) => sub(t, A1064_STEER_AFTER_TOOLPAIR, A1064_TOOLPAIR_STEER),
  },
  {
    name: "7 引导卡另造第二种展开动画（不复用 collapse → 节拍与思考段/规划卡不一致）",
    file: PANEL,
    /* ⚠️ 2026-10-08：锚点提成模块级字面量常量 + 补显式的 from 字段。
       ⚠️ 锚点比旧写法**多了两行下文**（`steer-card-text` 那两行）：裸类名
       `className={`collapse…`}` 在ChatPanel.tsx 里出现 **4** 次（思考段/规划卡/引导卡…）
       ⇒ 旧写法靠 `inSteerRender` 先切到 steer 范围才能定位，而那个范围核验器看不见。
       现在带下文收窄到**唯一命中**（已实测）。 */
    from: A1064_STEER_COLLAPSE,
    to: A1064_STEER_ANIM,
    mutate: (t) => sub(t, A1064_STEER_COLLAPSE, A1064_STEER_ANIM),
  },
  {
    name: "8 编排指令不再钉死 action=add（模型会落到 replace → 用户既有计划被整表抹掉）",
    file: LOOP,
    mutate: (t) => sub(t, '**默认用 action=\\"add\\"**', "**默认按需选择 action**"),
  },
];

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

if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1064-visibility")) { process.exit(1); }
console.log("行尾检测器自检 + 锚点自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）`);
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
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
