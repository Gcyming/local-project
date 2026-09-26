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
 * ## 第二类核验：「序号 ↔ `name` 前缀」（A-1117 补）
 *
 * 变异脚本里 `--apply N` 是按**位置**取的，而文档/汇报里引用一条变异一律用 `name` 的**序号**。
 * 两者错位时：`--apply N` 跑的是别的条目，而"测试真的红了" ⇒ 结论"N 被捕获"是**假绿**
 * （实测过一次：`mut-a1106.mjs` 有 5 条被插在数组中间，`--apply 96` 变异的是名叫 91 的那条）。
 * ⇒ 每份脚本都核验：**第 k 个带纯数字编号的条目，编号必须是 k**。
 * ⚠️ 子编号（`18b`/`18c`）与字母/圈号（`A1`/`①`）**只计数、不判等** —— 它们是刻意的结构；
 * 按"编号 == 位置"判会一次报 20 项，报警长红 = 没人看（正是本文件反复警告的那种噪音）。
 * ⚠️ 判据不许放宽成"只比前缀"或"猜一个期望值"，那会造出比"未核验"更危险的假绿。
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
 * ## 「未核验」的底线与**分界线**（2026-09-24 大扫）
 *
 * ⚠️ 判据是「**未核验 = 没人核验 = 没有保护**」。所以"核验不了"和"我没写解析"必须分清：
 * 前者只能换手段（例如按变异**真跑**一遍 = `mut-*.mjs` 自己做的事），后者是本脚本该补的能力。
 * 本轮把长期停在 **226** 的未核验压到 **62**，手段全部是"补齐解析能力"而**不是**放宽判据：
 *   · 单引号 / **反引号模板字面量**（含真换行，拒绝 `${…}` 插值）—— 锚点写法
 *   · **拼接字面量**（`"a" + CONST + "c"`，注释感知 + 截断即拒）—— 绝不给前缀假值
 *   · `sub(t, CONST, …)` / `subLines(t, [...], …)` 的常量与数组形态
 *   · **脚本级唯一写入目标**（`writeFileSync` 只指向一个文件时可证 ⇒ 补 `file:`）
 *   · `file:` 支持模板字面量
 * 顺带**修出的真缺陷**（都曾被"未核验"掩盖，即§8.5 的"没人核验 = 没有保护"实证）：
 *   · `mut-a1090` 第 23 条：`from` 被注释里的 `` `sub(t,` `` 吞掉（扩能时**自己引入的回归**，
 *     靠 `maskComments` 根除）；`mut-a1047` M6、`mut-a1026` ③/④ 同类
 *   · `mut-a1040` M4/M8、`mut-a1046` M1、`mut-a1055` ②：锚点**不唯一**（真歧义，已收窄）
 *   · `mut-a1048` M3：锚点**随源码漂移**（`ResidentState` 加了 `defaultModels`）⇒ 守卫早已失去保护
 *   · `mut-a1040`：脚本**自身是 CRLF**，跨行锚点的换行是 `\r\n`，只对"目标也是 CRLF"成立 ⇒
 *     改接 `_mut-eol.mjs` 的 `sub`（行尾无关），该条从 12/13 恢复到 **13/13**
 *
 * 剩下的 62 条**已按具名理由分类打印**（分母必须能被解释，否则它只是被习惯性忽略的数字）。
 * 它们**不是"写法没支持"**，而是**本质上无法从文本静态核验**：
 *   · `from` 藏在自定义 helper 闭包里（`withRelayElse` / 索引切片…）—— 锚点作用域是
 *     **运行期切出来的子块**，不是整个文件；在文件里数它的出现次数**必然数错**（26 条）
 *   · 脚本写了**多个**不同目标 ⇒ 默认目标不可证（14 条，如 `mut-a1029` 的 `o.p/target.p/tsP`）
 *   · `file:` 是**函数调用**（`notes("v0.0.4")` / `copy("v0.0.4")`）—— 要"求值"才能知道路径（9 条）
 *   · 压根没有 `from`（二进制 / 影子文件 / 纯新增行）（8 条）
 *   · `moveAfter`/`moveBefore` 布局指令、`corrupt:` 二进制破坏（3 + 2 条）
 * ⇒ 这 62 条的"保护"只能由 `mut-*.mjs` **真跑**来提供（本脚本不执行脚本，只做静态核验）。
 * ⚠️ **禁止**为了把 62 变成 0 而放宽判据（例如"猜一个目标文件"或"只比前缀"）——
 *   那会造出**假绿**：核验器打勾、运行期改错对象，比"未核验"更危险。
 *
 * ⚠️ 本脚本**不改任何文件**，纯只读。
 *
 * 用法：
 *   node gui/scripts/check-mut-anchors.mjs                # 扫全部 mut-*.mjs
 *   node gui/scripts/check-mut-anchors.mjs --show-skipped # 打印每一条未核验的**具名理由**
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
     本仓确有这种形态（`mut-a1026-wincap.mjs` 的 `REQ_CAP_RETRY` 是多行锚点拼出来的）。
     ⚠️ 走 `readConcat`（**注释感知 + 截断即拒**）—— 旧正则遇注释即截断并给出**前缀假值**，
     导致"核验器说命中、运行期说未命中"的假绿。理由见 `readConcat` 的文档。 */
  for (const g of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*/g)) {
    if (m.has(g[1])) { continue; }
    const r = readConcat(src, g.index + g[0].length);
    if (r.parts.length === 0) { continue; }          // 不是字面量形态（join / 对象 / 标识符…）
    if (r.truncated) { bad.push(g[1]); continue; }   // 截断 ⇒ 拒登记（绝不给前缀假值）
    if (r.parts.length === 1) { continue; }          // 单字面量：由上面那段负责
    if (r.parts.some((p) => unlit(p) === null)) { bad.push(g[1]); continue; }
    m.set(g[1], r.parts.map((p) => unlit(p)).join(""));
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
const STR = String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`
  /* ⚠️ **反引号模板字面量**（2026-09-24 补，A-1098）：本仓**大量**锚点写成
     `` from: `…` `` —— 其中不少是**多行**片段（模板字面量允许真换行）。只认 `"` / `'` 时
     它们整批落进「锚点写法未识别」：实测 64 份脚本里 **118 条**（含 4 份脚本**整份 0 条**被核验过：
     `mut-a1044-inputarb` 23 条、`mut-a1051-resume` 19 条、`mut-a1041-bundle` 18 条…）。
     那不是"这种写法核验不了"，而是**没人核验** —— 与 `missingFiles` 同族。
     ⚠️ 三个刻意的取舍：
      · 允许**真换行**（`[^\`\\$]` 含 `\n`）—— 模板字面量跨行是合法的，
        而旧的"字面量不许含裸换行"那条规则只对 `"` / `'` 成立（那里跨行=未配对）。
      · **拒绝 `${…}` 插值**（`\$(?!\{)`）：插值求不出静态值，若放过去会拿一个"看着像"
        的串去数命中数 ⇒ **假绿**（比假红危险）。落回「未核验」并给出专门理由。
      · 转义一律走 `\\[\s\S]`（`. ` 不匹配换行，写成 `\\.` 会漏掉 `\` + 换行的组合）。
     ⚠️ 这一段刻意**不用** `String.raw` 而用**单引号串**：单引号里反引号无需转义，
     写出来的正是正则要的样子（用 `String.raw` 就得写 `\`` 这种 identity escape，
     能跑但依赖 Annex B，且读起来极易被当成"转义错了"而误改）。 */
  + "|" + '`(?:\\\\[\\s\\S]|[^`\\\\$]|\\$(?!\\{))*`';

/**
 * 从 `i` 起读一条**拼接字面量**链（`"a" + 'b' + "c"`），**注释感知**。
 *
 * 为什么必须是扫描器而不是一条正则（2026-09-24 修，A-1095 #8′ 实测踩到）：
 *   旧写法 `(${STR}(?:\s*\+\s*${STR})+)` **遇到夹在 `+` 链中的 `/* … *​/` 就停**，
 *   于是把常量记成**前几段的前缀**。而那个前缀恰好出现在目标文件里 ⇒
 *   核验器报「命中」，运行期 `sub` 却报「未命中」—— **两边结论打架，且错的那边不响**。
 *   ⇒ 这是"检测器自己空转"的又一形态：假绿比假红危险。
 *
 * `truncated` = 在 `+` 之后读不到字面量（例如 `const X = "a" + Y;`）——
 *   调用方据此**拒绝登记**该常量（宁可报"解析失败"= 响亮，也不给前缀值 = 不响）。
 *
 * ⚠️ **可选的 `consts` 解析器**（2026-09-24 补，`mut-a1026-wincap.mjs` ③/④ 实证）：
 *   `from:` 常常是 `"…字面量…" + LOCAL_GUARD` 这种**字面量与常量混拼**。
 *   不解析常量时只能拿到**前半段前缀** —— 而前缀在目标文件里几乎必然命中，
 *   于是核验器打勾、运行期 `sub` 用的却是**完整**锚点 ⇒ **两边结论打架，且错的那边不响**。
 *   ⇒ 传 `consts` 后，标识符段会被替换成它的**字面量形态**（`JSON.stringify` 后入列），
 *   于是调用方拿到的 `parts` 能拼出**完整**锚点。常量表本身已由 `constMap` 解析成终值，
 *   所以**只需要一层**解析（不必递归，也就不会撞上环）。
 *   ⚠️ 解析不了（未登记 / 根本不是标识符）时仍然 `truncated: true` —— 宁可未核验，不给前缀。
 */
function readConcat(src, i, consts) {
  const parts = [];
  const sticky = new RegExp(STR, "y");
  const skip = (j) => {
    for (;;) {
      const ws = /^[ \t\r\n]+/.exec(src.slice(j));
      if (ws) { j += ws[0].length; continue; }
      if (src.startsWith("/*", j)) { const e = src.indexOf("*/", j + 2); if (e < 0) { return null; } j = e + 2; continue; }
      if (src.startsWith("//", j)) { const e = src.indexOf("\n", j); if (e < 0) { return null; } j = e; continue; }
      return j;
    }
  };
  let j = skip(i);
  if (j === null) { return { parts, truncated: true }; }
  for (;;) {
    sticky.lastIndex = j;
    const t = sticky.exec(src);
    if (t) {
      parts.push(t[0]);
      j = skip(sticky.lastIndex);
    } else if (consts) {
      const id = /^[A-Z][A-Z0-9_]*/.exec(src.slice(j));
      /* ⚠️ **必须用 `id ? … : undefined` 而不是 `id && consts.get(id[0])`**（2026-09-25 修，A-1113 实测）：
         旧写法在 `id === null`（锚点首参既不是字面量、也不是常量名，例如直接是形参/调用式）时
         得到 `v = null`，而 `null === undefined` 是 **false** ⇒ 不会提前返回，
         接着执行 `id[0]` ⇒ **TypeError: Cannot read properties of null**，整轮核验**当场崩掉**。
         症状极具误导性：调用方读到的不是"这条锚点解析不出来"，而是"核验器坏了"，
         且**崩在哪个文件之前打过的勾都还在**（看起来像"扫到一半正常结束"）。
         —— 这是"检测器自己空转"的又一形态：它把**自己的**异常报成了**别人的**问题。 */
      const v = id ? consts.get(id[0]) : undefined;
      if (v === undefined) { return { parts, truncated: parts.length > 0 }; }
      parts.push(JSON.stringify(v));
      j = skip(j + id[0].length);
    } else {
      return { parts, truncated: parts.length > 0 };
    }
    if (j === null) { return { parts, truncated: true }; }
    if (src[j] === "+") { j = skip(j + 1); if (j === null) { return { parts, truncated: true }; } continue; }
    return { parts, truncated: false };
  }
}

/** `/` 前面出现这些字符时，`/` 是**正则开头**而不是除号（标准启发式，够用且无状态） */
const REGEX_CAN_START_AFTER = "(,=:[!&|?{};+-*%~^<>";

/**
 * 把**注释**换成空格，**字符串 / 模板字面量原样保留**，且长度与换行位置不变。
 *
 * ## 为什么必须有它（2026-09-24，扩 STR 支持反引号时**自己踩爆**的回归）
 *
 * `anchorOf` 的几条正则是**在整段条目原文**上跑的，而条目里**夹着注释**。
 * 旧 `STR` 只认 `"` / `'`，注释里写 `` `sub(t,` `` 时那个反引号**匹配不上**、
 * 于是正则自然地跳到后面真正的 `sub(` —— **靠巧合正确**。
 * 一旦 `STR` 支持反引号，同一个注释里的 `` `sub(t,` `` 就被当成模板字面量**开口**，
 * 一路吞到下一个反引号，`from` 解析成**注释正文**（实测 `mut-a1090-rescue.mjs` 第 23 条：
 * `from` 变成「 与锚点之间会让核验器认不出这条锚点…（注释收尾）+ `mutate: (t) => sub(`…」）
 * ⇒ 报「未命中（源码已漂移）」，**假警报指向错误对象**。
 *
 * ⚠️ 写这条注释时我自己踩了一次：上面引用"注释收尾标记"时**不能**在块注释里写出那个两字符序列，
 *   否则**注释在本行就被截断**（`SyntaxError: Invalid or unexpected token`）。
 *   ——"在注释里写注释标记"和"在正则里写正则"是同一族自伤，见 `ref-engineering`。
 *
 * ⇒ 判据：**解析锚点只许看代码**。注释必须先在语义上消失，而不是"恰好没被匹配上"。
 *
 * ## 取舍与边界
 *
 * · 未配对的 `"` / `'` 遇到换行就**停**（不吞掉整份脚本）—— 与 `STR` 的"字面量不许含裸换行"同口径。
 * · 模板字面量里的 `${…}` **不单独解析**：整段模板当作不透明。代价是"插值里写的注释不会被屏蔽"，
 *   而那对本核验器的判据（找字面量锚点）无影响。
 * · 正则字面量走**上一个非空白字符**启发式识别（`=` / `(` / `,` / `return` 之后…），
 *   免得"字符类里带星号或斜杠"的正则把后面的代码当成注释吞掉。
 */
function maskComments(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k += 1) { if (out[k] !== "\n" && out[k] !== "\r") { out[k] = " "; } } };
  let prev = "";   // 上一个**非空白**字符（判断 `/` 是除号还是正则开头）
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === ch) { i += 1; break; }
        if (src[i] === "\n") { break; }
        i += 1;
      }
      prev = ch;
      continue;
    }
    if (ch === "`") {
      i += 1;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") { i += 1; break; }
        i += 1;
      }
      prev = "`";
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && (prev === "" || REGEX_CAN_START_AFTER.includes(prev))) {
      let j = i + 1;
      let cls = false;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "\n") { break; }
        if (c === "[") { cls = true; }
        else if (c === "]") { cls = false; }
        else if (c === "/" && !cls) { closed = true; break; }
        j += 1;
      }
      if (closed) { i = j + 1; prev = "/"; continue; }
    }
    if (!/\s/.test(ch)) { prev = ch; }
    i += 1;
  }
  return out.join("");
}

/** 抽出一条变异的目标文件与 from 锚点（不认识的写法返回 null）
 *  `defaultFile` = **脚本级默认目标**（仅在条目内没有 `file:` 时使用，且必须是可证的，见 `soleWriteTarget`）。 */
function anchorOf(rawEntry, consts, defaultFile = null) {
  /* ⚠️ **只解析代码**（2026-09-24 修，见 `maskComments`）：条目里夹着注释，
     而注释里可能写着 `` `sub(t,` `` 这种"长得像代码"的片段 —— 直接在原文上跑正则会把它当锚点。 */
  const entry = maskComments(rawEntry);
  const name = /name:\s*("(?:\\.|[^"\\\n])*")/.exec(entry);
  const label = name ? (unlit(name[1]) ?? "(名字面量解析失败)") : "(无名)";
  /* `all: true` = 作者显式声明"整组替换"（计数闸门用的形态，见文件头与 `_mut-eol.mjs` 的 `subAll`）。 */
  const all = /\ball:\s*true\b/.test(entry);
  // 目标文件：`file: XXX` 或 `file: "path"`（含模板字面量）
  let file = null;
  const fm = new RegExp(`\\bfile:\\s*([A-Z][A-Z0-9_]*|${STR})`).exec(entry);
  if (fm) {
    if (fm[1].startsWith('"') || fm[1].startsWith("'") || fm[1].startsWith("`")) {
      const lit = unlit(fm[1]);
      /* `file: "PROD"` 把键名放进字符串里，真值在映射表（见 `constMap`）—— 先查表，查不到才当路径。 */
      file = (lit !== null && consts.has(lit)) ? consts.get(lit) : lit;
    } else {
      file = consts.get(fm[1]) ?? null;
    }
  }
  /* 条目内没有 `file:` 时，用**脚本级唯一写入目标**兜底（见 `soleWriteTarget` 的判据；
     拿不出证据时 `defaultFile` 就是 null，本条照旧落进「未核验」并给出具名理由）。 */
  if (file === null) { file = defaultFile; }
  // from 锚点：`from: "…"`（字面量）/ `from: A + "b"`（拼接）/ `from: XXX`（常量引用）
  //            / `sub(t, "…", …)` / `subAll(t, "…", …)`
  let from = null;
  const fFrom = /\bfrom:\s*/.exec(entry);
  if (fFrom) {
    /* ⚠️ 走 `readConcat`（**注释感知 + 截断即拒**）：`from:` 后面允许是**拼接字面量**
       （`mut-a1047-reqowner.mjs` 的 M6 是多行锚点用 `+` 拼出来的）。旧写法只吃**第一段**，
       于是拿一条**前缀**去数命中数 —— 前缀天然命中更多次，就报「不唯一」，
       **假警报指向"改错对象"，真因是核验器把锚点读短了**。 */
    const r = readConcat(entry, fFrom.index + fFrom[0].length, consts);
    if (r.parts.length > 0 && !r.truncated) {
      const vals = r.parts.map((p) => unlit(p));
      if (!vals.some((v) => v === null)) { from = vals.join(""); }
    } else if (r.parts.length === 0) {
      /* ⚠️ **常量引用的 from 必须能解析**（2026-09-23 补）：本仓大量脚本把锚点抽成常量
         （`from: LOCAL_GUARD` / `from: REQ_CAP_RETRY`），只认字面量时它们全部落进
         「锚点写法未识别」—— 于是一份 12 条变异的脚本**0 条被核验**，
         而输出读起来像"这种写法本来就核验不了"。 */
      const f1c = /from:\s*([A-Z][A-Z0-9_]*)/.exec(entry);
      if (f1c && consts.has(f1c[1])) { from = consts.get(f1c[1]); }
    }
  }
  if (from === null) {
    /* ⚠️ **`sub(t, …)` 的首参一律走 `readConcat`**（2026-09-25 补，A-1113 实测踩到）：
       与上面 `from:` 完全同款的理由 —— 本仓会把首参写成**拼接**形态
       （`sub(t, "字面量" + CONST, …)`）。旧写法 `sub\(\s*t\s*,\s*(STR)` 只吃**紧跟的第一个
       字面量**，于是把锚点记成**前缀**：前缀在目标文件里要么命中很多次、要么恰好唯一 ——
       两种都会让核验器的结论与运行期 `sub` 用的**完整**锚点**两边打架，而错的那边不响**
       （实测：`mut-a1113.mjs` 的 M11 写 `sub(t, "\n" + A_HOVER, "")`，核验器报
        「命中 3220 次」—— 真因是它把 `"\n"` 当成了整条锚点；若那个前缀恰好唯一，
        同样的读短就会变成**假绿**：锚点漂移了核验器照样打勾）。
       `readConcat` 注释感知 + 截断即拒，且能同时解析**纯字面量 / 纯常量 / 混拼**三种形态
       （故一并取代旧的 `f2c` 常量分支 —— 两者对纯常量等价，这里只留一条路径，
        避免"同一个锚点两种解析器给出两个答案"）。 */
    const f2 = /sub(?:All)?\(\s*t\s*,\s*/.exec(entry);
    if (f2) {
      const r = readConcat(entry, f2.index + f2[0].length, consts);
      if (r.parts.length > 0 && !r.truncated) {
        const vals = r.parts.map((p) => unlit(p));
        from = vals.some((v) => v === null) ? null : vals.join("");
      }
    }
    if (from === null) {
      /* ⚠️ **`subLines(t, ["…","…"], …)` 的数组形态**（2026-09-24 补）：本仓用"分行书写"表达多行锚点
         （`_mut-eol.mjs` 文档里推荐的两种写法之一）。它把各行**用行尾连接**后拿去匹配，
         所以静态锚点 = 各行字面量用 `\n` 连接。不支持时这批整条未核验。
         实测 `mut-a1055.mjs` 的 A-1055① 两条就是这么写的。 */
      const f3 = /subLines\(\s*t\s*,\s*\[([\s\S]*?)\]\s*[,)]/.exec(entry);
      if (f3) {
        const lits = [...f3[1].matchAll(new RegExp(STR, "g"))].map((x) => unlit(x[0]));
        if (lits.length > 0 && !lits.some((v) => v === null)) { from = lits.join("\n"); }
      }
    }
  }
  if (!file || from === null) {
    /* ⚠️ **理由必须具名**（2026-09-24，用户明确点过这个问题）：
       旧输出一律写「锚点写法未识别（moveAfter/mutateBuf 等）」——
       而"等"字把**六种本质不同的原因**糊成一条。判据是"没人核验 = 没有保护"，
       于是"到底为什么核验不了"必须能**一条条说出来**，否则分母永远只能被笼统带过。
       ⇒ 这里给出**具名理由 + 收到的实际写法**，让每一条未核验都能被单独决策。 */
    const why = !file ? `目标文件：${fileWhy(entry)}` : `锚点：${fromWhy(entry)}`;
    return { label, unverified: true, why, file, from };
  }
  return { label, file, from, all };
}

/** 未核验的**具名**理由之一：目标文件为什么解析不出来（附收到的实际写法） */
function fileWhy(entry) {
  const fm = /\bfile:\s*([^\n]*)/.exec(entry);
  if (!fm) {
    return "条目里没有 `file:` 字段，且本脚本**写入了多个不同目标（或写入目标无法解析）**"
      + "⇒ 默认目标不可证（核验器只认证据，不猜目标 —— 猜错会造出假绿）";
  }
  const got = fm[1].trim().replace(/,\s*$/, "").slice(0, 60);
  return `\`file:\` 的写法未识别（收到 ${JSON.stringify(got)}）`;
}

/** 未核验的**具名**理由之二：from 锚点为什么解析不出来（附收到的实际写法） */
function fromWhy(entry) {
  if (/\bmoveAfter\b|\bmoveBefore\b/.test(entry)) { return "锚点写在 `moveAfter`/`moveBefore` 指令里（不是 from/to）"; }
  if (/\bmutateBuf\b/.test(entry)) { return "目标不是源码文本（`mutateBuf` 直接改二进制缓冲）"; }
  if (/\bcorrupt\b/.test(entry)) { return "`corrupt:` 二进制破坏（没有文本锚点可数）"; }
  if (/\bmutate\s*:/.test(entry)) { return "`from` 藏在 `mutate:` 闭包里，且不是 `sub(t, \"…\")` 形态"; }
  if (/\bts\s*:|\bjs\s*:/.test(entry)) { return "条目只有 `ts:`/`js:` 源码影子字段（没有 from）"; }
  return "条目里既没有 `from` 也没有可识别的变异指令";
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = argv.length > 0
  ? argv
  : readdirSync(SCRIPTS_DIR).filter((f) => /^mut-.*\.mjs$/.test(f)).map((f) => `gui/scripts/${f}`);

let ok = 0;
let missed = 0;
let ambiguous = 0;
let unverified = 0;
/** 未核验的**理由分类**计数（末行汇总用；见输出处的注释：分母要能被解释） */
const reasonTally = new Map();
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

/**
 * 求出"这份脚本**唯一**写入的目标文件"（拿不出证据时返回 null）。
 *
 * 用途：本仓有整份脚本的条目**都不写 `file:`**，而目标放在脚本级常量里
 * （`mut-a1020-ipc.mjs` 的 `MAIN`）—— 于是那 7 条**一条都没被核验过**（输出里只是"未核验"，
 * 看起来像"这种写法本来核验不了"，实际是**没人核验**）。
 *
 * 判据（**必须基于证据，不是猜**）：把脚本里所有 `writeFileSync(…)` / `writeFile(…)` 的
 * 首个实参取出并解析，**只有恰好一个**不同的表达式且能解析成路径时才采用它 ——
 * 那意味着"这份脚本改来改去只改这一个文件"，故"缺 `file:` 的条目必然是它"是**可证的**。
 *
 * ⚠️ 写出**两个以上**不同目标（例如 `mut-a1029-diffvis.mjs` 的 `o.p` / `target.p` / `tsP`）时
 *   一律返回 null —— "猜一个"会造出**假绿**：核验器数的是错文件里的命中数，却照样打勾。
 *   （这正是 §8.5「未核验 = 没人核验 = 没有保护」里最危险的那半边：**比未核验更糟**。）
 */
function soleWriteTarget(src, consts) {
  const args = new Set();
  for (const m of src.matchAll(/\bwriteFileSync\(\s*([^,\n]+?)\s*,/g)) { args.add(m[1].trim()); }
  for (const m of src.matchAll(/\bwriteFile\(\s*([^,\n]+?)\s*,/g)) { args.add(m[1].trim()); }
  if (args.size !== 1) { return null; }
  const a = [...args][0];
  if (/^["'`]/.test(a)) { return unlit(a); }
  return /^[A-Z][A-Z0-9_]*$/.test(a) ? (consts.get(a) ?? null) : null;
}

/* ⚠️ **"脚本不存在"必须计成失败，不能只是"跳过"**（2026-09-24 实测踩到）：
   入参**以仓库根为基准**（`ROOT = scripts 的上两级`）。若在 `gui/` 里传
   `scripts/mut-x.mjs`，会拼成 `<根>/gui/scripts/scripts/mut-x.mjs` ⇒ 这里报"不存在，跳过"，
   而它**不参与任何计数** ⇒ 末行照样打 `✅ 所有可核验锚点都命中且可用` ——
   **零核验却打勾**（比真红危险：它不响）。同一个陷阱还能由「拼错文件名」触发。
   ⇒ 不存在的脚本一律计入 `missingFiles`，与「未命中」同等对待。 */
const missingFiles = [];
const nameDrift = [];
/** 非纯数字前缀（`A1` / `C4` / `14a` …）⇒ 位置期望值推不出来，只能记数（见下方检查处注释） */
let nameUnchecked = 0;
for (const rel of files) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.log(`\n=== ${rel} ===（⚠️ 脚本不存在）`);
    console.log(`  ✗ 入参以**仓库根**为基准 —— 从别的目录跑时须写成 gui/scripts/…（收到：${rel}）`);
    missingFiles.push(rel);
    continue;
  }
  const src = readFileSync(abs, "utf8");
  const { map: consts, bad: constBad } = constMap(src);
  /* 脚本级默认目标（条目内缺 `file:` 时的**可证**兜底，见 `soleWriteTarget`） */
  const defaultFile = soleWriteTarget(src, consts);
  // 条目切分：以行首 `{` 起头的一段算一条（够用：这些脚本格式统一）
  const entries = src.split(/\n\s*\{\n/).slice(1);
  const bad = [];
  const skipped = [];
  /* ── 「序号 ↔ name 前缀」一致性（A-1117 补）────────────────────────────────
     症状（本轮实测）：`mut-a1106.mjs` 有一组 5 条被**插在数组中间**，`name` 前缀还写着
     114~118，于是 `--apply 96` 实际变异的是名叫 "91 状态行激励语字号" 的那条 ——
     测试**真的红了**，于是结论"96 被捕获"是**假绿**（红的根本不是那条判据）。
     ⚠️ 这类错位 `tsc` 不报、eol 自检不报、锚点核验也不报（锚点自身是命中的），
     只有"把 name 里的序号与位置对一遍"能发现。
     ⚠️⚠️ **判据是「第 k 个带纯数字编号的条目，编号就是 k」**，不是"编号 == 位置"——
     本仓有脚本用 `18b`/`18c` 这类**子编号**插在 18 与 19 之间（那是刻意的结构，不是错误），
     按"编号 == 位置"判会把它们之后所有条目全部报错（实测一次报 20 项 ⇒ 报警长红 = 没人看，
     正是本文件反复警告的"检测器自己变成噪音"）。上面那条 a1106 的缺陷用**计数器**口径照样抓到
     （顺序 1..75, 114..118, 76..113 ⇒ 第 76 个数字编号叫 114 ≠ 76）。
     ⇒ 子编号/字母编号只计数不判等；静态切分与 name 字段数不一致时报"无法核验"（不许静默跳过）。 */
  /* ⚠️ `name:` 必须**锚在行首**（条目里的 `name:` 恒是缩进后独占一行）——
     不锚会被**锚点代码里**的同名字段骗到（实测 `mut-a1055.mjs` 有一条变异改的是
     `{ name: "IconUri", … }` 这种源码字面量，静态数 name 就多出 1 个 ⇒ 恒报"不一致"）。 */
  const nameLits = [...src.matchAll(/^\s*name: "([^"]*)"/gm)].map((m) => m[1]);
  const numeric = nameLits.filter((x) => /^\d+\s/.test(x)).length;
  if (nameLits.length !== entries.length) {
    /* ⚠️ 只在**这份脚本真的有纯数字编号**时才报"不一致"：整份都是 `①`/`A1` 这类编号时，
       "位置 ↔ 数字"这条判据本来就不适用，报出来只是噪音（噪音长红 = 没人看）。 */
    if (numeric > 0) {
      nameDrift.push(`${rel} 无法核验序号（静态切出 ${entries.length} 条 vs 行首 name 字段 ${nameLits.length} 个，不一致）`);
    } else { nameUnchecked += nameLits.length; }
  } else {
    let seq = 0;
    for (let i = 0; i < nameLits.length; i++) {
      const nm = /^(\d+)\s/.exec(nameLits[i]);
      if (!nm) { nameUnchecked += 1; continue; }
      seq += 1;
      if (Number(nm[1]) !== seq) {
        nameDrift.push(`${rel} 第 ${i + 1} 个条目（第 ${seq} 个数字编号）叫「${nm[1]} …」`
          + `⇒ \`--apply ${i + 1}\` 变异的不是它（跑出来会是一条假绿）`);
      }
    }
  }
  let n = 0;
  for (const e of entries) {
    const a = anchorOf(e, consts, defaultFile);
    if (a.unverified) {
      unverified += 1;
      skipped.push(`· 未核验（${a.why}）：${a.label}`);
      /* 分类只取理由的"类"（把「（收到 …）」那截附注去掉），用于末行汇总 */
      const cat = a.why.replace(/（收到[\s\S]*$/, "").trim();
      reasonTally.set(cat, (reasonTally.get(cat) ?? 0) + 1);
      continue;
    }
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

console.log(`\n合计：命中且唯一 ${ok - allCount} · 整组替换（all: true）${allCount} · 未命中 ${missed} · 不唯一 ${ambiguous} · 未核验 ${unverified} · 脚本不存在 ${missingFiles.length} · 序号错位 ${nameDrift.length} · 序号不可核验 ${nameUnchecked}`);
/* ⚠️ **未核验必须按理由分类打出来**（2026-09-24 补）：只给一个数字时，
   它读起来像"这些本来就没法核验"，于是年复一年没人动它（本仓实测：这个数字长期停在 190+，
   而被笼统写成「moveAfter/mutateBuf 等写法」——"等"字把**六种本质不同的原因**糊成一条）。
   ⇒ 判据是"没人核验 = 没有保护"，所以必须**逐类说清为什么**，每类才能被单独决策：
     是可解析的写法没支持（该扩能），还是**本质上不可静态核验**（该记档 + 换别的手段）。 */
if (unverified > 0) {
  console.log("未核验按理由分类（分母要能被解释，否则它只是被习惯性忽略的数字）：");
  for (const [why, cnt] of [...reasonTally].sort((a, b) => b[1] - a[1])) {
    console.log(`  · ${String(cnt).padStart(3)} 条 —— ${why}`);
  }
}
/* ⚠️ **"跳过"不许算通过**（见上方 `missingFiles` 注释）：不存在 / 拼错路径都计入失败。
   一句话判据：**只有"每一条锚点都被核验且可用"才配打勾**；"这条没查"不是通过。 */
const failed = missed + ambiguous + missingFiles.length + nameDrift.length;
if (missingFiles.length > 0) {
  console.log(`⚠️ 有 ${missingFiles.length} 份脚本没找到（未核验 —— 多半是入参路径写错）：${missingFiles.join("、")}`);
}
/* ⚠️ 序号错位**必须计入失败**并逐条点名：它是"假绿"的产地 ——
   `--apply N` 跑的不是 N 描述的那条，测试红了会让人以为"N 被捕获"。 */
if (nameDrift.length > 0) {
  console.log(`⚠️ 有 ${nameDrift.length} 处「name 序号 ↔ 位置序号」不一致（会让 --apply 跑到别的条目 ⇒ 假绿）：`);
  for (const d of nameDrift) { console.log(`  ✗ ${d}`); }
}
console.log(failed === 0
  ? `✅ 全部 ${files.length} 份脚本的锚点都命中且可用（序号一致）`
  : `⚠️ 有 ${failed} 项需要处理（未命中=该守卫已失去保护；不唯一=可能改错对象；脚本不存在=压根没核验；序号错位=--apply 会跑错条目）`);
if (files.length === 0) {
  console.log("⚠️ 没有核验任何脚本（`files` 为空 —— 检查入参）");
}
process.exit(failed === 0 && files.length > 0 ? 0 : 1);
