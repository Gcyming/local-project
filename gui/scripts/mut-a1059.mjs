/**
 * A-1059 变异测试：把 v0.0.7 实测三问题的每一处关键实现**逐个改坏**，要求守卫变红。
 *
 * 红不出来的那一条 = 守卫锁错了对象或根本没锁（本项目已有多次前科：
 * A-1019 隐形地板、A-1034 假防线、A-1054 W1 浅锁、A-1056 假存活）。
 * 所以变异是**验收标准**，不是可选步骤。
 *
 * 三条修复：
 *   ① 启动面板首帧不透明（否则先闪一下主界面）
 *   ② 启动门等「选中会话的决定」落定 + 历史 DOM 提交后再放行
 *   ③ 更新：检查默认开（旧模板写的 enabled=false 不算用户意图），下载/安装只能点击
 *
 * ⚠️ 本文件（以及本仓所有 JS/TS）里**不许**在中文句子中夹 ASCII 双引号 ——
 * 那是 A-1056 就记录过的自伤（会把字符串当场截断）。中文引号一律用「」。
 *
 * 用法：node gui/scripts/mut-a1059.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = **行尾无关**的替换（共享模块，不要在本脚本另写一份）。
   ⚠️ 本脚本多条锚点是**跨行**的：裸 `"...\n..."` 只在目标文件恰好 LF 时命中，
   行尾一翻就**静默失效**（「未命中」会被误读成「守卫守住了」）。见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"...pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 两个 spec 都要跑：A-1059 是本轮新守卫，A-1039 里那条被判据搬家迁移过的断言也在这里被验 */
const SPECS = ["tests/gui/a1059-guards.spec.ts", "tests/gui/a1039-guards.spec.ts"];

const SPLASH = "gui/src/renderer/pages/SplashScreen.tsx";
const GATE = "gui/src/renderer/pages/startupGate.ts";
const APP = "gui/src/renderer/App.tsx";
const CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const POLICY = "core-ts/src/services/updatePolicy.ts";
const UPDATER = "gui/src/main/updater.ts";
const MIND = "gui/src/main/mind_config.ts";
const TOML = "gui/template/slime.toml";
const PANEL = "gui/src/renderer/pages/StatusPanel.tsx";

const TARGETS = [SPLASH, GATE, APP, CHAT, POLICY, UPDATER, MIND, TOML, PANEL];

const RAW_MUTATIONS = [
  // ── A-1059① 启动面板首帧 ────────────────────────────────────────────────────
  {
    name: "①-1 opaque 初值退回 false —— 首帧透明，主界面透出来，先闪一下复活",
    file: SPLASH,
    from: "const [opaque, setOpaque] = React.useState(visible);",
    to: "const [opaque, setOpaque] = React.useState(false);",
  },

  // ── A-1059② 启动门 ────────────────────────────────────────────────────────
  {
    name: "②-1 选中会话的决定还没落定，却错判成收尾（本次 bug 的原形）",
    file: GATE,
    from: 'if (!input.selectionSettled) { return "wait"; }',
    to: 'if (!input.selectionSettled) { return "self-finish"; }',
  },
  {
    name: "②-2 列表未就绪也放行（此刻有几个会话根本不可知）",
    file: GATE,
    from: 'if (!input.sessionsReady) { return "wait"; }',
    to: 'if (!input.sessionsReady) { return "self-finish"; }',
  },
  {
    name: "②-3 等帧数归零 —— 等于拿到数据就回执，门又比内容先到",
    file: GATE,
    from: "export const HISTORY_SETTLE_FRAMES = 2;",
    to: "export const HISTORY_SETTLE_FRAMES = 0;",
  },
  {
    name: "②-4 settleAfterFrames 退化成同步调用（帧数参数形同虚设）",
    file: GATE,
    from: "if (frames <= 0) { finish(); return; }",
    to: "if (true) { finish(); return; }",
  },
  {
    name: "②-5 App 装配时把 selectionSettled 写死 true（判据被绕过）",
    file: APP,
    from: "      selectionSettled,\n",
    to: "      selectionSettled: true,\n",
  },
  {
    name: "②-6 不再登记选中决定已落定（门只能枯等到 8s 兜底）",
    file: APP,
    from: "      setSelectionSettled(true);\n",
    to: "      void 0;\n",
  },
  {
    name: "②-7 不看判据结论，一律收尾（门当场放行）",
    file: APP,
    from: 'if (decision === "self-finish") { markChatHistoryLoaded(); }',
    to: "markChatHistoryLoaded();",
  },
  {
    name: "②-8 选中退回直接取第一个（丢掉保留当前有效选中的逻辑）",
    file: APP,
    from: "setSelectedSessionId((cur) => (cur && items.some((s) => s.sessionId === cur) ? cur : items[0].sessionId));",
    to: "setSelectedSessionId(items[0].sessionId);",
  },
  {
    name: "②-9 ChatPanel 回执退回裸调用 —— 不等 DOM 提交，用户仍看到空一会儿",
    file: CHAT,
    from: "settleAfterFrames(HISTORY_SETTLE_FRAMES, () => onHistoryLoaded?.());",
    to: "onHistoryLoaded?.();",
  },

  // ── A-1059③ 更新策略 ─────────────────────────────────────────────────────
  {
    name: "③-1 旧模板的 enabled=false 被当成用户想关（本次抱怨的原形）",
    file: POLICY,
    from: 'if (raw.enabled === false) { return { autoCheck: true, reason: "legacy-shipped-default" }; }',
    to: 'if (raw.enabled === false) { return { autoCheck: false, reason: "legacy-shipped-default" }; }',
  },
  {
    name: "③-2 显式 auto_check=false 被忽略（用户说了不算）",
    file: POLICY,
    from: 'if (raw.autoCheck === false) { return { autoCheck: false, reason: "explicit-auto-check-off" }; }',
    to: 'if (raw.autoCheck === false) { return { autoCheck: true, reason: "explicit-auto-check-off" }; }',
  },
  {
    name: "③-3 文案把检查说成整个更新功能已关闭（正是误会的来源）",
    file: POLICY,
    from: '    case "legacy-enabled-on": return "启动时会自动检查更新";',
    to: '    case "legacy-enabled-on": return "更新功能已关闭";',
  },
  {
    name: "③-4 自动下载不变量被打开（几百 MB 又会在后台自己跑）",
    file: UPDATER,
    from: "autoUpdater.autoDownload = false;",
    to: "autoUpdater.autoDownload = true;",
  },
  {
    name: "③-5 启动检查退回读旧键（判据搬走等于白搬）",
    file: UPDATER,
    from: "  if (!policy.autoCheck) {",
    to: "  if (!cfg.enabled) {",
  },
  {
    name: "③-6 判据来源不再留痕（又变成静默行为）",
    file: UPDATER,
    // ⚠️ 锚点必须带上前面的 `）`：单写 ` · ${...}` 会漏（源码里是 `）· ${...}`，`）` 与 `·` 之间无空格）
    from: "）· ${describeUpdatePolicy(policy)}",
    to: "",
  },
  {
    name: "③-7 配置层丢掉 auto_check 键（新键读不到，用户无法显式关闭）",
    file: MIND,
    from: '        if (line.startsWith("auto_check")) {',
    to: "        if (false) {",
  },
  {
    name: "③-8 模板的 auto_check 写回 false（随包默认又变成不检查）",
    file: TOML,
    // ⚠️ 不能用单行锚点 `auto_check = true` —— 模板**讲解注释里也写了同一个串**，
    // 单行替换会先命中注释那一行（文件确实变了，但生效配置没动）→ 守卫照样绿 = 假捕获。
    // 必须带上 `[update]` 段头把范围钉死在生效配置上（`§8-1` 同名多产地的老坑）。
    from: "[update]\nauto_check = true\n",
    to: "[update]\nauto_check = false\n",
  },
  {
    name: "③-9 模板的 enabled 写回 false（本次用户抱怨的那个值）",
    file: TOML,
    from: "enabled = true\nfeed_url",
    to: "enabled = false\nfeed_url",
  },
  {
    name: "③-10 界面文案退回自动检查未开启（读起来像功能被关）",
    file: PANEL,
    from: "              未开启启动时自动检查（可在 slime.toml 的 [update] 段设 auto_check = true）。",
    to: "              自动检查未开启（可点「手动检查」随时对比 GitHub Release；",
  },
  // ── A-1061④′：内容组不许被元数据组的兜底绕过 + 等帧必须有时间兜底 ───────────────
  {
    name: "④′-1 元数据兜底也能放行内容组（本次「加载界面提前结束」的原形复辟）",
    file: GATE,
    from: "  const contentOk = !contentMissing || i.contentGuard;",
    to: "  const contentOk = !contentMissing || i.contentGuard || i.metadataGuard;",
  },
  {
    name: "④′-2 内容组的兜底被截成 0（等于内容组没有兜底、也没有等待）",
    file: APP,
    from: "const CONTENT_GUARD_MS = 20000;",
    to: "const CONTENT_GUARD_MS = 0;",
  },
  {
    name: "④′-3 装配层把 contentGuard 写死 true（判据被绕过）",
    file: APP,
    from: "    contentGuard,\n",
    to: "    contentGuard: true,\n",
  },
  {
    name: "④′-4 等帧去掉时间兜底（rAF 被暂停时永远不回执 → 门只能枯等超时）",
    file: GATE,
    from: "  schedule(finish, SETTLE_FALLBACK_MS);\n",
    to: "",
  },
  {
    name: "④′-5 done 可以被多次调用（时间兜底与帧回调同时到点 → 回执两遍）",
    file: GATE,
    from: "  const finish = (): void => { if (!finished) { finished = true; done(); } };",
    to: "  const finish = (): void => { done(); };",
  },
  {
    name: "④′-6 被兜底放行不再留痕（又变成静默行为）",
    file: APP,
    from: "      `[startup] 启动门被超时兜底放行（${uiReadyDecision.forcedBy}）—— 仍未到齐：` +",
    to: "      `[startup] 收门（${uiReadyDecision.forcedBy}）—— 仍未到齐：` +",
  },
];

/* `mutate` 由 `from`/`to` **机械派生** —— 这样 `eolProblems()` 自检与执行循环共用同一套行为判据，
   不存在「自检走一条路、执行走另一条路」的假绿。 */
const MUTATIONS = RAW_MUTATIONS.map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1059")) { process.exit(1); }
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
    writeFileSync(path, src); // 立即还原，防后续变异叠加
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
