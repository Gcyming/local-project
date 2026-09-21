/**
 * A-1039 变异测试：把「启动门 / 加载面板」的每一处关键实现**逐个改坏**，
 * 要求对应守卫变红。红不出来的那一条，说明守卫锁错了对象或根本没锁。
 *
 * 本项目已有前科：守卫"全绿"但锁的是无关代码（A-1019 的隐形地板、A-1034 的假防线），
 * 所以变异测试是**验收标准**，不是可选步骤。
 *
 * 用法：node gui/scripts/mut-a1039-splash.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = **行尾无关**的替换（共享模块，不要在本脚本另写一份）。
   ⚠️ 本脚本 M11–M13 是**跨行锚点**：裸 `"...\n..."` 只在目标文件恰好是 LF 时能用，
   行尾一翻就**静默失效**（"未命中"被误读成"守卫守住了"）。见 `_mut-eol.mjs` 顶部说明。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"...pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/a1039-guards.spec.ts";

/** 待变异的文件（原样备份，最后逐个还原） */
const TARGETS = ["gui/src/renderer/App.tsx", "gui/src/renderer/pages/SplashScreen.tsx", "gui/src/renderer/pages/ChatPanel.tsx"];

/* `from` / `to` 仍然是本脚本的书写形态（好读）；`mutate` 由它们**机械派生** ——
   这样 `eolProblems()` 与执行循环共用同一套行为判据，不存在"自检走一条路、执行走另一条路"。 */
const RAW_MUTATIONS = [
  {
    name: "M1 门判据退回 boot.phase（degraded 会当场放行 = 本次卡顿的直接成因）",
    file: "gui/src/renderer/App.tsx",
    from: "const splashVisible = !splashMinDone || !uiReady;",
    to: 'const splashVisible = !splashMinDone || boot?.phase === "starting" || boot?.phase === "backend" || (boot?.phase === "ready" && !uiReady);',
  },
  {
    name: "M2 uiReady 退回「只看会话列表」（丢掉 providers / localModels）",
    file: "gui/src/renderer/App.tsx",
    from: "const uiReady = firstLoadGuard || FIRST_LOAD_KEYS.every((k) => firstLoad[k]);",
    to: "const uiReady = firstLoadGuard || Boolean(firstLoad.sessions);",
  },
  {
    name: "M3 FIRST_LOAD_KEYS 漏掉 providers（键少了，门就少等一项）",
    file: "gui/src/renderer/App.tsx",
    from: 'const FIRST_LOAD_KEYS = ["agents", "sessions", "providers", "localModels", "chatHistory"] as const;',
    to: 'const FIRST_LOAD_KEYS = ["agents", "sessions", "chatHistory"] as const;',
  },
  {
    name: "M4 markFirstLoad 只 setState 到一半（登记表永远收不齐）→ 靠 8s 兜底才放行",
    file: "gui/src/renderer/App.tsx",
    from: 'markFirstLoad("providers"); // A-1039：记入启动门',
    to: "void 0;",
  },
  {
    name: "M5 总超时兜底删掉（某个数据源挂掉 → 用户被永久关在加载页）",
    file: "gui/src/renderer/App.tsx",
    from: "setFirstLoadGuard(true), 8000",
    to: "setFirstLoadGuard(true), 60 * 60 * 1000",
  },
  {
    name: "M6 面板改回硬切（visible=false 立刻卸载，没有淡出）",
    file: "gui/src/renderer/pages/SplashScreen.tsx",
    from: "setMounted(false), 260",
    to: "setMounted(false), 0",
  },
  {
    name: "M7 阶段清单写死为已完成（用户又看不到「在等什么」）",
    file: "gui/src/renderer/App.tsx",
    from: "done: Boolean(firstLoad.agents && firstLoad.sessions)",
    to: "done: true,",
  },
  {
    name: "M8 主题写死深色背景（浅色主题下瞎眼）",
    file: "gui/src/renderer/pages/SplashScreen.tsx",
    from: "background: \"var(--bg)\",",
    to: 'background: "#0b101e",',
  },
  {
    name: "M9 App 不再渲染 SplashScreen（组件写了不接线 = 白写）",
    file: "gui/src/renderer/App.tsx",
    from: "<SplashScreen visible={splashVisible} status={splashStatus} steps={splashSteps} subtitle={`v${appVersion}`} />",
    to: "{null}",
  },
  {
    name: "M10 版本号通道拆掉 preload 一侧（跨进程契约只剩一半）",
    file: "gui/src/renderer/App.tsx",
    from: "api?.boot?.version?.()",
    to: "undefined",
  },
  // ── A-1058①：门要覆盖"中间那栏的会话内容"（M11–M13）─────────────────────────────
  {
    name: "M11 App 不再把 onHistoryLoaded 传给 ChatPanel（门永远收不齐 → 靠 8s 兜底）",
    file: "gui/src/renderer/App.tsx",
    from: "      onHistoryLoaded={markChatHistoryLoaded}\n",
    to: "",
  },
  {
    name: "M12 ChatPanel 的 catch 路径漏回执（历史加载失败 → 只能干等到 8s）",
    file: "gui/src/renderer/pages/ChatPanel.tsx",
    from: "      // A-1058①：**失败也必须回执** —— 否则门只能等 8s 总超时（A-1039 的\"失败也放行\"规矩）\n      onHistoryLoaded?.();\n",
    to: "",
  },
  {
    name: "M13 删掉「没有会话可开就自己登记」的兜底（欢迎页/无 agentId → 门空等 8s）",
    file: "gui/src/renderer/App.tsx",
    from: "    if (hasNoSession || !selectedAgentId) { markChatHistoryLoaded(); }\n",
    to: "",
  },
];   // ← RAW_MUTATIONS 结束

const MUTATIONS = RAW_MUTATIONS.map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

function hash(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

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

// 前置：基线必须绿（否则变异"红"毫无意义）
if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

/* 行尾自检：先验**检测器自己**不空转（恒真的自检比没有自检更危险），再验锚点行尾无关。 */
const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1039")) { process.exit(1); }
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

// 还原校验：哈希必须回到原值（否则会污染工作树）
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
