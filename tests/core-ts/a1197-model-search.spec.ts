import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");

const readText = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const PROVIDERS = "gui/src/renderer/pages/ProvidersPanel.tsx";

/**
 * A-1197：供应商模型列表的**搜索栏**（用户原话「在模型列表的正上方加一个搜索栏，
 * 专门搜索该供应商模型列表的模型」）。
 *
 * 这一批最危险的地方**不是**「搜不出来」，而是**搜出来之后改错模型**：
 * 表格里每一行的开关/上下文/定价都通过 `updateDraftModel(i, patch)` 按**原始数组下标**写回。
 * 过滤若重排了下标（典型写法 `rows.filter(...).map((x, j) => ({ ...x, i: j }))`），
 * 拨动开关就会改到**另一个模型**上 —— 而界面上那一行显示的仍是你以为的那个模型，
 * 属于**静默改错**（用户与守卫都看不出来）。所以本文件把「保留原始索引」钉成第一条不变量。
 *
 * 断言是**形状断言**（读源码 + 正则），不是运行时行为测试：React 交互在 node 环境下跑不起来。
 *
 * ⚠️ 词边界与剥注释的规矩（本项目四次前科）：
 *   · 计数字符串里若含 `(`，不转义会被当**捕获组** ⇒ 计数恒 0、断言永远绿；
 *   · 代码形状断言**必须先剥注释**，否则我们自己的说明性注释（里面大段提到这些标识符）会假命中。
 */

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countWord(src: string, word: string): number {
  const re = new RegExp(`(?<![\\w$])${escRe(word)}(?![\\w$])`, "g");
  return (src.match(re) ?? []).length;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const raw = readText(PROVIDERS);
const code = stripComments(raw);

/** 取出 `visibleModelRows` 的 useMemo 整体（含函数体），拿不到就返回空串。 */
function visibleRowsMemo(src: string): string {
  const m = /const\s+visibleModelRows\s*=\s*React\.useMemo\([\s\S]*?\},\s*\[edit,\s*modelQuery\]\);/.exec(src);
  return m ? m[0] : "";
}

describe("A-1197 模型搜索：① 保留原始索引（最危险的一条）", () => {
  it("过滤时每个候选都带着原始下标 i（不是过滤后重排的名次）", () => {
    const memo = visibleRowsMemo(code);
    expect(memo, "找不到 visibleModelRows 的 useMemo —— 搜索栏的过滤逻辑不见了").not.toBe("");
    // 造候选行时必须绑定原始下标
    expect(memo).toMatch(/edit\.models\.map\(\(m,\s*i\)\s*=>\s*\(\{\s*m,\s*i\s*\}\)\)/);
  });

  it("过滤后不许重排下标（出现 i: j 这类重编号 = 静默改错模型）", () => {
    const memo = visibleRowsMemo(code);
    expect(memo).not.toBe("");
    expect(memo).not.toMatch(/i:\s*j\b/);
    // 也禁止「先 filter 再 map 出新的 i」这种等价重排写法
    expect(memo).not.toMatch(/\.filter\([\s\S]*?\)\s*\.map\(\([^)]*,\s*j\)/);
  });

  it("type 上就写明带的是原始索引 i（防止日后有人把 i 改成序号）", () => {
    expect(code).toMatch(/Array<\{\s*m:\s*DraftModel;\s*i:\s*number\s*\}>/);
  });
});

describe("A-1197 模型搜索：② 表格渲染的是过滤后的行", () => {
  it("tbody 遍历 visibleModelRows，而不是全量 edit.models", () => {
    expect(code).toMatch(/visibleModelRows\.map\(\(\{\s*m,\s*i\s*\}\)\s*=>\s*\(/);
    const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(code);
    expect(tbody, "找不到 tbody").not.toBeNull();
    expect(tbody![1]).not.toMatch(/edit\.models\.map\(/);
  });
});

describe("A-1197 模型搜索：③ 搜索栏本体与清除入口", () => {
  it("有独立的搜索词 state 与输入框绑定", () => {
    expect(code).toMatch(/const\s+\[modelQuery,\s*setModelQuery\]\s*=\s*React\.useState\(""\)/);
    expect(code).toMatch(/value=\{modelQuery\}/);
    expect(code).toMatch(/onChange=\{\(e\)\s*=>\s*setModelQuery\(e\.target\.value\)\}/);
  });

  it("能清除搜索词（否则用户会卡在一个再也搜不到东西的框里）", () => {
    // ≥2：一处是「换编辑目标时重置」，一处是「清除」按钮 —— 只留一处都算这条不变量破了
    expect(countWord(code, 'setModelQuery("")')).toBeGreaterThanOrEqual(2);
  });

  it("搜索栏独占一行并贴在 sticky 表头里（长列表滚动时仍可见）", () => {
    expect(code).toMatch(/flexBasis:\s*"100%"/);
    expect(code).toMatch(/position:\s*"sticky"/);
  });
});

describe("A-1197 模型搜索：④ 边界情形（假象比缺失更糟）", () => {
  it("换编辑目标时清空搜索词（否则下一个供应商会「莫名没有模型」）", () => {
    expect(code).toMatch(/React\.useEffect\(\(\)\s*=>\s*\{\s*setModelQuery\(""\);\s*\},\s*\[edit\?\.key,\s*edit\?\.mode\]\)/);
  });

  it("搜不到时给出显式说明（空白表格会被误读成「该供应商没有模型」）", () => {
    expect(code).toMatch(/visibleModelRows\.length\s*===\s*0\s*&&/);
  });

  it("匹配大小写不敏感，且过滤过程不触碰配置", () => {
    const memo = visibleRowsMemo(code);
    expect(memo).not.toBe("");
    // ⚠️ 必须**逐个锚** id 与 label 的 toLowerCase：只断言「memo 里出现过 toLowerCase()」会被
    // `modelQuery.trim().toLowerCase()` 那一行救活 —— 实测 M6（去掉 id/label 的降大小写）会**存活**。
    expect(memo).toMatch(/String\(m\.id \?\? ""\)\.toLowerCase\(\)/);
    expect(memo).toMatch(/String\(\(m as \{ label\?: string \}\)\.label \?\? ""\)\.toLowerCase\(\)/);
    // 过滤只筛「显示哪些行」，绝不能回头去 setEdit（那会把筛选变成一次配置变更）
    expect(memo).not.toMatch(/setEdit\(/);
  });

  it("计数文案给的是「筛出数 / 总数」（让用户知道自己看的是子集）", () => {
    expect(code).toMatch(/visibleModelRows\.length\}\s*\/\s*\{edit\.models\.length\}/);
  });
});
