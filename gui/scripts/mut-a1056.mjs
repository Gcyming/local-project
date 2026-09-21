#!/usr/bin/env node
/**
 * gui/scripts/mut-a1056.mjs — A-1056 守卫（以及仍由 a1054-guards 承接的入队契约）的变异验证。
 *
 * 这一族断言全是**源码静态形态 + 纯逻辑取值**，它们不会让任何类型检查失败 ——
 * 一个不跑变异的静态守卫，最常见的失败是"锁错对象"：文件里还留着那行字符串，行为早变了。
 * 所以每条变异都对应一个**用户真的会读到的观感**，改坏它守卫必须变红。
 *
 * 覆盖：
 *  ① 激励语节拍（阈值 5s / 有限性 / 轮换稳定）
 *  ② 激励语文案纪律（带表情包 / 不许混入"用法说明"）
 *  ③ 状态行的**渲染成本契约**（React.memo + 自持 1s 时钟）与**分工**（不许搬回监测栏）
 *  ④ 状态行**真的接上线**（只定义组件 ≠ 接线 —— A-1054 W1 的教训）
 *  ⑤ 入队路径仍是"排队不打断"（不许改回抢占）
 *  ⑥ A-1058② 待发卡片长在输入圆角容器**之上**（不许包回输入框里）
 *  ⑦ A-1058③ 图标 mask 的 `url()` **必须加引号**（未加引号 → 声明被 CSS 丢弃 → 实心方块）
 *
 * ⚠️ 纪律（同 mut-a1054 / mut-a1053）：
 *   - 快照 / 还原一律走**字节**（Buffer），不做文本往返；
 *   - 每条变异都要求"文本确实变了"，否则是**未命中** —— 那种情况下"守卫仍绿"毫无意义；
 *   - 全程结束做字节级还原复核。
 *
 * 用法：node gui/scripts/mut-a1056.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = [
  "tests/core-ts/a1056-guards.spec.ts",
  "tests/core-ts/a1054-guards.spec.ts",
];

const CHEER = "gui/src/renderer/pages/cheerPhrases.ts";
const CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const FILES = [CHEER, CHAT];

/* `sub` / `subLines` / 行尾自检 全部来自**共享模块** `./_mut-eol.mjs` ——
   不要在本脚本里另写一份。本脚本**曾经没有**这个 helper，于是被当成模板抄走，
   把"多行锚点对行尾敏感"的坑原样复制到了 mut-a1055（4 条静默未命中）。 */

const MUTATIONS = [
  /* ── ① 激励语节拍（cheerPhrases.ts） ─────────────────────────────── */
  {
    name: "A-1056① 阈值被改成 3s（太早出场，把状态行挤乱）",
    file: CHEER,
    mutate: (t) => sub(t,
      "export const CHEER_AFTER_MS = 5000;",
      "export const CHEER_AFTER_MS = 3000;"),
  },
  {
    name: "A-1056① shouldCheer 丢掉阈值（任何非负都播）",
    file: CHEER,
    mutate: (t) => sub(t,
      "return Number.isFinite(stageMs) && stageMs >= CHEER_AFTER_MS;",
      "return stageMs >= 0;"),
  },
  {
    name: "A-1056① shouldCheer 丢掉有限性（Infinity 也会乱播）",
    file: CHEER,
    mutate: (t) => sub(t,
      "return Number.isFinite(stageMs) && stageMs >= CHEER_AFTER_MS;",
      "return stageMs >= CHEER_AFTER_MS;"),
  },
  {
    name: "A-1056① pickCheer 非有限 seed 回退不再是第 0 句（每次渲染换一句 → 闪烁）",
    file: CHEER,
    mutate: (t) => sub(t,
      "if (!Number.isFinite(seed)) { return CHEER_PHRASES[0]!; }",
      "if (!Number.isFinite(seed)) { return CHEER_PHRASES[1]!; }"),
  },

  /* ── ② 激励语文案纪律 ───────────────────────────────────────────── */
  {
    name: "A-1056② 激励语池混入「用法说明」句（用户说读起来像系统敷衍）",
    file: CHEER,
    mutate: (t) => sub(t,
      "export const CHEER_PHRASES: readonly string[] = [",
      'export const CHEER_PHRASES: readonly string[] = [\n  "输入消息… Enter 发送，/ 展开指令 🙂",'),
  },
  {
    name: "A-1056② 某句丢了表情包（变回纯文字状态行）",
    file: CHEER,
    mutate: (t) => sub(t, '"别急，好东西值得多等三秒 🍀",', '"别急，好东西值得多等三秒",'),
  },

  /* ── ③ 状态行的渲染成本契约 ─────────────────────────────────────── */
  {
    name: "渲染成本：状态行丢掉 React.memo（父组件每次渲染都拖着它一起重渲染）",
    file: CHAT,
    mutate: (t) => sub(t,
      "const LiveStatusLine = React.memo(function LiveStatusLine(",
      "const LiveStatusLine = (function LiveStatusLine("),
  },
  {
    name: "渲染成本：状态行的 1s 时钟改成 100ms（每秒 10 次重渲染的苗头）",
    file: CHAT,
    mutate: (t) => sub(t,
      "window.setInterval(() => setNow(Date.now()), 1000)",
      "window.setInterval(() => setNow(Date.now()), 100)"),
  },
  {
    name: "渲染成本：面板级复活「占位轮播」计时器（把 5000 行的面板拖进每秒重渲染）",
    file: CHAT,
    mutate: (t) => sub(t,
      "  const [partial, setPartial] = React.useState(\"\");",
      "  const [partial, setPartial] = React.useState(\"\");\n  const [placeholderIndex, setPlaceholderIndex] = React.useState(0);"),
  },

  /* ── ③ 分工：激励语不许搬回底部监测栏 ───────────────────────────── */
  {
    name: "A-1056③ 激励语被搬回底部监测栏（用户在输入区读到系统闲话）",
    file: CHAT,
    mutate: (t) => sub(t, "<SubAgentExpandButton />", "<SubAgentExpandButton />{pickCheer(0)}"),
  },

  /* ── ④ 状态行必须真的接上线 ─────────────────────────────────────── */
  {
    name: "A-1056③ 状态行不再挂到 Agent 输出最下方（组件还在，界面已经看不见）",
    file: CHAT,
    mutate: (t) => sub(t,
      "{liveStatus && <LiveStatusLine status={liveStatus} stageKey={liveStageKey} />}",
      "{false && <LiveStatusLine status={liveStatus} stageKey={liveStageKey} />}"),
  },

  /* ── ⑤ 入队路径：不打断是唯一默认 ───────────────────────────────── */
  {
    name: "A-1054④ 入队路径改回抢占（打断正在跑的流）",
    file: CHAT,
    mutate: (t) => sub(t,
      "syncQueue(enqueue(interruptQueueRef.current, queued));",
      "syncQueue(promote(interruptQueueRef.current, queued.id));"),
  },

  /* ── ⑥ A-1058② 待发卡片的位置：必须在输入圆角容器**之上** ─────────── */
  {
    name: "A-1058② 待发卡片被包回 glass-input 圆角容器（用户原话「这个插入怎么在输入框内」）",
    file: CHAT,
    /* 表达"卡片被包进圆角容器"：在卡片块前插一个 glass-input 起点。
       守卫按**源码顺序**判 queueAt < glassAt，插入这个标记即让顺序反过来 —— 等价于把卡片搬回框内。 */
    mutate: (t) => sub(t,
      "{/* ── A-1056③ 待发指令：",
      '<div className="glass-input" style={{}}>\n        {/* ── A-1056③ 待发指令：'),
  },

  /* ── ⑦ A-1058③ 图标 mask：url() 必须加引号（未加引号 → 声明被丢弃 → 实心方块） ── */
  {
    name: "A-1058③ mask 的 url() 去掉引号（data URI 含单引号 → 整条声明被 CSS 丢弃 → 实心方块）",
    file: CHAT,
    mutate: (t) => sub(t,
      'WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")`,',
      "WebkitMaskImage: `url(${src})`, maskImage: `url(${src})`,"),
  },
  {
    name: "A-1058③ mask 只去掉一处引号（只改 -webkit- 或只改标准属性都属于「还有一条在生效」的假修复）",
    file: CHAT,
    mutate: (t) => sub(t,
      'WebkitMaskImage: `url("${src}")`',
      "WebkitMaskImage: `url(${src})`"),
  },
  {
    name: "A-1058③ mask 丢掉 -webkit- 前缀（Electron 的 Chromium 上标准属性未必生效）",
    file: CHAT,
    mutate: (t) => sub(t,
      "WebkitMaskSize: \"contain\", maskSize: \"contain\",",
      "maskSize: \"contain\","),
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

const snapshot = () => {
  const m = new Map();
  for (const rel of FILES) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { m.set(p, readFileSync(p)); }
  }
  return m;
};
const restore = (snap) => { for (const [p, buf] of snap) { writeFileSync(p, buf); } };
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);
const treeHash = (snap) => [...snap.entries()].map(([p, b]) => `${p}:${sha(b)}`).join("|");

function main() {
  const snap = snapshot();
  const before = treeHash(snap);
  const missing = FILES.filter((f) => !snap.has(resolve(ROOT, f)));
  if (missing.length) {
    console.error(`[mut-a1056] 快照缺少文件：${missing.join("、")}`);
    process.exit(1);
  }
  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1056] 基线守卫未通过\n" + base.out.slice(-2000));
    process.exit(1);
  }
  console.info(`[mut-a1056] 基线守卫通过（${FILES.length} 个源文件）\n`);

  /* 行尾自检（跑变异之前）。先验**检测器自己**不空转 —— 见 `_mut-eol.mjs`
     `eolProblems` 的第一版：默认读函数取错 + `catch { continue; }` → 对任何输入都返回空数组、
     一律"通过"。恒真的自检比没有自检更危险（它会让人以为这道门已经守住了）。 */
  const probe = selfTestEolDetector(ROOT);
  if (probe.length) {
    console.error("[mut-a1056] 行尾检测器自检失败（检测能力本身坏了）：");
    for (const b of probe) { console.error(`  - ${b}`); }
    process.exit(1);
  }
  if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1056")) { process.exit(1); }
  console.info("[mut-a1056] 行尾检测器自检 + 锚点自检均通过\n");

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = readFileSync(path, "utf8");   // 每轮从**磁盘现值**出发（上轮已字节还原）
    const next = m.mutate(original);
    if (next === original) {
      console.error(`[mut-a1056] ${m.name}\n  ✗ 变异未命中（文本没变）—— 守卫"仍绿"不能说明任何事`);
      survivors.push(`${m.name}（未命中）`);
      continue;
    }
    writeFileSync(path, next, "utf8");
    if (runGuards().ok) {
      console.error(`[mut-a1056] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1056] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);

  const restored = treeHash(snapshot()) === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1056] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  if (!restored) {
    console.error("[mut-a1056] 还原失败 ✗（源文件指纹与快照不一致）");
    process.exit(1);
  }
  console.info(`[mut-a1056] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），源文件字节级已还原 ✓`);
  process.exit(0);
}

main();
