/**
 * tests/core-ts/a1019-guards.spec.ts — A-1019（窗口缩小时界面"出屏幕"）的结构守卫。
 *
 * 这一轮修的是三类**静默**缺陷 —— 它们不会让 tsc / vitest / 产物断言变红，
 * 只在"把窗口拖窄"这个动作下才现形，所以必须钉结构关系：
 *
 *  ① **布局地板只有一个来源**：三栏 min-width 之和（左 240 + 聊 380 + 右 260 = 880）。
 *     `.app` / `.body` 不许再声明更大的 min-width —— 那是一个"隐形地板"，
 *     会把整页钉宽、绕过三栏的自动收缩。（原病灶：`.app { min-width: 1100px }`，
 *     而窗口地板 WIN_MIN.width 只有 900 → 窗口能缩进 [900,1100) 死区，
 *     右栏连同标题栏右上角的开合按钮一起被推出屏幕外。）
 *  ② **侧栏宽度变量不许用百分比**：百分比在固有尺寸计算阶段不可解析 →
 *     外层 `.right-wrapper` 按内容 max-content 算出 431px（右栏真实 260px）→
 *     窄窗口下右栏先被顶出去。必须用 vw。
 *  ③ **两份比例数值必须同源**：CSS 的 clamp 中间值（17.5vw / 21.5vw）与
 *     App.tsx 的 SIDEBAR_RATIO（0.175 / 0.215）是同一个设计比例的两种表达，
 *     改一边忘一边就会出现"按比例算出来却不是比例"的旧毛病。
 *  ④ **`window.slimeAPI` 取出后必须有守卫**：否则 preload 未就绪时在渲染阶段抛异常，
 *     被 ErrorBoundary 拦下 → 整棵组件树被替换成"界面渲染出错"（整页白屏），
 *     而不是某个功能降级。（原病灶：TasksTab 里 `api.chat?.onChunk` —— 第二层带了
 *     可选链、第一层没带，照样崩。）
 *
 * 每一条都能通过变异测试验红。`assert-layout-fit.cjs` 是同一批不变量的**运行时**取证
 * （真实渲染 + 真实几何 + 截图）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INDEX_CSS = join(ROOT, "gui/src/renderer/index.css");
const APP_TSX = join(ROOT, "gui/src/renderer/App.tsx");
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const RENDERER_DIR = join(ROOT, "gui/src/renderer");

const read = (p: string): string => readFileSync(p, "utf8");

/** 取某个类选择器块里**所有** min-width 声明中的最后一个（`body, #root, .app {}` 这类
 *  选择器列表块会先命中，只取第一处会锁错对象 —— 变异测试当场抓出来过）。 */
function blockMinWidth(css: string, cls: string): number | null {
  const re = new RegExp(`\\.${cls} \\{([^}]*)\\}`, "g");
  let m: RegExpExecArray | null;
  let seen = false;
  let hit: number | null = null;
  while ((m = re.exec(css))) {
    seen = true;
    const mm = /min-width:\s*(\d+)px/.exec(m[1]);
    if (mm) { hit = Number(mm[1]); }
  }
  return seen ? (hit === null ? 0 : hit) : null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) { out.push(p); }
  }
  return out;
}

/** 把访问链一路剥到根的 identifier（`api?.chat.stream()` → `api`）。 */
function chainRoot(e: ts.Expression): ts.Expression {
  let cur: ts.Expression = e;
  while (
    ts.isPropertyAccessExpression(cur)
    || ts.isElementAccessExpression(cur)
    || ts.isCallExpression(cur)
    || ts.isNonNullExpression(cur)
    || ts.isParenthesizedExpression(cur)
  ) {
    cur = (cur as ts.PropertyAccessExpression).expression;
  }
  return cur;
}

/**
 * 这棵子树里**提到了** `name`（不判安全性，只判"这是不是一道关于 api 的条件"）。
 *
 * ⚠️ 极易与下一节的「安全」混淆：正因为它**不看** `?.`，`!act || !choice || !api.chat?.stream`
 * 这类**危险**条件也会被判成 `true` —— 这正是设计意图（它是一道"关于 api 的 `if`"，
 * 因此必须把**条件本身**交给 `findBare` 查裸访问），而不是"它安全"。
 * 安全与否由 `hasOptionalApiChain` + `findBare` 决定。
 */
function mentionsApi(e: ts.Expression, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) { return; }
    if (ts.isIdentifier(n) && n.text === name && !isPropertyName(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(e);
  return found;
}

/** 该 identifier 处在「属性名」位置（`x.api` / `{ api: 1 }` 里的 `api`）—— 那不是对 api 的引用。 */
function isPropertyName(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) { return true; }
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === n) { return true; }
  if (ts.isQualifiedName(p) && p.right === n) { return true; }
  return false;
}

/* ══ 作用域边界 + 「api 存在性」的抽象解释（几个小谓词）══════════════════
   下面这些谓词只回答一个问题：**api 为 undefined 时，这个表达式 / 这个分支会不会被执行**。
   判"守卫"只能靠短路语义，不能靠"谁写在最左"。 */

/** 以 name 为根的访问链（`api` / `api?.x` / `api.x.y`）。 */
function isApiChain(e: ts.Expression, name: string): boolean {
  const root = chainRoot(e);
  return ts.isIdentifier(root) && root.text === name;
}

function unwrapParens(e: ts.Expression): ts.Expression {
  let c = e;
  while (ts.isParenthesizedExpression(c)) { c = c.expression; }
  return c;
}

/** `!X` → X；不是取反则 null。 */
function negated(e: ts.Expression): ts.Expression | null {
  const u = unwrapParens(e);
  return ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.ExclamationToken ? u.operand : null;
}

/* ⚠️ 枚举成员名必须带 `Token` 后缀：`SyntaxKind.BarBar` / `.AmpersandAmpersand` 这两个
   别名在 TS 5.x 已被删除 ⇒ 值是 `undefined` ⇒ 比较**恒假**。而它不会让 vitest 变红
   （esbuild 只转译不做类型检查）⇒ 整个短路极性判据**静默失效**（实测踩到：本仓 3 处
   `&&` 型守卫的分支因此被误报）。
   ⚠️ 这里**返回操作数元组，而不是写成类型谓词**（`e is ts.BinaryExpression`）：同形状的
   谓词会被 TS 的**别名条件收窄**串起来 —— `if (isOr(u) || isAnd(u))` 之后 `u` 已被收窄掉
   `BinaryExpression`，同一作用域里 `const or = isOr(u)` 的**假**分支就把 `u` 收窄成 `never`
   ⇒ `u.left` 报 TS2339（根 `tsc` 实测）。返回元组、不写谓词，就不参与收窄。 */
function bothParts(e: ts.Expression, kind: ts.SyntaxKind): readonly [ts.Expression, ts.Expression] | null {
  const u = unwrapParens(e);
  if (!ts.isBinaryExpression(u)) { return null; }
  if (u.operatorToken.kind !== kind) { return null; }
  return [u.left, u.right];
}

function orParts(e: ts.Expression): readonly [ts.Expression, ts.Expression] | null {
  return bothParts(e, ts.SyntaxKind.BarBarToken);
}

function andParts(e: ts.Expression): readonly [ts.Expression, ts.Expression] | null {
  return bothParts(e, ts.SyntaxKind.AmpersandAmpersandToken);
}

/** **api 缺失时**该表达式必为真？（`!api` / `!api?.x` / 它们的 `||` 组合） */
function truthyWhenApiMissing(e: ts.Expression, name: string): boolean {
  const u = unwrapParens(e);
  const n = negated(u);
  if (n) { return falsyWhenApiMissing(n, name); }
  const o = orParts(u);
  if (o) { return truthyWhenApiMissing(o[0], name) || truthyWhenApiMissing(o[1], name); }
  const a = andParts(u);
  if (a) { return truthyWhenApiMissing(a[0], name) && truthyWhenApiMissing(a[1], name); }
  return false;
}

/** **api 缺失时**该表达式必为假？（`api` / `api?.x` 这类链；`&&` 任一侧假、`||` 两侧都假） */
function falsyWhenApiMissing(e: ts.Expression, name: string): boolean {
  const u = unwrapParens(e);
  const n = negated(u);
  if (n) { return truthyWhenApiMissing(n, name); }
  const a = andParts(u);
  if (a) { return falsyWhenApiMissing(a[0], name) || falsyWhenApiMissing(a[1], name); }
  const o = orParts(u);
  if (o) { return falsyWhenApiMissing(o[0], name) && falsyWhenApiMissing(o[1], name); }
  return isApiChain(u, name);
}

/** 条件为**真** ⇒ api 一定存在（`api` / `api?.x` 为真，说明那条链刚被求过值）。 */
function truthyProvesApi(e: ts.Expression, name: string): boolean {
  const u = unwrapParens(e);
  const n = negated(u);
  if (n) { return falsyProvesApi(n, name); }
  const a = andParts(u);
  if (a) { return truthyProvesApi(a[0], name) || truthyProvesApi(a[1], name); }
  const o = orParts(u);
  if (o) { return truthyProvesApi(o[0], name) && truthyProvesApi(o[1], name); }
  return isApiChain(u, name);
}

/** 条件为**假** ⇒ api 一定存在（`!api` / `!api?.x` / `typeof api?.x !== "function"`）。 */
function falsyProvesApi(e: ts.Expression, name: string): boolean {
  const u = unwrapParens(e);
  const n = negated(u);
  if (n) { return truthyProvesApi(n, name); }
  const o = orParts(u);
  if (o) { return falsyProvesApi(o[0], name) || falsyProvesApi(o[1], name); }
  const a = andParts(u);
  if (a) { return falsyProvesApi(a[0], name) && falsyProvesApi(a[1], name); }
  return typeofApiProvesApi(u, name);
}

/** `typeof api?.x !== "function"` 为假 ⇒ 它是个函数 ⇒ api 存在（能力守卫的常见写法）。 */
function typeofApiProvesApi(e: ts.Expression, name: string): boolean {
  if (!ts.isBinaryExpression(e)) { return false; }
  const t = e.left;
  if (!ts.isTypeOfExpression(t) || !isApiChain(t.expression, name)) { return false; }
  if (!ts.isStringLiteral(e.right)) { return false; }
  const k = e.operatorToken.kind;
  if (k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken) {
    return e.right.text !== "undefined";
  }
  if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken) {
    return e.right.text === "undefined";
  }
  return false;
}

/** 该访问节点往上到根的整条链是否**全程无 `?.`**（有一个就说明已被保护）。 */
function bareChain(n: ts.Expression): boolean {
  let cur: ts.Expression = n;
  while (
    ts.isPropertyAccessExpression(cur)
    || ts.isElementAccessExpression(cur)
    || ts.isCallExpression(cur)
    || ts.isNonNullExpression(cur)
    || ts.isParenthesizedExpression(cur)
  ) {
    if (ts.isPropertyAccessExpression(cur) && cur.questionDotToken !== undefined) { return false; }
    if (ts.isElementAccessExpression(cur) && cur.questionDotToken !== undefined) { return false; }
    cur = (cur as ts.PropertyAccessExpression).expression;
  }
  return true;
}

/**
 * 在**本作用域内**找 name 的裸属性访问。返回起点位置，找不到返回 null。
 *
 * ⚠️ 「裸」= **从 name 到该属性、整条链都没带 `?.`** —— 只看最外层那个节点的
 * `questionDotToken` 会误报：`api?.tasks?.saveTodos?.(x).catch(f)` 里 `.catch` 本身
 * 没写 `?.`，但它上游全程有 `?.` ⇒ api 为 undefined 时整条链短路、**不会崩**。
 * （这里踩过一次：修好之前，`App.tsx` / `RightSidebar.tsx` 里二十来处合法写法全被误报。）
 *
 * ⚠️ **不下钻作用域边界**（函数体 / 块）：那些地方各自是独立作用域，由 `scanList` 递归去扫
 * —— 因为**守卫只在它所在的那个作用域里生效**。不设边界就会出现最离谱的误报：
 * 取值点在组件顶层、守卫在 `useCallback` 回调里的写法（本仓 5 处）全被冤枉。
 *
 * ⚠️ 这里**故意不写** `x.questionDotToken === undefined`：`bareChain(x)` 的第一步就在查
 * 同一个节点自己的 `?.`，写了是冗余条件 —— 而冗余条件会变成「等价变异体」
 * （改坏它测试照样绿），必须删掉而不是留着撑门面。
 */
function findBareInScope(node: ts.Node, name: string): number | null {
  let hit: number | null = null;
  const visit = (x: ts.Node): void => {
    if (hit !== null) { return; }
    if (ts.isPropertyAccessExpression(x) && bareChain(x)) {
      const root = chainRoot(x.expression);
      if (ts.isIdentifier(root) && root.text === name) { hit = x.getStart(); return; }
    }
    if (ts.isFunctionLike(x)) { return; }                 // 函数体一律单独扫（含入口本身）
    if (x !== node && ts.isBlock(x)) { return; }          // 块单独扫
    ts.forEachChild(x, visit);
  };
  visit(node);
  return hit;
}

/**
 * 条件里的裸 api 访问（认 `||` / `&&` 的**短路极性**）。
 *
 * `!api?.x || api.a.b`：左侧为真（api 缺失时必然为真）⇒ 右侧不求值 ⇒ 安全。
 * `api?.x || api.a.b`：左侧为假（api 缺失时为假）⇒ **右侧会真的求值** ⇒ 报。
 * `!act || !choice || !api.chat?.stream`（A-1019 ④ 原病灶）：左侧那串没有一个能在
 * api 缺失时为真 ⇒ 右侧求值 ⇒ 报，且报在**条件这一行**（崩就崩在这里）。
 */
function findBareInCondition(e: ts.Expression, name: string): number | null {
  const u = unwrapParens(e);
  const o = orParts(u);
  const a = o ? null : andParts(u);
  const kids = o ?? a;
  if (kids) {
    const left = findBareInCondition(kids[0], name);
    if (left !== null) { return left; }
    // 左侧已能短路（`||` 左真 / `&&` 左假）⇒ 右侧**不会真的求值** ⇒ 不算裸访问
    const shorted = o ? truthyWhenApiMissing(kids[0], name) : falsyWhenApiMissing(kids[0], name);
    if (shorted) { return null; }
    return findBareInCondition(kids[1], name);
  }
  return findBareInScope(e, name);
}

/** 一条语句里**同层**的嵌套作用域（块 / 函数体）；不下钻到更深层。 */
function nestedScopes(n: ts.Node, out: ts.Node[] = []): ts.Node[] {
  ts.forEachChild(n, (c) => {
    if (ts.isBlock(c) || ts.isFunctionLike(c)) { out.push(c); }
    else { nestedScopes(c, out); }
  });
  return out;
}

/** 分支是否**一定离开**当前函数（early `return` / `throw`）—— 只有这种 `if` 才构成守卫。 */
function alwaysExits(s: ts.Statement): boolean {
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) { return true; }
  if (ts.isBlock(s)) {
    const last = s.statements[s.statements.length - 1];
    return !!last && alwaysExits(last);
  }
  return false;
}

/**
 * A-1019 ④ 的**唯一判据实现** —— 返回「取了 `window.slimeAPI` 却既无 null 守卫、
 * 又不带第一层可选链就裸访问」的位置列表（空数组 = 合格）。
 *
 * ## ⚠️ 为什么走 **AST** 而不是逐行正则 / 手写扫描器（这里连踩三次坑）
 *
 * 第一版逐行正则 + `isComment = /^\s*(\/\/|\*|\/\*)/` 跳注释。坑一：**本仓注释续行的行首
 * 是「缩进 + 正文」而不是 `*`** ⇒ 续行被当成代码 ⇒ 一段**解释这道守卫的注释**恰好能把它
 * 关掉（注释里写 `api &&` 就把 `guarded` 置真，之后所有裸访问被洗白）。
 *
 * 第二版手写字符级 `stripComments` 维护注释 / 字符串状态。坑二（**这次实测踩到**）：
 * 它不认识正则字面量与 JSX 文本，状态机一偏就**再也不恢复** ⇒ `ChatPanel.tsx` 的注释
 * 原样留在「已剥注释」的行里 ⇒ 注释里的 `api &&` 又把守卫洗白（缺 null 守卫的新入口
 * **没有被检出**）。坑三：正则版只认**单行**取值点 ⇒ `UsageStatsPanel.tsx:692` 那个
 * 跨行声明**从未被检查过**（AST 版当场把它翻出来）。
 *
 * 教训（可变现的判据）：**手写扫描器追不上真实语法** —— 模板里的 `${}`、正则字面量、
 * JSX 文本、注释里的引号，每一样都能让状态机**静默**偏掉。TypeScript 编译器本身就是
 * tokenizer + parser（项目已有该依赖），注释在它眼里是 trivia、根本不进 AST。
 *
 * ## ⚠️ 判据语义（三条，少一条就会误判）
 *
 * 1. **守卫 = 「一定离开当前函数的 `if`」**：`if (!api?.x) { …; return; }` 之后整段都处在
 *    "api 已确证"里；`if (api?.x) { … }`（不 return）**不构成守卫**，后面照查。
 * 2. **作用域感知**：守卫只在**它所在的那个语句列表**（含其嵌套作用域）生效。调用点的
 *    真实形态是「取值点在组件顶层、守卫在 `useCallback` / `useEffect` 的回调里」⇒ 必须
 *    递归进函数体与块；否则本仓 5 处**合法**写法会一起变红（`RuntimePanel:55`、
 *    `MindHubPanel:242`、`RightSidebar:920 / 1929 / 2898`）。误报的代价是下一个人直接
 *    删掉这道守卫 —— 比漏检更贵。
 * 3. **条件本身也要查**，且认 `||` / `&&` 的短路极性（见 `findBareInCondition`）。
 *
 * | 写法 | 判定 | 为什么 |
 * |---|---|---|
 * | `if (!api) { return; }` | ✅ 守卫 | 纯存在性判断，不访问属性 |
 * | `if (!api?.x) { …; return; }`（在回调里） | ✅ 守卫 | 条件安全 + 一定离开 ⇒ 覆盖本作用域其余部分 |
 * | `typeof api?.usage?.recompute !== "function"` | ✅ 能力守卫 | 全程带 `?.`；为假即证明 api 存在 |
 * | `!api?.agents?.list \|\| !api.agents.detail` | ✅ 安全 | 左侧为真（api 缺失时必真）⇒ 右侧短路不求值 |
 * | `api?.x \|\| api.a.b` | ❌ 报 | 左侧为假（api 缺失时为假）⇒ 右侧**真的会求值** |
 * | `!act \|\| !choice \|\| !api.chat?.stream` | ❌ 报 | 第二层带了 `?.`、**第一层没带** ⇒ 条件自己就抛（A-1019 ④ 原病灶） |
 *
 * ## ⚠️ 已知边界（保守取舍，如实登记）
 *
 * 1. 命中第一条裸访问即停止该取值点的扫描 —— 报一处与报五处的修复动作相同，且能聚焦**最早**那处。
 * 2. 只有 `if` 被当作守卫候选。`while (api.x)` / 三元 `api.x ? a : b` 里的裸访问按普通
 *    语句照查（更严，不漏）；代价是 `api.y ? api.x : null` 这种"自己给自己做守卫"会误报 ——
 *    本仓无此形态，若出现应显式改写为 `if (!api) {}`，而不是放宽判据。
 * 3. 赋值给**别名**后（`const a = api; a.chat.stream()`）不再追踪 —— 需要数据流分析，
 *    收益不抵"守卫变成噪音"的风险。本仓无此形态。
 * 4. `??` 兜底（`(api ?? fallback).chat`）判为裸 —— `api` 真为 undefined 时 `.chat` 照样抛，
 *    这是**有意**的严格。
 * 5. 守卫的"覆盖范围"按**词法**算：`if (!api?.x) { …; return; }` 之后的嵌套函数也算安全
 *    （定义被求值就意味着守卫已经过了）。这在本仓成立（api 一旦就绪不会变回 undefined）。
 *
 * 取舍理由：本守卫防的是「取值点之后**什么都没有**就直接用 api」这一高发形态
 * （原病灶 TasksTab、实测修出的 `MindHubPanel.convertToSkill`）。
 */
function findBareSlimeApiAccess(src: string, rel = ""): string[] {
  const sf = ts.createSourceFile(rel || "x.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  /** 扫一个**语句列表**（= 一个作用域）。`guarded` 为真 = api 已确证 ⇒ 后续全部安全。 */
  function scanList(stmts: readonly ts.Statement[], name: string, declLine: number, guarded0: boolean): void {
    let guarded = guarded0;
    for (const s of stmts) {
      if (guarded) { return; }        // 已确证 ⇒ 本列表及其嵌套作用域都不会再有裸访问
      const iff = ts.isIfStatement(s) ? s : null;
      const isApiIf = iff !== null && mentionsApi(iff.expression, name);
      const bare = iff !== null && isApiIf
        ? findBareInCondition(iff.expression, name)
        : findBareInScope(s, name);
      if (bare !== null) {
        offenders.push(`${rel}:${lineOf(bare)}  裸访问 ${name}…（取值点在第 ${declLine} 行）`);
        return;
      }
      if (iff !== null && isApiIf) {
        const cond = iff.expression;
        enter(iff.thenStatement, guarded || truthyProvesApi(cond, name), name, declLine);
        if (iff.elseStatement) { enter(iff.elseStatement, guarded || falsyProvesApi(cond, name), name, declLine); }
        /* 「条件为假 ⇒ api 存在」+「分支一定离开」= 守卫；两条缺一不可
           （缺前者 ⇒ `if (!api) return;` 会被当成守卫后再放行后面的裸访问）。 */
        if (alwaysExits(iff.thenStatement) && falsyProvesApi(cond, name)) { guarded = true; }
      } else {
        for (const c of nestedScopes(s)) { enter(c, guarded, name, declLine); }
      }
    }
  }

  /** 进入一个子作用域：块 / 函数体 / 单条语句。 */
  function enter(child: ts.Node, guarded0: boolean, name: string, declLine: number): void {
    if (guarded0) { return; }
    if (ts.isBlock(child)) { scanList(child.statements, name, declLine, false); return; }
    if (ts.isFunctionLike(child)) {
      const body = (child as ts.FunctionLikeDeclaration).body;
      if (body) { enter(body, false, name, declLine); }
      return;
    }
    scanList([child as ts.Statement], name, declLine, false);
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isPropertyAccessExpression(node.initializer)
      && node.initializer.name.getText(sf) === "slimeAPI"
    ) {
      const name = node.name.text;
      const declLine = lineOf(node.getStart(sf));
      const stmt = node.parent.parent;                 // VariableStatement
      const container = stmt.parent;                   // Block / SourceFile / CaseClause
      const stmts: readonly ts.Statement[] = ts.isBlock(container) || ts.isSourceFile(container)
        ? container.statements
        : ts.isCaseClause(container) || ts.isDefaultClause(container) ? container.statements : [];
      const at = [...stmts].indexOf(stmt as ts.Statement);
      if (at >= 0) { scanList(stmts.slice(at + 1), name, declLine, false); }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offenders;
}

describe("A-1019 ①：布局地板只有一个来源（三栏 min-width 之和）", () => {
  const css = read(INDEX_CSS);
  const app = read(APP_TSX);
  const main = read(MAIN_INDEX);

  const sidebarMin = Number(/const SIDEBAR_MIN_W = (\d+)/.exec(app)![1]);
  const chatMin = Number(/const CHAT_MIN_W = (\d+)/.exec(app)![1]);
  const rightMin = Number(/\.right-sidebar \{[^}]*min-width:\s*(\d+)px/.exec(css)![1]);
  const floor = sidebarMin + chatMin + rightMin;

  it("`.app` / `.body` 不得声明超过三栏下限之和的 min-width", () => {
    for (const cls of ["app", "body"]) {
      const w = blockMinWidth(css, cls);
      expect(w, `取不到 .${cls} 的 min-width（守卫自己失效了）`).not.toBeNull();
      expect(
        w!,
        `.${cls} { min-width: ${w}px } > 三栏下限之和 ${floor}：这是比三栏 min-width 更硬的`
          + "「隐形地板」，会把整页钉宽（窗口缩到它以下时右栏与标题栏开合按钮被推出屏幕）。"
          + "布局地板应只由三栏 min-width 决定。",
      ).toBeLessThanOrEqual(floor);
    }
  });

  it("窗口最小宽度 ≥ 三栏下限之和（窗口不允许缩到布局装不下）", () => {
    const winMinW = Number(/const WIN_MIN = \{ width: (\d+), height: \d+ \}/.exec(main)![1]);
    expect(
      winMinW,
      `WIN_MIN.width ${winMinW} < 三栏下限之和 ${floor}（${sidebarMin}+${chatMin}+${rightMin}）`,
    ).toBeGreaterThanOrEqual(floor);
  });
});

describe("A-1019 ②：侧栏宽度变量必须是 vw（百分比在固有尺寸阶段不可解析）", () => {
  const css = read(INDEX_CSS);

  it("--sidebar-w / --right-sidebar-w 不含百分比", () => {
    const decls = [...css.matchAll(/--(sidebar-w|right-sidebar-w)\s*:\s*([^;]+);/g)];
    expect(decls.length, "两个宽度变量都必须存在").toBeGreaterThanOrEqual(2);
    for (const d of decls) {
      expect(
        d[2].includes("%"),
        `--${d[1]} 用了百分比（${d[2].trim()}）：百分比在固有尺寸计算阶段不可解析 → `
          + "flex item 退化成 auto → 外层容器按内容 max-content 撑宽（实测 431px vs 右栏真实 260px）"
          + " → 窄窗口下右栏先被顶出屏幕。请用 vw。",
      ).toBe(false);
    }
  });
});

describe("A-1019 ③：CSS 比例与 App.tsx 的 SIDEBAR_RATIO 同源", () => {
  const css = read(INDEX_CSS);
  const app = read(APP_TSX);

  it("clamp 的 vw 值与 SIDEBAR_RATIO 一致", () => {
    const ratio = /const SIDEBAR_RATIO = \{ left: ([\d.]+), right: ([\d.]+) \}/.exec(app);
    expect(ratio, "取不到 SIDEBAR_RATIO").toBeTruthy();
    const leftPct = Number(ratio![1]) * 100;
    const rightPct = Number(ratio![2]) * 100;

    const leftVw = /--sidebar-w:\s*clamp\([^,]+,\s*([\d.]+)vw/.exec(css);
    const rightVw = /--right-sidebar-w:\s*clamp\([^,]+,\s*([\d.]+)vw/.exec(css);
    expect(leftVw, "取不到 --sidebar-w 的 vw 值").toBeTruthy();
    expect(rightVw, "取不到 --right-sidebar-w 的 vw 值").toBeTruthy();

    expect(
      Number(leftVw![1]),
      `--sidebar-w 的 ${leftVw![1]}vw 与 SIDEBAR_RATIO.left（${leftPct}%）不一致：`
        + "两处是同一设计比例的两种表达，改一边忘一边 → 「按比例算出来却不是比例」。",
    ).toBeCloseTo(leftPct, 2);
    expect(
      Number(rightVw![1]),
      `--right-sidebar-w 的 ${rightVw![1]}vw 与 SIDEBAR_RATIO.right（${rightPct}%）不一致。`,
    ).toBeCloseTo(rightPct, 2);
  });
});

describe("A-1019 ⑤：标题栏 overlay 配色在**启动时**就必须对（不只是切换时纠正）", () => {
  const main = read(MAIN_INDEX);

  it("overlay 初值不得写死单色，必须读持久化主题", () => {
    const overlayDecl = /titleBarOverlay:\s*\{([^}]*)\}/.exec(main);
    expect(overlayDecl, "取不到 titleBarOverlay 初值声明").toBeTruthy();
    const body = overlayDecl![1];
    expect(
      /titleBarColors\(\s*readPersistedTheme\(\)\s*\)/.test(body),
      "`titleBarOverlay` 初值写死了固定配色 → alpha 主题用户每次启动都会先闪一帧 beta 色的色块"
        + "（那三个系统按钮背后一块比标题栏更深的色块）。初值必须来自 `titleBarColors(readPersistedTheme())`。",
    ).toBe(true);
  });

  it("配色只有一份实现，切换主题时同时持久化", () => {
    // 合成色字面量只允许出现在 titleBarColors 里（其它地方出现 = 又分叉了）
    const hexes = [...main.matchAll(/"#(0b101e|1e293b)"/g)];
    expect(
      hexes.length,
      `标题栏合成色字面量出现 ${hexes.length} 次：必须收敛到 titleBarColors() 一处，`
        + "否则改主题配色时会漏改某处 → 又出现色块。",
    ).toBeLessThanOrEqual(2);

    expect(main.includes("function titleBarColors("), "缺少 titleBarColors 唯一实现").toBe(true);
    const setter = /"slime:theme:set"[\s\S]{0,400}?\}\)/.exec(main);
    expect(setter, "取不到 slime:theme:set 处理体").toBeTruthy();
    expect(
      setter![0].includes("writePersistedTheme("),
      "slime:theme:set 没有持久化主题 → 下次启动读不到，overlay 初值又回到错的",
    ).toBe(true);
    expect(
      setter![0].includes("titleBarColors("),
      "slime:theme:set 没有走 titleBarColors（唯一实现）",
    ).toBe(true);
  });
});

describe("A-1019 ④：window.slimeAPI 取出后必须有守卫（否则整页白屏）", () => {
  it("取值点之后、任何守卫生效之前，不得出现裸属性访问", () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER_DIR)) {
      const rel = file.replace(ROOT, "").replace(/\\/g, "/");
      offenders.push(...findBareSlimeApiAccess(read(file), rel));
    }
    expect(
      offenders,
      "这些位置取了 window.slimeAPI 却既没有 null 守卫、也不带第一层可选链：\n"
        + offenders.map((o) => `  · ${o}`).join("\n")
        + "\npreload 未就绪时会在渲染阶段抛异常（或 async 边界变成 unhandled rejection） → ErrorBoundary 把整棵组件树替换成「界面渲染出错」"
        + "（整页白屏），而不是让某个功能降级。",
    ).toEqual([]);
  });

  /* ── 检测器自检（"检测器自己也会空转"那一族）──────────────────────
     这几条验证的是 `findBareSlimeApiAccess` **本身的检出能力**，
     而不是某个具体源文件 —— 没有它们，检测器坏掉时上面那条 it 会**静默通过**。

     ⚠️ 头两条锁的是「有人把实现改回逐行正则 / 手写扫描器」这种退化：
     那个方向**已经连踩两次坑**（① 注释续行行首不是 `*` ② 手写状态机不认识正则字面量
     与 JSX，在 ChatPanel.tsx 上直接失效，实测漏掉了缺 null 守卫的新入口）。
     AST 实现天然免疫，但"免疫"这件事必须由断言钉住，不能靠记性。 */

  it("自检：注释里出现 `api &&` 不许把后面的裸访问洗白（注释不是代码）", () => {
    const bad = [
      "function f() {",
      "  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;",
      "  /* 守卫判定只认三个形态",
      "     （`if (!api…)` / `if (api…)` / `api &&|??|…`）",
      "     `!api?.chat` 一个都不算 */",
      "  if (act) { return; }",
      "  void api.chat.stream({});",
      "}",
    ].join("\n");
    expect(
      findBareSlimeApiAccess(bad, "synthetic.tsx").length,
      "注释被当成代码 ⇒ 这个取值点之后的**全部**裸访问被永久洗白"
        + "（preload 未就绪时整页白屏的老路又打开了，而门禁全绿）。",
    ).toBeGreaterThan(0);
  });

  it("自检：注释里出现 `api.xxx` 形状的说明不许误报（注释不是代码）", () => {
    const good = [
      "function f() {",
      "  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;",
      "  if (!api) { return; }",
      "  // 例如 api.chat.stream 这种用法",
      "  void api.chat.stream({});",
      "}",
    ].join("\n");
    expect(
      findBareSlimeApiAccess(good, "synthetic.tsx"),
      "注释里的 `api.xxx` 被当成真访问 ⇒ 守卫变成「狼来了」，下一个人会顺手把它删掉。",
    ).toEqual([]);
  });

  it("自检：字符串里的 `//` 不许吃掉同一行后面的守卫（否则会把合格代码判成违规）", () => {
    const good = [
      "function f() {",
      "  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;",
      "  const re = \"a//b\"; if (!api) { return; }",
      "  void api.chat.stream({});",
      "}",
    ].join("\n");
    expect(
      findBareSlimeApiAccess(good, "synthetic.tsx"),
      "把 `\"a//b\"` 里的 `//` 当行注释 ⇒ 同一行后面的 `if (!api)` 被吃掉 ⇒ 后续裸访问被误报。",
    ).toEqual([]);
  });

  it("自检：带 `?.` 的访问链**不是**裸访问（`api?.chat?.stream` 合法）", () => {
    const good = [
      "function f() {",
      "  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;",
      "  void api?.chat?.stream({});",
      "  void api?.files?.pick?.();",
      "}",
    ].join("\n");
    expect(
      findBareSlimeApiAccess(good, "synthetic.tsx"),
      "把带 `?.` 的链也算成裸访问 ⇒ 全仓几十处合格写法一起变红 ⇒ 守卫形同虚设（狼来了）。",
    ).toEqual([]);
  });

  it("自检：链**尾**没写 `?.` 但上游全程有 `?.`（`api?.x?.y().then(f).catch(g)`）也不算裸访问", () => {
    const good = [
      "function f() {",
      "  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;",
      "  void api?.tasks?.saveTodos?.(1, []).catch(() => {});",
      "  void api?.boot?.version?.().then((v: string) => setV(v)).catch(() => {});",
      "}",
    ].join("\n");
    expect(
      findBareSlimeApiAccess(good, "synthetic.tsx"),
      "只看最外层节点的 `?` ⇒ 链尾那个 `.catch`（本身没写 `?.`）被当成裸访问 ⇒ "
        + "本仓二十来处合法写法全被误报（实测踩到过：`chainRoot` 剥链时没看 `?.`，"
        + "`bareChain` 就是为它补的）。",
    ).toEqual([]);
  });

  it("自检：条件里的**裸**访问（`!act || … || !api.chat?.stream`）必须报 —— 它自己就会崩，不算守卫", () => {
    const bad = [
      "function f() {",
      "  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;",
      "  if (!act || !choice || !api.chat?.stream) { return; }",
      "  void api.chat.stream({});",
      "}",
    ].join("\n");
    const out = findBareSlimeApiAccess(bad, "synthetic.tsx");
    expect(
      out.length,
      "把「条件里裸访问 api」的复合条件当成守卫 ⇒ **恰恰是缺守卫的写法**被认成有守卫"
        + "（`api` 为 undefined 时该条件自己就抛 TypeError，正是 A-1019 ④ 的原病灶）。",
    ).toBeGreaterThan(0);
    expect(out[0], "应当报在**条件那一行**（崩在这里，不是等到后面那句）").toContain(":3");
  });

  it("自检：能力守卫（`typeof api?.usage?.recompute !== \"function\"`）要被承认（不误报）", () => {
    const good = [
      "function f() {",
      "  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;",
      "  if (typeof api?.usage?.recompute !== \"function\") { return; }",
      "  void api.usage.recompute();",
      "}",
    ].join("\n");
    expect(
      findBareSlimeApiAccess(good, "synthetic.tsx"),
      "不承认能力守卫 ⇒ 本仓既有的合法写法（先查能力、再调用）被误报 ⇒ 守卫变成「狼来了」。",
    ).toEqual([]);
  });

  it("自检：跨行取值点也要被识别（正则版只认单行 ⇒ 整个取值点从未被检查过）", () => {
    const good = [
      "function f() {",
      "  const api = (window as unknown as {",
      "    slimeAPI?: { usage?: { recompute?: () => void } };",
      "  }).slimeAPI;",
      "  if (typeof api?.usage?.recompute !== \"function\") { return; }",
      "  void api.usage.recompute();",
      "}",
    ].join("\n");
    expect(findBareSlimeApiAccess(good, "synthetic.tsx"), "跨行取值点本身应当被识别且合格").toEqual([]);

    const bad = [
      "function f() {",
      "  const api = (window as unknown as {",
      "    slimeAPI?: { usage?: { recompute?: () => void } };",
      "  }).slimeAPI;",
      "  void api.usage.recompute();",
      "}",
    ].join("\n");
    expect(
      findBareSlimeApiAccess(bad, "synthetic.tsx").length,
      "跨行取值点没有被识别 ⇒ 它之后的裸访问全部漏检（`UsageStatsPanel.tsx:692` 的真实形态）。",
    ).toBeGreaterThan(0);
  });
});
