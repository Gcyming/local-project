#!/usr/bin/env node
/**
 * gui/scripts/mut-a1045-browser-theme.mjs — A-1045 守卫的变异验证。
 *
 * 守卫"通过"只说明它没报错，不说明它**锁住了正确的对象**。这里把「浏览器面板主题化」的修法
 * 逐条改坏，要求 tests/gui/a1045-guards.spec.ts **必须变红**。改坏方向刻意选成"看起来更直觉"
 * 的形态（把 host 底色写回 #fff、把占位层判据退回 navUrl、让覆盖层吃点击），
 * 因为这些正是下一个人顺手会写回去的样子 —— 且它们**都不报错**，只在真机上表现为"进去就晃眼/点不动"。
 *
 * ⚠️ 全程快照 + 还原：任何时刻中断，源文件内容都必须回到原样（末尾核对哈希）。
 * 用法：node gui/scripts/mut-a1045-browser-theme.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"…pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "tests/gui/a1045-guards.spec.ts";
const SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const CSS = "gui/src/renderer/index.css";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const abs = (rel) => resolve(ROOT, rel);

const MUTATIONS = [
  {
    name: "M1 webview host 底色写回硬编码 #fff（guest 未绘制的那一帧又露白）",
    file: SIDEBAR,
    from: `style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "var(--bg)" }}`,
    to: `style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "#fff" }}`,
  },
  {
    name: "M2 容器退回内联布局（丢掉 .browser-stage，主题底色随之消失）",
    file: SIDEBAR,
    from: `<div className="browser-stage">`,
    to: `<div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>`,
  },
  {
    name: "M3 占位页判据退回 `!active && !navUrl`（加载窗口期又露白 = 本次病灶）",
    file: SIDEBAR,
    from: `        {!active && !failInfo && (
          <div className="browser-blank">`,
    to: `        {!active && !navUrl && !failInfo && (
          <div className="browser-blank">`,
  },
  {
    name: "M4 去掉占位页（回到「纯白晃眼」的原始状态）",
    file: SIDEBAR,
    from: `          <div className="browser-blank">
            <div className="browser-blank-mark"><GlobeIcon size={34} /></div>`,
    to: `          <div>
            <div className="browser-blank-mark"><GlobeIcon size={34} /></div>`,
  },
  {
    name: "M5 `.browser-stage` 底色写回 #fff（宿主层露白）",
    file: CSS,
    from: `.browser-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}`,
    to: `.browser-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  background: #fff;
}`,
  },
  {
    name: "M6 占位页底色改为透明（盖不住 guest 的白色基底 = 修了等于没修）",
    file: CSS,
    from: `  text-align: center;
  background: var(--bg);
  pointer-events: none; /* ① 绝不吞 Agent 的点击 */`,
    to: `  text-align: center;
  background: transparent;
  pointer-events: none; /* ① 绝不吞 Agent 的点击 */`,
  },
  {
    name: "M7 占位页吃掉点击（A-976 前科：Agent 点不动页面）",
    file: CSS,
    from: `  pointer-events: none; /* ① 绝不吞 Agent 的点击 */`,
    to: `  pointer-events: auto; /* ① 绝不吞 Agent 的点击 */`,
  },
  {
    name: "M8 占位页层级抬到错误页之上（加载失败时被白色占位页盖住）",
    file: CSS,
    from: `.browser-blank {
  position: absolute;
  inset: 0;
  z-index: 6;`,
    to: `.browser-blank {
  position: absolute;
  inset: 0;
  z-index: 9;`,
  },
  {
    name: "M9 占位页改成 JSX 内联定位（静态守卫 ⑬ 的射程：收起即卸载的残留浮层）",
    file: SIDEBAR,
    from: `          <div className="browser-blank">`,
    to: `          <div className="browser-blank" style={{ position: "absolute", inset: 0 }}>`,
  },
  {
    name: "M10 地址栏退回 `.term-input` 的近黑底（与主题脱节的黑洞）",
    file: CSS,
    from: `.browser-url {
  flex: 1;
  background: var(--bg-input);
  border-color: var(--border);
  color: var(--text);
}`,
    to: `.browser-url {
  flex: 1;
  background: #111;
  border-color: #333;
  color: #e5e5e5;
}`,
  },
  {
    name: "M11 地址栏聚焦描边写死字面色（不随主题）",
    file: CSS,
    from: `.browser-url:focus { border-color: var(--accent); }`,
    to: `.browser-url:focus { border-color: #3b82f6; }`,
  },
];

function runGuard() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", GUARD, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function snapshot(files) {
  const out = new Map();
  for (const rel of files) {
    const p = abs(rel);
    if (existsSync(p)) { out.set(p, readFileSync(p, "utf8")); }
  }
  return out;
}

function restore(snap) {
  for (const [p, text] of snap) { writeFileSync(p, text); }
}

function main() {
  const files = [SIDEBAR, CSS];
  const snap = snapshot(files);
  if (snap.size !== files.length) {
    console.error(`[mut-a1045] 快照不全（${snap.size}/${files.length}），先确认路径`);
    process.exit(1);
  }
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");

  const base = runGuard();
  if (!base.ok) {
    console.error("[mut-a1045] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info(`[mut-a1045] 基线守卫通过（快照 ${snap.size} 个文件）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const original = snap.get(path);
    if (original === undefined) {
      console.error(`[mut-a1045] ${m.name}\n  ✗ 快照里没有 ${m.file}`);
      survivors.push(m.name);
      continue;
    }
    const next = original.includes(m.from) ? original.replace(m.from, m.to) : null;
    if (next === null) {
      console.error(`[mut-a1045] ${m.name}\n  ✗ 锚点未命中`);
      survivors.push(m.name);
      continue;
    }
    if (next === original) {
      console.error(`[mut-a1045] ${m.name}\n  ✗ 变异无效果（改了等于没改）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, next);

    const r = runGuard();
    if (r.ok) {
      console.error(`[mut-a1045] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1045] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }

  restore(snap);
  const after = snapshot(files);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before
    && after.size === snap.size;

  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1045] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1045] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "源文件还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
