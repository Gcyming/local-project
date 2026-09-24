/**
 * A-1061④ 变异测试：把「上游重试如实上报」的每处关键实现逐个改坏，要求守卫变红。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1061-notice.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1061-notice.spec.ts";

const UP = "core-ts/src/llm/upstreamNotice.ts";
const CLIENT = "core-ts/src/llm/client.ts";
const ROUTER = "core-ts/src/router.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const LIVE = "gui/src/renderer/pages/liveStatus.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [UP, CLIENT, ROUTER, ENGINE, LIVE, PANEL];

const RAW_MUTATIONS = [
  {
    name: "1 429 重试不再上报（这段最长 60s 的等待又变回静默）",
    file: CLIENT,
    from: '      noteUpstream("retry", formatRetryNotice({ attempt, maxAttempts, waitMs, status: resp.status }));\n',
    to: "",
  },
  {
    name: "2 网络级重试不再上报（WiFi 抖动看起来像卡死）",
    file: CLIENT,
    from: '      noteUpstream("retry", formatRetryNotice({ attempt, maxAttempts, waitMs: netWaitMs }));\n',
    to: "",
  },
  {
    name: "3 睡完再上报（等于这段等待期仍然是静默的）",
    file: CLIENT,
    from: "      noteUpstream(\"retry\", formatRetryNotice({ attempt, maxAttempts, waitMs, status: resp.status }));\n      await sleep(waitMs);",
    to: "      await sleep(waitMs);\n      noteUpstream(\"retry\", formatRetryNotice({ attempt, maxAttempts, waitMs, status: resp.status }));",
  },
  {
    name: "4 切换备用模型不再上报（静默换模型）",
    file: ROUTER,
    /* ⚠️ 锚点**不带尾随换行**（旧写法写了 `\n`）：`core-ts/src/router.ts` 是 **CRLF** 文件，
       尾随 `\n` 匹配不到 `\r\n` ⇒ 锚点静默失效（`sub` 一个字都没改）。本仓铁律：
       锚点不依赖**装饰性空白**（行尾、行末空白都不属于判据）。 */
    from: '    noteUpstream("fallback", formatFallbackNotice(from, to ?? ""));',
    to: "",
  },
  {
    name: "5 工具路径不再吐出通知（长任务里最需要它的时候没有）",
    file: ENGINE,
    from: '        const notice = takeUpstreamNotice();\n        if (notice) { liveQueue.push({ type: "notice", content: notice.text }); }\n',
    to: "",
  },
  {
    name: "6 纯流式路径不再吐出通知",
    file: ENGINE,
    from: '      const notice = takeUpstreamNotice();\n      if (notice) { liveQueue.push({ type: "notice", content: notice.text }); }\n',
    to: "",
  },
  {
    name: "7 状态行不再显示上游通知（界面仍旧只有一句「等待上游返回」）",
    file: LIVE,
    from: '  if (input.upstreamNotice) {\n    return { kind: "notice", text: input.upstreamNotice, detail, animated: true };\n  }\n',
    to: "",
  },
  {
    name: "8 通知挪到 loading 判定之后（空转期反而不显示了）",
    file: LIVE,
    from: '  if (input.upstreamNotice) {\n    return { kind: "notice", text: input.upstreamNotice, detail, animated: true };\n  }\n\n  if (!input.loading) { return null; }',
    to: '  if (!input.loading) { return null; }\n\n  if (input.upstreamNotice) {\n    return { kind: "notice", text: input.upstreamNotice, detail, animated: true };\n  }',
  },
  {
    name: "9 通知不播扫光（在等上游却被显示成「停着」）",
    file: LIVE,
    from: 'return { kind: "notice", text: input.upstreamNotice, detail, animated: true };',
    to: 'return { kind: "notice", text: input.upstreamNotice, detail, animated: false };',
  },
  {
    name: "10 界面不再接收 notice 事件（状态行永远拿不到通知）",
    file: PANEL,
    /* ⚠️ 只锚**分支条件 + 第一条语句**：A-1061⑦ 往这个分支里补了「刷新引导确认时间戳」，
       锚整段会在下次同类插话时再次漂移（漂移症状与"守卫太浅"一模一样，极易误判）。 */
    from: '      if (c.type === "notice") {\n        if (otherSid == null) { setUpstreamNotice(c.data?.content ?? null); }\n',
    to: '      if (false) {\n        if (otherSid == null) { setUpstreamNotice(c.data?.content ?? null); }\n',
  },
  {
    name: "11 有真实产出时不清通知（「正在重试」会与已开始的输出同屏自相矛盾）",
    file: PANEL,
    from: '      if (c.type !== "heartbeat") { setUpstreamNotice(null); }\n',
    to: "",
  },
  {
    name: "12 界面不再把通知喂给状态行",
    file: PANEL,
    from: "    upstreamNotice: upstreamNotice ?? undefined,\n",
    to: "",
  },
  {
    name: "13 重试次数差一（显示「第 0/4 次」）",
    file: UP,
    from: "  const nth = Math.min(info.attempt + 1, info.maxAttempts);",
    to: "  const nth = Math.min(info.attempt, info.maxAttempts);",
  },
  {
    name: "14 429 被说成普通 HTTP 码（用户不知道是被限流）",
    file: UP,
    from: '  if (status === 429) { return "被限流（429）"; }',
    to: "  if (false) { return \"被限流（429）\"; }",
  },
  {
    name: "15 空文本也占槽（状态行会出现一句空话）",
    file: UP,
    from: '  if (!t) { return; }',
    to: "",
  },
  {
    name: "16 取走不清空（每次轮询都重复吐同一条）",
    file: UP,
    from: "  const v = slot;\n  slot = null;\n  return v;",
    to: "  return slot;",
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

if (!runSpec()) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1061-notice")) { process.exit(1); }
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
