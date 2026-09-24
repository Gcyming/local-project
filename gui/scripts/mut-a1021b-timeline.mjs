/*
 * 变异测试：A-1021b（+ A-1021 ② 尺寸收敛）守卫的**取证**。
 *
 * 每条变异都打在"改回去不报错、跑起来也不崩、只有用户看截图才发现"的那个根因上，
 * 且都必须让对应守卫变红。跑完自动还原并校验哈希。
 *
 * checker=vitest → tests/core-ts/a1021b-guards.spec.ts 与 a1021-guards.spec.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const CHAT = path.join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx");
const CTX = path.join(ROOT, "gui", "src", "renderer", "pages", "sessionCtxMeta.ts");
const THINK = path.join(ROOT, "gui", "src", "renderer", "pages", "thinkingText.ts");

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");

/** 两个守卫文件一起跑：一条变异只要让**任一**守卫变红即算验红 */
const GUARDS = [
  "tests/core-ts/a1021b-guards.spec.ts",
  "tests/core-ts/a1021-guards.spec.ts",
];

const variants = [
  {
    name: "① 终止按钮图标退回手填 36（= 用户说「太大了」的那版，方块占圆底 51%）",
    file: CHAT,
    from: "{stopping ? <LoadingCircleIcon size={20} /> : <StopIcon size={STOP_ICON_SIZE} />}",
    to: "{stopping ? <LoadingCircleIcon size={20} /> : <StopIcon size={36} />}",
  },
  {
    name: "② 目标比例从 40% 漂到 55%（超出常规区间，方块又把圆底填满）",
    file: CHAT,
    from: "const STOP_ICON_SIZE = Math.round((STOP_BTN_SIZE * 0.40) / 0.512);",
    to: "const STOP_ICON_SIZE = Math.round((STOP_BTN_SIZE * 0.55) / 0.512);",
  },
  {
    name: "③ 圆底直径退回字面量（与图标尺寸脱钩，两侧各自漂移）",
    file: CHAT,
    from: "width: STOP_BTN_SIZE, height: STOP_BTN_SIZE, borderRadius: \"50%\",",
    to: "width: 36, height: 36, borderRadius: \"50%\",",
  },
  {
    name: "④ 历史兜底退回单节点（用户截图里的「时间线设计没了」）",
    file: CHAT,
    from: "        ...splitThinkingIntoSteps(cleanReasoning).map((t) => ({ kind: \"think\" as const, text: t })),",
    to: "        { kind: \"think\" as const, text: cleanReasoning },",
  },
  {
    name: "⑤ onDone 兜底退回单节点",
    file: CHAT,
    from: "finalTimeline = [...finalTimeline, ...splitThinkingIntoSteps(finalReasoning).map((t) => ({ kind: \"think\" as const, text: t }))];",
    to: "finalTimeline = [...finalTimeline, { kind: \"think\" as const, text: finalReasoning }];",
  },
  {
    name: "⑥ 切走会话分支不再落盘时间线（缺陷 A 原病灶：整条时间线凭空消失）",
    file: CHAT,
    from: "              void attachApi?.chat?.attachTimeline?.(agentId, sid, snap.timeline as unknown[]);",
    to: "              void attachApi?.chat?.attachTimeline?.(agentId, sid, []);",
  },
  {
    name: "⑦ 加载侧不再读记录自带的 timeline（缺陷 B 原病灶：只写不读）",
    file: CTX,
    /* A-1068 迁移：外面包了一层 `settleRunning(...)`（清掉落盘时粘住的 running），
       锚点跟着搬到**带外壳的整句**。判据（localStorage 缺项时回退到记录自带的 timeline）没变。 */
    from: "      timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),",
    to: "      timeline: fromMeta,",
  },
  {
    name: "⑧ 节点数上限放到 200（有界合并失效 → 渲染成百上千节点）",
    file: THINK,
    from: "export const THINK_STEP_MAX = 24;",
    to: "export const THINK_STEP_MAX = 200;",
  },
];

const before = { chat: sha(CHAT), ctx: sha(CTX), think: sha(THINK) };
const results = [];

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

for (const v of variants) {
  const orig = fs.readFileSync(v.file, "utf8");
  if (!orig.includes(v.from)) { results.push({ name: v.name, error: "变异锚点未命中（脚本失效）" }); continue; }
  fs.writeFileSync(v.file, orig.replace(v.from, v.to), "utf8");

  const r = runGuards();
  const reason = (r.text.split("\n").find((l) => l.includes("AssertionError")) || "").trim().slice(0, 170);
  results.push({ name: v.name, code: r.code, reason, red: r.code !== 0 });

  fs.writeFileSync(v.file, orig, "utf8");
}

const after = { chat: sha(CHAT), ctx: sha(CTX), think: sha(THINK) };
const restored = after.chat === before.chat && after.ctx === before.ctx && after.think === before.think;

console.log("\n================ A-1021b 变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 三文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
