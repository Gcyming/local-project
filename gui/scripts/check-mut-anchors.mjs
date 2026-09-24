/**
 * gui/scripts/check-mut-anchors.mjs — 变异脚本「锚点命中」的**静态核验**（不跑测试）。
 *
 * ## 为什么需要它
 *
 * 变异套件的一半职能是"锚点在目标文件里命中且**唯一**"。这一半**不需要跑测试**：
 * 静态扫一遍就能查出来。而它正是本仓反复踩的那类事故的探测器 ——
 * 重构改了实现，`mut-*.mjs` 里打旧实现原文的锚点就"未命中"，
 * 那条守卫**从那一刻起失去保护**（报错是响的，但没人跑就等于静默）。
 *
 * 还有一个现实理由：某些运行环境禁止 **node→node 孙进程**
 * （WorkBuddy 的 process shim 对 `spawnSync(process.execPath, …)` 直接 `EBUSY`），
 * 于是 `mut-*.mjs` 一跑就卡在"基线未通过"。此时本脚本是唯一能做的核验。
 *
 * ## 判据
 *
 * 对每条变异取它的 `from` 锚点，在目标文件里数出现次数：
 *   · `1`        → 命中且唯一 ✓
 *   · `0`        → **未命中**（源码漂移了，这条守卫已失效）✗
 *   · `>1`       → **不唯一**（改坏了哪一处无法确定，且可能改错对象）✗
 * 只认 `from:`/`to:` 与 `sub(t, "…", "…")` 两种写法；其余（`moveAfter`/`mutateBuf` 等）如实报"未核验"。
 *
 * ## 例外：`all: true`（整组替换）
 *
 * 闸门本身是**计数闸门**时（例如 A-1061 那条"复位现场必须清掉『执行中』行"数的是
 * `setRunningTool(null);` 的出现次数 ≥3），忠实复现缺陷必须把**每一处**一起改掉，
 * 锚点因此天然命中多次。这时在条目里显式写 `all: true`（配合 `_mut-eol.mjs` 的 `subAll`）：
 *   · 命中 ≥1 → **通过**（不再要求"唯一"）；
 *   · 命中 0  → 仍然**未命中**（锚点漂移，该守卫已失去保护）。
 * 判据仍是这一条：**多处命中只有在作者显式声明"我就是要整组改"时才算合格** ——
 * 不声明就默认"可能改错对象"，因为核验器无法从文本上区分这两者。
 *
 * ⚠️ 本脚本**不改任何文件**，纯只读。
 *
 * 用法：
 *   node gui/scripts/check-mut-anchors.mjs                # 扫全部 mut-*.mjs
 *   node gui/scripts/check-mut-anchors.mjs gui/scripts/mut-a1063-streamerrors.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS_DIR = join(ROOT, "gui", "scripts");

/** 把 JS 字符串字面量（含 `\\n` 等转义）还原成真字符串；解析失败返回 null（**不炸整轮核验**）
 *  ⚠️ 为什么要兜住：本脚本要以"扫全部"运行，任何一条坏数据都不该让整轮核验中断
 *  （2026-09-23 实测：`mut-a1024-config.mjs` 的 `from: "const KEY_RE = ",` 让本函数抛 SyntaxError
 *    ⇒ 全扫在第二个文件就崩，后面所有文件**一条都没核验**，而输出里看不出来）。 */
const unlit = (lit) => {
  try { return Function(`"use strict"; return (${lit});`)(); } catch { return null; }
};

/** 目标常量（`const XXX = "path"`）解析表
 *  ⚠️ 不要求以 `;` 收尾（有的脚本写成 `const X = "p", Y = "q";` 或带尾注释）。
 *  ⚠️ 字面量里**不许出现裸换行**（`[^"\\\n]`）：真正的字面量跨行是语法错误，
 *     能跨行只说明这个 `"` 的配对越界了 —— 于是把**下游几百行**都吞进来当成一个"字面量"。
 *     （2026-09-23 实测：`from: "const KEY_RE = ",` 的内容恰好长得像一条 `const` 声明本身，
 *      越界匹配到下一行 ⇒ `unlit` 抛异常 ⇒ 全扫崩在第二个文件。）
 *  返回 `{ map, bad }`：`bad` 是"看起来像常量声明但字面量解析不了"的常量名（不再静默丢弃）。 */
function constMap(src) {
  const m = new Map();
  const bad = [];
  /* 单引号也算（同 `STR` 的理由）：`const KEY = 'gui/src/…'` 这种写法此前一律解析不到
     ⇒ `file:` 解析成 null ⇒ 整条变异被报成「目标文件写法未识别」，**看似"没法核验"，
     实则"没人核验"**。 */
  /* ⚠️ **末尾的 `(?!\s*\+)` 不能省**：若写成 `const X = "a" + Y（或其他字面量）`，
     这里的正则会把 X 记成**只有第一段** —— 于是引用它的锚点"命中失败"，
     而真因是解析器把锚点截短了（假警报指向错误对象）。拼接形态交给下面那一段解析。 */
  for (const g of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')(?!\s*\+)/g)) {
    if (m.has(g[1])) { continue; }
    const v = unlit(g[2]);
    if (v === null) { bad.push(g[1]); continue; }
    m.set(g[1], v);
  }
  /* ⚠️ **拼接字面量**（2026-09-23 补）：`const A = "x" + Y + "z";` 这种写法此前解析不到
     ⇒ 引用它的 `from: A` 报「锚点写法未识别」⇒ **又是"没人核验"**。
     本仓确有这种形态（`mut-a1026-wincap.mjs` 的 `REQ_CAP_RETRY` 是多行锚点拼出来的）。 */
  for (const g of src.matchAll(new RegExp(`const\\s+([A-Z][A-Z0-9_]*)\\s*=\\s*(${STR}(?:\\s*\\+\\s*${STR})+)`, "g"))) {
    if (m.has(g[1])) { continue; }
    const parts = [...g[2].matchAll(new RegExp(STR, "g"))].map((x) => unlit(x[0]));
    if (parts.length === 0 || parts.some((p) => p === null)) { bad.push(g[1]); continue; }
    m.set(g[1], parts.join(""));
  }
  /* `const X = path.join(BASE, "src", …)` —— 本仓**新一批**脚本的目标文件写法。
     ⚠️ 必须支持（同上一段的理由）：不支持时它们整份脚本的锚点全部落进
     「未核验（目标文件写法未识别）」—— 12 条锚点**一条都没被核验过**，
     而输出看起来只是"这类写法没法核验"，很容易被放过。
     ⚠️ **第一个参数必须一起解析**（`path.join(GUI, "src", …)`，`GUI` 在别处声明）：
     把它当 ROOT 硬拼会得到 `src/renderer/index.css` 这种缺前缀的路径 ⇒
     报「目标文件不存在」——**又一个指向错误对象的假警报**（真因是解析器少解析了一层）。
     解析不出 base（非常量）就**不登记**（宁可未核验，也别给出错的路径）。 */
  for (const g of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:path\.)?join\(\s*([A-Za-z_$][\w$]*)\s*,([^)]*)\)/g)) {
    if (m.has(g[1])) { continue; }
    const base = m.get(g[2]);
    const parts = [...g[3].matchAll(new RegExp(STR, "g"))].map((x) => unlit(x[0]));
    if (base === undefined || parts.length === 0 || parts.some((p) => p === null)) { continue; }
    m.set(g[1], [base.replace(/[\\/]+$/, ""), ...parts].join("/"));
  }
  /* `const FILES = { PROD: "gui/src/…", PANEL: "gui/src/…" }` —— **键名→路径映射表**。
     ⚠️ 必须支持：一批老脚本的写法是 `file: "PROD"`（键名放在字符串里），真值在这张表里。
     不支持时它们全部被误报成「目标文件不存在：PROD」—— 15 条噪声，把真问题淹掉。 */
  for (const g of src.matchAll(/const\s+[A-Z][A-Z0-9_]*\s*=\s*\{([^}]*)\}/g)) {
    for (const kv of g[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g)) {
      if (m.has(kv[1])) { continue; }
      const v = unlit(kv[2]);
      if (v !== null) { m.set(kv[1], v); }
    }
  }
  return { map: m, bad };
}

/* ⚠️ 同上：字面量**不许含裸换行** —— 否则一个未配对的 `"` 会把后面整段源码
   当成一条锚点，症状是"锚点未命中"或"目标文件不存在"这种**指向错误对象**的假警报。
   ⚠️ **单引号也算**（2026-09-23 补）：本仓大量锚点写成 `from: '…'`，只认双引号时它们
   全部落进「未核验」—— 而「未核验」是**没人查**的同义词，等于这几百条锚点的
   "命中且唯一"从来没被核验过（本仓已经吃过一次"锚点静默未命中"的亏）。 */
const STR = String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`;

/** 抽出一条变异的目标文件与 from 锚点（不认识的写法返回 null） */
function anchorOf(entry, consts) {
  const name = /name:\s*("(?:\\.|[^"\\\n])*")/.exec(entry);
  const label = name ? (unlit(name[1]) ?? "(名字面量解析失败)") : "(无名)";
  /* `all: true` = 作者显式声明"整组替换"（计数闸门用的形态，见文件头与 `_mut-eol.mjs` 的 `subAll`）。 */
  const all = /\ball:\s*true\b/.test(entry);
  // 目标文件：`file: XXX` 或 `file: "path"`
  let file = null;
  const fm = /file:\s*([A-Z][A-Z0-9_]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/.exec(entry);
  if (fm) {
    if (fm[1].startsWith('"') || fm[1].startsWith("'")) {
      const lit = unlit(fm[1]);
      /* `file: "PROD"` 把键名放进字符串里，真值在映射表（见 `constMap`）—— 先查表，查不到才当路径。 */
      file = (lit !== null && consts.has(lit)) ? consts.get(lit) : lit;
    } else {
      file = consts.get(fm[1]) ?? null;
    }
  }
  // from 锚点：`from: "…"`（字面量）/ `from: XXX`（常量引用）/ `sub(t, "…", …)` / `subAll(t, "…", …)`
  let from = null;
  const f1 = new RegExp(`from:\\s*(${STR})`).exec(entry);
  if (f1) { from = unlit(f1[1]); }
  else {
    /* ⚠️ **常量引用的 from 必须能解析**（2026-09-23 补）：本仓大量脚本把锚点抽成常量
       （`from: LOCAL_GUARD` / `from: REQ_CAP_RETRY`），只认字面量时它们全部落进
       「锚点写法未识别」—— 于是一份 12 条变异的脚本**0 条被核验**，
       而输出读起来像"这种写法本来就核验不了"。 */
    const f1c = /from:\s*([A-Z][A-Z0-9_]*)/.exec(entry);
    if (f1c && consts.has(f1c[1])) { from = consts.get(f1c[1]); }
    else {
      const f2 = new RegExp(`sub(?:All)?\\(\\s*t\\s*,\\s*(${STR})`).exec(entry);
      if (f2) { from = unlit(f2[1]); }
    }
  }
  if (!file || from === null) {
    const why = !file ? "目标文件写法未识别" : "锚点写法未识别（moveAfter/mutateBuf 等）";
    return { label, unverified: true, why, file, from };
  }
  return { label, file, from, all };
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = argv.length > 0
  ? argv
  : readdirSync(SCRIPTS_DIR).filter((f) => /^mut-.*\.mjs$/.test(f)).map((f) => `gui/scripts/${f}`);

let ok = 0;
let missed = 0;
let ambiguous = 0;
let unverified = 0;
/** 其中有多少条是 `all: true` 的整组替换（用于把"命中且唯一"这个说法说准） */
let allCount = 0;
const fileCache = new Map();
const readTarget = (p) => {
  if (!fileCache.has(p)) {
    /* ⚠️ **绝对路径要能直接用**：`mut-a1019-layout.mjs` 那批脚本把 `path.join(GUI, …)`
       解析成 `D:/pilot project/gui/src/…`；若无脑 `join(ROOT, p)` 会拼出
       `D:/pilot project/D:/…` ⇒ 报「目标文件不存在」（假警报）。 */
    const abs = isAbsolute(p) ? p : join(ROOT, p);
    let v = null;
    /* ⚠️ 必须判"是文件"：目标是目录时 `readFileSync` 抛 EISDIR，会把整轮核验打断。
       （真出现过：某条变异的 `file` 常量解析成了目录。） */
    try { if (existsSync(abs) && statSync(abs).isFile()) { v = readFileSync(abs, "utf8"); } } catch { v = null; }
    fileCache.set(p, v);
  }
  return fileCache.get(p);
};

for (const rel of files) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { console.log(`\n=== ${rel} ===（不存在，跳过）`); continue; }
  const src = readFileSync(abs, "utf8");
  const { map: consts, bad: constBad } = constMap(src);
  // 条目切分：以行首 `{` 起头的一段算一条（够用：这些脚本格式统一）
  const entries = src.split(/\n\s*\{\n/).slice(1);
  const bad = [];
  const skipped = [];
  let n = 0;
  for (const e of entries) {
    const a = anchorOf(e, consts);
    if (a.unverified) { unverified += 1; skipped.push(`· 未核验（${a.why}）：${a.label}`); continue; }
    n += 1;
    const text = readTarget(a.file);
    if (text === null) { bad.push(`目标文件不存在：${a.file}  （${a.label}）`); missed += 1; continue; }
    /* ⚠️ **行尾必须归一**（2026-09-23 补）：本仓检出**行尾是混的**（实测 `providers.ts` 是
       CRLF、`index.ts` 是 LF），而锚点常量里写的是 `\n` —— 不归一时 CRLF 文件上的锚点
       一律报「未命中」，**假警报指向"源码漂移了"这个错误对象**（真因只是行尾）。
       `mut-*.mjs` 运行期本来就按文件行尾替换（`_mut-eol.mjs` / 各脚本的 eol 判定），
       核验器必须与它们同口径，否则两边结论会打架。 */
    const cnt = text.replace(/\r\n/g, "\n").split(a.from.replace(/\r\n/g, "\n")).length - 1;
    /* `all: true`（整组替换）：命中多次是**预期**的（计数闸门必须整组改，见 `anchorOf` 与文件头）。
       但命中 0 仍是未命中 —— 锚点漂移了，那条守卫已失去保护。 */
    if (a.all) {
      if (cnt >= 1) { ok += 1; allCount += 1; }
      else {
        missed += 1;
        bad.push(`未命中（整组替换锚点一处都没匹配上：源码已漂移，该守卫已失效）：${a.label}\n      file=${a.file}\n      from=${JSON.stringify(a.from.slice(0, 100))}`);
      }
      continue;
    }
    if (cnt === 1) { ok += 1; continue; }
    if (cnt === 0) { missed += 1; bad.push(`未命中${" ".repeat(0)}（源码已漂移，该守卫已失效）：${a.label}\n      file=${a.file}\n      from=${JSON.stringify(a.from.slice(0, 100))}`); }
    else { ambiguous += 1; bad.push(`不唯一（命中 ${cnt} 次，无法确定改的是哪一处）：${a.label}\n      file=${a.file}\n      若这条闸门本身就是"计数闸门"（每条变异都要整组改），请在条目里写 all: true`); }
  }
  console.log(`\n=== ${rel} ===  命中可用 ${n - bad.length}/${n}${bad.length ? "" : " ✓"}`);
  for (const b of bad) { console.log(`  ✗ ${b}`); }
  /* ⚠️ 未核验**必须出声**：它不参与 ok/missed 计数，静默跳过等于"这份脚本有 N 条变异
     但没人知道其中几条根本没被核验过" —— 与"变异脚本静默不命中"同族。 */
  for (const s of skipped) { console.log(`  ${s}`); }
  if (constBad.length > 0) {
    console.log(`  ⚠️ 常量字面量解析失败（已跳过，可能影响 file/from 解析）：${constBad.join("、")}`);
  }
}

console.log(`\n合计：命中且唯一 ${ok - allCount} · 整组替换（all: true）${allCount} · 未命中 ${missed} · 不唯一 ${ambiguous} · 未核验（moveAfter 等写法）${unverified}`);
console.log(missed + ambiguous === 0
  ? "✅ 所有可核验锚点都命中且可用"
  : `⚠️ 有 ${missed + ambiguous} 条锚点需要修（未命中=该守卫已失去保护；不唯一=可能改错对象）`);
process.exit(missed + ambiguous === 0 ? 0 : 1);
