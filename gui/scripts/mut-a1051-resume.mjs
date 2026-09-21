#!/usr/bin/env node
/**
 * gui/scripts/mut-a1051-resume.mjs — A-1051 守卫（tests/core-ts/resume-outcome.spec.ts）的变异验证。
 *
 * 改坏方向都是"下一个人顺手就会写回去"的样子，而且**全都不报错**：
 * 把「查到了」当「还活跃」（active=false 被无视 → 永久「恢复中」）、判死却不结束 loading、
 * 重试耗尽仍永久 loading、无证据就删气泡（内容丢失）、把「放弃等待」冒充「判死证据」、
 * 错误收尾也建结算气泡（与落库后缀双份）、空白正文也算正文、流还在跑就冻结正文。
 * 契约层再做四条：判定没被调用、老判据回来了、早退分支漏复位、判死标记无条件置位。
 *
 * ⚠️ 全程快照 + 还原；行尾自适应（这些文件在 Windows 上是 CRLF）。
 * 用法：node gui/scripts/mut-a1051-resume.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = ["tests/core-ts/resume-outcome.spec.ts", "tests/core-ts/diff-colors.spec.ts"];
const F_LOGIC = "gui/src/renderer/pages/resumeOutcome.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_CSS = "gui/src/renderer/index.css";
const FILES = [F_LOGIC, F_PANEL, F_CSS];

const MUTATIONS = [
  {
    name: "M1 把「查到了」当「还活跃」→ active=false 被无视，永久「恢复中」",
    file: F_LOGIC,
    from: `  if (input.query && input.query.active) {`,
    to: `  if (input.query) {`,
  },
  {
    name: "M2 判死却不结束 loading → 用户仍永久停在「恢复中」",
    file: F_LOGIC,
    from: `    return {\n      endLoading: true,\n      bubble: settledOk ? "settle" : "drop",`,
    to: `    return {\n      endLoading: false,\n      bubble: settledOk ? "settle" : "drop",`,
  },
  {
    name: "M3 重试耗尽仍永久 loading → 一次 IPC 失败就卡死（原病另一面）",
    file: F_LOGIC,
    from: `  return { endLoading: true, bubble: "keep", retry: false, confirmedDead: false };`,
    to: `  return { endLoading: false, bubble: "keep", retry: false, confirmedDead: false };`,
  },
  {
    name: "M4 无证据就删气泡 → 流其实还活着时内容凭空消失（用户观感「被回滚」）",
    file: F_LOGIC,
    from: `  return { endLoading: true, bubble: "keep", retry: false, confirmedDead: false };`,
    to: `  return { endLoading: true, bubble: "drop", retry: false, confirmedDead: false };`,
  },
  {
    name: "M5 把「放弃等待」冒充「判死证据」→ 历史回调据此丢弃仍然有效的占位气泡",
    file: F_LOGIC,
    from: `  return { endLoading: true, bubble: "keep", retry: false, confirmedDead: false };`,
    to: `  return { endLoading: true, bubble: "keep", retry: false, confirmedDead: true };`,
  },
  {
    name: "M6 错误收尾也建结算气泡 → 与落库的 [截断] 后缀文本双份显示",
    file: F_LOGIC,
    from: `  const settledOk = partial.length > 0 && !input.hasTailError;`,
    to: `  const settledOk = partial.length > 0;`,
  },
  {
    name: "M7 重试条件方向写反 → 从不重试，瞬时抖动直接判死",
    file: F_LOGIC,
    from: `  if (input.attempts < input.maxAttempts) {`,
    to: `  if (input.attempts > input.maxAttempts) {`,
  },
  {
    name: "M8 流还在跑就把气泡转结算 → 正文被冻结，后续 chunk 不再续长",
    file: F_LOGIC,
    from: `    return { endLoading: false, bubble: "keep", retry: false, confirmedDead: false };\n  }\n  if (input.query) {`,
    to: `    return { endLoading: false, bubble: "settle", retry: false, confirmedDead: false };\n  }\n  if (input.query) {`,
  },
  {
    name: "M9 空白正文也算正文 → 断流后留一个空的「结算气泡」空壳",
    file: F_LOGIC,
    from: `  const partial = (input.partial ?? "").trim();`,
    to: `  const partial = (input.partial ?? "");`,
  },
  {
    name: "M10 恢复收尾不走纯函数判定 → 老判据会悄悄回来",
    file: F_PANEL,
    from: `            const outcome = decideResumeOutcome({`,
    to: `            const outcome = decideResumeInline({`,
  },
  {
    name: "M11 老判据回归：把「结束 loading」重新绑在粘性 stoppingRef 上",
    file: F_PANEL,
    from: `            setLoading(false);\n            // ⚠️ \`streamActiveRef\` 只在**拿到"流已死"的证据**时才清（支②）。`,
    to: `            if (streamActiveRef.current && !stoppingRef.current) { setLoading(false); }\n            // ⚠️ \`streamActiveRef\` 只在**拿到"流已死"的证据**时才清（支②）。`,
  },
  {
    name: "M12 早退分支漏复位 stoppingRef → 流式期间切走会让它永久为 true",
    file: F_PANEL,
    from: `        stoppingRef.current = false;\n        setStopping(false);\n        return;`,
    to: `        setStopping(false);\n        return;`,
  },
  {
    name: "M13 判死标记无条件置位 → 重试耗尽也冒充「流已死」，丢弃有效的占位气泡",
    file: F_PANEL,
    from: `            if (outcome.confirmedDead) {`,
    to: `            if (true) {`,
  },
  {
    name: "M14 去掉 Promise.resolve 包裹 → 方法缺失时抛 TypeError，仍是永久卡死路径",
    file: F_PANEL,
    from: `            const r = await Promise.resolve(api.chat?.isActive?.(sessionId)).catch(() => null);`,
    to: `            const r = await api.chat?.isActive?.(sessionId).catch(() => null);`,
  },
  {
    name: "D1 产物卡 diff 底色写死（比主题变量淡）→ +/- 底色几乎看不见",
    file: F_PANEL,
    from: `          background: l.type === "add" ? "var(--diff-add-bg, rgba(46, 160, 67, 0.16))" : l.type === "del" ? "var(--diff-del-bg, rgba(248, 81, 73, 0.14))" : "transparent",`,
    to: `          background: l.type === "add" ? "rgba(52,211,153,0.10)" : l.type === "del" ? "rgba(248,113,113,0.12)" : "transparent",`,
  },
  {
    name: "D2 产物卡 diff 文字色写死 → 与思考历程的绿红对不上、切主题不变",
    file: F_PANEL,
    from: `          color: l.type === "add" ? "var(--diff-add, #3fb950)" : l.type === "del" ? "var(--diff-del, #f85149)" : "var(--text-muted)",`,
    to: `          color: l.type === "add" ? "#34d399" : l.type === "del" ? "#f87171" : "var(--text-muted)",`,
  },
  {
    name: "D3 删掉主题里的 diff 变量定义 → var() 静默回退兜底色，切主题这处不变",
    file: F_CSS,
    from: `  --diff-add: #3fb950;\n  --diff-add-bg: rgba(46, 160, 67, 0.16);`,
    to: `  --diff-add: #3fb950;`,
  },
  {
    name: "D4 思考历程的 diff 行写死色 → 两处产地再次分叉",
    file: F_CSS,
    from: `.think-diff-row.diff-add { background: var(--diff-add-bg); }`,
    to: `.think-diff-row.diff-add { background: #2ea043; }`,
  },
  {
    name: "D5 两套主题取值改成全同 → 「随主题走」变成空话（写死色再也观察不出来）",
    file: F_CSS,
    from: `  --diff-add: #56d364;`,
    to: `  --diff-add: #3fb950;`,
  },
];

function runGuards() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...GUARDS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const snapshot = (files) => {
  const m = new Map();
  for (const rel of files) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { m.set(p, readFileSync(p, "utf8")); }
  }
  return m;
};
const restore = (snap) => { for (const [p, t] of snap) { writeFileSync(p, t); } };
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const eolOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n");
const adapt = (s, eol) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

function main() {
  const snap = snapshot(FILES);
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");
  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1051] 基线守卫未通过\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info("[mut-a1051] 基线守卫通过\n");

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = snap.get(path);
    if (original === undefined) { survivors.push(m.name); continue; }
    const eol = eolOf(original);
    const from = adapt(m.from, eol);
    const to = adapt(m.to, eol);
    if (!original.includes(from)) {
      console.error(`[mut-a1051] ${m.name}\n  ✗ 锚点未命中（行尾 ${JSON.stringify(eol)}）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, original.replace(from, to));
    if (runGuards().ok) {
      console.error(`[mut-a1051] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1051] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);
  const after = snapshot(FILES);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1051] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1051] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
