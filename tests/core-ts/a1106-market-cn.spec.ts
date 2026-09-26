/**
 * tests/core-ts/a1106-market-cn.spec.ts — A-1106 续：MCP 广场的**中文可用性**。
 *
 * ## 用户报障
 *
 *   「官方 MCP 全是英文，太不能用了」
 *
 * ## 两层原因（第二层比第一层更致命）
 *
 *   ① **语言**：registry 的 `description` 是英文原文，卡片上连"这是什么类别"都没有中文线索。
 *   ② **检索**：检索词此前是**把用户的中文原样 URL 编码**发给上游 ⇒ 上游搜不到任何东西
 *      ⇒ 中文用户只有"看字母序前 60 条长尾"（`ac.` / `ad.` / `agency.` 开头）这一条路。
 *      **只翻译语言不修检索，等于让人看一堆翻成中文的垃圾。**
 *
 * ## 判据一句话
 *
 *   · 中文输入必须被展开成**上游认得的英文检索词**，且**永不静默**（未收录要说出来）；
 *   · 卡片必须显示**中文类别标签**（只加标签，不翻译整句 —— 避免半中半英的怪句子）；
 *   · registry 结果**不许**再拿用户的中文输入做本地二次过滤（必空 —— 这就是"修一个坏一个"）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandMarketQuery,
  localizeServerTags,
  MARKET_CN_TO_EN,
  MARKET_QUERY_MAX_TERMS,
  MARKET_TAG_MAX,
} from "../../core-ts/src/services/marketLocalize.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再断言（注释里会**故意**写出旧写法，不剥就是假红或假绿） */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

/* ═════════════════ H 组：中文 → 英文检索词展开 ═════════════════ */

describe("A-1106 H 组 — 中文输入必须被展开成上游认得的英文检索词", () => {
  it("H1 纯中文「浏览器」⇒ 检索词含 browser（此前是把中文原样发给上游 ⇒ 搜不到）", () => {
    const e = expandMarketQuery("浏览器");
    expect(e.terms).toContain("browser");
    expect(e.query).toContain("browser");
    expect(e.mapped).toBe(true);
    expect(e.unrecognized).toBe(false);
  });

  it("H2 各主要类别都能展开（数据库 / 文件 / 搜索 / 地图 / 记忆 / 表格）", () => {
    expect(expandMarketQuery("数据库").terms).toContain("database");
    expect(expandMarketQuery("文件").terms).toContain("filesystem");
    expect(expandMarketQuery("搜索").terms).toContain("search");
    expect(expandMarketQuery("地图").terms).toContain("maps");
    expect(expandMarketQuery("记忆").terms).toContain("memory");
    expect(expandMarketQuery("表格").terms).toContain("spreadsheet");
  });

  it("H3 口语输入也能命中（子串包含，不引分词器）", () => {
    const e = expandMarketQuery("我要找个浏览器自动化的");
    expect(e.terms).toContain("browser");
    expect(e.terms).toContain("automation");
    expect(e.unrecognized).toBe(false);
  });

  it("H4 英文输入原样透传（英文用户不受影响）", () => {
    const e = expandMarketQuery("playwright");
    expect(e.terms).toEqual(["playwright"]);
    expect(e.query).toBe("playwright");
    expect(e.mapped, "纯英文不该被标成「中文展开」").toBe(false);
    expect(e.unrecognized).toBe(false);
  });

  it("H5 混合输入去重（browser + 浏览器 ⇒ 只留一个 browser）", () => {
    const e = expandMarketQuery("browser 浏览器");
    expect(e.terms).toEqual(["browser"]);
    expect(e.mapped, "有中文命中就该标 mapped").toBe(true);
  });

  it("H6 ⚠️ 入参非空 ⇒ query **永不为空**（永不发明、也永不发一个空检索词）", () => {
    for (const s of ["浏览器", "playwright", "量子纠缠", "  x  ", "数据库123"]) {
      const e = expandMarketQuery(s);
      expect(e.query.length, `「${s}」的检索词不能为空`).toBeGreaterThan(0);
    }
  });

  it("H7 空输入 ⇒ 全空且无任何标记（不发请求的语义）", () => {
    expect(expandMarketQuery("")).toEqual({ query: "", terms: [], raw: "", mapped: false, unrecognized: false });
    expect(expandMarketQuery("   ").query).toBe("");
    expect(expandMarketQuery("   ").unrecognized).toBe(false);
  });

  it("H8 ⚠️ 未收录的纯中文 ⇒ `unrecognized=true` 且检索词退回原输入（**不许静默**）", () => {
    const e = expandMarketQuery("量子纠缠");
    expect(e.unrecognized, "没认出来必须说出来 —— 否则用户只看到「搜了没结果」").toBe(true);
    expect(e.terms).toEqual([]);
    expect(e.query, "退回原输入（不发明一个检索词骗用户）").toBe("量子纠缠");
  });

  it("H9 检索词数量封顶（多了上游多半按 AND 收窄到 0 条）", () => {
    const e = expandMarketQuery("浏览器 文件 数据库 搜索 地图 记忆");
    expect(e.terms.length).toBeLessThanOrEqual(MARKET_QUERY_MAX_TERMS);
    expect(e.terms.length).toBe(MARKET_QUERY_MAX_TERMS);
  });

  it("H10 ⚠️ 词典键一律 ≥ 2 个汉字（单字键会被「云南」这类无关输入误命中）", () => {
    for (const [cn] of MARKET_CN_TO_EN) {
      expect(cn.length, `词典键「${cn}」太短 —— 会被无关输入子串命中`).toBeGreaterThanOrEqual(2);
    }
  });

  it("H11 词典值一律是 ASCII（上游只认英文）", () => {
    for (const [, en] of MARKET_CN_TO_EN) {
      expect(/^[a-z][a-z0-9. -]*$/i.test(en), `词典值「${en}」含非 ASCII —— 上游搜不到`).toBe(true);
    }
  });
});

/* ═════════════════ I 组：中文类别标签 ═════════════════ */

describe("A-1106 I 组 — 卡片必须给出中文类别标签（registry 描述是英文原文）", () => {
  it("I1 浏览器自动化类（playwright / puppeteer 的真实描述）", () => {
    expect(localizeServerTags("ac.example/playwright-mcp", "Browser automation: navigate, click, screenshot"))
      .toContain("浏览器自动化");
  });

  it("I2 数据库 / 代码仓库 / 联网搜索", () => {
    expect(localizeServerTags("x", "Query a SQLite database")).toContain("数据库");
    expect(localizeServerTags("x", "GitHub repository and pull request tools")).toContain("代码仓库");
    expect(localizeServerTags("x", "Web search via Brave")).toContain("联网搜索");
  });

  it("I3 名字里带关键词也算（name + description 一起判）", () => {
    expect(localizeServerTags("ac.inference.sh/mcp", "Run 150+ AI apps")).toEqual([]);
    expect(localizeServerTags("google-maps-server", "geocoding and places")).toContain("地图位置");
  });

  it("I4 大小写不敏感，且**更具体的规则优先**（browser 只给「浏览器」，playwright 才给「浏览器自动化」）", () => {
    expect(localizeServerTags("x", "BROWSER AUTOMATION")).toContain("浏览器");
    expect(localizeServerTags("x", "browser")).toEqual(["浏览器"]);
    expect(localizeServerTags("x", "PLAYWRIGHT browser driver")).toContain("浏览器自动化");
  });

  it("I5 ⚠️ 没命中 ⇒ **空数组**（不许编造、也不许塞一个「其他」当装饰）", () => {
    expect(localizeServerTags("zzz", "qqq www eee")).toEqual([]);
    expect(localizeServerTags("", "")).toEqual([]);
  });

  it("I6 标签数量封顶（多了把卡片布局撑坏）", () => {
    const tags = localizeServerTags("x", "browser automation with sqlite database, web search, images, calendar, finance");
    expect(tags.length).toBeLessThanOrEqual(MARKET_TAG_MAX);
    expect(tags.length).toBe(MARKET_TAG_MAX);
  });

  it("I7 标签不重复（同一类别被多条规则命中时也只出一个）", () => {
    // filesystem / directory / folder 三条都映射「文件读写」⇒ 只许出一个
    expect(localizeServerTags("x", "filesystem directory folder access")).toEqual(["文件读写"]);
  });
});

/* ═════════════════ J 组：接线（唯一出处 + 不许本地二次过滤）═════════════════ */

const CFG = stripComments(readSrc("gui/src/main/config_files.ts"));
const MCP = stripComments(readSrc("gui/src/renderer/pages/McpPanel.tsx"));

describe("A-1106 J 组 — 接线：检索词展开在 main、标签在渲染层、本地过滤必须放过 registry", () => {
  it("J1 main 必须用 expandMarketQuery 构造上游检索词（不许把原始输入直接发出去）", () => {
    expect(CFG).toContain("const expanded = expandMarketQuery(query ?? \"\");");
    expect(CFG).toContain("const q = expanded.query;");
    expect(
      CFG,
      "又拿原始输入当检索词了 —— 中文会被原样 URL 编码发给上游（搜不到任何东西）",
    ).not.toContain("const q = (query ?? \"\").trim();");
  });

  it("J2 main 必须回带 appliedQuery（界面要如实显示真正搜的是什么）", () => {
    expect(CFG).toContain("appliedQuery: q,");
    expect(CFG).toContain("...(expanded.unrecognized ? { unrecognized: true } : {}),");
  });

  it("J3 ⚠️ registry 结果**不许**用中文输入做本地二次过滤（否则中文搜索稳定显示没找到）", () => {
    expect(MCP, "registry 模式必须跳过本地过滤").toContain("const filtered = !useRegistry && q");
  });

  it("J4 registry 卡片必须算中文标签，且那是唯一出处（不许内联一套关键词）", () => {
    expect(MCP).toContain("tags: localizeServerTags(s.displayName, s.description),");
    expect(countOf(MCP, "localizeServerTags("), "调用点必须恰好一处").toBe(1);
    expect(
      MCP,
      "标签规则不许在组件里再写一份（两个产地 = 改一处漏一处）",
    ).not.toMatch(/\/\(\?:.*browser.*\)\/i/);
  });

  it("J5 标签必须真的**渲染出来**（内置精选的 tags 此前是死数据：定义了却从没显示）", () => {
    expect(MCP).toContain("{(item.tags ?? []).length > 0 && (");
    expect(MCP).toContain("{(item.tags ?? []).map((t) => (");
  });

  it("J6 界面上不许再出现英文 `registry` 标记（用户报的就是英文）", () => {
    expect(MCP).toContain(">官方目录</span>");
    expect(MCP, "卡片上的英文 registry 标记回来了").not.toContain("fontWeight: 600 }}>registry</span>");
    expect(MCP).toContain("官方目录 ${filtered.length}");
  });

  it("J7 说明文必须如实显示「实际检索词」与「没认出来」（两条都不许静默）", () => {
    expect(MCP).toContain("（实际检索词：${registryApplied}）");
    expect(MCP).toContain("未收录「${registryQuery}」对应的英文关键词");
    expect(MCP).toContain("useRegistry ? `官方目录没有与「${registryQuery}」");
  });

  it("J8 IPC 契约两端都要有 appliedQuery / unrecognized（否则渲染层拿不到）", () => {
    const preload = stripComments(readSrc("gui/src/preload/index.ts"));
    expect(countOf(preload, "appliedQuery?: string; unrecognized?: boolean;"), "两处类型镜像都要更新").toBe(2);
  });
});
