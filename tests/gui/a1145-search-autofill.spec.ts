





















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const PAGE = readFileSync(join(PROJECT_ROOT, "apps/local-search-engine/index.html"), "utf8");

const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
const fnBody = (name: string): string => {
  const i = CODE.indexOf(`function ${name}`);
  return i < 0 ? "" : CODE.slice(i, CODE.indexOf("\n  }", i));
};

describe("A-1145 ① 判据是**唯一一处**的纯函数", () => {
  it("`shouldCrawl` 存在，且三道闸门都在（索引在线 / 有结果 / 冷却）", () => {
    const fn = fnBody("shouldCrawl");
    expect(fn).not.toBe("");
    expect(fn).toContain("web.online");         
    expect(fn).toContain("items.length");       
    expect(fn).toContain("CRAWL_COOLDOWN_MS");  
  });

  it("冷却是**具名常量**，且取值有意义（不是「有个数字就算过」）", () => {
    const cd = Number((CODE.match(/var CRAWL_COOLDOWN_MS = (\d+);/) ?? [])[1]);
    
    expect(cd, "冷却为 0 ⇒ 等于没有冷却（每次搜索都发收录请求）").toBeGreaterThanOrEqual(5000);
  });
});

describe("A-1145 ② 收录挂在**联网路径之后**（可达落点）", () => {
  it("调用点在 `renderOnlineResults()` 之后（先给结果，再收录）", () => {
    expect(CODE).toMatch(/renderOnlineResults\(\);[\s\S]{0,400}?autoCrawlOnline\(r\.items, state\.query\);/);
  });

  it("⚠️ 不再挂在 `runWeb` 里（那里与「有联网能力」互斥 ⇒ 是永远不会执行的死分支）", () => {
    expect(CODE, "收录又被挂回 runWeb ⇒ 探针实测证明那里不可达")
      .not.toMatch(/renderWebResults\(\);[\s\S]{0,300}?autoCrawlOnline/);
  });

  it("⚠️ 收录**不覆盖**搜索结果（不许写 `el.resultList.innerHTML =`）", () => {
    expect(fnBody("autoCrawlOnline"), "收录把结果顶掉了 ⇒ 用户看不到刚搜到的东西")
      .not.toContain("el.resultList.innerHTML");
    expect(CODE).toMatch(/insertBefore\(box, el\.resultList\.nextSibling\)/);
  });
});

describe("A-1145 ③ 降级要看得见 + 只提交真地址", () => {
  it("如实说出「已提交收录」（下次同一个问题本地就能命中）", () => {
    expect(CODE).toContain("提交收录");
    expect(CODE).toContain("svc-note");
    
    expect(CODE).toMatch(/\.svc-note\s*\{/);
  });

  it("收录只提交**真 http(s) 地址**（别把站内路径 / 空串丢给爬虫）", () => {
    expect(CODE).toMatch(/https\?:\\\/\\\/\$?\/i\.test\(u\)/);
    const fn = fnBody("crawlSeeds");
    expect(fn).toContain("web.online");
    
    expect(fn).toContain("'/crawl'");
    expect(fn).toContain("method: 'POST'");
  });
});
