#!/usr/bin/env node
/**
 * gui/scripts/mut-a1129-outgoing-messages.mjs — A-1129（出网前空内容规范化）的变异验证。
 *
 *   1  空串不再算空（上游那条 400 原样复发）
 *   2  空数组不算空（识图路径的空 content 块漏修）
 *   3  有元素的数组被判空（识图消息被"修"成一句占位，图丢了）
 *   4  空内容改成**整条丢弃**（破坏角色交替 ⇒ 换成另一个 400）
 *   5  空 system 不丢（留一条空消息出网）
 *   6  补占位时整条替换（`tool_calls` 丢失 ⇒ 后面的 tool 消息失去配对）
 *   7  没变化也造新数组（每帧一次白复制，且调用方无法用引用判断"改过没"）
 *   8  未知角色的占位回落到空串（等于没补）
 *   9  `router.chat` 不再过门（非流式路径照旧 400）
 *   10 `router.chatStream` 不再过门（流式 = GUI 主路径，照旧 400）
 *   11 落点搬回 engine（假保险：管不到 tool_loop 的中途重发）
 *   12 无 messages 的请求也被塞一个 `messages: []`（embeddings 从此非法）
 *   13 `sanitizeWirePayload` 无变化也造副本（每轮请求白复制，引用判据失效）
 *   14 就地改写入参（落盘历史/渲染层被一起污染）
 *   15 `user` 的占位写成空串（补了等于没补）
 *
 * ⚠️ 落点说明：判据挂在 **`ModelRouter`（唯一分派点）**，不是 engine ——
 *   `tool_loop` 第 2..N 轮直接 `router.chat(opts.messages)` 重发、不经过 `buildMessages`，
 *   而那里正是推 `content: null` 的地方。挂在 engine 上会让"多轮工具调用"整类漏网。
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环：
 *      for i in $(seq 1 12); do node gui/scripts/mut-a1129-outgoing-messages.mjs --apply $i \
 *        && node node_modules/vitest/vitest.mjs run tests/core-ts/a1129-outgoing-messages.spec.ts \
 *             --config vitest.config.ts --reporter=dot; node gui/scripts/mut-a1129-outgoing-messages.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（否则是"没跑到"而不是"被抓到"）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1129-outgoing-messages.spec.ts";
const F_MODULE = "core-ts/src/services/outgoingMessages.ts";
const F_ROUTER = "core-ts/src/router.ts";
const F_ENGINE = "core-ts/src/services/engine.ts";
const TARGETS = [F_MODULE, F_ROUTER, F_ENGINE];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1129");

const MUTATIONS = [
  {
    name: "1 空串不再算空（上游那条 400 原样复发）",
    file: F_MODULE,
    mutate: (t) => sub(t, '  if (typeof content === "string") { return content.trim() === ""; }', '  if (typeof content === "string") { return false; }'),
  },
  {
    name: "2 空数组不算空（识图路径的空 content 漏修）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  if (Array.isArray(content)) { return content.length === 0; }", "  if (Array.isArray(content)) { return false; }"),
  },
  {
    name: "3 有元素的数组被判空（识图消息被修成一句占位，图丢了）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  if (Array.isArray(content)) { return content.length === 0; }", "  if (Array.isArray(content)) { return true; }"),
  },
  {
    name: "4 空内容改成整条丢弃（破坏角色交替 ⇒ 换成另一个 400）",
    file: F_MODULE,
    mutate: (t) => sub(
      t,
      '      out.push({ ...m, content: placeholderForRole(String(m?.role ?? "")) } as T);\n      continue;',
      "      continue;",
    ),
  },
  {
    name: "5 空 system 不丢（留一条空消息出网）",
    file: F_MODULE,
    mutate: (t) => sub(t, '      if (m?.role === "system") { changed = true; continue; }', '      if (false) { changed = true; continue; }'),
  },
  {
    name: "6 补占位时整条替换（tool_calls 丢失 ⇒ 后面的 tool 消息失去配对）",
    file: F_MODULE,
    mutate: (t) => sub(
      t,
      '      out.push({ ...m, content: placeholderForRole(String(m?.role ?? "")) } as T);',
      '      out.push({ role: m.role, content: placeholderForRole(String(m?.role ?? "")) } as T);',
    ),
  },
  {
    name: "7 没变化也造新数组（每帧一次白复制，调用方也无法用引用判断改过没）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  return changed ? out : (messages as T[]);", "  return out;"),
  },
  {
    name: "8 未知角色的占位回落到空串（等于没补）",
    file: F_MODULE,
    mutate: (t) => sub(t, '  return typeof p === "string" && p ? p : "（继续）";', '  return typeof p === "string" ? p : "";'),
  },
  /* ⚠️ 下面 9/10 两条的锚点必须**夹到该入口独有的行**为止（`try {` vs `let started = false;`）。
     原锚靠行尾注释 `// A-1129（chat 入口）` 区分两个入口，而 2026-10-05 全仓注释剥离把注释
     换成了空行 ⇒ 两行变成**逐字节相同**（`    payload = sanitizeWirePayload(payload); `，
     连尾随空格都一样）⇒ 单行锚点必然命中 2 次。
     ⚠️ 顺带注意：入口到分叉点之间那 8 行**也是逐字节相同**的，所以锚点必须一路走到分叉行，
     只往下扩一两行没有用（实测 2/3/4/5/6/7 行都是 2 次命中）。 */
  {
    name: "9 router.chat 不再过门（非流式路径照旧 400）",
    file: F_ROUTER,
    mutate: (t) => sub(t,
      "    payload = sanitizeWirePayload(payload); \n"
      + '    const chain = this.fallbackChain("chat");\n'
      + "    if (chain.length === 0) {\n"
      + "      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);\n"
      + "    }\n"
      + "    const errors: string[] = [];\n"
      + "    for (let i = 0; i < chain.length; i++) {\n"
      + "      const route = chain[i];\n"
      + "      try {",
      '    const chain = this.fallbackChain("chat");\n'
      + "    if (chain.length === 0) {\n"
      + "      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);\n"
      + "    }\n"
      + "    const errors: string[] = [];\n"
      + "    for (let i = 0; i < chain.length; i++) {\n"
      + "      const route = chain[i];\n"
      + "      try {",
    ),
  },
  {
    name: "10 router.chatStream 不再过门（流式 = GUI 主路径，照旧 400）",
    file: F_ROUTER,
    /* 同上：分叉行是 `let started = false;`（流式要记录「这一轮是否已开始输出」）。 */
    mutate: (t) => sub(t,
      "    payload = sanitizeWirePayload(payload); \n"
      + '    const chain = this.fallbackChain("chat");\n'
      + "    if (chain.length === 0) {\n"
      + "      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);\n"
      + "    }\n"
      + "    const errors: string[] = [];\n"
      + "    for (let i = 0; i < chain.length; i++) {\n"
      + "      const route = chain[i];\n"
      + "      let started = false;",
      '    const chain = this.fallbackChain("chat");\n'
      + "    if (chain.length === 0) {\n"
      + "      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);\n"
      + "    }\n"
      + "    const errors: string[] = [];\n"
      + "    for (let i = 0; i < chain.length; i++) {\n"
      + "      const route = chain[i];\n"
      + "      let started = false;",
    ),
  },
  {
    name: "11 落点搬回 engine（假保险：管不到 tool_loop 的中途重发）",
    file: F_ENGINE,
    /* 原锚的 `to` 挂在紧随其后的块注释上（`\n    /*`）⇒ 注释剥离后断裂。
       改成**只锚这一行代码**并在它后面插入：语义不变（仍是「在 engine 多接一道」），
       且不再依赖任何注释。守卫 = spec 的 engine 侧不许出现 sanitizeOutgoingMessages。 */
    mutate: (t) => sub(t,
      "    if (reminder) { out = foldUserReminder(out, reminder); }",
      "    if (reminder) { out = foldUserReminder(out, reminder); }\n    out = sanitizeOutgoingMessages(out);",
    ),
  },
  {
    name: "12 无 messages 的请求也被塞一个 messages: []（embeddings 从此非法）",
    file: F_MODULE,
    mutate: (t) => sub(t, '  if (!Array.isArray(msgs)) { return payload; }', '  if (!Array.isArray(msgs)) { return { ...payload, messages: [] } as T; }'),
  },
  {
    name: "13 sanitizeWirePayload 无变化也造副本（每轮请求白复制，引用判据失效）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  return safe === (msgs as WireMessage[]) ? payload : ({ ...payload, messages: safe } as T);", "  return { ...payload, messages: safe } as T;"),
  },
  {
    name: "14 就地改写入参（落盘历史/渲染层被一起污染）",
    file: F_MODULE,
    mutate: (t) => sub(
      t,
      '      out.push({ ...m, content: placeholderForRole(String(m?.role ?? "")) } as T);',
      '      (m as { content?: unknown }).content = placeholderForRole(String(m?.role ?? ""));\n      out.push(m);',
    ),
  },
  {
    name: "15 `user` 的占位写成空串（补了等于没补）",
    file: F_MODULE,
    mutate: (t) => sub(t, '  user: "（继续）",', '  user: "",'),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

function runSpec() {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply" : "full";

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
      console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore。"); process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1129")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); console.error(res.out); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
