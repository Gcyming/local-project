#!/usr/bin/env node
/**
 * gui/scripts/mut-a1144-sidebar-mount.mjs — A-1144（**右栏挂载**）的变异验证。
 *
 * ## 用户原话
 * 「我想要的是跟挂载文件夹一样，直接实时监测挂载右侧边栏的内容……用户直接提要求的时候 Agent
 *  不需要用户额外说一大段提示词，直接联想到右侧边栏挂载的内容。同时把「交给 slime」按钮直接去掉。」
 *
 * ## 这一组要护的四条线
 *  ① **按会话隔离**：挂载不能变成"上下文层的串台"（A-1142 刚修完显示层的串台）；
 *  ② **只挂内容类页签**：任务 / Git 是内部面板（用户实测吐槽过"待办任务列表怎么也会出现"）；
 *  ③ **两条系统提示路径都注入**：漏一条 = "只有打字机模式看得见右栏"（A-1106 同款事故）；
 *  ④ **链路完整**：渲染层上报 → preload → 主进程存住 → 工具可读。
 *
 * ## 逐条
 *  1  会话不匹配也注入（把串台从显示层搬到上下文层）
 *  2  没给会话号就退化成「全局挂载」
 *  3  空载荷**不清空**（右栏关了，模型还拿着旧内容）
 *  4/5 白名单混进 `tasks` / `git`（内部面板开始被播报）
 *  6  流式路径漏注入
 *  7  两处拼装口径不一致（加第三个来源时只剩一处被改）
 *  8  上报时把 sessionId 写空（主进程按会话匹配 ⇒ 永远匹配不上）
 *  9  没有可挂载内容时报空串而不是 `null`（清不掉旧的）
 * 10/11 preload / 主进程的通道名漂（一边改一边没改）
 * 12  工具权限被升级成 `terminal`（每次读右栏都弹审批）
 * 13  没有挂载时**编造**内容（最坏的一种幻觉）
 *
 * ⚠️ 本组只跑 `tests/gui/a1144-sidebar-mount.spec.ts`（纯函数 + 源码形状 + 工具行为）。
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 `_run-mut-batch.sh` 逐条跑。
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（剥 ANSI 之后）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号 —— 一律「」（本仓已重复踩这个坑）。
 * ⚠️ 本文件必须是 **LF**（`check-mut-anchors.mjs` 按字节切锚点）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1144-sidebar-mount.spec.ts"];

const F_MOUNT = "core-ts/src/sidebarMount.ts";
const F_CHAT = "core-ts/src/services/chat.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_VIEW = "gui/src/renderer/pages/sidebarSearch.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_PRELOAD = "gui/src/preload/index.ts";
const F_MAIN = "gui/src/main/index.ts";

const TARGETS = [F_MOUNT, F_CHAT, F_BUILTIN, F_VIEW, F_PANEL, F_PRELOAD, F_MAIN];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1144");

const MUTATIONS = [
  /* ───── ① 会话隔离 ───── */
  {
    name: "1 mount：会话不匹配也注入（把串台从显示层搬到**上下文层**）",
    file: F_MOUNT,
    mutate: (t) => sub(t, "  if (!sid || sid !== cur.sessionId) { return \"\"; }", "  if (!sid) { return \"\"; }"),
  },
  {
    name: "2 mount：没给会话号就退化成「全局挂载」（隔离被绕开的口子）",
    file: F_MOUNT,
    mutate: (t) => sub(t, "  if (!sid || sid !== cur.sessionId) { return \"\"; }", "  if (sid && sid !== cur.sessionId) { return \"\"; }"),
  },
  {
    name: "3 mount：空载荷**不清空**（右栏关了，模型还一直拿着旧内容）",
    file: F_MOUNT,
    mutate: (t) => sub(t, "    current = null;\n    return;\n  }", "    return;\n  }"),
  },

  /* ───── ② 只挂内容类页签 ───── */
  {
    name: "4 view：白名单混进 `tasks`（用户实测吐槽：待办任务列表怎么也会出现）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'new Set(["browser", "file", "terminal"]);', 'new Set(["browser", "file", "terminal", "tasks"]);'),
  },
  {
    name: "5 view：白名单混进 `git`（内部面板又出现在状态条上）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'new Set(["browser", "file", "terminal"]);', 'new Set(["browser", "file", "terminal", "git"]);'),
  },

  /* ───── ③ 两条系统提示路径 ───── */
  {
    name: "6 chat：**流式路径漏注入**（只有打字机模式看不见右栏，最难复现的那种）",
    file: F_CHAT,
    mutate: (t) => sub(t, "const systemBase = [systemPrompt, teamCtx, mount].filter(Boolean).join(\"\\n\\n\");",
      "const systemBase = [systemPrompt, teamCtx].filter(Boolean).join(\"\\n\\n\");"),
  },
  {
    name: "7 chat：两处拼装口径不一致（回到三元写法 ⇒ 再加来源时必漏一处）",
    file: F_CHAT,
    mutate: (t) => sub(t, "const systemBegin = [systemPrompt, teamCtx, mount].filter(Boolean).join(\"\\n\\n\");",
      "const systemBegin = teamCtx ? systemPrompt + \"\\n\\n\" + teamCtx + \"\\n\\n\" + mount : systemPrompt;"),
  },

  /* ───── ④ 链路 ───── */
  {
    name: "8 panel：上报时把 sessionId 写空（主进程按会话匹配 ⇒ 永远匹配不上）",
    file: F_PANEL,
    mutate: (t) => sub(t, "? { sessionId: sid, text: sideStatus.inject } : null);",
      "? { sessionId: \"\", text: sideStatus.inject } : null);"),
  },
  {
    name: "9 panel：没有可挂载内容时报**空串**而不是 `null`（清不掉上一份）",
    file: F_PANEL,
    mutate: (t) => sub(t, "? { sessionId: sid, text: sideStatus.inject } : null);",
      "? { sessionId: sid, text: sideStatus.inject } : { sessionId: sid, text: \"\" });"),
  },
  {
    name: "10 preload：通道名漂（`mount` → `mnt`，主进程收不到）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, 'ipcRenderer.send("slime:sidebar:mount", payload),',
      'ipcRenderer.send("slime:sidebar:mnt", payload),'),
  },
  {
    name: "11 main：通道名漂（preload 发过来没人接）",
    file: F_MAIN,
    mutate: (t) => sub(t, 'ipcMain.on("slime:sidebar:mount", ', 'ipcMain.on("slime:sidebar:mnt", '),
  },
  {
    name: "12 builtin：`sidebar_mount` 权限被升级成 `terminal`（每次读右栏都要弹审批）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, "    parameters: { type: \"object\", properties: {}, required: [] },\n    executeFn: sidebarMountRead,\n    permissions: [\"read\"],",
      "    parameters: { type: \"object\", properties: {}, required: [] },\n    executeFn: sidebarMountRead,\n    permissions: [\"terminal\"],"),
  },
  {
    name: "13 builtin：没有挂载时**编造**内容（最坏的一种幻觉）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, '      return "[无挂载] 右侧边栏此刻没有可读的内容（或它属于**别的会话** —— 右栏是按会话隔离的）。"',
      '      return "右侧边栏正在显示一个网页。";'),
  },
];

/* ---------------- 以下与 mut-a1141-search-gateway.mjs 同构（同一套校准逻辑） ---------------- */
const arg = process.argv;
const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const p = spawnSync(process.execPath, [
    join(ROOT, "node_modules/.pnpm/vitest@2.1.0_@types+node@24.13.3_supports-color@7.1.0/node_modules/vitest/vitest.mjs"),
    "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot",
  ], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = (p.stdout || "") + (p.stderr || "");
  const spawnBlocked = /EBUSY|EINVAL.*spawn/i.test(out) && /node_modules/.test(out);
  const hasSummary = /Tests\s+\d+\s+(failed|passed)/.test(out.replace(/\u001b\[[0-9;]*m/g, ""));
  return { ok: p.status === 0, out, spawnBlocked, measurementFailed: !hasSummary };
}

const mode = arg.includes("--list") ? "list"
  : arg.includes("--restore") ? "restore"
    : arg.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(arg[arg.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) { console.error("上一轮变异还没还原 —— 先 --restore。"); process.exit(1); }
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
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* ⚠️ 签名是 `installRestoreOnSignal(targets, root)`（传**路径数组**，不是回调）——
   传回调时它内部 `targets.map` 直接抛，而本环境全量模式本来就跑不到那一行 ⇒ 缺陷会一直潜伏。 */
installRestoreOnSignal(TARGETS, ROOT);

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1144")) { process.exit(1); }
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
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { for (const t of TARGETS) { writeFileSync(abs(t), originals.get(t)); } }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
