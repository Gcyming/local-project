/**
 * A-1068 变异测试（#227 收口）：把「思考历程里的实时工具卡」逐环改坏，要求守卫变红。
 *
 * 覆盖 `tests/core-ts/a1068-livecard.spec.ts`。缺了这条链的哪一环，用户看到的就还是
 * 「只有在最下方标注的成功/失败」—— 他反复反馈的正是这个体感。
 *
 * A 组：建卡（running:true / toolId 索引 / 原地翻 / else 兜底 / 可展开 / 状态词优先级）
 * B 组：回看历史时清掉粘住的 running（判据 + 两个数据源 + 不许用在渲染层）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 *
 * 用法：node gui/scripts/mut-a1068.mjs
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
const SPEC = "tests/core-ts/a1068-livecard.spec.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const META = "gui/src/renderer/pages/sessionCtxMeta.ts";
const TARGETS = [PANEL, META];

const MUTATIONS = [
  // ── A 建卡 / 原地翻 ───────────────────────────────────────────────────────
  {
    name: "A1 tool-start 不再往思考历程建卡（退回用户抱怨的处境：只有最下方事后成败）",
    file: PANEL,
    /* ⚠️ 首版写成"用一个仍会调用 appendTimelineStep 的诱饵表达式替换赋值"—— 那是**没变异到点子上**：
       守卫锁的是"这一段真的建了卡"，而诱饵把 `appendTimelineStep(` 这个串留在原地 → 假存活。
       变异必须改掉**被判据锁住的那个事实**（这里就是"整段建卡 + 写回 + 广播"）。 */
    mutate: (t) => sub(
      t,
      "        const steps = appendTimelineStep(timelineStepsRef.current, {\n          kind: \"tool\", name: rawName,",
      "        const steps = timelineStepsRef.current; void ({\n          kind: \"tool\", name: rawName,",
    ),
  },
  {
    name: "A1b 建了卡但没写回 / 没广播（ref 与 state 都没更新 → 界面上依然不出现）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      "        timelineStepsRef.current = steps;\n        if (toolId) { toolStepIndexRef.current.set(toolId, steps.length - 1); }\n        setLiveTimeline(steps);",
      "        void steps; void toolId;",
    ),
  },
  {
    name: "A2 建卡不带 running（卡片一出现就是「未记录」的哑行，实时态消失）",
    file: PANEL,
    mutate: (t) => sub(t, "          detail: extractToolDetail(c.data.args, undefined),\n          running: true,\n        });", "          detail: extractToolDetail(c.data.args, undefined),\n        });"),
  },
  {
    name: "A3 不记 toolId 索引（结果到了配不上 → 出两张卡：一张永远停在执行中）",
    file: PANEL,
    mutate: (t) => sub(t, "        if (toolId) { toolStepIndexRef.current.set(toolId, steps.length - 1); }", "        if (toolId) { /* 索引不记 */ }"),
  },
  {
    name: "A4 结果到了不取配对索引（永远追加 → 违反「原地翻状态」）",
    file: PANEL,
    mutate: (t) => sub(t, "        const stepIdx = toolIdHere ? toolStepIndexRef.current.get(toolIdHere) : undefined;", "        const stepIdx: number | undefined = undefined;"),
  },
  {
    name: "A5 原地翻时忘了判 running（会把历史里已完成的卡也翻掉，状态互相污染）",
    file: PANEL,
    mutate: (t) => sub(t, "if (pendingStep && pendingStep.kind === \"tool\" && pendingStep.running === true) {", "if (pendingStep && pendingStep.kind === \"tool\") {"),
  },
  {
    name: "A6 翻完不销索引（下一次同名调用会翻错卡）",
    file: PANEL,
    mutate: (t) => sub(t, "          toolStepIndexRef.current.delete(toolIdHere);", "          void toolIdHere;"),
  },
  {
    name: "A7 else 兜底删掉（配不上的结果事件静默消失：历史回退路径整段没卡）",
    file: PANEL,
    mutate: (t) => sub(t, "        } else {\n          timelineStepsRef.current = appendTimelineStep(timelineStepsRef.current, {\n            kind: \"tool\", name: rawName, label: displayLabel.replace(/^⟳\\s*/, \"\"), detail, result: ev.result,\n          });\n        }", "        }"),
  },
  {
    name: "A8 兜底建卡也带上 running（历史卡永远显示「执行中」）",
    file: PANEL,
    mutate: (t) => sub(t, "label: displayLabel.replace(/^⟳\\s*/, \"\"), detail, result: ev.result,", "label: displayLabel.replace(/^⟳\\s*/, \"\"), detail, result: ev.result, running: true,"),
  },
  {
    name: "A9 组件不再把 running 传进唯一出处（正在跑又变回一行哑行）",
    file: PANEL,
    mutate: (t) => sub(t, "const statusLabel = toolStatusLabel(tool.result, isFail, isRunning);", "const statusLabel = toolStatusLabel(tool.result, isFail);"),
  },
  {
    name: "A10 卡片丢掉展开能力（用户要的是「可展开栏目」）",
    file: PANEL,
    mutate: (t) => sub(t, "const hasBody = !!tool.detail || !!r;", "const hasBody = false;"),
  },

  // ── B 回看历史时清掉粘住的 running ────────────────────────────────────────
  {
    name: "B1 settleRunning 退化成恒等（回看历史时那张卡永久「执行中」）",
    file: META,
    mutate: (t) => sub(t, "return steps.map((s) => (s.running ? { ...s, running: false } : s));", "return steps as TimelineStepLite[];"),
  },
  {
    name: "B2 settleRunning 把整条节点删掉（不是清标志，而是丢卡片 —— 历史信息又少一块）",
    file: META,
    mutate: (t) => sub(t, "return steps.map((s) => (s.running ? { ...s, running: false } : s));", "return steps.filter((s) => !s.running);"),
  },
  {
    name: "B3 短路判据写反（有 running 时反而直接返回原样）",
    file: META,
    mutate: (t) => sub(t, "if (!steps.some((s) => s.running)) { return steps as TimelineStepLite[]; }", "if (steps.some((s) => s.running)) { return steps as TimelineStepLite[]; }"),
  },
  {
    name: "B4 只包磁盘那一路（localStorage 那一路照旧带着粘住的 running）",
    file: META,
    mutate: (t) => sub(t, "timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),", "timeline: fromMeta ?? settleRunning(adoptRecordTimeline(m.timeline)),"),
  },
  {
    name: "B5 settleRunning 整段不接线（函数写了但没人调用）",
    file: META,
    mutate: (t) => sub(t, "timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),", "timeline: fromMeta ?? adoptRecordTimeline(m.timeline),"),
  },
  {
    name: "B6 陈旧断言原样复活（下一个人会照着它相信 running 不落盘）",
    file: META,
    mutate: (t) => sub(t, "   * ⚠️ A-1068 更正：这里原先写着", "   * ⚠️ 持久化时它必然已是 false/缺省（结果到了才会落库）。原文：这里原先写着"),
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

const originals = new Map(TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(join(ROOT, t))]));

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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1068")) { process.exit(1); }

/** 引号自伤自检（A-1056）：**剥注释后**仍出现「CJK + ASCII 双引号 + CJK」才算坏。
 *  ⚠️ 判据必须**两侧都 CJK**（单侧命中是合法的 `it("中文…")`），且必须**先剥注释**。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of [SPEC, ...TARGETS]) {
  const bad = quoteSelfHarm(readFileSync(join(ROOT, rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 锚点自检 + 引号自伤自检均通过\n");

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
