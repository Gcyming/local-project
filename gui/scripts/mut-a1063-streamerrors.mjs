/**
 * A-1063 变异测试：把「流式失败判定」的关键实现逐个改坏，要求守卫变红。
 *
 * 重点盯的是那**一次真实回归**：`isPermanentStreamError` 的裸数字子串匹配
 * 把「十次重连」提前短路掉（`MAX_RETRY = 9` 一直在，只是从没跑到）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1063-streamerrors.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/stream-errors.spec.ts";

const ERR = "gui/src/renderer/pages/streamErrors.ts";
/* A-1081：新增「上下文超限 → 压缩+重试一次」的接线，接线事实在 ChatPanel 里，故一并纳入目标 */
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [ERR, PANEL];

const RAW_MUTATIONS = [
  {
    name: "1 状态码退回「裸三位数字扫描」（响应体里的 404 又会被当成不可恢复 → 零次重连）",
    file: ERR,
    from: '  const m = /上游错误\\s*(\\d{3})|HTTP\\s*(\\d{3})/i.exec(msg ?? "");',
    to: '  const m = /(\\d{3})/.exec(msg ?? "");',
  },
  {
    name: "2 把 400 也算成不可恢复（这正是「重连阈值看起来消失」的那类修法）",
    file: ERR,
    from: "export const PERMANENT_STATUSES: readonly number[] = [401, 403, 404];",
    to: "export const PERMANENT_STATUSES: readonly number[] = [400, 401, 403, 404];",
  },
  {
    name: "3 状态码分支被架空（401/403/404 全部当成可重连）",
    file: ERR,
    from: "  if (status !== null && PERMANENT_STATUSES.includes(status)) { return true; }",
    to: "  if (false) { return true; }",
  },
  {
    name: "4 区域限制信号丢失（RegionError 常以 400/5xx 返回，只靠状态码认不出）",
    file: ERR,
    from: "  if (/regionerror|not available in your (country|region)/i.test(m)) { return true; }",
    to: "  if (false) { return true; }",
  },
  {
    name: "5 重连次数不再出现在标题（用户看不到「重连 10 次仍失败」）",
    file: ERR,
    from: '    `❌ 模型调用失败${attemptCount ? `（已自动重连 ${attemptCount} 次仍无法恢复）` : "（错误无法自动恢复，请按下方提示处理）"}`',
    to: '    `❌ 模型调用失败（错误无法自动恢复，请按下方提示处理）`',
  },
  {
    name: "6 5xx 诱因丢失（上游挂了却只说「未知错误」）",
    file: ERR,
    from: "  if ((status !== null && status >= 500) || /overloaded|maintenance|服务暂时不可用/i.test(low)) {",
    to: "  if (false) {",
  },
  {
    name: "7 兜底诱因被抹掉（认不出时给一句空话）",
    file: ERR,
    from: '    causes.push("未知错误 → 参考上方完整错误信息；检查模型是否已启用、网络是否正常");',
    to: '    causes.push("");',
  },
  {
    name: "8 空错误串不再兜底（重连耗尽时红字后面空一块）",
    file: ERR,
    from: '    `错误信息：${msg || "连接意外中断"}`,',
    to: "    `错误信息：${msg}`,",
  },
  {
    name: "A-1081-1 超限判据只留 code、删掉散文（OpenAI 的 code 在 200 字符截断后已丢失 → 漏判，超限又走 9 次重连）",
    file: ERR,
    /* 2026-10-07 重打锚点：原锚点行尾带了**中文行尾注释原文**（OpenAI / DeepSeek 系）
       + 精确的补空格数，注释被系统剥离成空白后必然断裂。
       改为**只锚代码行**（纯 if 条件 + return）—— 不含注释文本，实测唯一。 */
    from: "  if (/maximum context length/i.test(m)) { return true; }",
    to: "",
  },
  {
    name: "A-1081-2 把 400 混进超限状态码（任何 400 都被当超限 → 压缩+重试掩盖真因）",
    file: ERR,
    from: "export const CONTEXT_OVERFLOW_STATUSES: readonly number[] = [413, 414];",
    to: "export const CONTEXT_OVERFLOW_STATUSES: readonly number[] = [400, 413, 414];",
  },
  {
    name: "A-1081-3 反应式分支被摘掉（上游说太长时又只剩空转 9 次重连 —— 这正是用户报的症状）",
    file: PANEL,
    from: "      if (isContextOverflowError(msg)) {",
    to: "      if (false) {",
  },
];

const MUTATIONS = RAW_MUTATIONS.map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

/* ── 骨架：--list / --apply N / --restore ──────────────────────────────────
 * 与 mut-a1091 / mut-a1037 / mut-a1042 / mut-a1053 / mut-a1064 同款约定（全仓一致）。
 * ⚠️ --restore **无参可用**，且**变异态下也能跑**。
 * ⚠️ `--apply` 调用**同一个** `m.mutate`（`sub(t, from, to)`），不另拼锚点 ——
 *   否则 apply 与全量模式走两套判据，"全量能红、apply 没改"的假绿就回来了。
 */
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1063");
const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    const path = join(ROOT, m.file);
    const src = readFileSync(path, "utf8");
    mkdirSync(SAVE_DIR, { recursive: true });
    writeFileSync(join(SAVE_DIR, "orig.txt"), src);
    const next = m.mutate(src);          // ← 与全量模式**同一个** mutate
    if (next === src) {
      console.error(`锚点未命中（源码已漂移）：${m.name}\n    ${m.from.slice(0, 60)}…`);
      rmSync(SAVE_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    writeFileSync(path, next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 ${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(join(ROOT, man.file), readFileSync(join(SAVE_DIR, "orig.txt")));
  const now = createHash("sha256").update(readFileSync(join(ROOT, man.file))).digest("hex");
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

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
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 没这道保险，变异会留在源码里，
   下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（2026-09-23 实测踩到） */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);
const hashes = new Map([...originals.keys()].map((t) => [t, hash(join(ROOT, t))]));

if (!runSpec()) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1063-streamerrors")) { process.exit(1); }
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
  restoreAll();
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
