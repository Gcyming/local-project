/**
 * tests/gui/a1104-async-iife-call.spec.ts — A-1104：`void (async () => {…})` **必须被调用**。
 *
 * 用户原话：「点击保存后，这个界面依旧一直停在这里，直接叉掉界面后，选中的模型也没有保存。」
 *
 * ## 根因
 *
 * `gui/src/renderer/pages/ResidentPanel.tsx` 的保存按钮，`onClick` 处理器写成了：
 *
 *     onClick={() => void (async () => { … })}          ← 少了尾部那一对括号
 *                                        ↑↑
 * 即「**构造**一个 async 函数 → `void` 掉 → **从不调用**」。于是 handler 体**一行都不执行**：
 *
 *   · 没有 `setModelModal(false)` ⇒ 弹层卡住不关（用户：界面一直停在这里）；
 *   · 没有 `subagentSetModels(…)` ⇒ 选中模型不落盘（用户：叉掉后选中的模型也没有保存）；
 *   · 没有异常、没有 reject、控制台**一个字都不报**。
 *
 * ⇒ 这是「**静默失效家族**」里最难查的一种：过 `tsc`、过构建、过全部逻辑测试，
 *   **只在用户眼里翻车**（A-1095 返工的总教训：门禁全绿 ≠ 用户看得见变化）。
 *
 * ## 为什么守卫必须查 AST 而不是 grep
 *
 * 缺陷与正确形态的差别只有**两个字符**（`})` vs `})()`），而 `void (async () => {…)()` 这种写法
 * 在仓库里有十几处、每处内容各不相同 —— 文本正则会既漏（换行/嵌套括号）又误伤（注释里写着旧写法）。
 * 只有语法树能确定地问出那句话：**`void` 的操作数是不是一个「从未被调用」的函数**。
 *
 * ## 判据（两条，全仓必须为 0）
 *
 *   ① `VoidExpression(ParenthesizedExpression(ArrowFunction | FunctionExpression))`
 *      —— 事故本体：`void` 掉一个从不调用的函数；
 *   ② `ExpressionStatement(ParenthesizedExpression(fn))`
 *      —— 同一族的另一种写法：裸 IIFE 从不调用（没有 `void`，但同样「构造了就扔」）。
 *
 *   对照项（必须 > 0，用来证明扫描真的读到了源码）：正确形态
 *   `VoidExpression(CallExpression(ParenthesizedExpression(fn)))`。
 *
 * ## 自检（§15①：检测器自己也会空转）
 *
 * 一个「永远返回 0 命中」的检测器，会以「守卫绿」的形式骗过所有人 —— 比没有守卫更危险。
 * 故本 spec 先喂**已知坏样本**（必须有命中）与**已知好样本**（必须零命中），两边都对上，
 * 才允许拿它去扫全仓。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 样本一律写在**字符串字面量**里：它们不会成为 AST 节点，故本文件被全仓扫描时
 *   不会自己触发自己（**不需要给自己开豁免** —— 开豁免的守卫会顺手把真缺陷也豁免掉）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 扫描根：只扫**手写源码**目录（`.js` 影子 / 产物目录一律不进 —— 影子会让整批假绿） */
const SCAN_ROOTS = ["gui/src", "core-ts/src", "gateway-ts/src", "shared", "tests"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", "release-linux", ".probe", ".slime-worktrees",
]);

export type Uncalled = { line: number; kind: string; snippet: string };
export type Scan = { uncalled: Uncalled[]; called: number };

const unwrapParens = (n: ts.Node): ts.Node => {
  let e: ts.Node = n;
  while (ts.isParenthesizedExpression(e)) { e = e.expression; }
  return e;
};
const isFnLike = (n: ts.Node): boolean => ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** `void (fn)()` / `void ((fn)())` —— 函数**被**调用了（正确形态） */
const isCalledFnOperand = (n: ts.Node): boolean =>
  ts.isCallExpression(n) || (ts.isParenthesizedExpression(n) && ts.isCallExpression(n.expression));

/**
 * 纯函数：给一段源码文本，返回其中「构造了却从不调用」的函数 IIFE 与「被调用」的计数。
 * 做成纯函数是为了让自检能直接喂样本 —— 不依赖任何文件。
 */
export function scanText(text: string, fileName: string): Scan {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const uncalled: Uncalled[] = [];
  let called = 0;
  const at = (node: ts.Node): Uncalled => {
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: p.line + 1, kind: "", snippet: node.getText(sf).split("\n")[0].trim().slice(0, 90) };
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVoidExpression(node)) {
      const operand = node.expression;
      if (isCalledFnOperand(operand)) {
        called += 1;
      } else if (ts.isParenthesizedExpression(operand) && isFnLike(unwrapParens(operand.expression))) {
        uncalled.push({ ...at(node), kind: "void-uncalled" });
      }
    } else if (
      ts.isExpressionStatement(node)
      && ts.isParenthesizedExpression(node.expression)
      && isFnLike(unwrapParens(node.expression))
    ) {
      uncalled.push({ ...at(node), kind: "bare-iife-uncalled" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { uncalled, called };
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync> = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith("_tmp")) { continue; }
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

export type RepoScan = { files: string[]; uncalled: (Uncalled & { file: string })[]; called: number };

export function scanRepo(): RepoScan {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const uncalled: (Uncalled & { file: string })[] = [];
  let called = 0;
  for (const f of files) {
    const r = scanText(readFileSync(f, "utf8"), f);
    called += r.called;
    for (const u of r.uncalled) {
      uncalled.push({ ...u, file: relative(ROOT, f).replace(/\\/g, "/") });
    }
  }
  return { files, uncalled, called };
}

/* ─────────────── ① 检测器自检：先喂已知样本 ─────────────── */

describe("A-1104 ① — 检测器自检（喂已知坏样本 + 已知好样本，两边都要对上）", () => {
  /* ⚠️ 这些样本是**字符串字面量**，不是代码 —— 故本 spec 被全仓扫描时不会自己触发自己。 */
  const BAD_VOID = `const f = () => { void (async () => { await g(); setOpen(false); }) };`;
  const GOOD_VOID = `const f = () => { void (async () => { await g(); setOpen(false); })() };`;
  const BAD_BARE = `const f = () => { (async () => { h(); }); };`;
  const GOOD_BARE = `const f = () => { (async () => { h(); })(); };`;

  it("S1 【事故本体形态】`void (async () => {…})` 缺调用 → 必须命中 1 处", () => {
    const r = scanText(BAD_VOID, "sample.ts");
    expect(r.uncalled.length,
      "检测器对**已知坏样本**都没反应 —— 它是个空转的检测器，"
      + "拿它去扫全仓只会给出『守卫绿』的假安全感（§15①）",
    ).toBe(1);
    expect(r.uncalled[0]?.kind).toBe("void-uncalled");
  });

  it("S2 非 async 的箭头 / 函数表达式被 `void` 掉不调用 → 同样命中", () => {
    const r = scanText(`const f = () => { void (() => { h(); }); void (function () { h(); }); };`, "sample.ts");
    expect(r.uncalled.length, "同族：`void` 掉一个从不调用的普通函数也是「构造了就扔」，一样什么都不执行").toBe(2);
  });

  it("S3 正确形态 `void (async () => {…})()` → 零命中，且计入对照计数", () => {
    const r = scanText(GOOD_VOID, "sample.ts");
    expect(r.uncalled.length, "把**正确**写法判成缺陷 = 假红，会逼着后来人删掉守卫").toBe(0);
    expect(r.called, "正确形态必须被计入 called 对照计数（T1 靠它证明遍历真的跑起来了）").toBe(1);
  });

  it("S4 尾随 `.catch` / 可选调用 / 双层括号包裹的调用 → 都算「已调用」，零命中", () => {
    const r = scanText(
      `void (async () => { h(); })().catch(() => {});`
      + `void (async () => { h(); })?.();`
      + `void ((async () => { h(); })());`,
      "sample.ts",
    );
    expect(r.uncalled.length, "这三种都是**真的调用了**，误判成缺陷 = 假红").toBe(0);
    expect(r.called).toBe(3);
  });

  it("S5 非函数目标（`void 0` / `void (x)` / `void (a && b)`）→ 既不命中也不算调用", () => {
    const r = scanText(`void 0; void (x); void (a && b);`, "sample.ts");
    expect(r.uncalled.length, "把 `void 0` 这种东西判成缺陷 = 假红").toBe(0);
    expect(r.called).toBe(0);
  });

  it("S6 形状②：裸 IIFE 从不调用（无 `void`）也必须命中；带调用的不命中", () => {
    expect(scanText(BAD_BARE, "sample.ts").uncalled.length,
      "形状②（`(async () => {…});` 从不调用）没被检测到 —— 那是同一族的另一种写法",
    ).toBe(1);
    expect(scanText(BAD_BARE, "sample.ts").uncalled[0]?.kind).toBe("bare-iife-uncalled");
    expect(scanText(GOOD_BARE, "sample.ts").uncalled.length, "`(async () => {…})();` 是调用过的，不许判成缺陷").toBe(0);
  });
});

/* ─────────────── ② 全仓：一处都不许有 ─────────────── */

const REPO = scanRepo();

describe("A-1104 ② — 全仓：函数 IIFE 一律必须被调用", () => {
  it("T1 扫描确实读到了源码 —— 防「零文件 ⇒ 零命中 ⇒ 假绿」", () => {
    expect(REPO.files.length,
      `只扫到 ${REPO.files.length} 个 .ts/.tsx（应 ≥ 150）—— 扫描根或遍历写坏了，`
      + "下面是 T2 的「零命中」就不再有任何意义",
    ).toBeGreaterThanOrEqual(150);
    expect(REPO.called,
      "全仓一处「被调用的 async IIFE」都没数到（对照值应 ≥ 10）—— 说明 AST 遍历没真正跑起来，"
      + "这时的 T2 绿是**假绿**",
    ).toBeGreaterThanOrEqual(10);
  });

  it("T2 【事故本体】全仓没有「构造了却从不调用」的函数 IIFE", () => {
    const list = REPO.uncalled
      .map((u) => `  · [${u.kind}] ${u.file}:${u.line}  ${u.snippet}`)
      .join("\n");
    expect(REPO.uncalled.length,
      `全仓有 ${REPO.uncalled.length} 处「构造了却从不调用」的 IIFE：\n${list}\n`
      + "这些 handler / 副作用体**一行都不会执行** —— 没有报错、没有异常，只有用户看到「点了没反应」。"
      + "正确写法是 `void (async () => { … })()`（**带尾部调用**）",
    ).toBe(0);
  });
});
