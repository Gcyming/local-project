/*
 * 变异测试：A-1028 守卫的**取证**。
 *
 * 两条用户诉状各自的"改回去不报错、跑起来也不崩、只有看图才知道"的写法，逐一验红：
 *  ② 「Agent 输出结束后思考历程全变成『调用中/已执行』卡片」
 *     —— 两个独立病灶：状态词把"结果未记录"当"结果为空"（① ② ③）；时间线被 stages 的门
 *        挡在落盘之外（④ ⑤ ⑥ ⑦）。
 *  ① 「勾号删掉、保留图标、图标颜色风格与上面符号一致」
 *     —— ⑧⑨（图标退回双色）⑩（文案又带上勾）⑪（done 图标走回旁路，破坏"单一槽位"）。
 *
 * ⚠️ 为什么必须有这一步（项目铁律）：守卫写完只是**声明**了意图，变异测试才证明它**真的**在拦。
 *    本轮专门覆盖两类"守卫也可能瞎"的情形：
 *      · 断言"某段代码不存在"时**不能裸写字面量** —— 被锁的旧写法就原样躺在注释里
 *        （"此前这里是 `!r ? (isWrite ? …)`"），所以守卫一律盯只可能出现在**代码**里的形态。
 *      · 纯逻辑（`toolStatusLabel`）必须住纯模块才能**行为**测：住 `.tsx` 里时"短路成老写法"
 *        只能靠结构断言，而结构断言对**语义等价**的改写（`if (typeof result !== "string")`）
 *        完全没有分辨力（A-1027 变异 ③ 的同一条教训）。
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
const SIDEBAR = path.join(ROOT, "gui", "src", "renderer", "pages", "RightSidebar.tsx");
const ICON = path.join(ROOT, "gui", "src", "renderer", "components", "Icon.tsx");

const STATUS_CALL = "  const statusLabel = toolStatusLabel(tool.result, isFail);\n";
const STATUS_RENDER = "        {statusLabel && (\n";
const STAGES_GATE = "      const stages = finalReasoning || doneTools.length > 0 || finalTimeline.length > 0\n";
const ATTACH_GUARD = "        if (finalTimeline.length > 0) {\n";
const REBUILD = '      if (finalTimeline.length === 0) {\n        const seedTrace = splitToolTrace(finalReasoning ?? "");\n';
const ROWICON = "                  const RowIcon = (ev.tool ? resolveToolLabel(ev.tool).Icon : null) ?? b.Icon ?? null;\n";
const DONE_LABEL = '      pushEvent("done", m?.interrupted ? "⏹ 已中断" : "回复完成");\n';
const DONE_CIRCLE = '      <circle cx="512" cy="512" r="409" fill="none" stroke="currentColor" strokeWidth="80" />\n';
const DONE_TICK = '42.396 0 11.799-11.599 11.799-30.597 0-42.395z" />\n';
const ROW_SLOT =
  '                        <span className="task-badge task-badge-icon" title={rowTitle}\n' +
  '                          style={{ color: b.color, background: b.bg }}>\n' +
  '                          <RowIcon size={11} />\n' +
  '                        </span>\n';

const variants = [
  // ── ② 状态词：把「结果未记录」折回「结果为空」 ─────────────────────
  {
    name: "① ★ 状态词退回 `!r`（未记录的结果被当成空结果 → 已结束的回复标「调用中」）",
    file: THINK,
    from: '  if (typeof result !== "string") { return ""; }\n',
    to: '  if (typeof result !== "string" || result === "") { return "调用中"; }\n',
  },
  {
    name: "② ★ 渲染层不调纯模块、自己拼回老状态词（唯一实现被破坏）",
    file: PANEL,
    from: STATUS_CALL,
    to: '  const statusLabel = !r ? (isWrite ? "已执行" : "调用中") : isFail ? "失败" : "成功";\n',
  },
  {
    name: "③ ★ 状态列改回无条件渲染（空状态也占一列，看起来像还没做完）",
    file: PANEL,
    from: STATUS_RENDER,
    to: "        {statusLabel !== null && (\n",
  },

  // ── ② 时间线：被 stages 的门挡在落盘之外 ─────────────────────────
  {
    name: "④ ★ stages 的门去掉 finalTimeline（带结果的真时间线被整个丢掉 = 原病灶）",
    file: PANEL,
    from: STAGES_GATE,
    to: "      const stages = finalReasoning || doneTools.length > 0\n",
  },
  {
    name: "⑤ ★ 落盘判据退回借道 stages（stages 为空时时间线照样写不进 history.jsonl）",
    file: PANEL,
    from: ATTACH_GUARD,
    to: "        if (stages?.timeline?.length) {\n",
  },
  {
    name: "⑥ ★ 空数组落盘分支被恢复（attachTimelineToRecord 对空数组直接拒绝 → 假承诺）",
    file: PANEL,
    from:
      ATTACH_GUARD +
      '          const attachApi = (window as unknown as { slimeAPI?: { chat?: { attachTimeline?: (a: string, s: string | undefined, t: unknown[]) => Promise<unknown> } } }).slimeAPI;\n' +
      "          void attachApi?.chat?.attachTimeline?.(agentId, sessionRef.current, finalTimeline as unknown[]);\n" +
      "        }\n",
    to:
      ATTACH_GUARD +
      '          const attachApi = (window as unknown as { slimeAPI?: { chat?: { attachTimeline?: (a: string, s: string | undefined, t: unknown[]) => Promise<unknown> } } }).slimeAPI;\n' +
      "          void attachApi?.chat?.attachTimeline?.(agentId, sessionRef.current, finalTimeline as unknown[]);\n" +
      "        } else {\n" +
      '          const attachApi2 = (window as unknown as { slimeAPI?: { chat?: { attachTimeline?: (a: string, s: string | undefined, t: unknown[]) => Promise<unknown> } } }).slimeAPI;\n' +
      "          void attachApi2?.chat?.attachTimeline?.(agentId, sessionRef.current, []); // 变异：空数组\n" +
      "        }\n",
  },
  {
    name: "⑦ ★ 兜底重建被短路（流式时间线为空时不再从 done 载荷重解析）",
    file: PANEL,
    from: REBUILD,
    to: '      if (false) {\n        const seedTrace = splitToolTrace(finalReasoning ?? "");\n',
  },

  // ── ① 活动记录：图标配色与多余勾号 ──────────────────────────────
  {
    name: "⑧ ★ DoneIcon 退回实心底（圆改回实心色块，与上下行单色图标不是一套语言）",
    file: ICON,
    from: DONE_CIRCLE,
    to: '      <circle cx="512" cy="512" r="409" fill="var(--success)" stroke="none" />\n',
  },
  {
    name: "⑨ ★ 勾改回写死白色（不再跟随行内配色 = 双色版）",
    file: ICON,
    from: DONE_TICK,
    to: '42.396 0 11.799-11.599 11.799-30.597 0-42.395z" fill="#fff" />\n',
  },
  {
    name: "⑩ ★ 完成文案又带上勾号（勾由图标表达即可，文案里那个是多余的）",
    file: SIDEBAR,
    from: DONE_LABEL,
    to: '      pushEvent("done", m?.interrupted ? "⏹ 已中断" : "✓ 回复完成");\n',
  },
  {
    name: "⑪ ★ done 图标走回旁路槽位（更大 + 透明底，破坏「所有行同一个符号槽位」）",
    file: SIDEBAR,
    from: ROW_SLOT,
    to:
      '                        <span className="task-badge-icon" title={rowTitle}>\n' +
      "                          <RowIcon size={13} />\n" +
      "                        </span>\n",
  },
  {
    name: "⑫ ★ 行首图标槽位被拆成两套（RowIcon 只在工具事件里生效，done 图标又走 b.Icon 旁路）",
    file: SIDEBAR,
    from: ROWICON,
    to:
      "                  const RowIcon = (ev.tool ? resolveToolLabel(ev.tool).Icon : null);\n" +
      "                  const BadgeIcon = b.Icon ?? null;\n" +
      "                  const doneIconOnly = BadgeIcon;\n",
  },
];

const files = [THINK, PANEL, SIDEBAR, ICON];
const GUARDS = ["tests/core-ts/a1028-guards.spec.ts", "tests/core-ts/a1021-guards.spec.ts"];

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));

/** 从 vitest 输出里取一条**有信息量**的失败原因。
 *  ⚠️ 别用宽松匹配：测试名里就带箭头/中文，会把 `stdout | …` 噪音当成原因。 */
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
  /* ⚠️ 换行符**逐文件**判定：本仓库检出并不统一（实测 `providers.ts` 是 CRLF，而
     `ChatPanel.tsx` / `index.ts` 是 LF）。锚点写死 `\n` 会在 CRLF 文件上全部"未命中"，
     而脚本只报"锚点未命中"—— 看起来像脚本坏了，其实是锚点没适配换行。 */
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

console.log("\n========== A-1028（思考历程假状态 / 活动记录符号槽位）变异测试结果 ==========");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 四文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
