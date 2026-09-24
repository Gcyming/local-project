#!/usr/bin/env node
/**
 * gui/scripts/mut-a1091.mjs — A-1091 守卫的变异验证。
 *
 * 本轮修四件事，每件都有"下一个人顺手写回去、而且全都不报错"的退化形态：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | RPM | 上游 RPM 限额没有客户端执行者 / 死开关 | 零星 429、中间断流，且想调低设置也无效 |
 * | 浏览器 | 自家硬规则把内置浏览器拦在 127.0.0.1 外 | 「右侧栏浏览器被禁止调用」，而自家的 http_create_app 就靠它预览 |
 * | 图标 | terminal_run 不在 TOOL_LABELS | 卡片显示「⚡ terminal_run」英文名 + 闪电 |
 * | 光标 | 吐字光标无条件闪 | 流停滞 6 分多钟仍在闪，像"还在打字" |
 *
 * ## 覆盖的十三条
 *
 *   1~2   额度取值：实测优先被改成"取小"（付费档被按免费档限死）/ 未知被发明一个阈值
 *   3     响应头解析丢掉「窗口必须 60s」守卫（w=1 的每秒额度被当 RPM，放大 60 倍）
 *   4~5   滑动窗口：退化成固定分桶 / 边界判据 `<=` 变 `<`
 *   6     未知额度不再放行（抛错/丢请求 = 用户看到"什么都没发生"）
 *   7     429 冷却被并发 429 **互相缩短**（等不够就再撞一次）
 *   8~9   网络硬规则：回到旧 `block`（事故复现）/ 连云元数据也放行（真 SSRF 面）
 *   10    ⟳ 标记不再剥离（圆圈箭头回归）
 *   11    剥离改成全局替换（正文里的 ⟳ 被误删）
 *   12    吐字光标去掉阈值判定（恒亮 = 原缺陷）
 *   13    terminal_run 的映射被删（图标退化成闪电）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 目标文件行尾是**混的**（classifier.ts / ChatPanel.tsx / thinkingText.ts = LF，
 *    router 无关；rpmLimiter/streamCursor 是新建的 LF）⇒ 一律走共享模块 `sub()`。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1091.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1091.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1091.mjs --apply 3   # 只改第 3 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1091.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   SPECS="tests/core-ts/a1091-rpm.spec.ts tests/gui/a1091-ui-guards.spec.ts"
 *   for n in $(seq 1 13); do
 *     node gui/scripts/mut-a1091.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     red=0
 *     for s in $SPECS; do node node_modules/vitest/vitest.mjs run "$s" >/dev/null 2>&1 || red=1; done
 *     node gui/scripts/mut-a1091.mjs --restore >/dev/null
 *     [ "$red" = "1" ] && echo "M$n ✅ 被捕获" || echo "M$n ❌ 未被捕获"
 *   done
 *   ```
 *   ⚠️ 两份 spec 都要跑：每条变异的"捕获者"所在文件不同。多份 spec 传**同一次** vitest
 *   会「未收集却报绿」⇒ 必须**逐份跑**并判 exit code。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1091-rpm.spec.ts", "tests/gui/a1091-ui-guards.spec.ts"];

const F_LIMITER = "core-ts/src/llm/rpmLimiter.ts";
const F_CLASSIFIER = "core-ts/src/tools/classifier.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_THINK = "gui/src/renderer/pages/thinkingText.ts";
const F_CURSOR = "gui/src/renderer/pages/streamCursor.ts";
const TARGETS = [F_LIMITER, F_CLASSIFIER, F_PANEL, F_THINK, F_CURSOR];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1091");

const MUTATIONS = [
  /* ── ① 额度取值三层 ─────────────────────────────────────────────── */
  {
    name: "1 实测优先被改成「取较小值」（付费档实测 20 被免费档声明 10 限死）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      '  if (usableRpm(observed)) { return { rpm: observed, source: "observed" }; }',
      '  if (usableRpm(observed) && usableRpm(declared)) { return { rpm: Math.min(observed, declared), source: "observed" }; }\n  if (usableRpm(observed)) { return { rpm: observed, source: "observed" }; }',
    ),
  },
  {
    name: "2 未知额度被发明一个阈值（不发明值的原则被破坏 ⇒ 凭空限死用户）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      '  return { rpm: null, source: "unknown" };',
      '  return { rpm: 1, source: "unknown" };',
    ),
  },

  /* ── ② 响应头解析 ───────────────────────────────────────────────── */
  {
    name: "3 丢掉「窗口必须 60s」守卫（w=1 的每秒额度被当 RPM，放大 60 倍）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "  if (h.windowS !== undefined && h.windowS !== 60) { return undefined; }",
      "",
    ),
  },

  /* ── ③ 滑动窗口判据 ─────────────────────────────────────────────── */
  {
    name: "4 滑动窗口退化成固定分桶（桶边界一次放行 2×rpm ⇒ 正是触发限流的经典形态）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "  const waitMs = earliest + windowMs + WINDOW_EPSILON_MS - now;",
      "  const waitMs = Math.max(1, windowMs - (now % windowMs));",
    ),
  },
  {
    name: "5 边界判据写错（`< window` 变 `<= window` ⇒ 阈值差 1ms 的旧记录被提前放行）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "  const fresh = hits.filter((t) => Number.isFinite(t) && now - t < windowMs);",
      "  const fresh = hits.filter((t) => Number.isFinite(t) && now - t <= windowMs - 2);",
    ),
  },

  /* ── ④ 限流器行为 ───────────────────────────────────────────────── */
  {
    name: "6 未知额度不再放行（抛错/丢请求 ⇒ 用户看到「什么都没发生」）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "      if (rpm === null) { return { waitedMs: waited, source }; }   // 未知 → 放行（不发明阈值）",
      "      if (rpm === null) { throw new Error(\"unknown rpm\"); }",
    ),
  },
  {
    name: "7 429 冷却被并发 429 互相缩短（等不够 ⇒ 下一发继续撞限流）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "      s.cooldownUntil = s.cooldownUntil === undefined ? until : Math.max(s.cooldownUntil, until);",
      "      s.cooldownUntil = until;",
    ),
  },

  /* ── ⑤ 网络硬规则 ───────────────────────────────────────────────── */
  {
    name: "8 回到旧 block（内置浏览器再次打不开 127.0.0.1 —— 事故本体复现）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      '    return { level: "confirm", reason: `非 HTTPS / 本地地址访问 ${url.slice(0, 60)}`, matched: "lan-insecure" };',
      '    return { level: "block", reason: `非 HTTPS / 本地地址访问 ${url.slice(0, 60)}`, matched: "lan-insecure" };',
    ),
  },
  {
    name: "9 云元数据也放行（真正的凭证窃取面被打开）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      '    return { level: "block", reason: `云元数据地址禁止访问（可读取实例凭据）${url.slice(0, 60)}`, matched: "cloud-metadata" };',
      '    return { level: "confirm", reason: `云元数据地址 ${url.slice(0, 60)}`, matched: "cloud-metadata" };',
    ),
  },

  /* ── ⑥ ⟳ 标记 ───────────────────────────────────────────────────── */
  {
    name: "10 卡片不再剥离 ⟳（圆圈箭头回归——用户截图里的那个）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '<span className="think-tool-name" style={{ flexShrink: 0 }}>{stripToolTraceMark(tool.label)}</span>',
      '<span className="think-tool-name" style={{ flexShrink: 0 }}>{tool.label}</span>',
    ),
  },
  {
    name: "11 剥离改成全局替换（正文/工具名里的 ⟳ 被误删）",
    file: F_THINK,
    mutate: (t) => sub(
      t,
      '  return (label ?? "").replace(/^⟳\\s*/, "");',
      '  return (label ?? "").replace(/⟳\\s*/g, "");',
    ),
  },

  /* ── ⑦ 吐字光标 ─────────────────────────────────────────────────── */
  {
    name: "12 吐字光标去掉阈值判定（恒亮 = 原缺陷：停滞 6 分钟仍在闪）",
    file: F_CURSOR,
    mutate: (t) => sub(
      t,
      "  return now - lastEmitAt < idleMs;",
      "  return true;",
    ),
  },

  /* ── ⑧ 工具标签映射 ─────────────────────────────────────────────── */
  {
    name: "13 删掉 terminal_run 的映射（图标退化成闪电 + 英文原名）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '  terminal_run: { label: "执行命令", Icon: TerminalIcon },\n',
      "",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
  return { ok: true, spawnBlocked: false };
}

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
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);           // **字节**备份
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* 中断即还原：`finally` 在 Ctrl+C（SIGINT 直接终止、不展开栈）下**不执行** ——
   没这道保险，变异会留在源码里，下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（本仓实测踩到过）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (!base.ok) {
  console.error(`基线未通过（${base.spec}）—— 先修好测试再跑变异。`);
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1091")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) {
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

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
