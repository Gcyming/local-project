/**
 * gui/scripts/_run-mut-one.mjs —— 在**禁止 node→node 孙进程**的环境里，手工跑一条变异的助手。
 *
 * ## 为什么需要它
 * 本仓 `mut-*.mjs` 分两代：
 *   · 新一代（`mut-a1095b/s3/s5/s6/s7`、`mut-a1094`…）自带 `--apply N` / `--restore`（只改文件）；
 *   · 老一代（`mut-a1065` / `mut-a1061-visual` / `mut-a1061-livetool` / `mut-a1028-timeline` /
 *     `mut-a1054` / `mut-a1068` / `mut-a1075-appicon`…）**只有全量模式** ——
 *     一跑就 `spawnSync(process.execPath, …)` 起子进程，本环境 shim 直接 `EBUSY`。
 * ⇒ 老脚本的变异在本环境**根本跑不了**；"锚点核验通过"只覆盖了静态那一半。
 *
 * 本脚本补上运行那一半（**不改任何 mut-\*.mjs**）：
 *   `--apply`   备份目标文件（字节 + sha256）→ 按条目做替换；
 *   `--restore` 从备份还原并校验 sha256。
 *   **本脚本自己不 spawn 任何子进程** —— vitest 由调用方在 **shell 顶层**跑
 *   （从仓库根 `node vitest.mjs run <spec>`），这样才绕开 shim。
 *
 * ## 用法
 *   node gui/scripts/_run-mut-one.mjs <mut脚本> <序号(1基)> --apply
 *   node gui/scripts/_run-mut-one.mjs <mut脚本> <序号(1基)> --restore
 *   node gui/scripts/_run-mut-one.mjs <mut脚本> - --list
 * `--apply` 会打印该条目对应的 spec 列表（供下一步跑）。
 *
 * ## 解析能力（A-1095 #8′ 扩容）
 * 变异条目里"锚点"的写法越来越多样，解析器必须跟得上 —— 否则症状是**该条变异跑不了**
 * （脚本报「解析不了」），而锚点核验那边照样绿 ⇒ 又一条**没人核验**的守卫。
 * 现支持：
 *   · `from:` / `to:` 字段（值 = 字符串字面量 / 全大写常量名 / 两者用 `+` 拼接）；
 *   · `mutate: (t) => sub(t, <表达式>, <表达式>)`（同上，允许**多行**书写与尾逗号）；
 *   · 表达式里夹 `/* … *​/` 或 `//` 注释（实测 `mut-a1065` 的 `BODY` 就夹了一段）；
 *   · `file:` 取常量名或字面量；常量可为 `path.join(ROOT, "a", "b")` 形式。
 * ⚠️ 替换一律用 `_mut-eol.mjs` 的 `sub`（**行尾无关**的唯一实现）；
 *   **未命中与"存活"同等报错** —— 两者都意味着"这条变异没证明任何事"。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [, , mutArg, idxArg, mode] = process.argv;
if (!mutArg || !["--apply", "--restore", "--list"].includes(mode)) {
  /* ⚠️ 用法必须写**准确**：`-` 只对 `--list` 有效；`--restore` 仍要传序号
     （`idx = Number("-") = NaN` ⇒ 在还原分支之前就 `exit 2`）。
     旧文案写成 `<序号|-> --apply|--restore|--list` ⇒ 让人在还原时传 `-` 却**还原不回去**，
     变异留在源码里还没人知道（实测踩过：A-1106 复核 mut-a1061-visual #6）。 */
  console.error("用法: node gui/scripts/_run-mut-one.mjs <mut脚本> <序号> --apply|--restore");
  console.error("      node gui/scripts/_run-mut-one.mjs <mut脚本> - --list   （注意：`-` 只对 --list 有效）");
  process.exit(2);
}
const mutPath = isAbsolute(mutArg) ? mutArg : join(ROOT, mutArg);
if (!existsSync(mutPath)) { console.error(`mut 脚本不存在：${mutPath}`); process.exit(2); }
const mutSrc = readFileSync(mutPath, "utf8");

const STR = String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`;
const unlit = (lit) => { try { return Function(`"use strict"; return (${lit});`)(); } catch { return null; } };

/* ── ⓪ 字符串 / 注释感知的扫描原语 ─────────────────────────────────────────────
   ⚠️ 不能拿正则 `[^;]*` 去切表达式：`const A = "x;y";` 里的 `;` 会**提前收尾**。
   也不能忽略注释：`/* … *​/` 里的引号会破坏"字符串起始"的判断。 ───────────────── */

/** 跳过空白与注释，返回新下标 */
function skipTrivia(s, i) {
  for (;;) {
    const ws = /^[ \t\r\n]+/.exec(s.slice(i));
    if (ws) { i += ws[0].length; continue; }
    if (s.startsWith("/*", i)) { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (s.startsWith("//", i)) { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
    return i;
  }
}

/** 从 `i` 起吃一个字符串/模板字面量，返回结束下标（未闭合则返回 s.length） */
function skipString(s, i) {
  const q = s[i];
  i += 1;
  while (i < s.length) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] === q) { return i + 1; }
    i += 1;
  }
  return i;
}

/** 读**顶层**终止符之前的文本（终止符 ∈ `stops`，字符串/注释/括号内的不算） */
function readUntilTopLevel(s, i, stops) {
  let depth = 0;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(s, i); continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
    if (c === "(" || c === "[" || c === "{") { depth += 1; }
    if (c === ")" || c === "]" || c === "}") { depth -= 1; }
    if (depth === 0 && stops.includes(c)) { return s.slice(start, i); }
    i += 1;
  }
  return s.slice(start);
}

/** 从 `open`（指向 `(`）起，返回括号内文本 与 闭括号下标 */
function readParenInner(s, open) {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(s, i); continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
    if (c === "(") { depth += 1; }
    if (c === ")") { depth -= 1; if (depth === 0) { return { inner: s.slice(open + 1, i), end: i }; } }
    i += 1;
  }
  return { inner: s.slice(open + 1), end: s.length };
}

/** 按**顶层逗号**切分实参表（字符串/注释/括号感知） */
function splitTopLevel(s) {
  const out = [];
  let i = skipTrivia(s, 0);
  let start = i;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(s, i); continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
    if (c === "(" || c === "[" || c === "{") { depth += 1; }
    if (c === ")" || c === "]" || c === "}") { depth -= 1; }
    if (c === "," && depth === 0) { out.push(s.slice(start, i)); i = skipTrivia(s, i + 1); start = i; continue; }
    i += 1;
  }
  if (s.slice(start).trim()) { out.push(s.slice(start)); }
  return out;
}

/* ── ① 常量表 ───────────────────────────────────────────────────────────────
   `const NAME = <表达式>;`
     · 表达式 = 字符串字面量 / 全大写常量名 / 用 `+` 拼接（可夹注释）；
     · 或 `path.join(ROOT, "gui", "src", …)` —— 取其中**所有字符串实参**拼起来。
       ⚠️ 只取第一段会得到缺前缀的假路径（`"gui"`）。 ─────────────────────── */
const ATOM = String.raw`(?:${STR}|[A-Z_][A-Z0-9_]*)`;
const ATOM_RE = new RegExp(ATOM, "y");
const EXPR_RE = new RegExp(`^\\s*${ATOM}(?:\\s*\\+\\s*${ATOM})*\\s*$`);

/** 求值「字符串表达式」：STR / IDENT（查 consts）/ `+` 拼接（可夹注释） */
function evalArgExpr(expr) {
  const cleaned = expr.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  if (!EXPR_RE.test(cleaned)) { return null; }
  const atoms = [...cleaned.matchAll(new RegExp(ATOM, "g"))].map((m) => m[0]);
  const vals = atoms.map((a) => (/^["']/.test(a) ? unlit(a) : consts.get(a)));
  return vals.some((v) => v == null) ? null : vals.join("");
}

const consts = new Map();
/** 从 `i` 起读一个原子的**连续串**（`A + B + C`，可跨行、可夹注释），返回其文本 */
function readExprAtoms(s, i) {
  const atoms = [];
  let j = skipTrivia(s, i);
  for (;;) {
    ATOM_RE.lastIndex = j;
    const t = ATOM_RE.exec(s);
    if (!t) { break; }
    atoms.push(t[0]);
    j = skipTrivia(s, ATOM_RE.lastIndex);
    if (s[j] === "+") { j = skipTrivia(s, j + 1); continue; }
    break;
  }
  return atoms;
}

for (const g of mutSrc.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=/g)) {
  if (consts.has(g[1])) { continue; }
  const eqEnd = g.index + g[0].length;
  /* 先试拼接收敛（`+` 链）；失败再试 join/resolve，最后按顶层 `;` 兜底 */
  const atoms = readExprAtoms(mutSrc, eqEnd);
  if (atoms.length > 0) {
    const vals = atoms.map((a) => (/^["']/.test(a) ? unlit(a) : consts.get(a)));
    if (!vals.some((v) => v == null)) { consts.set(g[1], vals.join("")); continue; }
  }
  const callProbe = mutSrc.slice(eqEnd, eqEnd + 40);
  if (/^\s*(?:path\.)?(?:resolve|join)\s*\(/.test(callProbe)) {
    const open = eqEnd + callProbe.indexOf("(");
    const { inner } = readParenInner(mutSrc, open);
    const parts = [...inner.matchAll(new RegExp(STR, "g"))].map((x) => unlit(x[0])).filter((p) => p != null);
    if (parts.length > 0) { consts.set(g[1], parts.join("/")); }
  }
}
/** 对象的字符串属性（`const OBJ = { KEY: "…" }`，`file: "KEY"` 这种写法靠它解） */
for (const g of mutSrc.matchAll(/const\s+[A-Z_][A-Z0-9_]*\s*=\s*\{([^}]*)\}/g)) {
  for (const kv of g[1].matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*(${STR})`, "g"))) {
    const v = unlit(kv[2]); if (v !== null && !consts.has(kv[1])) { consts.set(kv[1], v); }
  }
}
const resolveFile = (raw) => (raw == null ? null : (consts.get(raw) ?? raw));

/* ── ② 切条目：按**行边界**（2 空格缩进的 `{` / `}`）切，而不是花括号深度扫描。
   ⚠️ 深度扫描会被**正则字面量**里的 `[` `]` 骗到（`/^\[错误\]/` ⇒ 提前收尾，
   `mut-a1068` 实测只切出 7 条、漏掉后面的 A7/A8）。行边界法不受字符串/正则影响：
   本仓 `MUTATIONS`/`variants` 数组的元素一律写成
     `\n  {\n … \n  },\n`（2 空格缩进），条目内部没有 2 空格缩进的 `}`。 ─────────── */
const arrStart = mutSrc.search(/(?:MUTATIONS|RAW_MUTATIONS|variants)\s*=\s*\[/);
if (arrStart < 0) { console.error("找不到 MUTATIONS / variants 数组"); process.exit(2); }
const lines = mutSrc.split("\n");
const arrLine = mutSrc.slice(0, arrStart).split("\n").length - 1;   // 数组声明所在行（0 基）
const blocks = [];
{
  let cur = null;
  for (let li = arrLine; li < lines.length; li++) {
    const L = lines[li];
    if (cur === null) {
      if (/^ {2}\{\s*$/.test(L)) { cur = [L]; }               // 条目开始
      else if (/^\]/.test(L)) { break; }                      // 数组结束
    } else {
      cur.push(L);
      if (/^ {2}\},?\s*$/.test(L)) { blocks.push(cur.join("\n")); cur = null; }
    }
  }
}

const items = blocks.map((body) => {
  const nm = body.match(new RegExp(`name:\\s*(${STR})`));
  const name = nm ? unlit(nm[1]) : "(无名)";
  const fm = body.match(/file:\s*([A-Za-z_$][\w$]*)/) ?? body.match(new RegExp(`file:\\s*(${STR})`));
  const rawFile = fm ? (unlit(fm[1]) ?? fm[1]) : null;
  let from = null, to = null, fn = "sub";

  /* 形态 A：显式 `from:` / `to:` 字段（值止于**顶层逗号**） */
  const atFrom = body.search(/from:\s*/);
  if (atFrom >= 0 && !/mutate:/.test(body.slice(0, atFrom))) {
    const afterFrom = atFrom + body.slice(atFrom).match(/from:\s*/)[0].length;
    from = evalArgExpr(readUntilTopLevel(body, afterFrom, [",", "}"]));
    const atTo = body.search(/to:\s*/);
    if (atTo > 0) {
      const afterTo = atTo + body.slice(atTo).match(/to:\s*/)[0].length;
      to = evalArgExpr(readUntilTopLevel(body, afterTo, [",", "}"]));
    }
  }

  /* 形态 B：`mutate: (t) => sub(t, <表达式>, <表达式>)`（`subAll` 同形，整组替换） */
  if (from == null) {
    const sm = /mutate:\s*\([^)]*\)\s*=>\s*(sub|subAll)\s*\(/.exec(body);
    if (sm) {
      fn = sm[1];
      const open = sm.index + sm[0].length - 1;
      const args = splitTopLevel(readParenInner(body, open).inner);
      if (args.length >= 3) {
        from = evalArgExpr(args[1]);
        to = evalArgExpr(args[2]);
      }
    }
  }
  return { name, file: resolveFile(rawFile), from, to, fn };
});

const idx = Number(idxArg);
if (mode === "--list") {
  console.log(`共 ${items.length} 条：`);
  items.forEach((x, i) => console.log(`  ${i + 1}. [${x.file ?? "?"}] ${x.from == null ? "⚠️解析不了" : "ok"} ${x.name}`));
  process.exit(0);
}
const it = items[idx - 1];
if (!it) { console.error(`序号 ${idx} 超出范围（共 ${items.length} 条：${items.map((x) => x.name.slice(0, 20)).join(" | ")}）`); process.exit(2); }
if (!it.file || it.from == null || it.to == null) { console.error(`第 ${idx} 条写法的解析不受支持：${it.name}`); process.exit(2); }

const target = isAbsolute(it.file) ? it.file : join(ROOT, it.file);
if (!existsSync(target)) { console.error(`目标文件不存在：${target}`); process.exit(2); }
const bak = `${target}.mutbak`;
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (mode === "--apply") {
  if (existsSync(bak)) { console.error(`⚠️ 已存在备份 ${bak} —— 先 --restore 再 --apply（防覆盖）`); process.exit(2); }
  const orig = readFileSync(target);
  const before = orig.toString("utf8");
  const after = (it.fn === "subAll" ? subAll : sub)(before, it.from, it.to);
  /* ⚠️ 未命中**不是**小事：它意味着这条变异一个字都没改 ⇒ "守卫仍绿"看着像守住了。
     与"变异存活"同等报错（A-1095 #8′；旧版只报「替换未生效」，语义上被当成可忽略）。
     ⚠️ 报错必须**带上它在找什么**：不打印锚点原文时，最可能的误诊是"解析器把锚点截短了"
     被读成"源码漂移了"（假警报指向错误对象）。 */
  if (after === before) {
    console.error(`✗ 锚点未命中（这条变异不证明任何事）：${it.name}`);
    console.error(`   file = ${it.file}`);
    console.error(`   from = ${JSON.stringify(it.from.slice(0, 300))}${it.from.length > 300 ? ` …（共 ${it.from.length} 字符）` : ""}`);
    process.exit(2);
  }
  writeFileSync(bak, orig);
  writeFileSync(target, after);
  /* 脚本声明的 spec 列表：`SPECS = [ … ]` / `GUARDS = [ … ]`，或单数 `SPEC = "…"` */
  const specArr = mutSrc.match(/(?:SPECS|GUARDS)\s*=\s*\[([^\]]*)\]/)?.[1];
  const specSrc = specArr ?? (mutSrc.match(/(?:^|\n)const\s+SPEC\s*=\s*([^\n;]+)/)?.[1] ?? "");
  const specs = [...specSrc.matchAll(new RegExp(STR, "g"))].map((x) => unlit(x[0])).filter(Boolean);
  console.log(`APPLIED #${idx} ${it.name}`);
  console.log(`FILE ${it.file}`);
  console.log(`SPECS ${specs.join(" ")}`);
  process.exit(0);
} else {
  if (!existsSync(bak)) { console.error(`没有备份可还原：${bak}`); process.exit(2); }
  const bakBytes = readFileSync(bak);
  writeFileSync(target, bakBytes);
  const h = sha(target);
  const expect = createHash("sha256").update(bakBytes).digest("hex");
  rmSync(bak);
  console.log(`${h === expect ? "✓" : "✗"} 还原 ${it.file}（sha256 ${h === expect ? "一致" : "不一致！"}）`);
  process.exit(h === expect ? 0 : 2);
}
