/**
 * A-1082 变异测试（「压缩并非真压缩」的闭环）—— 把手工验证过的变异**持久化**。
 *
 * ## 为什么补这个脚本
 *
 * A-1082 落地时本环境跑不了变异套件（WorkBuddy 运行时 shim 拦 `child_process` ⇒ `EBUSY`），
 * 于是按交接文档 §5.3① 走了**手工**改坏→跑守卫→还原。手工验证的结论有效，但**没留下可复跑的东西**：
 * 一旦有人重构，那 117 个新守卫用例（`context-loop` 36 / `context-compress-ui` 25 /
 * `context-compress` 31 / `stream-errors` 25）就**没有任何变异覆盖**了。
 * ⇒ 本脚本把当时的变异逐条固化。**手工验证是过程，脚本才是资产。**
 *
 * ## 覆盖的七条（每条对应一个已确认的根因或接线事实）
 *
 *  1. 估算退回「总字符 ÷ 4」—— CJK 4 倍低估（阈值形同虚设）
 *  2. `buildCompactedHistory` 退回**按条数硬切** —— 破坏 turn 对齐（不变量 I2）
 *  3. `sessions` 恢复 `delete meta.summaryCount` —— **降级路径空操作**（最致命的一条，A-1082 新发现）
 *  4. 主进程去掉 `!force` —— 反应式触发又被 `needsCompress` 拒掉（"少的那一环"实际没接上）
 *  5. `ChatPanel` 退回 `cap * 0.5` —— 假报占用（构造值，与真实体积无关）
 *  6. `isCompressWindow` 摘掉 skip/overflow —— 压缩窗口期放行 steer 会落到没人消费的循环（空头支票）
 *  7. `force` 下 skipped 不回带 `stillOverflow` —— 反应式路径白等一次注定失败的请求
 *
 * ## A-1083/A-1084/A-1085/A-1086 追加的十一条（8~21）
 *
 *   8~10（A-1083）：预算门误伤 / 窗口未知也拦 / 拒发分支被摘
 *  11~14（A-1084）：引擎退回"以为还能压" / **流式**路径闸门被摘 / 拒发文案丢本地标记 /
 *                   windowCap 不再透传（保险门永远放行 = 等于没做）
 *  15~16（A-1085）：`tailLimit` 的"不限"档改为返回空 / 压缩路径退回不读全量（早期对话静默丢失）
 *  17~21（A-1086）：放宽"必须严格更大" / 放宽"必须真装得下" / 排序反向 / 去掉平手 tie-break /
 *                   stillOverflow 不回带出路
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）—— 否则会把整份 spec 打成 0 用例。
 * ⚠️ 含反斜杠的锚点不要经 shell heredoc 写（本环境会吃掉一层反斜杠）。
 *
 * 用法：node gui/scripts/mut-a1082.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** @type {string[]} 本轮守卫分散在四份 spec（任一变红即算捕获） */
const SPECS = [
  "tests/core-ts/context-loop.spec.ts",
  "tests/core-ts/context-compress.spec.ts",
  "tests/gui/context-compress-ui.spec.ts",
  "tests/gui/stream-errors.spec.ts",
];
const CC = "core-ts/src/services/context_compress.ts";
const LOOP = "core-ts/src/services/context_loop.ts";
const SESSIONS = "core-ts/src/services/sessions.ts";
const MAIN = "gui/src/main/index.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const INSERT = "gui/src/renderer/pages/insertCopy.ts";
/* A-1084/A-1085 新增目标：引擎（闸门本体）、ChatService（windowCap 透传）、history（tailLimit） */
const ENGINE = "core-ts/src/services/engine.ts";
const CHAT = "core-ts/src/services/chat.ts";
const HISTORY = "core-ts/src/services/history.ts";
const TARGETS = [CC, LOOP, SESSIONS, MAIN, PANEL, INSERT, ENGINE, CHAT, HISTORY];

const MUTATIONS = [
  {
    name: "1 估算退回「总字符 ÷ 4」（CJK 4 倍低估 ⇒ 压缩阈值形同虚设）",
    file: CC,
    mutate: (t) => sub(
      t,
      "    total += MESSAGE_OVERHEAD_TOKENS + contentTokensOf(m?.content);",
      "    const c = m?.content; total += Math.round((typeof c === \"string\" ? c.length : 0) / 4);",
    ),
  },
  {
    name: "2 压缩保留段退回**按条数硬切**（切口落在半轮上 → 破坏 turn 对齐 I2）",
    file: CC,
    mutate: (t) => sub(
      t,
      "  const tail = trimTurnAligned(messages, keep).slice();",
      "  const tail = messages.slice(-(keep * 2)).slice();",
    ),
  },
  {
    name: "3 恢复 `delete meta.summaryCount`（降级路径变空操作 ⇒ 界面报「已压缩」而请求一字未少）",
    file: SESSIONS,
    mutate: (t) => sub(
      t,
      "    meta.summaryCount = Math.max(1, Math.floor(keep));",
      "    if (summary && summary.trim()) { meta.summaryCount = Math.max(1, Math.floor(keep)); } else { delete meta.summaryCount; }",
    ),
  },
  {
    name: "4 主进程不再把 `force` 当反应式触发（上游说超限后压缩一次也不发生 → 重试的还是那个超限请求）",
    file: MAIN,
    /* A-1083 重锚：判据已收口到 `planSend`，原来那条 `!force && !needsCompress(` 已不存在。
       现在等价的反向变异是「把 afterOverflow 摘掉」——即"上游说了也不当回事"。 */
    mutate: (t) => sub(
      t,
      "        afterOverflow: force,",
      "        afterOverflow: false,",
    ),
  },
  {
    name: "5 ChatPanel 退回 `cap * 0.5` 假报（构造值取代实测回填）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      "      const measuredAfter = typeof res?.tokensAfter === \"number\" && res.tokensAfter > 0 ? Math.round(res.tokensAfter) : 0;",
      "      const measuredAfter = res?.cap ? Math.max(1, Math.round(res.cap * 0.5)) : 0;",
    ),
  },
  {
    name: "6 `isCompressWindow` 摘掉 skip/overflow（压缩窗口期放行 steer → 落到没人消费的循环）",
    file: INSERT,
    mutate: (t) => sub(
      t,
      "  return stage === \"prep\" || stage === \"summarize\" || stage === \"trunc\" || stage === \"skip\" || stage === \"overflow\";",
      "  return stage === \"prep\" || stage === \"summarize\" || stage === \"trunc\";",
    ),
  },
  {
    name: "7 `force` 下 skipped 不回带 stillOverflow（反应式路径白等一次注定失败的请求）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      "        return { ok: true, skipped: true, reason: \"历史过短（不足 6 条），压缩无意义\", used: 0, cap, ...(force ? { stillOverflow: true } : {}) };",
      "        return { ok: true, skipped: true, reason: \"历史过短（不足 6 条），压缩无意义\", used: 0, cap };",
    ),
  },
  {
    name: "8 预算门退回「只要触发就拒发」（**误伤**：用户调低阈值时把能用的请求拦掉）",
    file: LOOP,
    mutate: (t) => sub(
      t,
      "  if (headroom < 0) {\n    return { action: \"cannot-fit\",",
      "  if (true) {\n    return { action: \"cannot-fit\",",
    ),
  },
  {
    name: "9 窗口未知也拦（cap<=0 保护被摘 ⇒ 窗口没探到的模型被无故拦下）",
    file: LOOP,
    mutate: (t) => sub(
      t,
      "  if (cap <= 0) {\n    return { action: \"ok\", headroom: 0, trigger: \"none\", reason: \"模型窗口未知，不做预算拦截（不猜）\" };",
      "  if (false) {\n    return { action: \"ok\", headroom: 0, trigger: \"none\", reason: \"模型窗口未知，不做预算拦截（不猜）\" };",
    ),
  },
  {
    name: "10 主进程 cannot-fit 分支被摘（真装不下时又发出去等 300s×N —— 「连接半天」复发）",
    file: MAIN,
    mutate: (t) => sub(t, '      if (plan.action === "cannot-fit") {', "      if (false) {"),
  },

  /* ══════════════ A-1084 engine 侧保险门（闸门必须长在必经之路上） ══════════════ */
  {
    name: "11 保险门退回 canShrink:true（引擎以为「还能压」⇒ 永远返回 ok ⇒ 闸门形同虚设）",
    file: LOOP,
    mutate: (t) => sub(t, "    canShrink: false, // 引擎层不压缩", "    canShrink: true, // 引擎层不压缩"),
  },
  {
    name: "12 **流式**路径的闸门被摘（只剩 chat ⇒ 主链路（走 stream）完全没有保护）",
    file: ENGINE,
    mutate: (t) => sub(
      t,
      "    const guard = this.guardSend(opts, messages, tools);\n    if (!guard.allow) {\n      this.logger.warn(`[engine] 上下文保险门拦截（未发送）: ${guard.reason}`);\n      // 标记的用途见 chat() 处同名注释",
      "    const guard: { allow: boolean; reason: string } = { allow: true, reason: \"（变异）\" };\n    if (!guard.allow) {\n      this.logger.warn(`[engine] 上下文保险门拦截（未发送）: ${guard.reason}`);\n      // 标记的用途见 chat() 处同名注释",
    ),
  },
  {
    name: "13 拒发文案丢掉本地标记（渲染层认不出是超限 ⇒ 落进 9 次重连，而每次都被拦回）",
    file: ENGINE,
    mutate: (t) => sub(
      t,
      "      yield { type: \"error\", message: `${LOCAL_PREFLIGHT_MARKER}\\n⚠️ 本次请求**未发送**",
      "      yield { type: \"error\", message: `\\n⚠️ 本次请求**未发送**",
    ),
  },
  {
    name: "14 windowCap 不再透传给引擎（保险门永远拿不到窗口 ⇒ 永远放行 = 等于没做）",
    file: CHAT,
    mutate: (t) => sub(t, "        windowCap: req.windowCap,", "        windowCap: undefined,"),
  },

  /* ══════════════ A-1085 摘要覆盖不受 50 条静默上限 ══════════════ */
  {
    name: "15 tailLimit 的「不限」档改为返回空（摘要轮读不到任何历史 ⇒ 压缩变空操作、早期内容全丢）",
    file: HISTORY,
    mutate: (t) => sub(t, "  return n > 0 ? records.slice(-n) : records;", "  return n > 0 ? records.slice(-n) : [];"),
  },
  {
    name: "16 压缩路径退回不读全量（摘要只覆盖最后 50 条 ⇒ 早期对话既不在摘要里也不在尾巴里 = 静默丢失）",
    file: MAIN,
    /* ⚠️ A-1106 迁移（**保留原意，不许删**）：A-1082 时这段是 `const history = await
       loadSessionHistory(sessionId, { full: true })` —— A-1106 把「读盘」拆成
       `loadRawHistoryWithMeta`（原始全量：判据 + 摘要素材 + 指纹）与 `loadSessionHistory`
       （折叠视图：真实发送体积）两个入口，压缩 handler 顶部因此换名。
       **缺陷本体没变**：丢掉 `{ full: true }` ⇒ 摘要轮只看到最后 50 条 ⇒ 更早的对话
       既不在摘要里、也不在保留尾巴里 = 静默丢失。故按新形态迁移锚点。 */
    mutate: (t) => sub(t, "      const { raw: historyAll, meta: histMeta } = await loadRawHistoryWithMeta(sessionId, { full: true });", "      const { raw: historyAll, meta: histMeta } = await loadRawHistoryWithMeta(sessionId);"),
  },

  /* ══════════════ A-1086 可救模型（压无可压时唯一有意义的出路） ══════════════ */
  {
    name: "17 「必须严格更大」放宽为 >=（建议换成同窗口模型 = 白等一次，用户以为被救了）",
    file: LOOP,
    mutate: (t) => sub(t, "    .filter((c) => c.cap > cur)", "    .filter((c) => c.cap >= cur)"),
  },
  {
    name: "18 「必须真装得下」放宽（换完没留出写回复的空间 ⇒ 建议本身把用户送进另一个坑）",
    file: LOOP,
    mutate: (t) => sub(t, "    .filter((c) => c.cap >= need + RESERVE_OUTPUT_TOKENS)", "    .filter((c) => c.cap >= need)"),
  },
  {
    name: "19 排序反向（取最贵 ⇒ 把用户甩到远超需要的模型上）",
    file: LOOP,
    /* ⚠️ A-1090 迁移：`pickRescueModel` 的排序从**单行三元**改成了多行比较器
       （平手判据改用 `choice ?? id`，与调用方去重键同源）。旧锚点是原实现原文 ⇒ 未命中
       ⇒ 这条变异从那一刻起**不再保护任何东西**（靠 `check-mut-anchors.mjs` 的总账发现）。
       意图不变（"按 cap 升序取最省的那个"），锚点换成新实现里那一行**单行**代码。 */
    mutate: (t) => sub(
      t,
      "      if (a.cap !== b.cap) { return a.cap - b.cap; }",
      "      if (a.cap !== b.cap) { return b.cap - a.cap; }",
    ),
  },
  {
    name: "20 平手 tie-break 被去掉（入参顺序一换建议就变 = 判据不确定，守卫 flaky）",
    file: LOOP,
    /* ⚠️ A-1090 迁移：同上。原锚点整行 `.sort(...)` 已不存在；现在把「平手如何排」整段换成
       `return 0`（= 交给 Array.sort 的稳定性 ⇒ 等价于"按入参顺序"）。cap 档的比较**保留**，
       所以这条变异精确地只打"确定性"这件事。 */
    mutate: (t) => sub(
      t,
      "      const ka = a.choice ?? a.id;\n      const kb = b.choice ?? b.id;\n      if (ka !== kb) { return ka < kb ? -1 : 1; }\n      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;",
      "      return 0;",
    ),
  },
  {
    name: "21 stillOverflow 不再回带出路（用户又只看到「请换窗口更大的模型」这句原则）",
    file: MAIN,
    mutate: (t) => sub(t, "        ...(stillOverflow ? { rescueHint: formatRescueHint(rescue) } : {}),", "        ...(false ? { rescueHint: formatRescueHint(rescue) } : {}),"),
  },
];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 任一份 spec 变红即算捕获（守卫分散在四份文件里，不能只跑第一份就判"绿"）。 */
function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.status !== 0) { return false; }
  }
  return true;
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(join(ROOT, t))]));
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 没这道保险，变异会留在源码里，
   下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（2026-09-23 实测踩到）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

if (!runSpecs()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  console.error("（若报 `EBUSY: spawnSync …`，是运行环境禁止 node→node 孙进程，见交接文档 §5.2/§5.3）");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1082")) { process.exit(1); }

/** 引号自伤自检：剥注释后仍出现「CJK + ASCII 双引号 + CJK」才算坏。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of ["gui/scripts/mut-a1082.mjs"]) {
  const bad = quoteSelfHarm(readFileSync(join(ROOT, rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 引号自伤自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpecs();
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
  restoreAll();
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
