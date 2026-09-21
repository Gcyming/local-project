#!/usr/bin/env node
/**
 * gui/scripts/mut-a1047-reqowner.mjs — A-1047 守卫（tests/gui/request-owner.spec.ts）的变异验证。
 *
 * 守卫"通过"只说明它没报错。这里把「请求归属判定 + 丢弃留痕」的每一处**逐个改坏**，
 * 要求守卫变红。改坏方向刻意选成"下一个人顺手就会写回去"的样子：
 *
 *   · 把 null 当成"未标注"（`!= null` 看起来更干净，实则放行了旧会话的请求）
 *   · 只 console.warn 不回决策（"留痕"做了一半：日志有了，主进程照样干等 300s）
 *   · 丢弃时顺手 alwaysAllow（把丢弃变成永久放行，最危险的一种）
 *   · 退回散落在 .tsx 里的裸判定（判据分裂成两份，各自漂移）
 *
 * 这些**都不报错**，只在真机上表现为"Agent 卡住 / 输入框被旧会话选择题占住 / 权限被静默放行"。
 *
 * ⚠️ 全程快照 + 还原：任何时刻中断，源文件内容都必须回到原样（末尾核对哈希）。
 * 用法：node gui/scripts/mut-a1047-reqowner.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"…pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = ["tests/gui/request-owner.spec.ts"];

const F_OWNER = "gui/src/renderer/pages/requestOwner.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const FILES = [F_OWNER, F_PANEL];

const MUTATIONS = [
  {
    name: "M1 `sessionId: null` 被当成「未标注」（`!== undefined` → `!= null`）→ 旧会话请求被放行",
    file: F_OWNER,
    from: `  if (reqSid !== undefined) {`,
    to: `  if (reqSid != null) {`,
  },
  {
    name: "M2 权限分支只留日志、不回决策（主进程照样干等 300s）",
    file: F_PANEL,
    from:
      `        void Promise.resolve(api?.perm?.resolve?.(buildPermDismissDecision(req.requestId, why)))\n` +
      `          .catch(() => { /* 请求可能已超时/不存在 → 忽略，动作本身不受影响 */ });\n`,
    to: ``,
  },
  {
    name: "M3 ask_user 分支只留日志、不回决策（用户只看到 Agent 卡住，界面上什么都没有）",
    file: F_PANEL,
    from:
      `        void Promise.resolve(api?.askUser?.resolve?.(buildAskDismissDecision(req.requestId, why)))\n` +
      `          .catch(() => { /* 请求可能已超时/不存在 → 忽略，动作本身不受影响 */ });\n`,
    to: ``,
  },
  {
    name: "M4 权限丢弃顺手开成 alwaysAllow（丢弃变成永久放行）",
    file: F_OWNER,
    from: `  return { requestId, approved: false, reason: \`（已丢弃：\${why}）\`, alwaysAllow: false };`,
    to: `  return { requestId, approved: false, reason: \`（已丢弃：\${why}）\`, alwaysAllow: true };`,
  },
  {
    name: "M5 ask 丢弃写成 skipped=false（主进程当成用户真的回答了）",
    file: F_OWNER,
    from: `  return { requestId, answer: \`（已丢弃：\${why}）\`, skipped: true };`,
    to: `  return { requestId, answer: \`（已丢弃：\${why}）\`, skipped: false };`,
  },
  {
    name: "M6 权限分支退回散落的裸判定（判据分裂成两份）",
    file: F_PANEL,
    from:
      `      const owner = classifyRequestOwner(req.sessionId, streamSessionRef.current, sessionRef.current);\n` +
      `      if (!owner.ok) {\n` +
      `        const why = describeRequestDrop(owner);\n` +
      `        console.warn(\`\${REQUEST_DROP_MARKER} 权限请求 \${req.requestId} 被丢弃：\${why}\`);`,
    to:
      `      const reqSid = req.sessionId !== undefined ? req.sessionId : streamSessionRef.current;\n` +
      `      if (reqSid !== sessionRef.current) { return; }\n` +
      `      if (false) {\n` +
      `        const why = "";`,
  },
  {
    name: "M7 丢弃日志去掉统一前缀（跨模块 grep 不到，等于没留痕）",
    file: F_PANEL,
    from: `console.warn(\`\${REQUEST_DROP_MARKER} ask_user 提问 \${req.requestId} 被丢弃：\${why}\`);`,
    to: `console.warn(\`ask_user 提问 \${req.requestId} 被丢弃：\${why}\`);`,
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

function snapshot(files) {
  const out = new Map();
  for (const rel of files) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { out.set(p, readFileSync(p, "utf8")); }
  }
  return out;
}

function restore(snap) {
  for (const [p, text] of snap) { writeFileSync(p, text); }
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** ⚠️ 行尾自适应：Windows 上这些文件是 CRLF；锚点写 `\n` 会**静默不命中**。 */
const eolOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n");
const adapt = (s, eol) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

function main() {
  const snap = snapshot(FILES);
  if (snap.size !== FILES.length) {
    console.error(`[mut-a1047] 快照不全（${snap.size}/${FILES.length}），先确认路径`);
    process.exit(1);
  }
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");

  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1047] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-2000));
    process.exit(1);
  }
  console.info(`[mut-a1047] 基线守卫通过（1 份守卫 / 快照 ${snap.size} 个文件）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = snap.get(path);
    if (original === undefined) {
      console.error(`[mut-a1047] ${m.name}\n  ✗ 快照里没有 ${m.file}`);
      survivors.push(m.name);
      continue;
    }
    const eol = eolOf(original);
    const from = adapt(m.from, eol);
    const to = adapt(m.to, eol);
    if (!original.includes(from)) {
      console.error(`[mut-a1047] ${m.name}\n  ✗ 锚点未命中（行尾 ${JSON.stringify(eol)}）`);
      survivors.push(m.name);
      continue;
    }
    const next = original.replace(from, to);
    if (next === original) {
      console.error(`[mut-a1047] ${m.name}\n  ✗ 变异无效果（改了等于没改）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, next);

    const r = runGuards();
    if (r.ok) {
      console.error(`[mut-a1047] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1047] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }

  restore(snap);
  const after = snapshot(FILES);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before
    && after.size === snap.size;

  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1047] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1047] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "源文件还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
