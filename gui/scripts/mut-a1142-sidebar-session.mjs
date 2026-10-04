#!/usr/bin/env node
/**
 * gui/scripts/mut-a1142-sidebar-session.mjs — A-1142（**右栏视图的会话隔离**）的变异验证。
 *
 * ## 用户实测到的缺陷
 * 「在另一个会话的 Agent 那派发了任务，后来换了个会话页，结果上一个 Agent 创建的右侧边栏
 *  直接创建在我这个会话的右侧边栏了。」
 *
 * ## 为什么必须靠变异来锁
 * 这类缺陷**没有一个报错点**：右栏视图是全局单例（一份 `tabs`），Agent 是异步的，
 * 于是"A 的请求落在 B 的界面上"在构建期、类型检查、甚至功能测试里都**全是绿的**。
 * ⇒ 只能靠"把每一条隔离线**故意拆掉**，看守卫红不红"来证明它真的被锁住。
 *
 * ## 本组要护的六条线
 *   1-3  判据 `sidebarOpenMatchesSession` 的三个边界（当前无会话 / 请求没带 / 严格相等）
 *   4    会话号的取法 `sessionIdFromArgs`（唯一产地；恒 undefined ⇒ 全链路没有归属可判）
 *   5-7  归一：url / terminal / files 三类**各自**都要透传（漏一个 kind = 那一类页永远串台）
 *   8-10 三个会开右栏的工具都必须把 `sessionId` 传下去
 *  11-17 渲染层：判据真的被调用、读的是 ref 不是过期闭包、不匹配的进暂存、切回时补投、
 *        补投必须异步（同步 ⇒ 复用到上一个会话的页签）、归属从请求上取
 *  18    契约字段本身（`SidebarOpenRequest.sessionId`）不许改名/消失
 *
 * ⚠️ 本组只跑 `tests/gui/a1142-sidebar-session.spec.ts`（纯函数 + 源码形状）。
 *    ⚠️ 渲染层不做判据：这里**不渲染组件**，断言的是"那条线还在"，不是像素。
 *
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
const SPECS = ["tests/gui/a1142-sidebar-session.spec.ts"];

const F_OPEN = "core-ts/src/sidebarOpen.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";

const TARGETS = [F_OPEN, F_BUILTIN, F_SIDEBAR];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1142");

const MUTATIONS = [
  /* ───── ① 判据的三个边界（错任何一个都会开一个串台的口子）───── */
  {
    name: "1 sidebarOpen：当前**没有**会话号时放行带归属的请求（最典型的那个口子）",
    file: F_OPEN,
    /* 反面写法的精髓：看着只是少了一个分支，实际是"界面还不知道自己在哪个会话时照单全收"。 */
    mutate: (t) => sub(t, "  if (!c) { return false; }", "  if (!c) { return true; }"),
  },
  {
    name: "2 sidebarOpen：请求没带会话号时**拒收**（旧调用点 / 站点弹窗全被挡在门外）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  if (!r) { return true; }", "  if (!r) { return false; }"),
  },
  {
    name: "3 sidebarOpen：判据恒真（**完全没有隔离**，用户实测的那个 bug 原样复现）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  return r === c;", "  return true;"),
  },

  /* ───── ② 会话号的取法（唯一产地）───── */
  {
    name: "4 sidebarOpen：`sessionIdFromArgs` 恒回 undefined（全链路根本没有归属可判）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  return s.length > 0 ? s : undefined;", "  return undefined;"),
  },

  /* ───── ③ 归一：三类请求各透传一次（漏一个 kind 只坏那一类）───── */
  {
    name: "5 sidebarOpen：terminal 类请求丢掉 `sessionId`（只有终端页会串台）",
    file: F_OPEN,
    mutate: (t) => sub(t, "    return { kind, cmd: trimOrUndef(req.cmd), name: nm, sessionId: sid };",
      "    return { kind, cmd: trimOrUndef(req.cmd), name: nm };"),
  },
  {
    name: "6 sidebarOpen：files 类请求丢掉 `sessionId`（只有文件页会串台）",
    file: F_OPEN,
    mutate: (t) => sub(t, "    return { kind, root: trimOrUndef(req.root), rel: trimOrUndef(req.rel), name: nm, sessionId: sid };",
      "    return { kind, root: trimOrUndef(req.root), rel: trimOrUndef(req.rel), name: nm };"),
  },
  {
    name: "7 sidebarOpen：url 类请求丢掉 `sessionId`（浏览器页 / http_create_app 会串台）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  return url ? { kind: \"url\", url, name: nm, from: req.from, sessionId: sid } : null;",
      "  return url ? { kind: \"url\", url, name: nm, from: req.from } : null;"),
  },

  /* ───── ④ 三个工具都必须把归属传下去 ───── */
  {
    name: "8 builtin：`sidebar_open_terminal` 不传 `sessionId`",
    file: F_BUILTIN,
    mutate: (t) => sub(t,
      "fireSidebarOpen({ kind: \"terminal\", cmd: prefill, name, sessionId: sessionIdFromArgs(args) })",
      "fireSidebarOpen({ kind: \"terminal\", cmd: prefill, name })"),
  },
  {
    name: "9 builtin：`sidebar_open_files` 不传 `sessionId`",
    file: F_BUILTIN,
    mutate: (t) => sub(t,
      "fireSidebarOpen({ kind: \"files\", root, rel, sessionId: sessionIdFromArgs(args) })",
      "fireSidebarOpen({ kind: \"files\", root, rel })"),
  },
  {
    name: "10 builtin：`http_create_app` 不传 `sessionId`（生成的网页应用开到别人的会话上）",
    file: F_BUILTIN,
    mutate: (t) => sub(t,
      "fireSidebarOpen({ kind: \"url\", url: localUrl, name: title, sessionId: sessionIdFromArgs(args) })",
      "fireSidebarOpen({ kind: \"url\", url: localUrl, name: title })"),
  },

  /* ───── ⑤ 渲染层：判据真的被调用 ───── */
  {
    name: "11 RightSidebar：归属校验整段删掉（请求一律就地打开 ⇒ bug 原样复现）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "      if (!sidebarOpenMatchesSession(owner, sessionIdRef.current)) {", "      if (false) {"),
  },
  {
    name: "12 RightSidebar：归属判断读的是**闭包里**的 `props.sessionId`（effect 依赖是 [] ⇒ 永远停在挂载那一刻）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "sidebarOpenMatchesSession(owner, sessionIdRef.current)",
      "sidebarOpenMatchesSession(owner, props.sessionId)"),
  },
  {
    name: "13 RightSidebar：不匹配的请求**直接丢弃**（不暂存 ⇒ 工具回执说已打开、用户永远看不到）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "        q.push(p);", "        /* 变异：丢弃 */"),
  },
  {
    name: "14 RightSidebar：切回会话时**不补投**暂存的请求（页永远开不出来）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "      const pend = pendingOpenRef.current[sid] ?? [];",
      "      const pend: SidebarOpenPayload[] = [];"),
  },
  {
    name: "15 RightSidebar：补投写成**同步**（接住事件的是上一次渲染的监听器 ⇒ 复用到上一个会话的页签）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t,
      "        setTimeout(() => {\n          for (const p of pend) {\n            requestSidebarOpen({ ...p, from: p.from === \"site\" ? \"site\" : \"user\" });\n          }\n        }, 0);",
      "        for (const p of pend) {\n          requestSidebarOpen({ ...p, from: p.from === \"site\" ? \"site\" : \"user\" });\n        }"),
  },
  {
    name: "16 RightSidebar：`sessionIdRef` 只在挂载时赋值一次（渲染期不再刷新 ⇒ ref 与闭包同样过期）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "  sessionIdRef.current = props.sessionId ?? \"\";", "  /* 变异：不刷新 ref */"),
  },
  {
    name: "17 RightSidebar：归属写死成空（不看请求 ⇒ 判据恒真，等于没有隔离）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "      const owner = p.sessionId ?? \"\";", "      const owner = \"\";"),
  },

  /* ───── ⑥ 契约字段本身 ───── */
  {
    name: "18 sidebarOpen：契约字段改名（`sessionId` → `session` ⇒ 工具层与渲染层的读写全部悬空）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  sessionId?: string;", "  session?: string;"),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1142")) { process.exit(1); }
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
