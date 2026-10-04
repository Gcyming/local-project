/**
 * tests/gui/a1145-search-autofill.spec.ts — 「联网结果 → 自动收录（越用越准）」的守卫（A-1145）。
 *
 * ## 用户原话
 * 「每次用户搜索后，调度相关功能全网检索、爬取相关、相似内容，按相关性排列，最符合要求的
 *  放在第一位，依次类推，直到检索完全网相关项。」
 *
 * ## ⚠️ 落点是**探针逼出来的**，不是当初想当然的那个
 * 第一版把「本地命中不足 ⇒ 联网补量」挂在 `runWeb`（本地索引路径）里；而 `runWeb` 只在
 * **没有内核**（`!online.hostReady`）时才被调用，补量判据却要求「有联网能力」⇒ 两条互斥 ⇒
 * **那个分支任何情况下都不会执行**。`gui/scripts/probe-search-autofill.mjs` 实测坐实了这一点
 * （变体 A：`/crawl` 0 次）。
 * ⇒ 真正缺的那一层是：**联网命中的网页收进本地索引**（用户说的「爬取」）⇒ 落点改到
 *   `runOnline` 出结果之后。有内核时页面本来就在走实时联网，不需要再"补联网"。
 *
 * ## 本组断言分两层（形状 + 真页面探针）
 * 被改动对象是**独立页面**（跑在右栏 webview 里、不是模块）⇒ vitest 加载不到它的函数。
 *   · 这里 = **形状断言**（锁住"改坏了就一定是事故"的不变量）；
 *   · 运行时行为由 `probe-search-autofill.mjs` 用**真 Electron + 真页面 + 真 preload + 假索引服务**
 *     验证：**13/13**（收录真的发出 `/crawl`、只收 http 地址、无内核时不收、**冷却只发一次**）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const PAGE = readFileSync(join(PROJECT_ROOT, "apps/local-search-engine/index.html"), "utf8");
/** 剥掉注释后再切片（⚠️ 顺序反了就会"按未剥注释的下标去切已剥注释的文本" ⇒ 切到别的函数体上）。 */
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
const fnBody = (name: string): string => {
  const i = CODE.indexOf(`function ${name}`);
  return i < 0 ? "" : CODE.slice(i, CODE.indexOf("\n  }", i));
};

describe("A-1145 ① 判据是**唯一一处**的纯函数", () => {
  it("`shouldCrawl` 存在，且三道闸门都在（索引在线 / 有结果 / 冷却）", () => {
    const fn = fnBody("shouldCrawl");
    expect(fn).not.toBe("");
    expect(fn).toContain("web.online");         // 索引没连 ⇒ 不发收录请求
    expect(fn).toContain("items.length");       // 没有结果 ⇒ 没什么可收
    expect(fn).toContain("CRAWL_COOLDOWN_MS");  // 同一查询有冷却
  });

  it("冷却是**具名常量**，且取值有意义（不是「有个数字就算过」）", () => {
    const cd = Number((CODE.match(/var CRAWL_COOLDOWN_MS = (\d+);/) ?? [])[1]);
    /* ⚠️ 只断言 `= \d+` 是不够的：把冷却改成 0 照样绿（本组前身实测踩过）。必须断言**取值本身**。 */
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
    /* 这一行必须有样式，否则它跟结果卡片糊在一起，等于没说 */
    expect(CODE).toMatch(/\.svc-note\s*\{/);
  });

  it("收录只提交**真 http(s) 地址**（别把站内路径 / 空串丢给爬虫）", () => {
    expect(CODE).toMatch(/https\?:\\\/\\\/\$?\/i\.test\(u\)/);
    const fn = fnBody("crawlSeeds");
    expect(fn).toContain("web.online");
    /* ⚠️ 带引号锚（`'/crawl'`）：只写 `/crawl` 的话 `/crawler` 也算「包含」⇒ 假绿。 */
    expect(fn).toContain("'/crawl'");
    expect(fn).toContain("method: 'POST'");
  });
});
