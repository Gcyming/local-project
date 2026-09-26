#!/usr/bin/env node
/**
 * gui/scripts/mut-a1121.mjs — A-1121（② 右栏 = Agent 的工具栏）的变异验证。
 *
 * 守卫：`tests/core-ts/a1121-sidebar-open.spec.ts`
 * 目标：`core-ts/src/sidebarOpen.ts`（契约/归一唯一出处）· `core-ts/src/tools/builtin.ts`（两个工具）
 *       · `RightSidebar.tsx`（消费者）· `gui/src/main/index.ts`（装配点）
 *
 * 这一条的每条变异都对应**一种"静默"**（吞掉、假装成功、写白名单）：
 *   1/2  不判空放行 → 渲染层静默忽略 = "点了没反应"
 *   3    未知 kind 静默变成别的承载
 *   4    站点限流语义外溢到终端/文件树
 *   5    调用方显式给的名字被兜底参数盖掉
 *   6    空白 cmd 留一个空格给渲染层预填
 *   7    未装配界面也返回 true → 工具回执写"已打开"（假陈述）
 *   8    opener 收到未归一载荷
 *   9    opener 抛异常被当成成功
 *  10    请求不成立也照样调用 opener
 *  11    `hasSidebarOpener` 恒真 → 回执永远走"界面拒绝了"那一支
 *  12    工具声明 terminal 权限 → 打开面板每次弹审批
 *  13    预填参数改名 `cmd` → 撞 `targetFromArgs` 的终端命令字段
 *  14    未装配时终端工具照写"已打开"
 *  15    文件工具不做目录存在性校验 → 开出一个空树
 *  16    文件工具参数改名 `path`（与 rel 口径分家）
 *  17    `http_create_app` 回执照写"已自动打开"
 *  18    渲染层 terminal 分支失配 → 整包转发也白转
 *  19    nonce 不再每次刷新 → 同一条命令连开两次无效
 *  20    预填直接执行 → "打开面板"变成"替用户敲回车"
 *  21    文件树定位先列根再跳 → 闪一下又跳走
 *  22    主进程不归一 → 判据长出第二份口径
 *
 * 用法：`--list` / `--apply N` / `--restore`（本环境禁 node→node 孙进程 ⇒ 全量跑不了，
 * 用 shell 顶层 `--apply N` → vitest → `--restore` 循环；见 memory 的环境节）。
 * ⚠️ 判据 = `exit≠0` **且**输出里真有剥掉 ANSI 的 `Tests` 汇总行。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1121-sidebar-open.spec.ts";
const F_OPEN = "core-ts/src/sidebarOpen.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const F_MAIN = "gui/src/main/index.ts";
const TARGETS = [F_OPEN, F_BUILTIN, F_SIDEBAR, F_MAIN];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1121");

const MUTATIONS = [
  {
    name: "1 字符串分支不判空（url 为空也放行 ⇒ 渲染层静默忽略 = 点了没反应）",
    file: F_OPEN,
    mutate: (t) => sub(t, '    return url ? { kind: "url", url, name: trimOrUndef(name) } : null;',
      '    return { kind: "url", url, name: trimOrUndef(name) };'),
  },
  {
    name: "2 对象 url 分支不判空（同上，第二个产地）",
    file: F_OPEN,
    mutate: (t) => sub(t, '  return url ? { kind: "url", url, name: nm, from: req.from } : null;',
      '  return { kind: "url", url, name: nm, from: req.from };'),
  },
  {
    name: "3 未知 kind 静默变成 terminal（不静默变承载这条判据失效）",
    file: F_OPEN,
    mutate: (t) => sub(t, '    req.kind === "terminal" || req.kind === "files" ? req.kind : "url";',
      '    req.kind === "terminal" || req.kind === "files" ? req.kind : "terminal";'),
  },
  {
    name: "4 terminal 类也保留 from（站点限流语义外溢）",
    file: F_OPEN,
    mutate: (t) => sub(t, "    return { kind, cmd: trimOrUndef(req.cmd), name: nm };",
      "    return { kind, cmd: trimOrUndef(req.cmd), name: nm, from: req.from };"),
  },
  {
    name: "5 name 优先级反转（调用方显式给的名字被兜底参数盖掉）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  const nm = trimOrUndef(req.name) ?? trimOrUndef(name);",
      "  const nm = trimOrUndef(name) ?? trimOrUndef(req.name);"),
  },
  {
    name: "6 cmd 不 trim（留一个空白串让渲染层预填空格）",
    file: F_OPEN,
    mutate: (t) => sub(t, '  const t = typeof v === "string" ? v.trim() : "";',
      '  const t = typeof v === "string" ? v : "";'),
  },
  {
    name: "7 未装配界面也返回 true（工具回执照写「已打开」= 假陈述）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  if (!sidebarOpenerRef) { return false; }",
      "  if (!sidebarOpenerRef) { return true; }"),
  },
  {
    name: "8 fireSidebarOpen 不归一（opener 收到原始入参）",
    file: F_OPEN,
    mutate: (t) => sub(t, "    sidebarOpenerRef(normalized);", "    sidebarOpenerRef(req, name);"),
  },
  {
    name: "9 opener 抛异常被当成成功",
    file: F_OPEN,
    mutate: (t) => sub(t, "  } catch {\n    return false;\n  }", "  } catch {\n    return true;\n  }"),
  },
  {
    name: "10 请求不成立也照样调用 opener（它收到空载荷）",
    file: F_OPEN,
    mutate: (t) => sub(t, "  if (!normalized) { return false; }",
      "  if (!normalized) { sidebarOpenerRef(req as SidebarOpenRequest); return true; }"),
  },
  {
    name: "11 hasSidebarOpener 恒真（回执永远走「界面拒绝了」那一支）",
    file: F_OPEN,
    mutate: (t) => sub(t, "export function hasSidebarOpener(): boolean { return sidebarOpenerRef !== null; }",
      "export function hasSidebarOpener(): boolean { return true; }"),
  },
  {
    name: "12 终端工具声明 terminal 权限（打开面板每次弹审批）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, '    executeFn: sidebarOpenTerminal,\n    permissions: ["read"],',
      '    executeFn: sidebarOpenTerminal,\n    permissions: ["terminal"],'),
  },
  {
    name: "13 预填参数改名 cmd（撞 targetFromArgs 的终端命令字段）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, '        prefill: { type: "string", description: "预填到终端输入框的命令（不会自动执行），可省" },',
      '        cmd: { type: "string", description: "预填到终端输入框的命令（不会自动执行），可省" },'),
  },
  {
    name: "14 未装配时终端工具照写「已打开」（假陈述）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, '    if (!fireSidebarOpen({ kind: "terminal", cmd: prefill, name })) {',
      '    fireSidebarOpen({ kind: "terminal", cmd: prefill, name });\n    if (false) {'),
  },
  {
    name: "15 文件工具不做目录存在性校验（开出一个空树让用户以为这里没文件）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, '        return `[错误] 目录不存在：${root}`;', '        return "";'),
  },
  {
    name: "16 文件工具参数 rel 改名 path（与 file_* 的口径分家）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, '        rel: { type: "string", description: "要在该目录下定位到的条目（相对 root），可省" },',
      '        path: { type: "string", description: "要在该目录下定位到的条目（相对 root），可省" },'),
  },
  {
    name: "17 http_create_app 回执照写「已自动打开」（未装配界面时是假陈述）",
    file: F_BUILTIN,
    mutate: (t) => sub(t,
      '        opened ? `已在右侧栏浏览器自动打开：${localUrl}` : `（界面未就绪，未自动打开；可点上方地址手动打开）`,',
      '        `已在右侧栏浏览器自动打开：${localUrl}`,'),
  },
  {
    name: "18 渲染层 terminal 分支失配（整包转发也白转）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, '      } else if (d.kind === "terminal") {', '      } else if (d.kind === "terminal-x") {'),
  },
  {
    name: "19 nonce 不再每次刷新（同一条命令连开两次无效）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "    const patch = { termCmd: prefill, termNonce: (termOpenSeq += 1), ...(title ? { title } : {}) };",
      "    const patch = { termCmd: prefill, termNonce: termOpenSeq, ...(title ? { title } : {}) };"),
  },
  {
    name: "20 预填直接执行（「打开面板」变成「替用户敲回车」）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "    setInput(cmd);", "    setInput(cmd);\n    void run(cmd);"),
  },
  {
    name: "21 文件树定位先列根再跳（闪一下又跳走）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "      void listDir(browseRoot, want);", '      void listDir(browseRoot, "");'),
  },
  {
    name: "22 主进程不归一（判据长出第二份口径）",
    file: F_MAIN,
    mutate: (t) => sub(t, "    const payload = normalizeSidebarOpenRequest(req, name);",
      '    const payload = (typeof req === "string" ? { kind: "url", url: req, name } : req) as ReturnType<typeof normalizeSidebarOpenRequest>;'),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1121")) { process.exit(1); }
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
