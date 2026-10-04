
























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



describe("A-1143 ① `editDistance`：与 Lucene 的相似度口径一致", () => {
  it("相同 ⇒ 0", () => {
    expect(editDistance("cloud", "cloud", 2)).toBe(0);
  });

  it("**用户举的两个例子**：`flare→fare` = 1、`cloud→clude` = 2", () => {
    expect(editDistance("flare", "fare", 2)).toBe(1);
    
    expect(editDistance("cloud", "clude", 2)).toBe(2);
  });

  it("相邻换位算 **1** 次（Damerau；`teh`/`the` 是真实输入里最常见的错法）", () => {
    
    expect(editDistance("teh", "the", 2)).toBe(1);
    expect(editDistance("cludo", "cloud", 3)).toBeLessThanOrEqual(3);
  });

  it("`max` 是**上界**：超了返回 `max + 1`，不返回真实距离（词典逐个扫靠它保性能）", () => {
    expect(editDistance("cloud", "xxxxx", 2)).toBe(3);
    expect(editDistance("a", "abcdefgh", 2)).toBe(3);   
  });
});



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
    
    expect(searchIndex(ci, mapOf(cn), "上下", 0, 10).total).toBe(0);
    
    const loose = { ...ci, opts: opts({ fuzzyMinTermLen: 2 }) };
    expect(searchIndex(loose, mapOf(cn), "上下", 0, 10).total).toBe(1);
  });

  it("候选封顶（`fuzzyMaxExpansions`）：词典里再多近似词也只取前 N 个", () => {
    const many: IndexedPage[] = ["clear", "clean", "cleat", "cleap", "cleas", "clead"]
      .map((w, i) => ({ id: i + 1, url: `https://a.test/${w}`, title: "", text: w }));
    const mi = buildIndex(many);
    


    const capped = { ...mi, opts: opts({ fuzzyMaxExpansions: 2 }) };
    const plan = expandQueryTerms(mi, ["clea"], opts({ fuzzyMaxExpansions: 2 }));
    expect(plan.expansions.length).toBe(2);
    expect(searchIndex(capped, mapOf(many), "clea", 0, 10).total).toBeLessThanOrEqual(2);
  });
});



describe("A-1143 ④ 近似命中要计入「用户那个词」，否则 AND 优先会静默失效", () => {
  









  const pages: IndexedPage[] = [
    { id: 1, url: "https://a.test/both", title: "", text: "cloud clout other " + "x ".repeat(400) },
    { id: 2, url: "https://a.test/one", title: "", text: "other other other" },
    { id: 3, url: "https://a.test/cloud", title: "", text: "cloud" },
  ];
  const idx = buildIndex(pages);

  it("一个用户词扩展到多个词典词时，它仍只算**用户的这一个词**（AND 优先才不会失效）", () => {
    const all = searchIndex(idx, mapOf(pages), "clou other", 0, 10);
    
    const byScore = [...all.items].sort((a, b) => b.score - a.score);
    expect(byScore[0].url, "前提：部分命中的分数确实更高").toBe("https://a.test/one");
    
    const top = searchIndex(idx, mapOf(pages), "clou other", 0, 1);
    expect(top.items.length).toBe(1);
    expect(top.items[0].url, "覆盖全部用户词的页必须排第一").toBe("https://a.test/both");
  });
});



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



describe("A-1143 ⑥ 接线：`/search` 回包必须带上 `expansions`", () => {
  it("服务层转发（不带 = 页面永远看不到「这是近似结果」）", () => {
    const svc = read("gui/src/main/searchIndexService.ts");
    expect(svc).toMatch(/expansions: r\.expansions/);
  });

  it("三个新参数进了面板的参数表（参数可调承诺不许半途而废）", () => {
    const panel = read("gui/src/renderer/pages/SearchIndexPanel.tsx");
    for (const k of ["fuzzyMaxEdits", "fuzzyMinTermLen", "fuzzyMaxExpansions"]) {
      

      expect(panel, `面板缺 ${k} 的输入项（或绑错了字段）`).toContain(`value={form.${k}}`);
    }
  });
});
