/**
 * A-1063 变异测试：把「流式失败判定」的关键实现逐个改坏，要求守卫变红。
 *
 * 重点盯的是那**一次真实回归**：`isPermanentStreamError` 的裸数字子串匹配
 * 把「十次重连」提前短路掉（`MAX_RETRY = 9` 一直在，只是从没跑到）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1063-streamerrors.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
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
    from: "  if (/maximum context length/i.test(m)) { return true; }          // OpenAI / DeepSeek 系\n",
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
