#!/usr/bin/env node
/**
 * gui/scripts/mut-a1052-blank.mjs — A-1052 守卫（tests/core-ts/message-text.spec.ts）的变异验证。
 *
 * 病：用户真机截图里的「巨型蓝色气泡」——满宽高饱和色块，只有顶/底两行字，
 *     中间 ~630px 纯空白。根因是 `whiteSpace: "pre-wrap"` 把正文里的连续空行各撑成一整行。
 *
 * 改坏方向都挑"下一个人顺手就会写回去、而且**全都不报错**"的样子：
 *   - 逻辑层：不收敛空行 / 不认空白行 / 不归一 CRLF / 不去首尾空行 / 收敛过狠把单换行也揉掉 /
 *     保留数写错 / keep 非法值不回退；
 *   - 契约层：三处渲染点任一退化成裸 `{m.content}`、净化模块没被 import、
 *     或者反过来把净化**污染到复制/回滚/发送落库**路径（这几条不报错，但用户复制/发出去的就是被改写过的文本）。
 *
 * ⚠️ 全程快照 + 还原（SHA256 校验）；行尾自适应。
 *
 * 一处刻意的**等价变异体**说明（M9 旁）：把阈值 `{n + 1,}` 单独改成 `{n,}` 不改变任何输出
 * （`\n{n,}` 与 `\n{n+1,}` 配 `repeat(n)` 结果全同），因此它"守卫仍绿"是正确的、不是漏锁。
 * 要击穿「1 个空行原样保留」必须同时下压替换量（M8 即此形态）。
 * 推论：阈值与替换量这一对里，真正的承重项是**替换量**。
 *
 * 用法：node gui/scripts/mut-a1052-blank.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = ["tests/core-ts/message-text.spec.ts"];
const F_LOGIC = "gui/src/renderer/pages/messageText.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const FILES = [F_LOGIC, F_PANEL];

const MUTATIONS = [
  // ── A 组：collapseBlankRuns 语义 ────────────────────────────────────────────
  {
    name: "M1 不收敛连续空行 → 30 个空行仍是 650px，「巨型色块」原样复现",
    file: F_LOGIC,
    from: '    .replace(new RegExp(`\\\\n{${n + 1},}`, "g"), "\\n".repeat(n))\n',
    to: "",
  },
  {
    name: "M2 不认空白行 → 只含空格/制表符的三行在界面上看着是空行，却一个都不折叠",
    file: F_LOGIC,
    from: '    .replace(/^[ \\t]+$/gm, "")\n',
    to: "",
  },
  {
    name: "M3 不归一 CRLF → Windows 复制粘贴的 \\r\\n 让 `\\n{3,}` 一条也匹配不到",
    file: F_LOGIC,
    from: '    .replace(/\\r\\n?/g, "\\n")\n',
    to: "",
  },
  {
    name: "M4 不去首空行 → 正文开头的连续空行仍各占一整行",
    file: F_LOGIC,
    from: '    .replace(/^\\n+/, "")\n',
    to: "",
  },
  {
    name: "M5 不去尾空行 → 正文结尾的连续空行仍各占一整行",
    file: F_LOGIC,
    from: '    .replace(/\\n+$/, "");\n',
    to: "",
  },
  {
    name: "M6 保留数写错（2→3）→ 段落间距与验收口径脱钩",
    file: F_LOGIC,
    from: "export const BLANK_RUN_KEEP = 2;",
    to: "export const BLANK_RUN_KEEP = 3;",
  },
  {
    name: "M7 keep 非法值不回退 → keep=0/NaN 时静默产出错口径（NaN 还会拼出非法量词）",
    file: F_LOGIC,
    from: "  const n = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : BLANK_RUN_KEEP;",
    to: "  const n = Math.floor(keep);",
  },
  {
    name: "M8 收敛过狠（阈值降到 n、替换降到 n-1）→ 正常段落分隔（1 个空行）被揉掉，排版塌陷",
    file: F_LOGIC,
    from: '\\n{${n + 1},}`, "g"), "\\n".repeat(n)',
    to: '\\n{${n},}`, "g"), "\\n".repeat(n - 1)',
  },
  {
    // 注：单独的 `{n + 1,}` → `{n,}` 是**等价变异体**（`\n{n,}` 与 `\n{n+1,}` 配 `repeat(n)` 输出全同），
    // 故意不复现它——变异不红时先判"是不是根本不该红"，而不是去加一条假守卫。
    name: "M9 收敛不足（repeat(n) → repeat(n+1)）→ 30 个空行只降到 2 个空行，仍撑出 65px 空白",
    file: F_LOGIC,
    from: '"\\n".repeat(n))',
    to: '"\\n".repeat(n + 1))',
  },

  // ── B 组：ChatPanel 源码契约 ───────────────────────────────────────────────
  {
    name: "C1 用户气泡渲染点退化成裸 {m.content} → 巨型色块回归（本次事故正身）",
    file: F_PANEL,
    from: "        {collapseBlankRuns(m.content)}",
    to: "        {m.content}",
  },
  {
    name: "C2 发言失败气泡漏净化 → 同一片空白在失败态继续撑高",
    file: F_PANEL,
    from: "            {collapseBlankRuns(m.content)}",
    to: "            {m.content}",
  },
  {
    name: "C3 错误气泡漏净化 → 报错串里的连续空行照样撑高",
    file: F_PANEL,
    from: '            color: "#f87171",\n          }}>\n            {collapseBlankRuns(m.content)}',
    to: '            color: "#f87171",\n          }}>\n            {m.content}',
  },
  {
    name: "C4 净化污染剪贴板 → 用户复制到的是被折叠过的文本（原文丢失）",
    file: F_PANEL,
    from: "navigator.clipboard.writeText(m.content)",
    to: "navigator.clipboard.writeText(collapseBlankRuns(m.content))",
  },
  {
    name: "C5 净化污染回滚 → 输入框里被塞进改写过的文本，再发出去就变味",
    file: F_PANEL,
    from: "setInput(target.content);",
    to: "setInput(collapseBlankRuns(target.content));",
  },
  {
    name: "C6 净化污染发送/落库路径 → 存下去、发出去的都是被改写过的正文",
    file: F_PANEL,
    from: "message: text, sessionId: sid",
    to: "message: collapseBlankRuns(text), sessionId: sid",
  },
  {
    name: "C7 净化模块没被 import → 「调用计数」假通过：名字还在、实现没了",
    file: F_PANEL,
    from: 'import { collapseBlankRuns } from "./messageText.js";\n',
    to: "",
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
    console.error("[mut-a1052] 基线守卫未通过\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info("[mut-a1052] 基线守卫通过\n");

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
      console.error(`[mut-a1052] ${m.name}\n  ✗ 锚点未命中（行尾 ${JSON.stringify(eol)}）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, original.replace(from, to));
    if (runGuards().ok) {
      console.error(`[mut-a1052] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1052] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);
  const after = snapshot(FILES);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1052] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1052] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
