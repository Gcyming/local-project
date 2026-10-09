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
 * ## 委托（A-1197 收尾续，2026-10-08）
 * 本脚本的解析器**刻意不猜**闭包/自定义 helper 形态 —— 但「解析不了」不该等于「没法跑」：
 * 新一代脚本（a1054 / a1064 / a1132 / a1143 / a1145 / a1155…）**自带** `--apply N` / `--restore`
 * （骨架约定：只改文件、不起子进程，在本环境实测可用）。⇒ 解析不了时**委托**给它，
 * 而不是停在「解析不了」。判据与防护见代码里 `delegatable` 处的注释。
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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sub, subAll, subLines, moveAfter, moveBefore } from "./_mut-eol.mjs";

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

/* ── ⓪bis 模板字面量（反引号）—— A-1108 修的解析缺陷就在这里 ───────────────────
   ⚠️ 症状：`from: \`…\`` 的条目**全部**报「解析不了」。原因不是锚点坏了，而是解析器：
     `STR` 只认 `"` / `'`，`ATOM` 是拿 `STR` 拼的 ⇒ 反引号锚点过不了 `EXPR_RE`
     ⇒ `evalArgExpr` 返回 null ⇒ 这些条目**从未被运行验证过**（静态核验照样绿）。
   ⚠️ **不能**直接把反引号塞进 `STR` 就算完事：锚点里的模板**包着目标源码**，所以
     模板内容天然含转义（`` \` `` 表示目标里的反引号、`\${` 表示目标里的 `${`），
     甚至含 `${…}` 真插值（`mut-a1020` 的 `${NEW_HANDLER}`）。
     朴素的 `` `(?:\\.|[^`])*` `` 会在嵌套反引号处**提前收尾**，切出来的锚点又是错的
     —— 症状从「解析不了」变成「锚点未命中」，一样是坏守卫，只是更难查。
   ⇒ 所以走**字符级扫描**（`readTemplateLiteral`），转义与插值分开处理。 ─────────── */

/** 从 `i`（指向开引号）起读一个模板字面量 → { text, end }；未闭合 ⇒ null */
function readTemplateLiteral(s, i) {
  if (s[i] !== "`") { return null; }
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      const e = s[j + 1];
      if (e === "\n") { j += 2; continue; }              // 行继续
      if (e === "\r") { j += (s[j + 2] === "\n" ? 3 : 2); continue; }
      if (e === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(j + 2, j + 4))) {
        out += String.fromCharCode(parseInt(s.slice(j + 2, j + 4), 16)); j += 4; continue;
      }
      if (e === "u") {
        const m = /^\u\{([0-9a-fA-F]+)\}|^\u([0-9a-fA-F]{4})/.exec(s.slice(j + 2, j + 10));
        if (m) { out += String.fromCodePoint(parseInt(m[1] ?? m[2], 16)); j += 2 + m[0].length; continue; }
      }
      if (e === "n") { out += "\n"; j += 2; continue; }
      if (e === "t") { out += "\t"; j += 2; continue; }
      if (e === "r") { out += "\r"; j += 2; continue; }
      if (e === "b") { out += "\b"; j += 2; continue; }
      if (e === "f") { out += "\f"; j += 2; continue; }
      if (e === "v") { out += "\v"; j += 2; continue; }
      if (e === "0") { out += "\0"; j += 2; continue; }
      /* 其余（`` \` ``、`\$`（即 `${`）、`\\`、`\'`、`\"` …）按"去掉反斜杠、留字符"处理，
         这正是我们要的：锚点里 `\`` 表示**目标源码里**的反引号，不是转义。 */
      if (e === undefined) { return null; }
      out += e; j += 2; continue;
    }
    if (c === "`") { return { text: out, end: j + 1 }; }
    if (c === "$" && s[j + 1] === "{") {
      const close = matchBrace(s, j + 1);
      if (close < 0) { return null; }
      const inner = s.slice(j + 2, close);
      const v = resolveInterpolation(inner);
      /* ⚠️ 插值**解不出就保留源码形态**（`${…}` 原样），而不是整条失败。
         锚点要匹配的是**目标文件里的源码**，目标里 `${pt.what}` 就是字面这几个字符；
         只有当插值是**本脚本的常量**（`mut-a1020` 的 `${NEW_HANDLER}`）时，
         目标里才是展开后的文本，才该替换。解不出的当常量看待 = 猜错。 */
      out += v === undefined ? "${" + inner + "}" : v;
      j = close + 1; continue;
    }
    out += c; j += 1;
  }
  return null;                                            // 未闭合
}

/** `s[open]` 应为 `{`，返回配对 `}` 的下标（字符串/模板/注释感知）；找不到 ⇒ -1 */
function matchBrace(s, open) {
  let depth = 0, i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      if (c === "`") { const t = readTemplateLiteral(s, i); i = t ? t.end : s.length; continue; }
      i = skipString(s, i); continue;
    }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
    if (c === "{") { depth += 1; }
    if (c === "}") { depth -= 1; if (depth === 0) { return i; } }
    i += 1;
  }
  return -1;
}

/** 插值取值：先查常量表（`${NEW_HANDLER}` 这种），再退回真求值。
    **解不出时返回 `undefined`（不是 `null`）** —— 语义是「这不是本脚本的常量」，
    调用方据此保留 `${…}` 的**源码形态**（锚点要匹配目标文件里的原文）。 */
function resolveInterpolation(expr) {
  const t = expr.trim();
  if (consts.has(t)) { return consts.get(t); }
  /* `A + B` 形式的插值：逐原子查表（与 evalArgExpr 的 `+` 链同思路） */
  const parts = splitTopLevel(t);
  if (parts.length > 1 && !parts.some((p) => p.trim() === "")) {
    const vals = parts.map((p) => consts.get(p.trim()));
    if (!vals.some((v) => v == null)) { return vals.join(""); }
  }
  try {
    const v = Function(`"use strict"; return (${t});`)();
    return typeof v === "string" ? v : undefined;
  } catch { return undefined; }
}

/** 把一个模板字面量文本转成**锚点源码形态**（即去掉模板包装、处理转义、解插值） */
function templateToSource(lit) {
  const t = lit.trim();
  if (!t.startsWith("`")) { return null; }
  const r = readTemplateLiteral(t, 0);
  return r && r.end === t.length ? r.text : null;
}

/* 简单模板的**正则**形态：内容里**没有未转义的反引号**。
   含嵌套反引号的走 `readTemplateLiteral` 兜底（正则会提前收尾，不能只靠它）。 */
const TMPL = String.raw`\`(?:\\[\s\S]|[^\\\`])*\``;
const LIT = `(?:${STR}|${TMPL})`;

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
const ATOM = String.raw`(?:${LIT}|[A-Z_][A-Z0-9_]*)`;
const ATOM_RE = new RegExp(ATOM, "y");
const EXPR_RE = new RegExp(`^\\s*${ATOM}(?:\\s*\\+\\s*${ATOM})*\\s*$`);

/**
 * 剥掉**字符串字面量之外**的注释（字符串内部原样保留）。
 *
 * ⚠️ 不能用整串 `replace(/\/\*…\*\//g, " ")`：变异锚点常常**故意**把源码里的行内注释
 *   一起抄进来以保证唯一性，例如
 *     `"  justify-content: flex-end;       /* 「最右边」 *​/"`
 *   整串 replace 会把这段注释也抹掉 ⇒ 清洗后的锚点在源码里**永远匹配不上**，
 *   症状是"这条变异跑不了"（而锚点核验、守卫本身都还是绿的）——
 *   mut-a1074-dock 的 B1 / B4 / B22 就这样静默失效过（实测 3 条一起"锚点未命中"）。
 *   ⇒ 只对字符串字面量**之外**的注释做移除，锚点里的注释照原样参与匹配。
 */
function stripCommentsOutsideStrings(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { const e = skipString(s, i); out += s.slice(i, e); i = e; continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); out += " "; i = e < 0 ? s.length : e + 2; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); out += " "; i = e < 0 ? s.length : e; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** 求值「字符串表达式」：STR / 模板 / IDENT（查 consts）/ `+` 拼接（可夹注释）
 *  / `IDENT.replace(<STR>, <STR>)`（受限方法调用，见 `evalReplaceCall`）。 */
function evalArgExpr(expr) {
  const cleaned = stripCommentsOutsideStrings(expr);
  if (!EXPR_RE.test(cleaned)) { return evalReplaceCall(cleaned); }
  const atoms = [...cleaned.matchAll(new RegExp(ATOM, "g"))].map((m) => m[0]);
  /* ⚠️ 反引号原子**不能**走 `unlit`：锚点里的模板包着目标源码，JS 求值会多留一层
     转义（`` \` `` → 目标里的反引号），匹配必然失败 ⇒ 统一走 `templateToSource`。 */
  const vals = atoms.map((a) => (a.startsWith("`") ? templateToSource(a)
    : /^["']/.test(a) ? unlit(a) : consts.get(a)));
  return vals.some((v) => v == null) ? null : vals.join("");
}

/** `IDENT.replace(<字符串字面量>, <字符串字面量>)` —— **受限**表达式（不是通用求值）：
 *  仅这一种方法调用形态，两个实参都必须是字面量。
 *  为什么支持它：`mut-a1019` / `mut-a1024` 的 `to:` 写成 `X.replace(A, B)`
 *  （基于同一常量派生「改一处」的变体）—— 不支持时整条变异报「解析不了」
 *  （2026-10-08 实测 3 条：a1019①、a1024⑨⑩）。
 *  语义与运行期**逐字一致**：运行期也是 JS 的 String.prototype.replace（首个匹配、字面量模式）。
 *  ⚠️ 替换**未生效**（a 在 base 里找不到 / a===b）⇒ 返回 null（落「解析不了」，响亮）——
 *    那种条目 to===from，变异不证明任何事，绝不许静默放行。 */
function evalReplaceCall(cleaned) {
  const m = new RegExp(`^\\s*([A-Z][A-Z0-9_]*)\\.replace\\(\\s*(${STR})\\s*,\\s*(${STR})\\s*\\)\\s*$`).exec(cleaned);
  if (!m) { return null; }
  const base = consts.get(m[1]);
  const a = unlit(m[2]);
  const b = unlit(m[3]);
  if (base == null || a === null || b === null) { return null; }
  const out = base.replace(a, b);
  return out === base ? null : out;
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
    const vals = atoms.map((a) => (a.startsWith("`") ? templateToSource(a)
      : /^["']/.test(a) ? unlit(a) : consts.get(a)));
    if (!vals.some((v) => v == null)) { consts.set(g[1], vals.join("")); continue; }
  }
  const callProbe = mutSrc.slice(eqEnd, eqEnd + 40);
  if (/^\s*(?:path\.)?(?:resolve|join)\s*\(/.test(callProbe)) {
    const open = eqEnd + callProbe.indexOf("(");
    const { inner } = readParenInner(mutSrc, open);
    /* ⚠️ **第一个实参（base）必须一起解析**（`path.join(GUI, "src", …)`，`GUI` 在别处声明）：
       旧版只取「所有**字符串**实参」⇒ 拼出 `src/renderer/index.css` 这种**缺前缀**的路径
       ⇒ apply/restore 报「目标文件不存在」（**假警报指向错误对象**，真因是解析器少解析一层）。
       ——与 `check-mut-anchors.mjs` 的 constMap 是**同源缺陷**；那边 2026-10-08 已修（判据与实现见
       其注释），本脚本漏了。实测 a1019 ① 的 apply 因此报「目标文件不存在：src/renderer/index.css」。
       base 解析不出（非常量 / 未登记）⇒ **不登记**（宁可落「解析不了」，也别给出错的路径）。 */
    const args = splitTopLevel(inner);
    const base = args.length > 0 ? consts.get(args[0].trim()) : undefined;
    const parts = [...inner.matchAll(new RegExp(STR, "g"))].map((x) => unlit(x[0])).filter((p) => p != null);
    if (base !== undefined && parts.length > 0) {
      consts.set(g[1], [base.replace(/[\\/]+$/, ""), ...parts].join("/"));
    }
  }
}
/** 对象的字符串属性（`const OBJ = { KEY: "…" }`，`file: "KEY"` 这种写法靠它解） */
for (const g of mutSrc.matchAll(/const\s+[A-Z_][A-Z0-9_]*\s*=\s*\{([^}]*)\}/g)) {
  for (const kv of g[1].matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*(${STR})`, "g"))) {
    const v = unlit(kv[2]); if (v !== null && !consts.has(kv[1])) { consts.set(kv[1], v); }
  }
}
const resolveFile = (raw) => (raw == null ? null : (consts.get(raw) ?? raw));

/* ── ⓪ter 三类「没有文本锚点」的变异形态（A-1106 #8′ 续，A-1197 收尾）──────────
 *
 *## 为什么要扩这三种（判据：没人核验 = 没有保护）
 * 前一批补了**模板字面量**与「条目切分遇 `]` 就break」，但仍有三类写法解析不了，
 * 症状是脚本报「解析不了」⇒ 这些条目**从未被运行验证过**（静态核验照样绿）：
 *
 *   ① **`ts:` / `js:` 影子文件**（`mut-a1029-diffvis`的 `PLANTS`）
 *      —— 新增**一对**文件（`.ts` + 它的 `.js` 影子），逼a1030 扫描器变红。
 *      本仓只有这一份脚本用它，且它写在**第二个数组** `PLANTS` 里。
 *   ② **二进制字节改写**（`buf:`（`mut-a1075`）/ `corrupt:`（`mut-a1053`））
 *      —— 入参出参都是 `Buffer`，**绝不能**进 `sub`/utf8 往返（会碾碎二进制，
 *         且"改完再还原"的自比对会假绿）。
 *   ③ **文件级三态**：`mode: WHOLE_FILE`（整文件替换）/ `mode: CREATE_FILE`（新建）
 *      / `renameTo`（改名），见 `mut-a1053` 与 `mut-a1042`。
 *
 * ## 为什么这一档风险比上一批高
 * 前两类仍是「改**一个**已存在的文件」，备份 = 一个 `.mutbak` 就够。
 * 第三类是**增/删/改名** ⇒ 「还原」必须是**文件系统级**的：
 *   · 新建的文件：还原 = **删掉它**（它本来不存在）；
 *   · 改名的文件：还原 = **挪回原名**（只挪 manifest 记的那一个，不扫目录 ——
 *     扫目录会误伤既有的 `.bak` 文件，那是 `mut-a1042` 亲自踩过的坑）。
 * ⇒ 所以本脚本的备份从「单个 `.mutbak`」升级成**manifest + 备份目录**，
 *   manifest 逐条记录**路径 + 三态动作 + sha256**，还原时**只动 manifest 里的那些路径**。
 *
 * ##⚠️ 判据：宁可「显式报解析不了」，也不猜
 *   二进制与文件级条目**没有可数的文本锚点**，所以它们**永远**进不了静态核验的分子
 *   （那是核验器的职责边界，不在本脚本）；本脚本负责让它们**能被运行验证**。
 *   凡本脚本认不出的形态，仍旧报「解析不了」——绝不"猜一个大概的改动"，
 *   那是比「解析不了」危险得多的假绿。 */
const WHOLE_FILE = "whole-file";
const CREATE_FILE = "create-file";

/** 条目里的 `mode: WHOLE_FILE` / `mode: CREATE_FILE`（值可能是常量名，`mut-a1053` 就是） */
function readModeOf(body) {
  const m = /^\s*mode:\s*([A-Za-z_$][\w$]*)\s*,?\s*$/m.exec(body) ?? /^\s*mode:\s*"([^"]*)"\s*,?\s*$/m.exec(body);
  if (!m) { return null; }
  const v = m[1];
  if (v === WHOLE_FILE || v === CREATE_FILE) { return v; }
  /* 常量名形态：查它在本脚本里被赋的值（`const WHOLE_FILE = "whole-file"`） */
  const src2 = mutSrc.match(new RegExp(`const\\s+${v}\\s*=\\s*"([^"]*)"`));
  const resolved = src2 ? src2[1] : v;
  return (resolved === WHOLE_FILE || resolved === CREATE_FILE) ? resolved : null;
}

/* ── ② 切条目：按**行边界**（2 空格缩进的 `{` / `}`）切，而不是花括号深度扫描。
   ⚠️ 深度扫描会被**正则字面量**里的 `[` `]` 骗到（`/^\[错误\]/` ⇒ 提前收尾，
   `mut-a1068` 实测只切出 7 条、漏掉后面的 A7/A8）。行边界法不受字符串/正则影响：
   本仓 `MUTATIONS`/`variants` 数组的元素一律写成
     `\n  {\n … \n  },\n`（2 空格缩进），条目内部没有 2 空格缩进的 `}`。 ───────────
 *
 * ⚠️⚠️ **但「条目内部没有 2 空格缩进的 `}`」这条前提会被多行模板打破（2026-10-08 实测）**：
 *   `mut-a1041` 的 M3 把一行源码 `  }` 抄进了模板 —— 裸行边界法把它当成「条目结束」，
 *   条目在**模板中间**被静默截断，from 解析拿到半截模板 ⇒ 报「解析不了」。
 *   （症状极隐蔽：锚点、守卫、静态核验全绿，只有最末端的**运行验证**丢了 ——
 *   又一个「检测器自己空转」的形态。）
 *   ⇒ 切分前先逐行推进一个**模板 / 块注释**的跨行状态；**进入某行时已在字面量内**
 *     的行不参与「条目开始 / 结束」判定。
 * ⚠️ 已知边界（先记下，遇到再补）：`${…}` 内的**嵌套模板**不做递归（本仓现无此写法）；
 *   正则字面量里的 `` ` ``/`"` 可能误开状态（与 `check-mut-anchors.mjs` 的扫描器家族同款
 *   边界）。误判代价 = 某行被跳过（条目数会少）—— 核验器的「序号 ↔ name 一致性」
 *   检查会兜住这类漂移。 */
const arrStart = mutSrc.search(/(?:MUTATIONS|RAW_MUTATIONS|variants)\s*=\s*\[/);
if (arrStart < 0) { console.error("找不到 MUTATIONS / variants 数组"); process.exit(2); }
const lines = mutSrc.split("\n");
const arrLine = mutSrc.slice(0, arrStart).split("\n").length - 1;   // 数组声明所在行（0 基）
/** 扫描第 li 行：返回**进入该行时**是否处于模板/块注释内；同时把跨行状态推进一步。
 *  （从文件第 0 行起逐行调用，状态才正确。） */
const litState = { tpl: false, cmt: false };
function scanLineLit(L) {
  const startsInside = litState.tpl || litState.cmt;
  let i = 0;
  while (i < L.length) {
    const c = L[i];
    if (litState.cmt) {
      const e = L.indexOf("*/", i);
      if (e < 0) { return startsInside; }        // 注释跨到下一行
      litState.cmt = false; i = e + 2; continue;
    }
    if (litState.tpl) {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { litState.tpl = false; i += 1; continue; }
      i += 1; continue;
    }
    if (c === "`") { litState.tpl = true; i += 1; continue; }
    if (c === "/" && L[i + 1] === "*") { litState.cmt = true; i += 2; continue; }
    if (c === "/" && L[i + 1] === "/") { return startsInside; }   // 行注释：后面都是注释
    if (c === '"' || c === "'") { i = skipString(L, i); continue; }
    i += 1;
  }
  return startsInside;
}
/* ⚠️ 一份脚本可能有**多批**条目：`const MUTATIONS = [ … ];` 之后再来
     `MUTATIONS.push(\n  {\n … \n  },\n … \n);`（`mut-a1106` 实测：75 条在数组里、
     76~127 条在紧随其后的 `MUTATIONS.push(...)` 里）。
     原来只在 `]` 处收尾 ⇒ 只会切出前 75 条，后面 52 条**整段静默丢失**
     ⇒ 「序号 99 超出范围（共 75 条）」= 本条目**从未被运行验证过**（静态核验照样绿）。
     ⇒ 现在把扫描范围放宽到**整个文件**，遇到 `]` / `);` 也不 break，只是不再"开新条目"，
        直到 EOF；条目仍按 2 空格 `{` / `},` 形状配对（与原策略一致，不受字符串/正则影响）。 */
const blocks = [];
{
  let cur = null;
  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    const startsInLiteral = scanLineLit(L);     // 先推进状态（全文件都要走一遍）
    if (li < arrLine) { continue; }             // 数组声明之前的行只用于推进状态
    if (startsInLiteral) {
      /* 字面量（模板/块注释）内的行：**不参与**开始/结束判定；cur 开着就收容它。 */
      if (cur !== null) { cur.push(L); }
      continue;
    }
    if (cur === null) {
      if (/^ {2}\{\s*$/.test(L)) { cur = [L]; }               // 条目开始（`]` / `);` 不再收尾）
    } else {
      cur.push(L);
      if (/^ {2}\},?\s*$/.test(L)) { blocks.push(cur.join("\n")); cur = null; }
    }
  }
}

const items = blocks.map((body) => {
  const nm = body.match(new RegExp(`name:\\s*(${LIT})`));
  const name = nm ? (nm[1].startsWith("`") ? templateToSource(nm[1]) : unlit(nm[1])) : "(无名)";
  const fm = body.match(/file:\s*([A-Za-z_$][\w$]*)/) ?? body.match(new RegExp(`file:\\s*(${LIT})`));
  const rawFile = fm ? (unlit(fm[1]) ?? fm[1]) : null;
  let from = null, to = null, fn = "sub";
  /* `subLines` 的两组行（形态 B′）；存在时优先于 `from`/`to` 的合并形态，
     因为 `subLines` 要的是**数组**，合并成字符串会丢掉"逐行书写"这个意图。 */
  let fromLines = null, toLines = null;

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
  /* 形态 B′：`mutate: (t) => subLines(t, [<行>,…], [<行>,…])` —— **数组形态**
     （`mut-a1055` 的 A-1055①/②/④ 那 7 条；上一批只认 `sub` 的三参数形态）。
     静态锚点 = 各行用 `\n` 连接（与 `_mut-eol.mjs` 的 `subLines` 语义一致）。
     ⚠️⚠️ **必须只认「`mutate:` 之后第一个就是 subLines」的那一种**，且
       **不得回写已解析好的 `from`** —— 否则会**制造回归**（2026-10-08 实测踩到）：
       本仓有大量条目长这样
         `from: RELAY_ANCHOR,  mutate: (t) => {…subLines…}`（声明式 from + 闭包里另有subLines）
       或 `mutate: (t) => sub(t, A, A.replace(...))`（锚点里嵌了别的调用）。
       旧实现（无 B′）靠 `sub(t, …)` 的 `sub` 前缀精确匹配，恰好绕开了这些；
       我第一版B′ 只要 body 里出现 `subLines(` 就抢先把 `from` 覆盖成解析结果，
       于是一批本来能解析的条目**反而变成解析不了**（实测 a1064 从 0 掉到 7 条）。
       ⇒ 教训与 `check-mut-anchors.mjs` 的 `fromWhy` 同源：**锚点的位置是有语义的**，
         「body 里出现某个调用」不等于「那个调用就是这条变异的锚点」。
       ⇒ 现在的判据：① 必须**由 `mutate:` 引导**（前面不能有别的 `mutate:` 之前的东西）；
         ② 只在 `from == null` 时才尝试；③ 解析成功才采用，失败就保持 null。 */
  if (from == null) {
    const sl = /mutate:\s*\([^)]*\)\s*=>\s*subLines\s*\(/.exec(body);
    if (sl) {
      const atMutate = body.search(/mutate:/);
      /*「这个 subLines 就是 mutate 引导的第一个调用」—— 否则不抢（见上方注释） */
      if (atMutate >= 0 && sl.index >= atMutate && !body.slice(atMutate, sl.index).includes("=>")) {
        fn = "subLines";
        const open = sl.index + sl[0].length - 1;
        const args = splitTopLevel(readParenInner(body, open).inner);
        const arr = (expr) => {
          const m = /^\s*\[([\s\S]*)\]\s*$/.exec(expr.trim());
          if (!m) { return null; }
          const lits = [...m[1].matchAll(new RegExp(LIT, "g"))].map((x) => (x[0].startsWith("`") ? templateToSource(x[0]) : unlit(x[0])));
          return lits.some((v) => v == null) ? null : lits;
        };
        if (args.length >= 3) {
          const a1 = arr(args[1]), a2 = arr(args[2]);
          if (a1 && a2) { fromLines = a1; toLines = a2; from = a1.join("\n"); to = a2.join("\n"); }
          else { fn = "sub"; fromLines = null; toLines = null; }     // 解析失败 ⇒ 撤回，不留半个结果
        }
      }
    }
  }

  /* 形态 B″：`mutate: (t) => moveAfter(t, <S>, <E>, <M>)` / `moveBefore(…)` —— 三段锚「搬位置」。
     用它的：`mut-a1069` B1、`mut-a1074` B20/B21 —— 这三条另有 `from: 纯核验锚`（声明式，不参与运行期）
     而 to 缺失，所以判据**不能**require `from == null`，改为「**文本替换对 / subLines 对都没解析出来**」。
     ⚠️ 与 B′ 同教训：只认「`mutate:` 之后第一个就是 moveAfter/moveBefore」的形态；
       解析成功**不覆盖**任何既有锚（from 的核验锚保留）。
     ⚠️ 执行用 `_mut-eol.mjs` 的**共享实现**（a1069/a1074 也 import 同一份）——
       **不存在**"助手模拟 vs 脚本执行"的行为分叉（这是本形态敢支持的前提）。 */
  let move = null;
  if ((from == null || to == null) && !(fromLines != null && toLines != null)) {
    const mm = /mutate:\s*\([^)]*\)\s*=>\s*(moveAfter|moveBefore)\s*\(/.exec(body);
    if (mm) {
      const atMutate3 = body.search(/mutate:/);
      if (atMutate3 >= 0 && mm.index >= atMutate3 && !body.slice(atMutate3, mm.index).includes("=>")) {
        const open = mm.index + mm[0].length - 1;
        const args = splitTopLevel(readParenInner(body, open).inner);
        if (args.length >= 4) {
          const s = evalArgExpr(args[1]);
          const e = evalArgExpr(args[2]);
          const m2 = evalArgExpr(args[3]);
          if (s != null && e != null && m2 != null) { move = { kind: mm[1], s, e, m: m2 }; }
        }
      }
    }
  }

  /* ── 以下四类是「**没有文本锚点**」的形态（详见⓪ter 的文档注释）── */
  /* 形态 C：`mode: WHOLE_FILE`（整文件替换）/ `mode: CREATE_FILE`（新建文件）。
     条目里**没有** `from`（它整文件替换/ 新建），故 `from` 保持 null，
     但 `kind` 让本脚本知道该怎么apply 与怎么还原。 */
  const md = readModeOf(body);
  /* 形态 D：`renameTo: "<新名>"`（改名；还原 = 挪回**它自己**那个新名，不扫目录）。 */
  const rt = /^[ \t]*renameTo:[ \t]*/m.exec(body);
  const renameTo = rt ? evalArgExpr(readUntilTopLevel(body, rt.index + rt[0].length, [",", "}"])) : null;
  /* 形态 E：`ts:` / `js:` 影子文件对（新增两个文件；还原 = 删掉它们两个）。 */
  const tsM = /^\s*ts:\s*([^\n]*)/m.exec(body);
  const jsM = /^\s*js:\s*([^\n]*)/m.exec(body);
  const litOf = (m) => {
    if (!m) { return null; }
    const v = m[1].trim().replace(/,\s*$/, "").trim();
    if (/^["'`]/.test(v)) { return unlit(v.startsWith("`") ? JSON.stringify(templateToSource(v) ?? "") : v); }
    return consts.get(v) ?? null;
  };
  const shadow = tsM && jsM ? { ts: litOf(tsM), js: litOf(jsM) } : null;
  /* 影子/新建文件的**内容**：条目里写了 `content:` / `body:` 就用它；
     没写就留 null，由 apply 分支退回该脚本的默认探针（本仓 `mut-a1029` 在主循环里硬编码）。 */
  const contentM = /^[ \t]*(?:content|body|text):[ \t]*/m.exec(body);
  const content = contentM ? evalArgExpr(readUntilTopLevel(body, contentM.index + contentM[0].length, [",", "}"])) : null;
  /* 形态 F：二进制字节改写 —— `buf:`（a1075）/ `corrupt:`（a1053）。
     ⚠️ 这两类**刻意不解析函数体**：它们要的是任意字节级运算
     （`writeUInt16LE(0,2)` / `buf.subarray(0, half)`），不是文本替换。
     本脚本能做的只有「把这段函数体在**本脚本自己的沙箱**里跑起来」——
     那需要把对方的私有 helper（`ICO` 常量等）也搬过来，风险与收益不成比例。
     ⇒ 因此本脚本对二进制条目**显式报「二进制条目：需脚本自带 --apply」**，
     而不是猜。它**不是**「没人核验」的新形态：那些条目在静态核验里本来就是
     「未核验（`mutateBuf`/`corrupt` 没有文本锚点）」，本脚本不假装能测。 */
  const isBinary = /^\s*(buf|corrupt):/m.test(body);

  return {
    name, file: resolveFile(rawFile), from, to, fn, fromLines, toLines,
    mode: md, renameTo, shadow, content, isBinary, move,
    /*「能不能被本脚本运行验证」的判据（--list 打印用）。刻意**不用** `from != null` ——
       文件级三态压根没有 from，却**完全可以**被验证。 */
    runnable: (md === WHOLE_FILE || md === CREATE_FILE || shadow != null || renameTo != null)
      || (from != null && to != null) || (fromLines != null && toLines != null) || move != null,
    kind: md ?? (shadow ? "shadow" : renameTo ? "rename" : isBinary ? "binary" : move ? "move" : "text"),
  };
});

const idx = Number(idxArg);

/* ── 委托探测：目标脚本是否自带 `--apply N` / `--restore`（新一代骨架约定）────────
 * 判据 = 源里**真的在 argv 上派发**这两个开关（`xxx.includes("--apply")` /
 *   `xxx.indexOf("--apply")` 形态）；**仅出现字面量的不算** —— 注释/说明文本里也常
 *   出现「--apply」字样，只看字面量会把委托交给一个根本不认识它的脚本 = 假绿通道。
 * ⚠️ 委托执行 = spawnSync(node, [脚本, "--apply", N]) —— **只此一层**；目标脚本的
 *   `--apply` 只改文件、不起子进程（新一代约定），故不触碰「node→node 孙进程 EBUSY」
 *   那条禁令（本环境一层嵌套实测 OK；真正会 EBUSY 的是老脚本全量模式里的 vitest 子进程）。 */
const ownApply = /\w+\.(?:includes|indexOf)\(\s*["'`]--apply["'`]/.test(mutSrc);
const ownRestore = /\w+\.(?:includes|indexOf)\(\s*["'`]--restore["'`]/.test(mutSrc);
const delegatable = ownApply && ownRestore;

if (mode === "--list") {
  console.log(`共 ${items.length} 条：`);
  /* ⚠️ 状态列刻意分成三档而不是「ok / 解析不了」两档：
     `ok`（可运行验证）/ `ok(形态)`（文件级三态，本脚本能跑）/ `解析不了`。
     两档会把「文件级三态」与「文本替换」混在一起 —— 而它们的还原语义**完全不同**
     （前者要删文件/挪文件），混在一档里就看不出本脚本到底支持了什么。 */
  items.forEach((x, i) => {
    /* 状态列四档：`ok`（本脚本可运行验证）/ `ok(形态)`（文件级，本脚本能跑）/
       `ok(委托…)`（解析不了但脚本自带 --apply —— apply/restore 委托给它）/
       `⚠️…`（真不支持：脚本也没有 --apply，需补齐脚本或整批跑）。 */
    const st = x.runnable
      ? (x.kind === "text" ? "ok" : `ok/${x.kind}`)
      : (delegatable ? "ok(委托脚本自带 --apply)"
        : (x.isBinary ? "⚠️二进制（本脚本与脚本都没有 --apply）" : "⚠️解析不了（脚本也没有 --apply）"));
    console.log(`  ${i + 1}. [${x.file ?? x.shadow?.ts ?? "?"}] ${st} ${x.name}`);
  });
  process.exit(0);
}
const it = items[idx - 1];
if (!it) { console.error(`序号 ${idx} 超出范围（共 ${items.length} 条：${items.map((x) => x.name.slice(0, 20)).join(" | ")}）`); process.exit(2); }
/* ⚠️ 早退只对「**不可委托**的解析不了」：可委托时放行到 apply/restore 分支
   （apply 走委托脚本；restore 走 MANIFEST 里的委托记录 —— 后者**不需要**条目可解析）。 */
if (!it.runnable && !delegatable) {
  console.error(`第 ${idx} 条写法的解析不受支持：${it.name}`);
  if (it.isBinary) {
    console.error("   形态=二进制字节改写（`buf:`/`corrupt:`）—— 本脚本刻意不支持（见源码⓪ter 注释）。");
  }
  process.exit(2);
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const abs = (rel) => (isAbsolute(rel) ? rel : join(ROOT, rel));

/* ── 还原记录：从「单个 `.mutbak`」升级成**manifest + 备份目录**（四态）──
 *
 *## 为什么必须升级（判据：还原比 apply 更容易出人命，且出错是**静默**的）
 * 上一版把备份写成 `${target}.mutbak`：只能表达「**改过**一个文件」。
 * 而本轮要支持的文件级三态里：
 *   · `CREATE_FILE` /影子文件：目标**本来不存在** ⇒ 没有可备份的字节，
 *     还原动作是「**把它删掉**」—— 没有 `.mutbak` 这个概念。
 *   · `renameTo`：原路径**已经不存在**（被挪走了）⇒ `.mutbak` 躺在
 *     「一个已经不在那里的路径」旁边，压根不会被写到。
 * ⇒ 所以还原必须能表达**四个动作**，且**只动manifest 里记的那些路径**：
 *     `rewrite`（改写：还原＝写回备份字节 + 校验 sha256）
 *     `create`（新建：还原＝**删除**该文件 + 确认已不在）
 *     `rename`（改名：还原＝**挪回**记录的**那一个**新名，**不扫目录**）
 *     `unlink` （删除：还原＝写回备份字节）
 *
 * ## ⚠️⚠️ 只动 manifest 记录的那些路径 —— 这是硬约束，不是优化
 *   `rename` 若改成"扫目录找`.bak` 挪回来"，会**误伤用户自己的 `.bak` 文件**
 *   （`mut-a1042` 亲自踩过：它的M7 就是改名变异，注释里明写"不扫目录"）。
 *   同理 `create` 绝不能"清理所有看起来像探针的文件"。
 *   ⇒ 实现里所有还原动作都**逐条读 manifest**，路径**只来自manifest**。
 *
 * ## 为什么备份目录要单独放（而不是散在目标旁边）
 *   文件级变异的备份/清单若散落在源码树里，一旦进程被杀就会**留下垃圾在仓库里**
 *   （本仓铁律：临时文件用完删掉）。集中到一个目录 ⇒ 残留一眼可见、可整体清掉。
 *   ⚠️ 目录名**故意不以 `_tmp-mut-` 开头**：那是 mut脚本自己的约定，
 *     用同一个前缀会让「谁的临时文件」变得不可分辨。 */
const SAVE_DIR = join(ROOT, "gui", "scripts", "_run-one-backup");
const MANIFEST = join(SAVE_DIR, "manifest.json");

/** 从 mut 脚本源里抽它声明的 spec 列表（`SPECS = [ … ]` / `GUARDS = [ … ]`，或单数 `SPEC = "…"`），
 *  供调用方在 shell 顶层跑验证；正常路径与**委托路径**共用同一份判据（防两处漂移）。 */
function specsOf() {
  const specArr = mutSrc.match(/(?:SPECS|GUARDS)\s*=\s*\[([^\]]*)\]/)?.[1];
  const specSrc = specArr ?? (mutSrc.match(/(?:^|\n)const\s+SPEC\s*=\s*([^\n;]+)/)?.[1] ?? "");
  return [...specSrc.matchAll(new RegExp(STR, "g"))].map((x) => unlit(x[0])).filter(Boolean);
}

/** 把一条已解析的条目变成 manifest 的动作记录（apply 时调用）。 */
function planOf(it) {
  if (it.shadow) { return { kind: "create", paths: [it.shadow.ts, it.shadow.js] }; }
  if (it.mode === CREATE_FILE) { return { kind: "create", paths: [it.file] }; }
  if (it.renameTo) { return { kind: "rename", paths: [it.file], renamedTo: it.renameTo }; }
  /* ⚠️ `whole-file` 必须**自成一类**，不能混进 `rewrite`：
     它没有 `from`（`rewrite` 分支要拿 `from` 去`sub`，`from` 为 null 会 TypeError
     —— 实测踩到：`sub()` 收到 null 直接抛 `Cannot read properties of null`，
     整个脚本崩在 apply 中途，而备份目录已建 ⇒ 源码可能停在半改状态）。
     两者的**还原动作相同**（写回备份字节 + 校验 sha256），**apply 动作不同**
     （一个按锚点替换、一个整文件覆盖）。 */
  if (it.mode === WHOLE_FILE) { return { kind: "whole-file", paths: [it.file] }; }
  return { kind: "rewrite", paths: [it.file] };
}

if (mode === "--apply") {
  if (!it.runnable) {
    if (delegatable) {
      /* 解析不了 ⇒ 委托脚本自己的 `--apply N`（新一代骨架：只改文件、不起子进程）。
         先写委托记录（kind: "delegated"），让**无参 --restore** 知道把还原交给谁；
         脚本失败 ⇒ **撤记录**并如实带出退出码 —— 绝不留"假 MANIFEST"，
         否则下次 restore 会对一个从未成功的变异做"还原"，把失败静默成通过。 */
      if (existsSync(MANIFEST)) {
        console.error(`⚠️ 已存在未还原的变异记录 ${MANIFEST} —— 先 --restore 再 --apply（防覆盖）`);
        process.exit(2);
      }
      mkdirSync(SAVE_DIR, { recursive: true });
      writeFileSync(MANIFEST, JSON.stringify({ kind: "delegated", script: mutArg, index: idx, name: it.name }, null, 2));
      const r = spawnSync(process.execPath, [mutPath, "--apply", String(idx)], { cwd: ROOT, stdio: "inherit" });
      if (r.error || r.status !== 0) {
        rmSync(MANIFEST, { force: true });
        console.error(`✗ 委托 ${mutArg} --apply ${idx} 失败（exit=${r.status ?? "-"}${r.error ? `，${r.error}` : ""}）—— 委托记录已撤`);
        process.exit(r.status ?? 2);
      }
      console.log(`DELEGATED #${idx} ${it.name}`);
      console.log(`SCRIPT ${mutArg}`);
      console.log(`SPECS ${specsOf().join(" ")}`);
      process.exit(0);
    }
    console.error(`✗ 第 ${idx} 条写法的解析不受支持：${it.name}`);
    if (it.isBinary) {
      console.error("   形态=二进制字节改写（`buf:`/`corrupt:`）。");
      console.error("   ⇒ 本脚本**刻意不支持**：那需要把对方的字节运算函数在沙箱里跑，");
      console.error("     而它们依赖对方脚本的私有常量（如 `ICO`），风险与收益不成比例。");
      console.error("     这类条目请用该 mut 脚本**自带的** `--apply`（它有 Buffer 快照 + 独立哈希）。");
    }
    process.exit(2);
  }
  if (existsSync(MANIFEST)) {
    console.error(`⚠️ 已存在未还原的变异记录 ${MANIFEST} —— 先 --restore 再 --apply（防覆盖）`);
    process.exit(2);
  }
  const plan = planOf(it);
  /* 动作前置校验：全部检查通过才动手（避免"改了一半才发现前提不成立"） */
  for (const p of plan.paths) {
    const abs_ = abs(p);
    const mustExist = plan.kind !== "create";
    if (mustExist && !existsSync(abs_)) { console.error(`目标文件不存在：${p}`); process.exit(2); }
    /* `create` 的前提是"它**现在**不存在"——若已存在，变异不成立（会造成重复创建/误覆盖）。 */
    if (!mustExist && existsSync(abs_)) { console.error(`${p} 已存在，「新建文件」这条变异不成立（脚本自身前提被破坏）`); process.exit(2); }
  }
  mkdirSync(SAVE_DIR, { recursive: true });

  const rec = { kind: plan.kind, index: idx, name: it.name, entries: [] };
  let after = null;

  if (plan.kind === "whole-file") {
    /* 整文件覆盖：`to` 就是**全部**新内容（无锚点、也不做文本替换）。
       ⚠️ 与 `mut-a1053` 的 `adapt(m.to, eolOf(original))` 对齐：替换体的行尾按**目标文件**
         自己的行尾拼（否则往 CRLF 文件里塞 LF，把源文件改成 MIXED）。 */
    const p = plan.paths[0];
    if (it.to == null) {
      console.error(`✗ 第 ${idx} 条是「整文件替换」但没有 to: 内容：${it.name}`);
      process.exit(2);
    }
    const orig = readFileSync(abs(p));
    const nl = orig.includes("\r\n") ? "\r\n" : "\n";
    after = it.to.split("\n").join(nl);
    if (after === orig.toString("utf8")) {
      console.error(`✗ 整文件替换写回了**完全相同**的内容（这条变异不证明任何事）：${it.name}`);
      process.exit(2);
    }
    writeFileSync(join(SAVE_DIR, "orig.bin"), orig);
    writeFileSync(abs(p), after, "utf8");
    rec.entries = [{ action: "rewrite", path: p, backup: "orig.bin", sha256: createHash("sha256").update(orig).digest("hex") }];
  } else if (plan.kind === "rewrite") {
    const p = plan.paths[0];
    const orig = readFileSync(abs(p));
    const before = orig.toString("utf8");
    if (it.fn === "subLines" && it.fromLines) { after = subLines(before, it.fromLines, it.toLines); }
    else if (it.move) {
      /* 形态 B″（搬位置）：用 `_mut-eol.mjs` 的**共享实现** —— 与脚本自己跑的是同一份函数，
         未命中（返回原文本）由下方统一的 `after === before` 检查抓住（与锚点未命中同罪）。 */
      after = it.move.kind === "moveAfter"
        ? moveAfter(before, it.move.s, it.move.e, it.move.m)
        : moveBefore(before, it.move.s, it.move.e, it.move.m);
    }
    else { after = (it.fn === "subAll" ? subAll : sub)(before, it.from, it.to); }
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
    writeFileSync(join(SAVE_DIR, "orig.bin"), orig);
    writeFileSync(abs(p), after);
    /* 还原校验基准 = **原始**字节的 sha256（不是变异后的） */
    rec.entries = [{ action: "rewrite", path: p, backup: "orig.bin", sha256: createHash("sha256").update(orig).digest("hex") }];
  } else if (plan.kind === "create") {
    /* 影子文件对：两个文件都写**同一段探针内容**（与 `mut-a1029` 的 `PLANTS` 一致：
       `.ts` 与它的 `.js` 影子 —— 正是"编译产物没清掉"这个缺陷本身）。
       ⚠️ 内容取自条目里的 `content:` 字段（`mut-a1029` 没写这个字段，
         它在脚本主循环里硬编码了探针文本），所以这里分两路：
         有 `content:` 就用它；没有就用**与该脚本同形的默认探针**。 */
    const content = it.content ?? it.to ?? "export const probe = 1;\n";
    if (content == null) {
      console.error(`✗ 第 ${idx} 条是「新建文件」但没有内容来源：${it.name}`);
      process.exit(2);
    }
    for (const p of plan.paths) {
      writeFileSync(abs(p), content, "utf8");
      rec.entries.push({ action: "create", path: p });
    }
  } else if (plan.kind === "rename") {
    /* ⚠️ `renameTo` 在脚本里是**追加**在原名之后的（`mut-a1042` 的 `renameSync(p, `${p}.${m.renameTo}`)`），
       所以本脚本按同一条规则拼出新路径 —— 不是"就地改名"。 */
    const from = abs(plan.paths[0]);
    const to = `${from}.${plan.renamedTo}`;
    if (existsSync(to)) { console.error(`改名目标已存在：${plan.renamedTo}`); process.exit(2); }
    const orig = readFileSync(from);
    writeFileSync(join(SAVE_DIR, "orig.bin"), orig);
    renameSync(from, to);
    rec.entries = [{ action: "rename", path: plan.paths[0], renamedTo: `${plan.paths[0]}.${plan.renamedTo}`, backup: "orig.bin", sha256: createHash("sha256").update(orig).digest("hex") }];
  }

  writeFileSync(MANIFEST, JSON.stringify(rec, null, 2));
  const specs = specsOf();
  console.log(`APPLIED #${idx} ${it.name}`);
  console.log(`KIND ${plan.kind}`);
  for (const p of plan.paths) { console.log(`FILE ${p}`); }
  console.log(`SPECS ${specs.join(" ")}`);
  process.exit(0);
} else {
  if (!existsSync(MANIFEST)) { console.error(`没有待还原的变异（${MANIFEST} 不存在）。`); process.exit(2); }
  const rec = JSON.parse(readFileSync(MANIFEST, "utf8"));
  /* 委托记录：还原交给目标脚本自己的 `--restore`（字节级快照 + sha256 校验都是它的）。
     成功才清 MANIFEST；失败保留（可重试），退出码如实带出。 */
  if (rec.kind === "delegated") {
    const targetPath = isAbsolute(rec.script) ? rec.script : join(ROOT, rec.script);
    if (!existsSync(targetPath)) { console.error(`✗ 委托记录的脚本不存在，无法还原：${rec.script}`); process.exit(2); }
    const r = spawnSync(process.execPath, [targetPath, "--restore"], { cwd: ROOT, stdio: "inherit" });
    if (r.error || r.status !== 0) {
      console.error(`✗ 委托还原失败（${rec.script} --restore exit=${r.status ?? "-"}）—— ${MANIFEST} 保留，可重试`);
      process.exit(r.status ?? 2);
    }
    rmSync(SAVE_DIR, { recursive: true, force: true });
    console.log(`✓ 已委托还原：${rec.script}`);
    process.exit(0);
  }
  const problems = [];
  /* ⚠️ 还原按**逆序**执行：多条目时后做的先撤（与文件系统语义一致）。 */
  for (const e of [...rec.entries].reverse()) {
    const p = abs(e.path);
    if (e.action === "create") {
      /* 新建的文件：还原 = 删掉它（它本来不存在）。 */
      if (!existsSync(p)) { problems.push(`create 目标本就不存在，无需删：${e.path}`); continue; }
      rmSync(p);
      if (existsSync(p)) { problems.push(`删不掉（可能被占用/只读）：${e.path}`); }
      continue;
    }
    if (e.action === "rename") {
      const renamed = abs(e.renamedTo);
      if (!existsSync(renamed)) { problems.push(`改名后的文件不在（无法挪回）：${e.renamedTo}`); continue; }
      renameSync(renamed, p);
    }
    /* rewrite / rename 都要写回备份字节并校验。 */
    const bakBytes = readFileSync(join(SAVE_DIR, e.backup));
    writeFileSync(p, bakBytes);
    const now = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (now !== e.sha256) { problems.push(`sha256 不一致：${e.path}`); }
  }
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (problems.length > 0) {
    console.error(`✗ 还原有问题（${problems.length} 项）：`);
    for (const x of problems) { console.error(`   - ${x}`); }
    process.exit(2);
  }
  const paths = rec.entries.map((e) => e.path).join("、");
  console.log(`✓ 已还原（${rec.kind}）：${paths}`);
  process.exit(0);
}
