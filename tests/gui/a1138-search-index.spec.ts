/**
 * tests/gui/a1138-search-index.spec.ts — 「自建全网索引写进 slime」的守卫（A-1138）。
 *
 * ## 这一轮要解决的是什么
 * 用户要求「把这些进程写进 slime，而非接线」⇒ 原先的 Python 三件套
 * （`core/websearch/crawler.py` / `indexer.py` / `server.py`）被 TypeScript 实现取代：
 *   · 引擎（切分 / 倒排 / BM25）→ `core-ts/src/websearch/engine.ts`
 *   · 爬虫（BFS / robots / 正文抽取）→ `core-ts/src/websearch/crawler.ts`
 *   · 服务（`/health` `/status` `/search` `/crawl`）→ `gui/src/main/searchIndexService.ts`
 *
 * ## ⚠️ 判据为什么必须是「行为」而不是「有这个文件」
 *   · 引擎：直接比 **BM25 的数值行为**（标题加权、AND 优先、分页），
 *     不是"函数存在"—— 公式写错照样能跑，只是搜出来的顺序悄悄变了（静默失效）。
 *   · 爬虫：**注入假抓取器**，把「去重 / 深度 / 跳过扩展名 / robots」当行为测，
 *     真联网测的是网络不是爬虫。
 *   · 服务：**真起一个 HTTP 服务**并 fetch 它（端口用随机值避免碰撞），
 *     断言回包形状与 CORS —— 页面侧是零改动的，形状漂了页面只会"少一块"而不报错。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/* ── electron 替身：`searchIndexService` 注册 IPC 要用 `ipcMain`。
   用真 stub（忘了 mock 就抛）⇒ 必须显式提供。 ── */
const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn); } },
  app: { getPath: () => "" },
}));

import {
  tokenize,
  queryTerms,
  parseQuery,
  buildIndex,
  searchIndex,
  makeSnippet,
  indexStats,
  emptyIndex,
  SEARCH_ENGINE_NAME,
  DEFAULT_INDEX_OPTIONS,
  type IndexedPage,
} from "../../core-ts/src/websearch/engine.js";
import {
  normalizeUrl,
  hostOf,
  cleanText,
  extractPage,
  extractLinks,
  robotsAllows,
  crawl,
  SKIP_EXT_RE,
  type FetchPage,
} from "../../core-ts/src/websearch/crawler.js";
import {
  startSearchIndexService,
  stopSearchIndexService,
  searchIndexStatus,
  searchIndexSites,
  startSearchIndexCrawl,
  registerSearchIndexIpc,
  normalizeSeeds,
  rebuildSearchIndex,
  clearSearchIndex,
  removeSearchIndexSite,
  __resetSearchIndexForTest,
  SEARCH_INDEX_PORT,
} from "../../gui/src/main/searchIndexService.js";
import { IPC_CHANNELS } from "../../gui/src/shared/ipc.js";

/* ══════════════ ① 切分（行为基准 = Python `indexer.py::tokenize`）══════════════ */

describe("A-1138 ① 切分", () => {
  it("英文/数字按词、小写化", () => {
    expect(tokenize("Hello World 123")).toEqual(["hello", "world", "123"]);
  });

  /* ⚠️ 长度 2 的中文串会产出**重复** token：二元切分的结果恰好等于整词，
     Python 侧 `tokenize("搜索")` 同样是 `['搜索', '搜索']`（bigram 之后又 append 整词）。
     ⇒ 这里**故意不去重**：目标是逐字替代那份 Python 服务，行为一致优先于"看起来更干净"。
     改它 = 改 tf ⇒ 改 BM25 排序，属于行为变更。 */
  it("中文走二元切分；长度 ≤ 4 的中文串**额外保留整词**", () => {
    expect(tokenize("搜索")).toEqual(["搜索", "搜索"]);                 // 长度 2：bigram 与整词同一个 ⇒ 重复
    expect(tokenize("上下文")).toEqual(["上下", "下文", "上下文"]);      // 长度 3：二元 2 个 + 整词
    expect(tokenize("上下文压")).toEqual(["上下", "下文", "文压", "上下文压"]); // 长度 4：二元 3 个 + 整词
  });

  it("长度 > 4 的中文串**不**保留整词（否则索引会塞满长词）", () => {
    /* ⚠️「上下文压缩」是 **5** 个字 ⇒ 只有 4 个 bigram，没有整词
       （上一版这里按 4 个字写期望，是我数错了，不是实现错）。 */
    expect(tokenize("上下文压缩")).toEqual(["上下", "下文", "文压", "压缩"]);
    const t = tokenize("上下文压缩算法");
    expect(t).not.toContain("上下文压缩算法");
    expect(t[0]).toBe("上下");
  });

  it("中英混排两种规则各走各的（中文长度 2 ⇒ 整词重复一次，见上条）", () => {
    expect(tokenize("BM25 算法")).toEqual(["bm25", "算法", "算法"]);
  });

  it("queryTerms 去重**并保持顺序**（BM25 的「命中几个词」按这个集合算）", () => {
    expect(queryTerms("搜索 搜索 引擎")).toEqual(["搜索", "引擎"]);
  });
});

/* ══════════════ ② BM25：数值行为（改公式必然红）══════════════ */

describe("A-1138 ② BM25", () => {
  const pages: IndexedPage[] = [
    { id: 1, url: "https://a.test/1", title: "上下文压缩", text: "上下文压缩 论文 压缩 综述" },
    { id: 2, url: "https://a.test/2", title: "天气", text: "今天 天气 不错 天气 很好" },
    { id: 3, url: "https://a.test/3", title: "杂项", text: "压缩 算法 提到 一句 压缩" },
  ];
  const index = buildIndex(pages);
  const byId = new Map(pages.map((p) => [p.id, p]));

  it("索引形状：docs / df / 文档长度", () => {
    expect(index.docs).toBe(3);
    expect(index.df["压缩"]).toBe(2);
    expect(index.docLen["1"]).toBeGreaterThan(0);
    expect(indexStats(index)).toEqual({ pages: 3, terms: Object.keys(index.df).length });
  });

  it("命中即召回；不相关的页面不出现", () => {
    const r = searchIndex(index, byId, "天气", 0, 10);
    expect(r.total).toBe(1);
    expect(r.items[0].url).toBe("https://a.test/2");
  });

  it("**标题命中加权**：标题里有的排在只有正文命中的前面（TITLE_BOOST=3）", () => {
    const r = searchIndex(index, byId, "压缩", 0, 10);
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    expect(r.items[0].url).toBe("https://a.test/1"); // 标题命中 ⇒ 排第一
    expect(DEFAULT_INDEX_OPTIONS.titleBoost).toBe(3.0);
  });

  /* ⚠️ 必须比**数值**，不能只比排序：idf 的新旧两种写法（基准 `ln(1+(N-df+0.5)/(df+0.5))`
     与「常见写法」`ln(1+N/df)`）在「谁大谁小」上完全一致（都是 df 的减函数）⇒
     改了公式**排序不变**，只比顺序的守卫抓不住（实测 M8 存活）。 */
  it("**BM25 绝对分数**等于 Python 基准公式（改 idf / k1 / b / TITLE_BOOST 都会红）", () => {
    /* 单页单词语料 ⇒ 手算可核对：
         title="天气" text="天气" ⇒ tokenize 各出 2 个 token（bigram 恰等于整词）
         titleTf = bodyTf = 2 ⇒ docLen = 4、avdl = 4
         effTf = 2 + TITLE_BOOST(3)*2 = 8
         denom = 8 + K1(1.5)*(1 - B(0.75) + B(0.75)*4/4) = 9.5
         idf   = ln(1 + (1-1+0.5)/(1+0.5)) = 0.2876821
         score = 0.2876821 * (8*2.5) / 9.5 = 0.6056465… ⇒ 落盘前 round3 ⇒ 0.606 */
    const one: IndexedPage[] = [{ id: 1, url: "https://a.test/x", title: "天气", text: "天气" }];
    const ix = buildIndex(one);
    const hit = searchIndex(ix, new Map([[1, one[0]]]), "天气", 0, 10).items[0];
    expect(hit.score).toBeCloseTo(0.606, 3);
  });

  it("**AND 优先**：全命中的排在部分命中前面 —— 即使部分命中的 BM25 分更高", () => {
    /* ⚠️ 必须构造「部分命中的分数**更高**」的场景：否则 ordered=ranked 恰好也是同样的顺序，
       这条守卫就是假的（上一版用「上下文 压缩」测，中文长词根本产不出整词，
       全命中集合为空 ⇒ AND 分支从未被走到，M9 实测存活）。 */
    const ps: IndexedPage[] = [
      { id: 1, url: "https://a.test/both", title: "", text: "alpha beta " + "x ".repeat(200) },
      { id: 2, url: "https://a.test/alpha", title: "", text: "alpha ".repeat(60) },
      { id: 3, url: "https://a.test/beta", title: "", text: "beta" },
    ];
    const ix = buildIndex(ps);
    const bm = new Map(ps.map((p) => [p.id, p]));
    const r = searchIndex(ix, bm, "alpha beta", 0, 10);
    /* 先钉死前提：真按分数排，部分命中的 alpha-only 页确实压过全命中的 both 页。 */
    const byScore = [...r.items].sort((a, b) => b.score - a.score);
    expect(byScore[0].url, "前提：部分命中的分数确实更高").toBe("https://a.test/alpha");
    /* 再钉死 AND 优先：全命中的仍必须排第一。 */
    expect(r.items[0].url, "AND 优先必须压过分数").toBe("https://a.test/both");
    expect(r.total).toBe(3);
  });

  it("分页：`page` 是 0 基，`total` 是命中总数", () => {
    const all = searchIndex(index, byId, "压缩", 0, 10);
    const first = searchIndex(index, byId, "压缩", 0, 1);
    expect(first.items.length).toBe(1);
    expect(first.total).toBe(all.total);
    expect(searchIndex(index, byId, "压缩", 99, 10).items.length).toBe(0);
  });

  it("空查询 / 空库 ⇒ 空结果（不抛、不伪造）", () => {
    expect(searchIndex(index, byId, "", 0, 10).total).toBe(0);
    expect(searchIndex(emptyIndex(), byId, "天气", 0, 10).total).toBe(0);
  });

  it("item 形状与 Python `/search` 一致（页面零改动的前提）", () => {
    const it0 = searchIndex(index, byId, "天气", 0, 10).items[0];
    expect(Object.keys(it0).sort()).toEqual(["score", "snippet", "source", "title", "url"]);
    expect(it0.source).toBe("自建索引");
    expect(it0.url).toMatch(/^https?:/);
    expect(typeof it0.score).toBe("number");
  });

  it("BM25 参数与 Python 逐字一致（改了就是改检索结果）", () => {
    /* ⚠️ 锚 `DEFAULT_INDEX_OPTIONS`（唯一产地）：三个旧别名 `BM25_K1`/`BM25_B`/`TITLE_BOOST`
       已删除 —— 它们没有实现侧消费点，留着就是第二产地。 */
    expect(DEFAULT_INDEX_OPTIONS.k1).toBe(1.5);
    expect(DEFAULT_INDEX_OPTIONS.b).toBe(0.75);
  });

  it("摘要：以首个命中词为中心截断，两端补省略号", () => {
    const s = makeSnippet("x".repeat(300) + "天气" + "y".repeat(300), ["天气"]);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("天气");
    expect(s.length).toBeLessThan(300);
  });

  it("没命中时摘要退化为开头一段（不返回空）", () => {
    expect(makeSnippet("abcdefg", ["zzz"]).length).toBeGreaterThan(0);
    expect(makeSnippet("", ["zzz"])).toBe("");
  });
});

/* ══════════════ ③ 爬虫：注入假抓取器，测**行为** ══════════════ */

describe("A-1138 ③ 爬虫", () => {
  it("normalizeUrl：只留 http/https —— `file:` / `ws:` / `ftp:` 一律拒绝", () => {
    expect(normalizeUrl("HTTPS://Example.COM:8080/a/b/?x=1#frag")).toBe("https://example.com:8080/a/b?x=1");
    expect(normalizeUrl("https://a.test/")).toBe("https://a.test/");   // 根路径保留斜杠
    /* ⚠️ 三条各走**不同**的拒绝理由，缺一条就漏一类变异：
       · `ws:` —— 协议非 http(s) **且** host 非空 ⇒ **唯一**能钉住「协议白名单」的那条；
       · `file:` —— 会被 `!u.hostname` 兜住（file URL 无 host）⇒ 单独测它证明不了白名单；
       · `ftp:` —— 走白名单（"只拦 ftp、放过 file/ws" 的变异靠 `ws:` 那条抓）。 */
    expect(normalizeUrl("ftp://a.test/x")).toBeNull();
    expect(normalizeUrl("ws://a.test/socket")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("不是网址")).toBeNull();
    expect(hostOf("https://A.test/x")).toBe("a.test");
  });

  it("SKIP_EXT：图片/样式/脚本/归档一律跳过", () => {
    for (const u of ["https://a.test/x.png", "https://a.test/s.css", "https://a.test/a.js", "https://a.test/f.pdf"]) {
      expect(SKIP_EXT_RE.test(u), u).toBe(true);
    }
    expect(SKIP_EXT_RE.test("https://a.test/page")).toBe(false);
  });

  it("正文抽取：去掉 script/style，取到 title", () => {
    const { title, text } = extractPage(
      "<html><head><title>标题A</title><style>.x{color:red}</style></head>" +
      "<body><script>var a=1;</script><p>正文  内容</p></body></html>");
    expect(title).toBe("标题A");
    expect(text).toContain("正文 内容");
    expect(text).not.toContain("var a=1");
    expect(text).not.toContain("color:red");
  });

  it("extractLinks：相对链接转绝对，跳过 mailto/javascript", () => {
    const links = extractLinks(
      '<a href="/b">b</a><a href="https://x.test/c">c</a><a href="mailto:a@b.c">m</a><a href="javascript:void(0)">j</a>',
      "https://a.test/p");
    expect(links).toContain("https://a.test/b");
    expect(links).toContain("https://x.test/c");
    expect(links.some((l) => l.startsWith("mailto:"))).toBe(false);
    expect(links.some((l) => l.startsWith("javascript:"))).toBe(false);
  });

  it("robots：Disallow 命中则禁止；**取不到 robots 就放行**", () => {
    const txt = "User-agent: *\nDisallow: /private\n";
    expect(robotsAllows(txt, "https://a.test/private/x")).toBe(false);
    expect(robotsAllows(txt, "https://a.test/public")).toBe(true);
  });

  it("BFS：**入队即去重**（自链接不会把同一页反复抓）", async () => {
    const pages: Record<string, string> = {
      /* ⚠️ 自链接放**最前**：上一版把它放最后，maxPages 先到 ⇒ 重复项根本轮不到出队，
         「不去重」的变异溜了过去（实测 M21 存活）。 */
      "https://a.test/": '<a href="/">self</a><a href="/p1">1</a>',
      "https://a.test/p1": "<p>正文一</p>",
    };
    const seen: string[] = [];
    const fetchPage: FetchPage = async (url) => {
      seen.push(url);
      return pages[url] ? { ok: true, url, html: pages[url] } : { ok: false, url, error: "404" };
    };
    await crawl(fetchPage, { seeds: ["https://a.test/"], maxPages: 5, maxDepth: 2, delay: 0.3 });
    /* 自链接必须被去重（否则是"不报错的死循环"） */
    expect(seen.filter((u) => u === "https://a.test/").length).toBe(1);
  });

  it("BFS：**深度上限**（maxDepth=1 ⇒ 第 2 层不抓，且根本不去请求）", async () => {
    const pages: Record<string, string> = {
      "https://a.test/": '<a href="/l1">1</a>',
      "https://a.test/l1": '<a href="/l2">2</a><p>一层</p>',
      "https://a.test/l2": "<p>二层</p>",
    };
    const seen: string[] = [];
    const fetchPage: FetchPage = async (url) => {
      seen.push(url);
      return pages[url] ? { ok: true, url, html: pages[url] } : { ok: false, url, error: "404" };
    };
    const r = await crawl(fetchPage, { seeds: ["https://a.test/"], maxPages: 10, maxDepth: 1, delay: 0.3 });
    expect(r.pages.some((p) => p.url === "https://a.test/l1")).toBe(true);
    expect(r.pages.some((p) => p.url === "https://a.test/l2"), "第 2 层不该被抓").toBe(false);
    expect(seen).not.toContain("https://a.test/l2");
  });

  it("BFS：**跳过扩展名**（png/pdf 不进队 ⇒ 根本不去请求，且记 skipped 不静默丢）", async () => {
    const seen: string[] = [];
    const fetchPage: FetchPage = async (url) => {
      seen.push(url);
      if (url.endsWith("/robots.txt")) { return { ok: false, url, error: "no robots" }; }
      return { ok: true, url, html: '<a href="/img.png">i</a><a href="/doc.pdf">d</a><a href="/p">p</a><p>正文</p>' };
    };
    const r = await crawl(fetchPage, { seeds: ["https://a.test/"], maxPages: 10, maxDepth: 2, delay: 0.3 });
    expect(seen.some((u) => /\.(png|pdf)$/i.test(u)), "图片/PDF 一律不该被抓").toBe(false);
    expect(r.pages.some((p) => /\.(png|pdf)$/i.test(p.url))).toBe(false);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("robots 禁止的页面不抓（且记为 skipped，不是静默丢掉）", async () => {
    const fetchPage: FetchPage = async (url) => {
      if (url.endsWith("/robots.txt")) { return { ok: true, url, html: "User-agent: *\nDisallow: /secret" }; }
      return { ok: true, url, html: "<p>ok</p>" };
    };
    const r = await crawl(fetchPage, { seeds: ["https://a.test/secret"], maxPages: 5, delay: 0.3 });
    expect(r.fetched).toBe(0);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("cleanText 压缩空白", () => {
    expect(cleanText("a \n\t b   c")).toBe("a b c");
  });
});

/* ══════════════ ④ 服务：真起 HTTP，断言回包形状 ══════════════ */

describe("A-1138 ④ 内建服务（真起端口）", () => {
  let dir = "";
  let port = 0;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slime-idx-")); __resetSearchIndexForTest(); });
  afterEach(async () => {
    await stopSearchIndexService();
    __resetSearchIndexForTest();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  async function startAt(p: number) {
    const r = await startSearchIndexService({ userData: dir, port: p });
    port = p;
    return r;
  }

  it("`/health` 回 `{ok:true}` 且 **CORS 全开**（页面靠它跨源 fetch）", async () => {
    const s = await startAt(0);
    expect(s.ok).toBe(true);
    const res = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("空库也能起服务；`/search` 返回空而不是崩", async () => {
    const s = await startAt(0);
    const res = await fetch(`http://127.0.0.1:${s.port}/search?q=天气`);
    const j = await res.json() as { ok: boolean; total: number; items: unknown[] };
    expect(j.ok).toBe(true);
    expect(j.total).toBe(0);
    expect(j.items).toEqual([]);
  });

  it("`/search` 缺 q ⇒ 明确报错（不返回一堆空命中糊弄）", async () => {
    const s = await startAt(0);
    const j = await (await fetch(`http://127.0.0.1:${s.port}/search`)).json() as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain("缺少 q");
  });

  it("`/crawl` 缺 seed ⇒ 400（不是静默 200）", async () => {
    const s = await startAt(0);
    const res = await fetch(`http://127.0.0.1:${s.port}/crawl`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });

  it("端到端：注入假抓取器爬一页 ⇒ `/search` 真能搜到，`/status` 页数对得上", async () => {
    const fake: FetchPage = async (url) => {
      if (url.endsWith("/robots.txt")) { return { ok: false, url, error: "no robots" }; }  // 取不到 ⇒ 放行
      return { ok: true, url, html: "<html><head><title>咖啡指南</title></head><body><p>手冲咖啡与意式浓缩的区别</p></body></html>" };
    };
    const s = await startSearchIndexService({ userData: dir, port: 0, fetchPage: fake });
    port = s.port!;

    const started = await (await fetch(`http://127.0.0.1:${port}/crawl`, {
      method: "POST", body: JSON.stringify({ seed: "https://coffee.test/" }),
    })).json() as { ok: boolean; started: boolean };
    expect(started.ok).toBe(true);

    /* 爬取是后台任务 ⇒ 等它落定（最多 3 秒） */
    for (let i = 0; i < 30; i += 1) {
      const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { crawling: boolean; pages: number };
      if (!st.crawling && st.pages > 0) { break; }
      await new Promise((r) => setTimeout(r, 100));
    }

    const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { pages: number; terms: number; crawling: boolean; ok: boolean };
    expect(st.ok).toBe(true);
    expect(st.pages).toBe(1);
    expect(st.terms).toBeGreaterThan(0);
    expect(st.crawling).toBe(false);

    const r = await (await fetch(`http://127.0.0.1:${port}/search?q=咖啡`)).json() as {
      ok: boolean; engine: string; total: number; items: { url: string; title: string; snippet: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.engine).toBe(SEARCH_ENGINE_NAME);
    expect(r.total).toBe(1);
    expect(r.items[0].title).toBe("咖啡指南");
    expect(r.items[0].snippet).toContain("咖啡");

    /* 落盘持久化（重启后还在） */
    expect(existsSync(join(dir, "search-index", "pages.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, "search-index", "pages.json"), "utf8")) as { url: string }[];
    expect(saved.length).toBe(1);
    expect(saved[0].url).toBe("https://coffee.test/");
  });

  it("**端口被占用必须出声**（静默没起来 = 页面永远少一块，无人知晓）", async () => {
    const first = await startAt(0);
    expect(first.ok).toBe(true);
    __resetSearchIndexForTest();                      // 清掉进程内记录，但端口仍被占
    const second = await startSearchIndexService({ userData: dir, port: first.port });
    expect(second.ok).toBe(false);
    expect(second.error ?? "", "端口冲突必须给出可读原因").toContain("已被占用");
    port = first.port;                                 // 让 afterEach 关掉那个还活着的
    __resetSearchIndexForTest();
    await startAt(first.port);
  });

  it("停止是幂等的；状态里 `running` 反映真实情况", async () => {
    await startAt(0);
    expect(searchIndexStatus().running).toBe(true);
    expect((await stopSearchIndexService()).ok).toBe(true);
    expect(searchIndexStatus().running).toBe(false);
    expect((await stopSearchIndexService()).ok, "重复停止不该报错").toBe(true);
  });

  it("默认端口就是 8600（页面零改动的前提）", () => {
    expect(SEARCH_INDEX_PORT).toBe(8600);
  });

  /* ── A-1138：「一键收录」的渲染层入口（与 HTTP `/crawl` 共用同一套夹取 + 同一个后台任务）── */

  it("一键收录：**服务没起来 / 网址为空都要明确报错**（静默失败 = 用户以为在收了）", async () => {
    __resetSearchIndexForTest();
    const off = startSearchIndexCrawl("https://a.test/");
    expect(off.ok, "服务没起来还接受收录请求").toBe(false);
    expect(off.error ?? "").toContain("未启动");

    const s = await startSearchIndexService({ userData: dir, port: 0, fetchPage: async (url) => ({ ok: false, url, error: "no" }) });
    port = s.port!;
    const blank = startSearchIndexCrawl("   ");
    expect(blank.ok).toBe(false);
    expect(blank.error ?? "").toContain("网址");
  });

  it("一键收录：立刻返回（后台跑）；同一时刻**只允许一个**爬取任务", async () => {
    const fetchPage: FetchPage = async (url) => ({ ok: false, url, error: "no" });   // 全程抓不到 ⇒ 很快收敛
    const s = await startSearchIndexService({ userData: dir, port: 0, fetchPage });
    port = s.port!;
    const a = startSearchIndexCrawl("https://a.test/");
    expect(a.ok).toBe(true);
    /* ⚠️ 后台任务在 await 之前 `crawling` 已置真 ⇒ 紧接着的第二次提交必须被拒
       （否则两条爬取交错写 `state.pages` ⇒ 索引里出现重复/错乱，且**不报错**）。 */
    const b = startSearchIndexCrawl("https://b.test/");
    expect(b.ok).toBe(false);
    expect(b.error ?? "").toContain("进行中");
    await new Promise((r) => setTimeout(r, 30));   // 让它收敛，避免污染后一条用例
  });
});

/* ══════════════ ⑤ IPC：非主窗口一律拒绝 ══════════════ */

describe("A-1138 ⑤ IPC 判据", () => {
  it("非主窗口不能启停索引服务（否则任何页面都能起一个监听本机端口的服务）", async () => {
    handlers.clear();
    const dir = mkdtempSync(join(tmpdir(), "slime-idx-ipc-"));
    registerSearchIndexIpc({ userData: dir, port: 0, isMainSender: (s) => (s as { id?: number })?.id === 7 });
    try {
      const start = handlers.get(IPC_CHANNELS.search_index_start)!;
      expect((await start({ sender: { id: 999 } }) as { ok: boolean }).ok).toBe(false);
      expect((await handlers.get(IPC_CHANNELS.search_index_stop)!({ sender: { id: 999 } }) as { ok: boolean }).ok).toBe(false);
      expect(handlers.get(IPC_CHANNELS.search_index_status)!({ sender: { id: 999 } })).toBeNull();
      /* ⚠️ 必须断言**原因**而不只是 `ok===false`：去掉授权检查后，非主窗口会走到业务层，
         而此时服务恰好没起 ⇒ 同样返回 `{ok:false}` ⇒ 只判 ok 的话这条守卫是**假的**
         （实测 M31 存活）。判据 = error 里必须是「未授权」。 */
      const denied = await handlers.get(IPC_CHANNELS.search_index_crawl)!({ sender: { id: 999 } }, "https://a.test/") as { ok: boolean; error?: string };
      expect(denied.ok).toBe(false);
      expect(denied.error ?? "", "非主窗口必须被**授权**拦下，而不是碰巧因为服务没起").toContain("未授权");
      /* 主窗口放行（这条证明"拒绝"不是因为我传错了参数） */
      const st = handlers.get(IPC_CHANNELS.search_index_status)!({ sender: { id: 7 } }) as { running: boolean };
      expect(st).not.toBeNull();
      /* 主窗口那条也要**真的走到业务**（此时服务没起 ⇒ 应当是「未启动」而不是「未授权」） */
      const mainCrawl = await handlers.get(IPC_CHANNELS.search_index_crawl)!({ sender: { id: 7 } }, "https://a.test/") as { ok: boolean; error?: string };
      expect(mainCrawl.ok).toBe(false);
      expect(mainCrawl.error ?? "", "主窗口被误拒了（走的是授权分支还是业务分支必须能分清）").toContain("未启动");
      await stopSearchIndexService();
    } finally {
      __resetSearchIndexForTest();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  });
});

/* ══════════════ ⑥ 一键 UI：设置页那个面板（源码判据，同 A-1125 的做法）══════════════ */

describe("A-1138 ⑥ 一键 UI 接线", () => {
  const PAGE = (f: string): string => readFileSync(resolve(__dirname, "../../gui/src/renderer/pages", f), "utf8");
  const SETTINGS = PAGE("SettingsDialog.tsx");
  const PANEL = PAGE("SearchIndexPanel.tsx");

  it("设置页新增了「搜索索引」栏目，且**真的把面板渲染出来**（只加栏目不渲染 = 点进去空白）", () => {
    expect(SETTINGS).toContain('id: "searchengine", label: "搜索索引", group: "ops"');
    expect(SETTINGS).toContain('{activeTab === "searchengine" && <SearchIndexPanel />}');
  });

  it("面板接上了**七条**桥（启 / 停 / 收录 / 状态 / 重建 / 清空 / 删站）—— 少一条就有功能是死的", () => {
    for (const m of ["indexStart", "indexStop", "indexCrawl", "indexStatus", "indexRebuild", "indexClear", "indexRemoveSite"]) {
      expect(PANEL, `面板没调 ${m}`).toContain(m);
    }
  });

  it("**每个动作接的是自己那条桥**（串了桥的后果：点「重建索引」把整库清空）", () => {
    /* ⚠️ 只判"面板里出现过这些名字"不够 —— 把 `onRebuild` 接到 `indexClear` 上时，
       七个名字**一个都不少**。所以这里锚的是"哪个函数体调了哪条桥"。 */
    expect(PANEL, "重建接到了别的桥").toMatch(/const onRebuild = useCallback[\s\S]{0,400}?api\.indexRebuild\(\)/);
    expect(PANEL, "清空接到了别的桥").toMatch(/const onClear = useCallback[\s\S]{0,400}?api\.indexClear\(\)/);
    expect(PANEL, "删站接到了别的桥").toMatch(/const onRemoveSite = useCallback[\s\S]{0,400}?api\.indexRemoveSite\(host\)/);
  });

  it("**破坏性操作必须二次确认**（清空不可撤销；删站同理）—— 少一次确认就少一次手滑的后悔机会", () => {
    expect(PANEL, "清空没有二次确认").toMatch(/if \(n > 0 && !window\.confirm\(/);
    expect(PANEL, "删站没有二次确认").toMatch(/if \(!window\.confirm\(`确定删除站点/);
    /* 确认文案要带上**具体数字**（只说「确定吗」等于没确认）；`${n}` 是页数。 */
    expect(PANEL, "清空的确认没告诉用户会丢多少页").toContain("将删除已收录的 ${n} 个页面");
  });

  it("**失败必须把 error 落到界面**（端口被占用静默 ⇒ 用户永远不知道「为什么搜不到」）", () => {
    /* 判据不是"看着像"：必须存在「拿到结果 → 检查 ok → 用 error 反馈」这条链。 */
    expect(PANEL, "失败路径把 error 吞了").toMatch(/if \(!r\.ok\) \{ setNotice\(\{ ok: false, text: r\.error/);
  });

  it("**只在爬取中轮询**（停了还挂着定时器 = 空转白耗）", () => {
    expect(PANEL).toMatch(/if \(!st\?\.crawling\) \{ return; \}/);
    expect(PANEL, "轮询后的定时器没清（组件卸载/爬完仍在跑）").toContain("window.clearInterval(t)");
  });

  it("主进程**真的把线接上了**（注册 IPC + 启动服务）—— 删掉这两处，功能全没而门禁全绿", () => {
    /* ⚠️ 这是一处**没有任何其他守卫覆盖**的静默失效：`gui/src/main/index.ts` 里少一行，
       服务就永远不起、IPC 永远不注册；tsc / 单测 / 构建**全绿**（模块本身照样被 import）。
       产物层还有一道 `assert-bundle`，这里给一道更快的源码级信号。 */
    const MAIN = readFileSync(resolve(__dirname, "../../gui/src/main/index.ts"), "utf8");
    expect(MAIN, "没注册 IPC ⇒ 设置页那几个按钮全是死的").toContain("registerSearchIndexIpc({");
    expect(MAIN, "没启动服务 ⇒ 搜索页永远拿不到「自建索引 · 补充命中」")
      .toMatch(/startSearchIndexService\(\{\s*userData: app\.getPath\("userData"\)/);
    expect(MAIN, "启动失败被静默吞掉（必须留日志，否则「为什么搜不到」永远查不到）")
      .toContain("[gui:search-index] 自建索引服务未启动");
  });
});

/* ══════════════ ⑧ 查询语法（对照全网搜索引擎的**最小可用子集**）══════════════
 *
 * user 要求「以全网权威搜索引擎为参考，完善设定」。只做三种高频指令：
 * `"精确短语"` / `site:` / `-排除`。
 *
 * ⚠️ 判据为什么必须锚**行为**：
 *   · 三种指令都是**硬过滤**（不参与打分）⇒ 做错的后果是"某几页被悄悄多留/少留"，
 *     没有报错、也没有异常分数，用户在结果页上看不出任何一样东西不对；
 *   · `site:` 的"子域算不算命中"、排除词的"按原文还是按分词"都无法从函数签名看出来；
 *   · 尤其**反例**：`site:` 写错成前缀字符串比较时会**多**命中（`xample.com` 命中
 *     `example.com`），这类错误比"少命中"更难发现。
 */

describe("A-1139 ⑧ 查询语法", () => {
  /* 一页一个"考点"，避免多个过滤维度互相掩盖：短语有空格 / 短语只在标题 / 排除词命中 / 子域。 */
  const PAGES: IndexedPage[] = [
    { id: 1, url: "https://a.example.com/1", title: "手冲咖啡入门", text: "手冲 咖啡 的研磨与水温" },
    { id: 2, url: "https://b.other.com/2", title: "咖啡机评测", text: "手冲咖啡机，含广告合作" },
    { id: 3, url: "https://c.a.example.com/3", title: "测试机说明", text: "手冲 咖啡 的测试设备" },
    { id: 4, url: "https://b.other.com/4", title: "茶与咖啡", text: "与咖啡无关的内容" },
  ];
  const index = buildIndex(PAGES);
  const byId = new Map(PAGES.map((p) => [p.id, p]));
  const run = (q: string, size = 10) => searchIndex(index, byId, q, 0, size);
  const urls = (q: string): string[] => run(q).items.map((i) => i.url);

  it("解析：三种指令各归各位，剩下的才是正词（`site:` 里的协议 / `www.` / 路径都要去掉）", () => {
    const q = parseQuery('"手冲 咖啡" site:https://www.Example.com/x?a=1 -广告 -测试 咖啡');
    expect(q.phrases).toEqual(["手冲 咖啡"]);
    expect(q.site).toBe("example.com");
    expect(q.excludes).toEqual(["广告", "测试"]);
    expect(q.terms).toEqual(["咖啡"]);
  });

  it("**先摘短语、再分词**（顺序反了 ⇒ 短语里的空格会把 `-b` 变成排除指令）", () => {
    const q = parseQuery('"a -b c" site:x.com');
    expect(q.phrases).toEqual(["a -b c"]);
    expect(q.excludes, "短语内部的 `-b` 被当成了排除指令").toEqual([]);
    expect(q.site).toBe("x.com");
  });

  it("`site:` 没写值 ⇒ **不当指令**（不能静默变成「不限站点」还顺手把词也丢掉）", () => {
    const q = parseQuery("site:");
    expect(q.site).toBeNull();
    expect(q.terms).toEqual(["site"]);
  });

  it("短语按**原样子串**硬过滤（不分词；中间的空格必须对得上；标题里出现也算）", () => {
    /* 页 1 与页 3 的正文里有「手冲 咖啡」（**中间有空格**）。 */
    expect(urls('"手冲 咖啡"').sort()).toEqual(["https://a.example.com/1", "https://c.a.example.com/3"]);
    /* 页 2 的正文是「手冲咖啡机」（**没有空格**）⇒ 按子串判就不该命中（按分词判就会）。 */
    expect(urls('"手冲 咖啡"')).not.toContain("https://b.other.com/2");
    /* 只在**标题**里出现同样算命中（短语判据 = 标题 + 正文）。 */
    expect(urls('"手冲咖啡入门"')).toEqual(["https://a.example.com/1"]);
  });

  it("`-排除词` 按**原文子串**剔除（`-测试` 要能剔掉「测试机」—— 分词就剔不掉了）", () => {
    const got = urls("咖啡 -测试");
    expect(got, "「测试机」没被 `-测试` 剔掉").not.toContain("https://c.a.example.com/3");
    expect(got).toHaveLength(3);
  });

  it("`site:` 命中**子域**，且不是字符串前缀比较（`xample.com` 不能命中 `example.com`）", () => {
    expect(urls("site:example.com").sort()).toEqual(["https://a.example.com/1", "https://c.a.example.com/3"]);
    expect(urls("site:other.com").sort()).toEqual(["https://b.other.com/2", "https://b.other.com/4"]);
    expect(urls("site:xample.com"), "`site:` 退化成了字符串后缀比较").toEqual([]);
  });

  it("**只有过滤器、没有正词** ⇒ 全量扫描并按 id 倒序（新收录的排前面）", () => {
    /* 倒排索引只按词进，没有"按主机"或"按不包含"的入口 ⇒ 这条路必须是全扫。 */
    expect(urls("site:example.com")).toEqual(["https://c.a.example.com/3", "https://a.example.com/1"]);
    /* 没有过滤器的空查询 ⇒ 空结果（不能因为"全扫"就把整库倒出来）。 */
    expect(run("").total).toBe(0);
  });

  it("**硬过滤排在分页之前**（否则第 1 页被滤空了、第 2 页却还有东西）", () => {
    const one = run("site:example.com", 1);
    expect(one.total, "total 必须是**过滤后**的命中数").toBe(2);
    expect(one.items).toHaveLength(1);
    /* 不加重词时 `total` 是真正的命中总数（不是全库页数）。 */
    expect(run("咖啡").total).toBe(4);
    expect(run("site:example.com 咖啡").total, "过滤器没作用在候选集上").toBe(2);
  });
});

/* ══════════════ ⑨ 增量入库 / 去重 / 站点管理（真起服务 + 假抓取器）══════════════
 *
 * user 要求补齐的三条欠账：**多站点批量收录** / **索引重建** / **清空**（+ 按站删除）。
 * 这一组全部走 `state.pages` 的**真实读写**（不是纯函数）—— 因为真正的风险在这里：
 *   · 同一 URL 重复收录 ⇒ 索引里两条一样的结果（用户以为是"搜索质量差"）；
 *   · 跨 URL 同样内容（镜像/转载）⇒ 一页结果全是同一条；
 *   · 清空后 `fpTaken` 残留 ⇒ **同一篇再也收不进来**（索引永远是空的，且不报错）；
 *   · 按站删除后 `id` 不重编号 ⇒ 下一批新增**撞号**，`byId` 里一页被另一页顶掉（静默丢结果）。
 * 四条的共同点：**都不报错**，只能靠行为断言抓。
 */

describe("A-1139 ⑨ 增量入库与站点管理", () => {
  let dir = "";
  let port = 0;
  let calls = 0;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slime-idx-inc-")); __resetSearchIndexForTest(); calls = 0; });
  afterEach(async () => {
    await stopSearchIndexService();
    __resetSearchIndexForTest();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  /** 假抓取器：`body` 里没有的 URL ⇒ 404（用它精确控制"哪一页有什么内容"）。 */
  function fakeFetch(body: Record<string, string>): FetchPage {
    return async (url) => {
      calls += 1;
      if (url.endsWith("/robots.txt")) { return { ok: false, url, error: "no robots" }; }  // 取不到 ⇒ 放行
      const html = body[url];
      if (html === undefined) { return { ok: false, url, error: "404" }; }
      return { ok: true, url, html };
    };
  }
  const page = (title: string, text: string): string =>
    `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;

  async function start(body: Record<string, string>, fetchPage?: FetchPage) {
    const s = await startSearchIndexService({ userData: dir, port: 0, fetchPage: fetchPage ?? fakeFetch(body) });
    port = s.port!;
    expect(s.ok).toBe(true);
    return port;
  }
  /** 爬取是后台任务 ⇒ 等它落定（最多 5 秒）。 */
  async function waitIdle(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { crawling: boolean };
      if (!st.crawling) { return; }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("爬取没有在 5 秒内结束");
  }
  async function crawl(seeds: string[]): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${port}/crawl`, {
      method: "POST", body: JSON.stringify({ seeds, delay: 0.3 }),
    });
    expect(res.status).toBe(200);
    await waitIdle();
  }
  async function status(): Promise<{ pages: number; log: string[] }> {
    return await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { pages: number; log: string[] };
  }
  async function hitCount(q: string): Promise<number> {
    const j = await (await fetch(`http://127.0.0.1:${port}/search?q=${encodeURIComponent(q)}`)).json() as { total: number };
    return j.total;
  }
  /** 命中的第一条（判"结果指向的是不是那一页"必须看 url —— id 撞号时 URL 会指错）。 */
  async function topHit(q: string): Promise<{ url: string; title: string }> {
    const j = await (await fetch(`http://127.0.0.1:${port}/search?q=${encodeURIComponent(q)}`))
      .json() as { items: { url: string; title: string }[] };
    expect(j.items.length, `「${q}」一条都没搜到`).toBeGreaterThan(0);
    return j.items[0]!;
  }

  it("`normalizeSeeds`：按**换行/逗号/空格**切、逐条 `normalizeUrl`、去重（非法一律丢掉不抛）", () => {
    expect(normalizeSeeds("https://a.test/1\nhttps://a.test/2, https://a.test/1  ftp://x/ file:///c:/"))
      .toEqual(["https://a.test/1", "https://a.test/2"]);
    expect(normalizeSeeds(["https://b.test/", "   ", 42])).toEqual(["https://b.test/"]);
    /* 空输入返回空数组是**合法**的（"用户什么都没填"由调用方决定报什么错）。 */
    expect(normalizeSeeds("")).toEqual([]);
    expect(normalizeSeeds(undefined)).toEqual([]);
  });

  it("**同一 URL 再爬到 = 更新那一页**（不是又插一条）；内容一字未变 ⇒ 什么都不做", async () => {
    /* ⚠️ 换内容要换**没有共享 bigram** 的词（中文按二元切分：`正文甲`/`正文乙` 共享 `正文`，
       那样查旧词也会命中新页 —— 断言就成了假的）。 */
    const body = { "https://a.test/": page("标题甲", "苹果") };
    await start(body);

    await crawl(["https://a.test/"]);
    expect((await status()).pages).toBe(1);

    await crawl(["https://a.test/"]);                       // 同 URL、同内容
    expect((await status()).pages, "同一页被重复入库了").toBe(1);

    body["https://a.test/"] = page("标题甲", "橘子");         // 内容变了
    await crawl(["https://a.test/"]);
    const st = await status();
    expect(st.pages, "内容变了却当成新页插进来了").toBe(1);
    expect(st.log.join("\n")).toContain("更新 1 页");
    /* ⚠️ 判据不止"页数没涨"：内容必须**真的**被写进去（只改 title 不改 text 是最常见的半吊子更新）。 */
    expect(await hitCount("橘子"), "更新没写进正文").toBe(1);
    expect(await hitCount("苹果"), "旧内容还在索引里").toBe(0);
  });

  it("**不同 URL、同样内容 ⇒ 只留先收录的那份**（镜像 / 转载），并记进日志", async () => {
    const body = {
      "https://a.test/": page("同一篇", "同样的正文"),
      "https://a.test/mirror": page("同一篇", "同样的正文"),
    };
    await start(body);
    await crawl(["https://a.test/", "https://a.test/mirror"]);
    const st = await status();
    expect(st.pages, "镜像页被当成第二条录进来了 ⇒ 结果页全是同一条").toBe(1);
    expect(st.log.join("\n")).toContain("跳过重复内容 1");
  });

  it("**清空**：页数归零、站点列表清空、搜不到；且**指纹也要清**（否则同一篇再也收不进来）", async () => {
    const body = { "https://a.test/": page("标题甲", "正文甲") };
    await start(body);
    await crawl(["https://a.test/"]);
    expect((await status()).pages).toBe(1);

    const r = clearSearchIndex();
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(1);
    expect((await status()).pages).toBe(0);
    expect(searchIndexSites()).toEqual([]);
    expect(await hitCount("正文甲")).toBe(0);

    /* ⚠️ 这一条才是"清空"真正的坑：如果 `fpTaken` 没跟着清，重新收录**同一篇**会被
       当成"重复内容"整条丢掉 ⇒ 索引**永远是空的**，而且日志里写的是"跳过重复内容"。 */
    await crawl(["https://a.test/"]);
    expect((await status()).pages, "清空后同一篇再也收不进来了（指纹残留）").toBe(1);
    expect(await hitCount("正文甲")).toBe(1);
  });

  it("**重建**：不重新抓任何东西，但按当前页面重新落盘（否则下次启动就「丢了」）", async () => {
    const body = { "https://a.test/": page("标题甲", "正文甲") };
    await start(body);
    await crawl(["https://a.test/"]);
    const before = calls;

    /* 把落盘文件删掉 ⇒ 重建必须把它写回来（`savePages` 是重建的一半职责）。 */
    rmSync(join(dir, "search-index", "pages.json"), { force: true });
    const r = rebuildSearchIndex();
    expect(r).toMatchObject({ ok: true, pages: 1 });
    expect(calls, "重建去抓外网了 —— 重建 ≠ 重新收录").toBe(before);
    expect(existsSync(join(dir, "search-index", "pages.json")), "重建没有落盘").toBe(true);
    expect(await hitCount("正文甲"), "重建后索引反而搜不到了").toBe(1);
  });

  it("**按站删除**：删干净 + 站点列表更新 + **id 重新编号**（否则下一批新增撞号 ⇒ 静默丢页）", async () => {
    /* ⚠️ 故意让被删的那个站落在**中间**：剩下 [id1, id3] ⇒ 不重编号时下一批新增会算出 id3，
       与现存页**撞号**，`byId` 里一页被另一页顶掉 —— 表现为"某页搜不到了"，而日志一切正常。 */
    /* ⚠️ 各页用**无共享 bigram** 的词（中文二元切分下 `甲页面`/`乙页面` 共享 `页面` ⇒ 假命中）。 */
    const body = {
      "https://a.test/1": page("甲", "苹果"),
      "https://b.test/1": page("乙", "香蕉"),
      "https://a.test/2": page("丙", "橘子"),
    };
    await start(body);
    await crawl(["https://a.test/1", "https://b.test/1", "https://a.test/2"]);
    expect((await status()).pages).toBe(3);

    const r = removeSearchIndexSite("b.test");
    expect(r).toEqual({ ok: true, removed: 1 });
    expect((await status()).pages).toBe(2);
    expect(searchIndexSites().map((s) => s.host)).toEqual(["a.test"]);
    expect(await hitCount("香蕉"), "删掉的站还在结果里").toBe(0);

    /* 再收一页 ⇒ 三篇都必须还能搜到（撞号时其中一篇会消失）。 */
    body["https://c.test/1"] = page("丁", "西瓜");
    await crawl(["https://c.test/1"]);
    expect((await status()).pages).toBe(3);
    expect(await hitCount("苹果")).toBe(1);
    expect(await hitCount("橘子"), "id 撞号 ⇒ 这一页被顶掉了").toBe(1);
    expect(await hitCount("西瓜")).toBe(1);
    /* ⚠️ **页数对得上不等于没坏**：撞号时 `byId` 里那一条被后来的顶掉，于是搜索
       **把 A 的内容配上 B 的 URL** 返回 —— 页数、条数全都正常，点进去是错的。
       判据只能落到 `url` 上（`hitCount` 本身抓不住这个）。 */
    expect((await topHit("橘子")).url, "结果里的 url 指向了另一页（id 撞号）").toBe("https://a.test/2");
    expect((await topHit("苹果")).url).toBe("https://a.test/1");
    expect((await topHit("西瓜")).url).toBe("https://c.test/1");

    /* 找不到的域名 / 空域名：明确报错而不是静默 ok。 */
    expect(removeSearchIndexSite("  ").ok).toBe(false);
    expect(removeSearchIndexSite("nope.test")).toMatchObject({ ok: true, removed: 0 });
  });

  it("`/crawl` 兼容 `seed`（旧）与 `seeds`（新：数组或**多行文本**），回包带上归一后的清单", async () => {
    const body = { "https://a.test/1": page("甲", "甲的内容"), "https://a.test/2": page("乙", "乙的内容") };
    await start(body);

    const j = await (await fetch(`http://127.0.0.1:${port}/crawl`, {
      method: "POST", body: JSON.stringify({ seeds: "https://a.test/1\nhttps://a.test/2\nhttps://a.test/1" }),
    })).json() as { ok: boolean; seeds: string[] };
    expect(j.ok).toBe(true);
    expect(j.seeds, "多行文本没有归一化/去重").toEqual(["https://a.test/1", "https://a.test/2"]);
    await waitIdle();

    /* 旧的单数 `seed` 继续有效（页面那边只发它 —— 改坏了就是"已经能用的一键收录"失灵）。 */
    const one = await (await fetch(`http://127.0.0.1:${port}/crawl`, {
      method: "POST", body: JSON.stringify({ seed: "https://a.test/1" }),
    })).json() as { ok: boolean; seeds: string[] };
    expect(one.ok).toBe(true);
    expect(one.seeds).toEqual(["https://a.test/1"]);
    await waitIdle();
  });

  it("**真抓一个 GBK 站点 ⇒ 中文入库不乱码**（默认抓取器必须走 `decodeHtmlBytes`）", async () => {
    /* ⚠️ 这条用**真身**默认抓取器（不注入假实现）打一个本机 HTTP 服务 —— 因为要护的正是
       "响应体怎么解码"这一步：写成 `Buffer.concat(chunks).toString("utf8")` 时，
       GBK 页面会整页变成 `����` **入库且不报错**，只有搜「中国」搜不出来才看得出来。 */
    const gbk = Buffer.concat([
      Buffer.from('<html><head><meta charset="gb2312"><title>', "utf8"),
      Buffer.from([0xd6, 0xd0, 0xb9, 0xfa]),        // 「中国」的 GBK 字节
      Buffer.from("</title></head><body><p>", "utf8"),
      Buffer.from([0xd6, 0xd0, 0xb9, 0xfa]),        // 正文里也放一个
      Buffer.from("</p></body></html>", "utf8"),
    ]);
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(gbk);
    });
    await new Promise<void>((r) => { srv.listen(0, "127.0.0.1", () => r()); });
    const portAddr = (srv.address() as { port: number }).port;
    try {
      /* ⚠️ 这里**必须**不注入 `fetchPage`（显式走真身），否则测的就不是"响应体怎么解码"了。 */
      const s = await startSearchIndexService({ userData: dir, port: 0 });
      expect(s.ok).toBe(true);
      port = s.port!;
      /* 直接用真身服务收本机这一页（种子必须走真实请求路径）。 */
      const started = await (await fetch(`http://127.0.0.1:${port}/crawl`, {
        method: "POST", body: JSON.stringify({ seeds: [`http://127.0.0.1:${portAddr}/`] }),
      })).json() as { ok: boolean };
      expect(started.ok).toBe(true);
      await waitIdle();

      expect(await hitCount("中国"), "GBK 页面按 UTF-8 硬解了 ⇒ 整页变乱码入库").toBe(1);
      const j = await (await fetch(`http://127.0.0.1:${port}/search?q=${encodeURIComponent("中国")}`))
        .json() as { items: { title: string }[] };
      expect(j.items[0]?.title).toContain("中国");
    } finally {
      await new Promise<void>((r) => { srv.close(() => r()); });
    }
  });
});
