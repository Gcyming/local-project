#!/usr/bin/env node
/**
 * gui/scripts/mut-a1120.mjs — A-1120（① 产物按类型分流）的变异验证。
 *
 * 守卫：`tests/gui/a1120-web-preview.spec.ts`
 * 目标：`gui/src/renderer/pages/webPreview.ts`（纯判据）+ `RightSidebar.tsx`（接线）
 *
 * 每条变异都对应**一种真实故障形态**，不是随便改坏：
 *   1  `.xhtml` 收进可预览表 —— 静态服务没它的 MIME ⇒ 交给浏览器 = 弹下载框
 *   2  `shouldRenderAsWeb` 只看 rel —— name 带扩展名的那一半产物点开不渲染
 *   3  整串 encodeURIComponent —— `/` 被编码，多文件产物必然 404
 *   4  基址不再优先回环 —— 0.0.0.0 模式下可能拿到 172.x 虚拟网卡
 *   5  `splitPath` 不再保住根分隔符 —— serve 到"当前盘工作目录"
 *   6  `extOf` 不大写归一 —— Windows 上写的 `.HTML` 不渲染
 *   7  基址不去末尾斜杠 —— 拼出 `//a.html`
 *   8  地址拼装任一块缺失也硬拼 —— 调用方失去"降级信号"
 *   9  `cleanTargetPath` 不剥「:行:列」 —— `a.html:12:3` 被当成文件名
 *  10  文件分支不再分流 —— `.html` 产物落回声源页（= 功能没做）
 *  11  降级路径不带说明 —— 静默退回源码页，用户以为功能没做
 *  12  自己拼绝对路径（不用唯一权威解析器 openTarget）
 *  13  链接支内联一份"复用谁" —— 两套判据并存
 *  14  `fileNotice` 不渲染 —— 说明挂在数据里、用户看不到
 *  15  `serve` 调用形态被改（承载口径与静态服务分家）
 *  16  主进程事件转发写成 url 白名单 —— 新增 kind 在这一跳被静默丢掉
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
const SPEC = "tests/gui/a1120-web-preview.spec.ts";
const F_PREVIEW = "gui/src/renderer/pages/webPreview.ts";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const TARGETS = [F_PREVIEW, F_SIDEBAR];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1120");

const MUTATIONS = [
  {
    name: "1 可预览扩展名收进 .xhtml（静态服务没有它的 MIME ⇒ 弹下载框）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, 'export const WEB_PREVIEW_EXTS: readonly string[] = [".html", ".htm"];',
      'export const WEB_PREVIEW_EXTS: readonly string[] = [".html", ".htm", ".xhtml"];'),
  },
  {
    name: "2 shouldRenderAsWeb 只看 rel（name 带扩展名的那一半产物点开不渲染）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, 'return isWebPreviewPath(rel) || isWebPreviewPath(name ?? "");',
      'return isWebPreviewPath(rel);'),
  },
  {
    name: "3 encodeUrlPath 整串编码（`/` 被编码 ⇒ 目录型产物必然 404）",
    file: F_PREVIEW,
    mutate: (t) => sub(t,
      '  return (raw ?? "")\n    .split(/[\\\\/]+/)\n    .filter((s) => s.length > 0)\n    .map((s) => encodeURIComponent(s))\n    .join("/");',
      '  return encodeURIComponent((raw ?? "").trim());'),
  },
  {
    name: "4 基址不再优先回环（0.0.0.0 模式下可能拿到 172.x 虚拟网卡）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, "const base = loopback ?? list[0] ?? \"\";",
      "const base = list[0] ?? loopback ?? \"\";"),
  },
  {
    name: "5 splitPath 不再保住根分隔符（`/a.html` 的 dir 变空串 ⇒ serve 到别处）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, " ? upto : upto.slice(0, -1);", " ? upto.slice(0, -1) : upto;"),
  },
  {
    name: "6 extOf 不大写归一（Windows 上写的 `.HTML` 不渲染）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, 'return i > 0 ? name.slice(i).toLowerCase() : "";',
      'return i > 0 ? name.slice(i) : "";'),
  },
  {
    name: "7 基址不去末尾斜杠（拼出 `http://x:1//a.html`）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, 'return base.replace(/\\/+$/, "");', "return base;"),
  },
  {
    name: "8 地址拼装任一块缺失也硬拼（调用方失去「降级信号」）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, 'if (!base || !path) { return ""; }', 'if (!base && !path) { return ""; }'),
  },
  {
    name: "9 cleanTargetPath 不剥「:行:列」（`a.html:12:3` 被当成文件名）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, 'return s.replace(/:\\d+(?::\\d+)?$/, "");', "return s;"),
  },
  {
    name: "10 文件分支不再分流（`.html` 产物落回源码页 = 功能没做）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t,
      '        if (shouldRenderAsWeb(d.rel, d.name)) { openWebPreview(d.rel, d.name); }\n        else { openFileAbs(d.rel, d.name); }',
      "        openFileAbs(d.rel, d.name);"),
  },
  {
    name: "11 降级路径不带说明（静默退回源码页，用户以为功能没做）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t,
      '        openFileAbs(rel, name, "这是网页产物，没能确定它所在的目录（无法起本地服务）。");',
      "        openFileAbs(rel, name);"),
  },
  {
    name: "12 不用唯一权威解析器 openTarget（自己拼绝对路径必然踩空）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "      const resolved = await api?.workspace?.openTarget?.(rel, {",
      "      const resolved = await api?.workspace?.readFileAbs?.(rel, {"),
  },
  {
    name: "13 链接支内联一份「复用谁」（两套判据并存 ⇒ 同址被两个页签挂着）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "        openBrowserTab(url, pageTitle());",
      '        const browsers = tabs.filter((t) => t.type === "browser");\n'
      + "        const sameUrl = browsers.find((t) => t.url === url);\n"
      + "        if (sameUrl) { setActiveId(sameUrl.id); return; }\n"
      + "        openBrowserTab(url, pageTitle());"),
  },
  {
    name: "14 fileNotice 不渲染（降级说明挂在数据里、用户看不到）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "          {props.tab.fileNotice && (", "          {props.tab.fileError && ("),
  },
  {
    name: "15 serve 调用形态被改（承载口径与静态服务分家）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "api?.http?.serve?.({ dir })", 'api?.http?.serve?.({ dir, spa: false })'),
  },
  {
    name: "16 主进程事件转发写成 url 白名单（terminal/files 在这一跳被静默丢掉）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t,
      '      requestSidebarOpen({\n        ...p,\n        from: p.from === "site" ? "site" : "user",\n      });',
      '      requestSidebarOpen({\n        kind: "url", url: p.url, name: p.name,\n        from: p.from === "site" ? "site" : "user",\n      });'),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1120")) { process.exit(1); }
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
