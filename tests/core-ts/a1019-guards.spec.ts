
























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


function isPropertyName(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) { return true; }
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === n) { return true; }
  if (ts.isQualifiedName(p) && p.right === n) { return true; }
  return false;
}






function isApiChain(e: ts.Expression, name: string): boolean {
  const root = chainRoot(e);
  return ts.isIdentifier(root) && root.text === name;
}

function unwrapParens(e: ts.Expression): ts.Expression {
  let c = e;
  while (ts.isParenthesizedExpression(c)) { c = c.expression; }
  return c;
}


function negated(e: ts.Expression): ts.Expression | null {
  const u = unwrapParens(e);
  return ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.ExclamationToken ? u.operand : null;
}









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

















function findBareInScope(node: ts.Node, name: string): number | null {
  let hit: number | null = null;
  const visit = (x: ts.Node): void => {
    if (hit !== null) { return; }
    if (ts.isPropertyAccessExpression(x) && bareChain(x)) {
      const root = chainRoot(x.expression);
      if (ts.isIdentifier(root) && root.text === name) { hit = x.getStart(); return; }
    }
    if (ts.isFunctionLike(x)) { return; }                 
    if (x !== node && ts.isBlock(x)) { return; }          
    ts.forEachChild(x, visit);
  };
  visit(node);
  return hit;
}









function findBareInCondition(e: ts.Expression, name: string): number | null {
  const u = unwrapParens(e);
  const o = orParts(u);
  const a = o ? null : andParts(u);
  const kids = o ?? a;
  if (kids) {
    const left = findBareInCondition(kids[0], name);
    if (left !== null) { return left; }
    
    const shorted = o ? truthyWhenApiMissing(kids[0], name) : falsyWhenApiMissing(kids[0], name);
    if (shorted) { return null; }
    return findBareInCondition(kids[1], name);
  }
  return findBareInScope(e, name);
}


function nestedScopes(n: ts.Node, out: ts.Node[] = []): ts.Node[] {
  ts.forEachChild(n, (c) => {
    if (ts.isBlock(c) || ts.isFunctionLike(c)) { out.push(c); }
    else { nestedScopes(c, out); }
  });
  return out;
}


function alwaysExits(s: ts.Statement): boolean {
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) { return true; }
  if (ts.isBlock(s)) {
    const last = s.statements[s.statements.length - 1];
    return !!last && alwaysExits(last);
  }
  return false;
}

























































function findBareSlimeApiAccess(src: string, rel = ""): string[] {
  const sf = ts.createSourceFile(rel || "x.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  
  function scanList(stmts: readonly ts.Statement[], name: string, declLine: number, guarded0: boolean): void {
    let guarded = guarded0;
    for (const s of stmts) {
      if (guarded) { return; }        
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
        

        if (alwaysExits(iff.thenStatement) && falsyProvesApi(cond, name)) { guarded = true; }
      } else {
        for (const c of nestedScopes(s)) { enter(c, guarded, name, declLine); }
      }
    }
  }

  
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
      const stmt = node.parent.parent;                 
      const container = stmt.parent;                   
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
