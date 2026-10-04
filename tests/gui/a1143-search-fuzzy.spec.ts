/**
 * tests/gui/a1143-search-fuzzy.spec.ts — 「近似项检索」的守卫（A-1143）。
 *
 * ## 用户原话
 * 「现在的搜索引擎只能**定向搜索符合所有文本**的内容……太死板了，有时候用户会记错一个/两个内容，
 *  比如 cloud 记成 clude、flare 记成 fare，所以现在引进近似项检索。」
 *
 * ## 权威标定（不是我拍的）
 * · Lucene `FuzzyQuery`：`maxEdits` **硬上限 2**（再大自动机会与大量词项相交 ⇒ 精度与性能双崩）；
 * · ES `fuzziness: AUTO`：长度 ≤2 → 0、3–5 → 1、>5 → 2；
 * · `prefix_length` / `max_expansions`（默认 50）是两项标准的剪枝旋钮；
 * · transpositions（Damerau，相邻换位算 1 次编辑）是 Lucene 的默认。
 * ⚠️ 实测标定用户举的两个例子：`flare→fare` = 1 次编辑、`cloud→clude` = 2 次
 *    （cloud → cloude → clude）⇒ AUTO 的「5 字给 1」覆盖不了，必须给到 2。
 *
 * ## ⚠️ 本组**最重要的**一条：精确命中的查询行为必须逐字不变
 * 用户选定的口径是「**精确优先，未命中才近似**」⇒ 全部词都精确命中时，
 * `effective` 与 `terms` 逐项相同、权重恒为 1 ⇒ 打分路径与 A-1138 的 Python 基准**逐字一致**
 * （既有的 golden 分数 / AND 优先守卫继续有效）。近似只作为**兜底**出现。
 *
 * ## ⚠️ 第二条：近似命中必须**看得见**
 * 用户搜的是 `clude`，命中的其实是 `cloud` —— 页面不提示就成了"索引里真有 clude"的假象
 * （铁律：降级要看得见）。所以结果里带回 `expansions`。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  DEFAULT_INDEX_OPTIONS,
  clampIndexOptions,
  editDistance,
  expandQueryTerms,
  buildIndex,
  searchIndex,
  type IndexOptions,
  type IndexedPage,
} from "../../core-ts/src/websearch/engine.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const mapOf = (ps: IndexedPage[]): Map<number, IndexedPage> => new Map(ps.map((p) => [p.id, p]));
const opts = (o: Partial<IndexOptions>): IndexOptions => ({ ...DEFAULT_INDEX_OPTIONS, ...o });

/* ══════════════ ① 编辑距离（Damerau–Levenshtein，带上界早停）══════════════ */

describe("A-1143 ① `editDistance`：与 Lucene 的相似度口径一致", () => {
  it("相同 ⇒ 0", () => {
    expect(editDistance("cloud", "cloud", 2)).toBe(0);
  });

  it("**用户举的两个例子**：`flare→fare` = 1、`cloud→clude` = 2", () => {
    expect(editDistance("flare", "fare", 2)).toBe(1);
    /* ⚠️ 这个 2 是「阈值必须给到 2」的实测依据：cloud → cloude（插入 e）→ clude（删掉 o）。 */
    expect(editDistance("cloud", "clude", 2)).toBe(2);
  });

  it("相邻换位算 **1** 次（Damerau；`teh`/`the` 是真实输入里最常见的错法）", () => {
    /* 经典 Levenshtein 会算成 2 ⇒ 用户打反两个字母反而搜不到。 */
    expect(editDistance("teh", "the", 2)).toBe(1);
    expect(editDistance("cludo", "cloud", 3)).toBeLessThanOrEqual(3);
  });

  it("`max` 是**上界**：超了返回 `max + 1`，不返回真实距离（词典逐个扫靠它保性能）", () => {
    expect(editDistance("cloud", "xxxxx", 2)).toBe(3);
    expect(editDistance("a", "abcdefgh", 2)).toBe(3);   // 长度差剪枝
  });
});

/* ══════════════ ② 精确优先：全部命中时**不改动**任何既有行为 ══════════════ */

describe("A-1143 ② 精确优先 ⇒ 既有结果逐字不变", () => {
  const pages: IndexedPage[] = [
    { id: 1, url: "https://a.test/1", title: "cloud", text: "cloud computing 云计算" },
    { id: 2, url: "https://a.test/2", title: "flare", text: "flare 火焰 云" },
  ];
  const idx = buildIndex(pages);

  it("全部词都精确命中 ⇒ `expansions` 为空、`effective` 与用户词逐项相同、权重恒 1", () => {
    const plan = expandQueryTerms(idx, ["cloud"], idx.opts);
    expect(plan.expansions).toEqual([]);
    expect(plan.effective).toEqual(["cloud"]);
    expect(plan.weight.get("cloud")).toBe(1);
    const r = searchIndex(idx, mapOf(pages), "cloud", 0, 10);
    expect(r.expansions).toEqual([]);
  });

  it("**与关闭近似的结果逐字一致**（这正是「默认开着却不影响老结果」的判据）", () => {
    const on = searchIndex(idx, mapOf(pages), "cloud", 0, 10);
    const off = searchIndex({ ...idx, opts: opts({ fuzzyMaxEdits: 0 }) }, mapOf(pages), "cloud", 0, 10);
    expect(on.items).toEqual(off.items);
  });
});

/* ══════════════ ③ 未命中才近似：真的能搜到"记错了的词" ══════════════ */

describe("A-1143 ③ 精确零命中时才找近似词", () => {
  const pages: IndexedPage[] = [{ id: 1, url: "https://a.test/1", title: "cloud", text: "cloud 云计算" }];
  const idx = buildIndex(pages);

  it("搜 `clude`（少写/写错字母）能命中 `cloud` 那一页", () => {
    const r = searchIndex(idx, mapOf(pages), "clude", 0, 10);
    expect(r.total).toBe(1);
    expect(r.items[0].url).toBe("https://a.test/1");
  });

  it("⚠️ **降级要看得见**：回包带 `expansions`，说清「没有精确匹配、按哪个词检索的」", () => {
    const r = searchIndex(idx, mapOf(pages), "clude", 0, 10);
    expect(r.expansions.length).toBeGreaterThan(0);
    expect(r.expansions[0]).toMatchObject({ from: "clude", to: "cloud", edits: 2 });
    /* ⚠️ `terms` 仍是**用户输入的词**（页面据此高亮/显示检索词），不许被替换成词典词。 */
    expect(r.terms).toEqual(["clude"]);
  });

  it("近似命中的分数**低于**同一个词精确命中（越像越靠前，永远不会盖过精确结果）", () => {
    const exact = searchIndex(idx, mapOf(pages), "cloud", 0, 10).items[0].score;
    const fuzzy = searchIndex(idx, mapOf(pages), "clude", 0, 10).items[0].score;
    expect(fuzzy).toBeGreaterThan(0);
    expect(fuzzy).toBeLessThan(exact);
  });

  it("关掉近似（`fuzzyMaxEdits: 0`）⇒ 记错的词就是搜不到（证明近似真的在起作用）", () => {
    const off = { ...idx, opts: opts({ fuzzyMaxEdits: 0 }) };
    expect(searchIndex(off, mapOf(pages), "clude", 0, 10).total).toBe(0);
  });

  it("太短的词**不**做近似扩展（中文 bigram / 2 字母词扩展全是噪音）", () => {
    const cn: IndexedPage[] = [{ id: 1, url: "https://a.test/cn", title: "", text: "上文 内容" }];
    const ci = buildIndex(cn);
    /* `上下` 与 `上文` 编辑距离 1，但词长 2 < fuzzyMinTermLen(3) ⇒ 不扩展 ⇒ 搜不到。 */
    expect(searchIndex(ci, mapOf(cn), "上下", 0, 10).total).toBe(0);
    /* 把门槛降到 2 ⇒ 立刻能扩展出来（证明挡它的是这个旋钮，不是别的）。 */
    const loose = { ...ci, opts: opts({ fuzzyMinTermLen: 2 }) };
    expect(searchIndex(loose, mapOf(cn), "上下", 0, 10).total).toBe(1);
  });

  it("候选封顶（`fuzzyMaxExpansions`）：词典里再多近似词也只取前 N 个", () => {
    const many: IndexedPage[] = ["clear", "clean", "cleat", "cleap", "cleas", "clead"]
      .map((w, i) => ({ id: i + 1, url: `https://a.test/${w}`, title: "", text: w }));
    const mi = buildIndex(many);
    /* `clea` 与上面每个词都是 1 次编辑 ⇒ 6 个候选；封顶 2 ⇒ 只取 2 个 ⇒ 命中页数 ≤ 2。
       ⚠️ 必须把参数钉在**索引自带那份**上（`searchIndex` 只读 `index.opts`，不接受调用方另传一份）；
       直接给 `expandQueryTerms` 传参数是另一条口径 —— 两者混用就是本仓反复警告的"两个产地"。 */
    const capped = { ...mi, opts: opts({ fuzzyMaxExpansions: 2 }) };
    const plan = expandQueryTerms(mi, ["clea"], opts({ fuzzyMaxExpansions: 2 }));
    expect(plan.expansions.length).toBe(2);
    expect(searchIndex(capped, mapOf(many), "clea", 0, 10).total).toBeLessThanOrEqual(2);
  });
});

/* ══════════════ ④ AND 优先仍按**用户输入的词**计数 ══════════════ */

describe("A-1143 ④ 近似命中要计入「用户那个词」，否则 AND 优先会静默失效", () => {
  /* ## 为什么要两个查询词 + `size = 1`（这条守卫的判据本身也是踩过坑才写对的）
     ① **一个查询词时"全命中"≡"命中"** ⇒ 每个命中页都是 `full`，AND 优先无从体现
        （第一版就是这么写的，守卫在错误实现上照样绿）；
     ② 让 `clou` 一个词扩展到**两个**词典词（cloud / clout）⇒ 正确实现里 pageA 的
        "覆盖的用户词数"仍是 1（那两个词同属 `clou`），而错误实现（直接数词典词）会数成 2 ⇒
        两个实现给出的 `full` 集合**不同**；
     ③ `size = 1` 让 `need = 1`：`full` 非空时排序**只输出 full** ⇒ 一旦判据写错、`full` 变空，
        结果第一位立刻从 pageA 变成"分数最高的那页"（pageB）⇒ 可观测。
     ④ pageA 是个**长文档**（BM25 被长度归一压下去）⇒ pageB 分数严格更高，
        否则"纯按分数"也恰好把 pageA 排第一，守卫又成了假绿。 */
  const pages: IndexedPage[] = [
    { id: 1, url: "https://a.test/both", title: "", text: "cloud clout other " + "x ".repeat(400) },
    { id: 2, url: "https://a.test/one", title: "", text: "other other other" },
    { id: 3, url: "https://a.test/cloud", title: "", text: "cloud" },
  ];
  const idx = buildIndex(pages);

  it("一个用户词扩展到多个词典词时，它仍只算**用户的这一个词**（AND 优先才不会失效）", () => {
    const all = searchIndex(idx, mapOf(pages), "clou other", 0, 10);
    /* 前提：纯按分数排，pageB（只覆盖 other）确实更高。 */
    const byScore = [...all.items].sort((a, b) => b.score - a.score);
    expect(byScore[0].url, "前提：部分命中的分数确实更高").toBe("https://a.test/one");
    /* 判据：pageA 覆盖了用户的**两个词** ⇒ 它是 full ⇒ size=1 时结果第一位就是它。 */
    const top = searchIndex(idx, mapOf(pages), "clou other", 0, 1);
    expect(top.items.length).toBe(1);
    expect(top.items[0].url, "覆盖全部用户词的页必须排第一").toBe("https://a.test/both");
  });
});

/* ══════════════ ⑤ 夹取：Lucene 的硬上限不许被调大 ══════════════ */

describe("A-1143 ⑤ `clampIndexOptions`：`fuzzyMaxEdits` 上限 = 2（Lucene 硬约束）", () => {
  it("填多大都被夹到 2；0 是合法值（= 关闭）", () => {
    expect(clampIndexOptions({ fuzzyMaxEdits: 99 }).fuzzyMaxEdits).toBe(2);
    expect(clampIndexOptions({ fuzzyMaxEdits: 0 }).fuzzyMaxEdits).toBe(0);
    expect(clampIndexOptions({}).fuzzyMaxEdits).toBe(2);
  });

  it("`fuzzyMinTermLen` / `fuzzyMaxExpansions` 有下界（不许被填成 0 把功能悄悄关掉）", () => {
    expect(clampIndexOptions({ fuzzyMinTermLen: 0 }).fuzzyMinTermLen).toBe(1);
    expect(clampIndexOptions({ fuzzyMaxExpansions: 0 }).fuzzyMaxExpansions).toBe(1);
    expect(clampIndexOptions({ fuzzyMaxExpansions: 9999 }).fuzzyMaxExpansions).toBe(200);
  });
});

/* ══════════════ ⑥ 接线：服务层把 `expansions` 透出去 ══════════════ */

describe("A-1143 ⑥ 接线：`/search` 回包必须带上 `expansions`", () => {
  it("服务层转发（不带 = 页面永远看不到「这是近似结果」）", () => {
    const svc = read("gui/src/main/searchIndexService.ts");
    expect(svc).toMatch(/expansions: r\.expansions/);
  });

  it("三个新参数进了面板的参数表（参数可调承诺不许半途而废）", () => {
    const panel = read("gui/src/renderer/pages/SearchIndexPanel.tsx");
    for (const k of ["fuzzyMaxEdits", "fuzzyMinTermLen", "fuzzyMaxExpansions"]) {
      /* ⚠️ 锚 `value={form.X}`（**输入框真的绑在这个字段上**），不许只锚标识符出现 ——
         后者在 `onChange` / 类型声明里到处都有，输入框被改成绑错字段时照样绿。 */
      expect(panel, `面板缺 ${k} 的输入项（或绑错了字段）`).toContain(`value={form.${k}}`);
    }
  });
});
