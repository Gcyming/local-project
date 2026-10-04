/**
 * tests/gui/a1140-search-params.spec.ts — 「分词 / 正文参数可调」的守卫（A-1140）。
 *
 * ## 这一轮补的是哪一笔欠账
 * 用户要求把「多站点批量收录 / **分词·正文参数可调** / 索引重建·清空」补齐，并
 * **以全网权威搜索引擎为参考**完善设定。A-1138/A-1139 已经落了收录、去重、重建、清空、删站；
 * 这一轮落的是**参数可调**：
 *   · 分词 / 打分参数 → `core-ts/src/websearch/engine.ts` 的 `IndexOptions`（对齐 Lucene 的
 *     analyzer + `BM25Similarity(k1, b)`）；
 *   · 正文参数       → `core-ts/src/websearch/crawler.ts` 的 `BodyOptions`（正文质量闸 + 长度闸）；
 *   · 生效面         → `gui/src/main/searchIndexService.ts`（落盘 / 夹取 / 改完即重建）+ 设置页面板。
 *
 * ## ⚠️ 这一组守护的是「**静默失效**」，不是"功能有没有"
 * 参数这类东西最坏的地方在于：**改坏了不报错**。
 *   · 索引与查询用了两套分词口径 ⇒ 命中数永远 0（用户以为"加了停用词之后搜不到了"）；
 *   · 夹取写成 `v > 0 ? v : d` ⇒ `k1=0` / `b=0` / `titleBoost=0` 被悄悄打回默认（看着没改）；
 *   · 改完参数不重建 ⇒ 新参数只对**之后**收录的页生效，同一个库里两套口径。
 * 三条都不会抛异常，只能靠**行为断言**抓。
 *
 * ## ⚠️ 默认值 = 行为基准
 * 不改参数的用户，检索结果必须与 A-1138 逐字一致（那是与 `core/websearch/indexer.py` 对齐的
 * Python 基准）。所以第一条就是「默认值不许漂」。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/* ── electron 替身：服务层注册 IPC 要用 `ipcMain`（真 stub：忘了 mock 就抛）。 ── */
const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn); } },
  app: { getPath: () => "" },
}));

import {
  DEFAULT_INDEX_OPTIONS,
  clampIndexOptions,
  tokenize,
  queryTerms,
  buildIndex,
  searchIndex,
  emptyIndex,
  type IndexedPage,
} from "../../core-ts/src/websearch/engine.js";
import {
  DEFAULT_BODY_OPTIONS,
  clampBodyOptions,
  crawl,
  type FetchPage,
} from "../../core-ts/src/websearch/crawler.js";
import {
  startSearchIndexService,
  stopSearchIndexService,
  startSearchIndexCrawl,
  searchIndexStatus,
  getSearchIndexParams,
  setSearchIndexParams,
  __resetSearchIndexForTest,
} from "../../gui/src/main/searchIndexService.js";
import { IPC_CHANNELS } from "../../gui/src/shared/ipc.js";

const mapOf = (ps: IndexedPage[]): Map<number, IndexedPage> => new Map(ps.map((p) => [p.id, p]));
/** 剥掉注释（铁律：形状断言先剥注释 —— 否则文档里提到的标识符会让断言假绿）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ══════════════ ① 默认值就是行为基准 ══════════════ */

describe("A-1140 ① 默认参数 = 行为基准（改默认值 = 改所有人的检索结果）", () => {
  it("`DEFAULT_INDEX_OPTIONS` 逐字等于 Python 基准；**打分口径只有这一处**", () => {
    expect(DEFAULT_INDEX_OPTIONS).toEqual({
      k1: 1.5, b: 0.75, titleBoost: 3.0, wholeWordMaxLen: 4, minTermLen: 1, stopwords: [],
      /* A-1143：后面三个是**查询期**参数（近似检索），Python 侧没有这份能力。
         它们默认开着**不影响**既有结果 —— `expandQueryTerms` 只在"某个词精确零命中"时才展开。 */
      fuzzyMaxEdits: 2, fuzzyMinTermLen: 3, fuzzyMaxExpansions: 50,
    });
    /* ⚠️ 三个旧常量（`BM25_K1` / `BM25_B` / `TITLE_BOOST`）已**删除**：
       它们在实现里没有任何消费点（打分读 `o.k1` / `o.b` / `o.titleBoost`），只剩 spec 的
       `toBe` 断言撑着 ⇒ 是纯测试面出口、第二产地的种子。留着就会出现"默认值看着没变、
       打分却变了"这类最难查的回归。⇒ 判据改为：**不许有人把它们加回来**。 */
    const ENGINE_CODE = stripComments(
      readFileSync(resolve(__dirname, "../../core-ts/src/websearch/engine.ts"), "utf8"),
    );
    for (const alias of ["BM25_K1", "BM25_B", "TITLE_BOOST"]) {
      expect(ENGINE_CODE, `\`${alias}\` 又回来了 ⇒ 打分口径出现两个产地`).not.toContain(alias);
    }
  });

  it("不传参数时与显式传默认值**逐字一致**（旧调用点行为不变）", () => {
    expect(tokenize("上下文压缩")).toEqual(tokenize("上下文压缩", DEFAULT_INDEX_OPTIONS));
    expect(queryTerms("上下文压缩")).toEqual(queryTerms("上下文压缩", DEFAULT_INDEX_OPTIONS));
    /* ⚠️ 默认值必须真的**落到索引上**（`SearchIndex.opts`）—— 否则检索会拿默认口径去查
       一份用别的口径建的倒排（命中数永远 0，且不报错）。 */
    expect(buildIndex([]).opts).toEqual(DEFAULT_INDEX_OPTIONS);
    expect(emptyIndex().opts).toEqual(DEFAULT_INDEX_OPTIONS);
  });

  it("`DEFAULT_BODY_OPTIONS` 等于旧行为：只挡空正文、不截断", () => {
    expect(DEFAULT_BODY_OPTIONS).toEqual({ minBodyChars: 1, maxBodyChars: 0 });
  });
});

/* ══════════════ ② 参数夹取（唯一产地）══════════════ */

describe("A-1140 ② 参数夹取（越界不许静默变味）", () => {
  it("越界夹到**边界**（既不原样接受，也不回默认值）", () => {
    expect(clampIndexOptions({ k1: 99 }).k1).toBe(3);
    expect(clampIndexOptions({ b: -1 }).b).toBe(0);
    expect(clampIndexOptions({ titleBoost: 99 }).titleBoost).toBe(10);
    expect(clampIndexOptions({ wholeWordMaxLen: 99 }).wholeWordMaxLen).toBe(8);
    expect(clampIndexOptions({ minTermLen: 0 }).minTermLen).toBe(1);
    expect(clampIndexOptions({ minTermLen: 99 }).minTermLen).toBe(5);
  });

  it("⚠️ `0` 是**合法值**，不许被当成「没填」", () => {
    /* 这是这类夹取最经典的洞：`v > 0 ? v : 默认` 会把这三个 0 全部打回默认，
       而它们都是有意义的（k1=0 ⇒ 分数退化成纯 idf；b=0 ⇒ 不做长度归一；titleBoost=0 ⇒ 标题不计分）。
       打回默认之后界面上**看不出任何区别** —— 用户只会觉得"这个参数没反应"。 */
    expect(clampIndexOptions({ k1: 0 }).k1).toBe(0);
    expect(clampIndexOptions({ b: 0 }).b).toBe(0);
    expect(clampIndexOptions({ titleBoost: 0 }).titleBoost).toBe(0);
    expect(clampIndexOptions({ wholeWordMaxLen: 0 }).wholeWordMaxLen).toBe(0);
  });

  it("缺省 / 空串 / 非数字 ⇒ 回**默认值**（不是回 0）", () => {
    expect(clampIndexOptions(undefined)).toEqual(DEFAULT_INDEX_OPTIONS);
    expect(clampIndexOptions({})).toEqual(DEFAULT_INDEX_OPTIONS);
    expect(clampIndexOptions({ k1: "", b: null, titleBoost: "abc" })).toEqual(DEFAULT_INDEX_OPTIONS);
  });

  it("停用词：去空 / 小写 / 去重 / 超长丢弃 / 条数封顶", () => {
    expect(clampIndexOptions({ stopwords: [" 的 ", "的", "We", "  ", "x".repeat(21)] }).stopwords)
      .toEqual(["的", "we"]);
    expect(clampIndexOptions({ stopwords: "不是数组" }).stopwords).toEqual([]);
    expect(clampIndexOptions({ stopwords: Array.from({ length: 300 }, (_, i) => `w${i}`) }).stopwords)
      .toHaveLength(200);
  });

  it("夹取是**幂等**的（夹过再夹一次必须一样，否则重启一次变一次）", () => {
    const once = clampIndexOptions({ k1: 99, b: -1, stopwords: ["A", "a"] });
    expect(clampIndexOptions(once)).toEqual(once);
    const bodyOnce = clampBodyOptions({ minBodyChars: -5, maxBodyChars: 9_999_999 });
    expect(clampBodyOptions(bodyOnce)).toEqual(bodyOnce);
  });

  it("`clampBodyOptions`：越界夹取 / 缺省回默认 / `0` 合法", () => {
    expect(clampBodyOptions({ minBodyChars: -5 }).minBodyChars).toBe(0);
    expect(clampBodyOptions({ maxBodyChars: 9_999_999 }).maxBodyChars).toBe(100_000);
    expect(clampBodyOptions(undefined)).toEqual(DEFAULT_BODY_OPTIONS);
    expect(clampBodyOptions({ minBodyChars: 0 }).minBodyChars, "0 = 不设闸，是合法值").toBe(0);
  });
});

/* ══════════════ ③ 分词参数真的改变切分 ══════════════ */

describe("A-1140 ③ 分词参数", () => {
  it("`wholeWordMaxLen` 控制中文整词：0 ⇒ 只留二元", () => {
    expect(tokenize("上下文压", { ...DEFAULT_INDEX_OPTIONS, wholeWordMaxLen: 0 }))
      .toEqual(["上下", "下文", "文压"]);
    /* ⚠️ 必须用 **≤ 4 字** 的短语当反例：5 字以上在**默认参数下本来就不保留整词**，
       拿它做对照的话，无论实现怎么写都"一致"（等价变异体，白测）。 */
    expect(tokenize("上下文压"), "默认 wholeWordMaxLen=4 时要保留整词").toContain("上下文压");
  });

  it("`minTermLen` 只作用于**英文/数字**（中文单字照旧保留）", () => {
    const o = { ...DEFAULT_INDEX_OPTIONS, minTermLen: 6 };
    expect(tokenize("hello 天气", o), "短英文词没被丢掉").not.toContain("hello");
    expect(tokenize("hello 天气", o), "中文被误伤").toContain("天气");
    expect(tokenize("hello 天气")).toContain("hello");
  });

  it("停用词在**索引侧与查询侧同时**剔除（只剔一边 ⇒ 永远搜不到，且不报错）", () => {
    const o = { ...DEFAULT_INDEX_OPTIONS, stopwords: ["我们"] };
    expect(tokenize("我们 上下文", o)).toEqual(["上下", "下文", "上下文"]);
    expect(queryTerms("我们 上下文", o)).toEqual(["上下", "下文", "上下文"]);
    /* 英文停用词走同一套（小写比较 ⇒ `The` 与 `the` 一起剔）。 */
    const en = { ...DEFAULT_INDEX_OPTIONS, stopwords: ["the"] };
    expect(tokenize("The alpha", en)).toEqual(["alpha"]);
  });
});

/* ══════════════ ④ 索引自描述：检索与建索引永远同口径 ══════════════ */

describe("A-1140 ④ 参数挂在索引上（`SearchIndex.opts`）", () => {
  it("`buildIndex` 把参数**钉在索引上**（不是丢掉、也不是复制一份默认值）", () => {
    const o = { ...DEFAULT_INDEX_OPTIONS, k1: 2.2, stopwords: ["压缩"] };
    expect(buildIndex([], o).opts).toBe(o);
  });

  it("⚠️ 查询侧用的是**索引自带**那份参数（判据：停用词把查询词也剔光了）", () => {
    const ps: IndexedPage[] = [{ id: 1, url: "https://a.test/1", title: "压缩技术", text: "压缩 算法 说明" }];
    const o = { ...DEFAULT_INDEX_OPTIONS, stopwords: ["压缩"] };

    const r = searchIndex(buildIndex(ps, o), mapOf(ps), "压缩", 0, 10);
    /* 建索引时「压缩」被当停用词剔掉 ⇒ 查询侧也剔 ⇒ 一个查询词都不剩 ⇒ 空结果。
       若 `searchIndex` 拿的是**默认**参数（stopwords 为空），这里会返回 1 条命中。 */
    expect(r.terms, "查询侧没剔停用词 ⇒ 它用的不是索引自带的那份参数").toEqual([]);
    expect(r.total).toBe(0);

    /* 反过来：同一个库用默认参数建 ⇒ 搜得到。两条一起才证明"参数真的来自索引"。 */
    expect(searchIndex(buildIndex(ps), mapOf(ps), "压缩", 0, 10).total).toBeGreaterThan(0);
  });

  it("⚠️ 第二个可区分输入：`wholeWordMaxLen`（防止只对停用词特判就算通过）", () => {
    const ps: IndexedPage[] = [{ id: 1, url: "https://a.test/1", title: "", text: "上下文压 入门" }];
    const r = searchIndex(buildIndex(ps, { ...DEFAULT_INDEX_OPTIONS, wholeWordMaxLen: 0 }), mapOf(ps), "上下文压", 0, 10);
    expect(r.terms, "查询侧切出了整词 ⇒ 它没读索引自带的分词参数").toEqual(["上下", "下文", "文压"]);
    expect(searchIndex(buildIndex(ps), mapOf(ps), "上下文压", 0, 10).terms).toContain("上下文压");
  });
});

/* ══════════════ ⑤ 打分参数真的改变分数 ══════════════ */

describe("A-1140 ⑤ 打分参数（改了必须真的改结果）", () => {
  it("`b = 0` ⇒ 关掉长度归一：同 tf 的两页分数**相同**（默认 b=0.75 时短页更高）", () => {
    const ps: IndexedPage[] = [
      { id: 1, url: "https://a.test/1", title: "", text: "alpha" },
      { id: 2, url: "https://a.test/2", title: "", text: "alpha beta beta beta beta beta" },
    ];
    const m = mapOf(ps);
    const off = searchIndex(buildIndex(ps, { ...DEFAULT_INDEX_OPTIONS, b: 0 }), m, "alpha", 0, 10).items;
    expect(off).toHaveLength(2);
    expect(off[0]!.score, "b=0 时长度不该再影响分数").toBe(off[1]!.score);

    const on = searchIndex(buildIndex(ps), m, "alpha", 0, 10).items;
    expect(on[0]!.score, "开了长度归一时短文应当更高").toBeGreaterThan(on[1]!.score);
  });

  it("`titleBoost = 0` ⇒ 标题不再参与打分（只在标题里出现的那页**掉出结果**）", () => {
    const ps: IndexedPage[] = [
      { id: 1, url: "https://a.test/1", title: "alpha", text: "beta" },
      { id: 2, url: "https://a.test/2", title: "beta", text: "alpha" },
    ];
    const m = mapOf(ps);
    /* `eff_tf = tf + titleBoost * title_tf` ⇒ boost=0 时标题命中的那页 eff_tf 归零，
       被"effTf ≤ 0 跳过"挡掉 —— 结果里只剩正文命中那条。 */
    const off = searchIndex(buildIndex(ps, { ...DEFAULT_INDEX_OPTIONS, titleBoost: 0 }), m, "alpha", 0, 10).items;
    expect(off.map((i) => i.url)).toEqual(["https://a.test/2"]);

    const on = searchIndex(buildIndex(ps), m, "alpha", 0, 10).items;
    expect(on[0]!.url, "默认 titleBoost=3 时标题命中的应当排前面").toBe("https://a.test/1");
  });

  it("`k1 = 0` ⇒ 分数退化成**纯 idf**（不再奖励词频）", () => {
    const ps: IndexedPage[] = [
      { id: 1, url: "https://a.test/1", title: "", text: "alpha alpha alpha alpha" },
      { id: 2, url: "https://a.test/2", title: "", text: "alpha beta" },
    ];
    const m = mapOf(ps);
    const hits = searchIndex(buildIndex(ps, { ...DEFAULT_INDEX_OPTIONS, k1: 0 }), m, "alpha", 0, 10).items;
    /* N=2、df=2 ⇒ idf = ln(1 + (2-2+0.5)/(2+0.5)) = ln(1.2)；k1=0 时两条分数**都**等于它。 */
    const idf = Math.round(Math.log(1 + (2 - 2 + 0.5) / (2 + 0.5)) * 1000) / 1000;
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBe(idf);
    expect(hits[1]!.score).toBe(idf);

    const on = searchIndex(buildIndex(ps), m, "alpha", 0, 10).items;
    expect(on[0]!.url, "默认 k1=1.5 时词频高的应当更高").toBe("https://a.test/1");
    expect(on[0]!.score).toBeGreaterThan(on[1]!.score);
  });
});

/* ══════════════ ⑥ 正文参数（抓取时生效）══════════════ */

describe("A-1140 ⑥ 正文参数", () => {
  const html = (title: string, text: string): string =>
    `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;
  /** 假抓取器：`body` 里没有的 URL ⇒ 失败；robots 一律取不到（⇒ 宽松放行）。 */
  function fakeFetch(body: Record<string, string>): FetchPage {
    return async (url) => {
      if (url.endsWith("/robots.txt")) { return { ok: false, url, error: "no robots" }; }
      const h = body[url];
      return h === undefined ? { ok: false, url, error: "404" } : { ok: true, url, html: h };
    };
  }

  it("`minBodyChars` 把「太短的页」挡在索引外（并计进 `skipped`，不静默）", async () => {
    const body = {
      "https://a.test/1": html("甲", "苹果"),                 // 2 字
      "https://a.test/2": html("乙", "橘子香蕉西瓜"),           // 6 字
    };
    const r = await crawl(fakeFetch(body), {
      seeds: ["https://a.test/1", "https://a.test/2"], delay: 0.3, minBodyChars: 5,
    });
    expect(r.pages.map((p) => p.url)).toEqual(["https://a.test/2"]);
    expect(r.skipped, "被闸掉的页没有计入 skipped（用户查不出为什么少了一页）").toBeGreaterThan(0);

    /* 默认（不传）= 旧行为：两页都收（只挡**空**正文）。 */
    const r2 = await crawl(fakeFetch(body), { seeds: ["https://a.test/1", "https://a.test/2"], delay: 0.3 });
    expect(r2.pages.map((p) => p.url)).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("`maxBodyChars` 截断正文；默认 0 = **不截断**（旧行为一字不变）", async () => {
    const body = { "https://a.test/1": html("丙", "苹".repeat(50)) };
    const cut = await crawl(fakeFetch(body), { seeds: ["https://a.test/1"], delay: 0.3, maxBodyChars: 10 });
    expect(cut.pages[0]!.text).toHaveLength(10);
    const full = await crawl(fakeFetch(body), { seeds: ["https://a.test/1"], delay: 0.3 });
    expect(full.pages[0]!.text, "默认把正文截了 ⇒ 旧行为变了").toHaveLength(50);
  });
});

/* ══════════════ ⑦ 服务层：落盘 + 改完即重建 ══════════════ */

describe("A-1140 ⑦ 服务层（真起服务）", () => {
  let dir = "";
  let port = 0;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slime-idx-param-")); __resetSearchIndexForTest(); });
  afterEach(async () => {
    await stopSearchIndexService();
    __resetSearchIndexForTest();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  const html = (title: string, text: string): string =>
    `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;
  const fakeFetch = (body: Record<string, string>): FetchPage => async (url) => {
    if (url.endsWith("/robots.txt")) { return { ok: false, url, error: "no robots" }; }
    const h = body[url];
    return h === undefined ? { ok: false, url, error: "404" } : { ok: true, url, html: h };
  };

  async function boot(fetchPage?: FetchPage): Promise<void> {
    const s = await startSearchIndexService({ userData: dir, port: 0, fetchPage: fetchPage ?? fakeFetch({}) });
    expect(s.ok).toBe(true);
    port = s.port!;
  }
  async function waitIdle(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { crawling: boolean };
      if (!st.crawling) { return; }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("爬取没有在 5 秒内结束");
  }
  async function crawlNow(seeds: string[]): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${port}/crawl`, { method: "POST", body: JSON.stringify({ seeds, delay: 0.3 }) });
    expect(res.status).toBe(200);
    await waitIdle();
  }
  async function hits(q: string): Promise<number> {
    const j = await (await fetch(`http://127.0.0.1:${port}/search?q=${encodeURIComponent(q)}`)).json() as { total: number };
    return j.total;
  }

  it("`setSearchIndexParams` 夹取 → 落盘 `params.json`；回带的 `notice` 说明**被夹取了**", async () => {
    await boot();
    const r = setSearchIndexParams({ index: { k1: 99, stopwords: ["A", "a"] }, body: { maxBodyChars: -1 } });
    expect(r.ok).toBe(true);
    expect(r.notice, "被夹取了却一声不吭（降级要看得见）").toBeTruthy();

    const eff = getSearchIndexParams();
    expect(eff.index.k1).toBe(3);
    expect(eff.index.stopwords).toEqual(["a"]);
    expect(eff.body.maxBodyChars).toBe(0);
    /* `/status` 也要回带（页面/第三方从 HTTP 看到的必须与 IPC 看到的**同一份事实**）。 */
    const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { params: unknown };
    expect(st.params).toEqual(eff);

    const saved = JSON.parse(readFileSync(join(dir, "search-index", "params.json"), "utf8")) as unknown;
    expect(saved, "没落盘 ⇒ 重启后参数丢").toEqual(eff);

    /* 全部合法时**不许**喊"已夹取"（提示的价值来自它稀有）。 */
    const clean = setSearchIndexParams({ index: { k1: 2 }, body: { maxBodyChars: 100 } });
    expect(clean.notice).toBeUndefined();
  });

  it("⚠️ 改分词参数 ⇒ **对已收录的页面立即生效**（不是只影响下次收录）", async () => {
    await boot(fakeFetch({ "https://a.test/1": html("压缩技术", "压缩 算法 说明") }));
    await crawlNow(["https://a.test/1"]);
    expect(await hits("压缩"), "收录没成功").toBe(1);

    /* 把「压缩」设成停用词 ⇒ 必须**当即**搜不到（主进程会重建索引）。
       不重建的话这条会是 1 —— 那意味着库里同时存在两套分词口径。 */
    expect(setSearchIndexParams({ index: { ...DEFAULT_INDEX_OPTIONS, stopwords: ["压缩"] } }).ok).toBe(true);
    expect(await hits("压缩"), "改完参数没有重建索引 ⇒ 老页面仍在用旧口径").toBe(0);

    /* 再清空停用词 ⇒ 又能搜到（证明重建是双向的，不是单向"越改越少"）。 */
    expect(setSearchIndexParams({ index: { ...DEFAULT_INDEX_OPTIONS, stopwords: [] } }).ok).toBe(true);
    expect(await hits("压缩")).toBe(1);
  });

  it("⚠️ 收录**进行中**拒绝改参数（否则这批页用了哪套分词没人说得清）", async () => {
    let hold = true;
    /* 门闸式假抓取器：`hold` 为真时所有请求都悬着 ⇒ `crawling` 稳定停在 true。 */
    const hanging: FetchPage = async (url) => {
      while (hold) { await new Promise((r) => setTimeout(r, 10)); }
      return { ok: false, url, error: "closed" };
    };
    await boot(hanging);
    expect(startSearchIndexCrawl("https://a.test/1").ok).toBe(true);

    const rejected = setSearchIndexParams({ index: { k1: 2 } });
    expect(rejected.ok, "收录中改参数被放行了").toBe(false);
    expect(rejected.error).toContain("正在收录");

    hold = false;
    await waitIdle();
    /* 收录结束后恢复正常。 */
    expect(setSearchIndexParams({ index: { k1: 2 } }).ok).toBe(true);
  });

  it("⚠️ 正文参数**真的接到了收录里**（两道闸都从全局参数取，不是摆设）", async () => {
    /* 这一条补的是一个**没有守卫的接线**：`beginCrawl` 把 `state.params.body` 传给 `crawl()`。
       少了它，界面上两个正文输入框照样能填、能存、能回显，而**收录时完全不生效** ——
       典型的静默失效（用户只会觉得"设了最短正文没用"）。 */
    const body = {
      "https://a.test/1": html("甲", "苹果"),                  // 2 字
      "https://a.test/2": html("乙", "橘子香蕉西瓜"),            // 6 字
      "https://a.test/3": html("丙", "樱桃"),                  // 2 字
    };
    await boot(fakeFetch(body));

    /* ① 质量闸：最短正文设成 5 ⇒ 2 字的页进不来。 */
    expect(setSearchIndexParams({ body: { minBodyChars: 5 } }).ok).toBe(true);
    await crawlNow(["https://a.test/1", "https://a.test/2"]);
    expect(await hits("橘子"), "正常长度的页应当照收").toBe(1);
    expect(await hits("苹果"), "太短的页没被挡住 ⇒ 全局正文参数没接到收录里").toBe(0);

    /* ② 长度闸：上限设成 1 ⇒ 只留首字（「樱桃」→「樱」）。 */
    expect(setSearchIndexParams({ body: { minBodyChars: 1, maxBodyChars: 1 } }).ok).toBe(true);
    await crawlNow(["https://a.test/3"]);
    expect(await hits("樱"), "只留了首字 ⇒ 正文上限没接上").toBe(1);
    expect(await hits("樱桃"), "整段都入库了 ⇒ 正文上限没接上").toBe(0);
  });

  it("重启服务后参数从 `params.json` **恢复**（不恢复 = 每次开机都要重设）", async () => {
    await boot();
    expect(setSearchIndexParams({ index: { k1: 2.5, minTermLen: 3 }, body: { minBodyChars: 20 } }).ok).toBe(true);
    await stopSearchIndexService();
    /* ⚠️ 这里**不能** `__resetSearchIndexForTest()`：那会把参数打回默认，测的就不是"恢复"了。 */
    await boot();
    const eff = getSearchIndexParams();
    expect(eff.index.k1).toBe(2.5);
    expect(eff.index.minTermLen).toBe(3);
    expect(eff.body.minBodyChars).toBe(20);
  });

  it("`params.json` 被写坏 ⇒ 回默认值**并记日志**（不静默重置）", async () => {
    mkdirSync(join(dir, "search-index"), { recursive: true });
    writeFileSync(join(dir, "search-index", "params.json"), "{ 这不是 json", "utf8");
    await boot();
    expect(getSearchIndexParams().index).toEqual(DEFAULT_INDEX_OPTIONS);
    expect(searchIndexStatus().log.join("\n"), "参数被重置了却没有任何痕迹").toContain("参数文件读不出来");
  });

  it("**落盘的值也是夹取过的**（手改 JSON 塞越界值不许直接进索引）", async () => {
    mkdirSync(join(dir, "search-index"), { recursive: true });
    writeFileSync(join(dir, "search-index", "params.json"),
      JSON.stringify({ index: { k1: 1e9, b: -3, stopwords: ["ok"] }, body: { minBodyChars: -1 } }), "utf8");
    await boot();
    const eff = getSearchIndexParams();
    expect(eff.index.k1).toBe(3);
    expect(eff.index.b).toBe(0);
    expect(eff.body.minBodyChars).toBe(0);
    expect(eff.index.stopwords).toEqual(["ok"]);
    /* 而且这份**生效值**就是建索引用到的那一份（`/status` 与 IPC 同源）。 */
    expect(searchIndexStatus().params).toEqual(eff);
  });
});

/* ══════════════ ⑧ 接线：面板 + IPC ══════════════ */

describe("A-1140 ⑧ 接线（面板 / IPC / preload）", () => {
  const read = (p: string): string => readFileSync(resolve(__dirname, "../../", p), "utf8");
  const PANEL = read("gui/src/renderer/pages/SearchIndexPanel.tsx");
  const SVC = read("gui/src/main/searchIndexService.ts");
  const SVC_CODE = stripComments(SVC);
  const PRELOAD = read("gui/src/preload/index.ts");

  it("面板接上了两条新桥，且**保存走的是自己那条**（串桥 = 点保存却去读了一次）", () => {
    expect(PANEL).toContain("indexParamsGet");
    expect(PANEL).toContain("indexParamsSet");
    expect(PANEL, "保存参数接到了别的桥")
      .toMatch(/const onSaveParams = useCallback[\s\S]{0,400}?api\.indexParamsSet\(formToPayload\(form\)\)/);
    /* ⚠️ 这条**不许**写成「onSaveParams 之后 600 字内出现过 `await refresh()`」——
       实测那是假绿：`onSaveParams` 自己那行被删掉之后，600 字的窗口正好够伸到**下一个函数**
       `onToggle` 的 `await refresh()` 上，于是"保存完不拉回生效值"这个缺陷照样通过。
       判据必须锚在**这一段自己的收尾**上：`setDirty(false)` 后面紧跟的就是 `await refresh()`。 */
    expect(PANEL, "保存完没有把生效值拉回来回显")
      .toMatch(/const onSaveParams = useCallback[\s\S]{0,400}?setDirty\(false\);\s*await refresh\(\);/);
  });

  it("⚠️ **被夹取要看得见**：主进程回的 `notice` 必须落到界面（不能被成功文案盖掉）", () => {
    expect(PANEL, "notice 被吞了 ⇒ 用户填了 999 被夹到 8 而界面上没有任何痕迹")
      .toMatch(/setNotice\(\{ ok: true, text: r\.notice \?/);
    /* 成功文案也不能改成"只在失败时用"（那等于把成功反馈整个去掉）。 */
    expect(PANEL).toMatch(/okText/);
  });

  it("参数输入框用 text 型输入（渲染层不做判据：空 / 半截输入原样交给主进程）", () => {
    expect(PANEL, "用了 type=number ⇒ 空输入会被这里悄悄变成 0/NaN").toMatch(/type="text" inputMode="decimal"/);
  });

  it("两条 IPC + preload 都在，且通道名两边对得上", () => {
    expect(SVC).toContain("IPC_CHANNELS.search_index_params_get");
    expect(SVC).toContain("IPC_CHANNELS.search_index_params_set");
    expect(PRELOAD).toContain("slime:search:indexParamsGet");
    expect(PRELOAD).toContain("slime:search:indexParamsSet");
    expect(IPC_CHANNELS.search_index_params_get).toBe("slime:search:indexParamsGet");
    expect(IPC_CHANNELS.search_index_params_set).toBe("slime:search:indexParamsSet");
  });

  it("**写参数那条有授权判据**（否则任何页面都能改整个索引的行为）", () => {
    expect(SVC_CODE).toMatch(/search_index_params_set[\s\S]{0,160}?未授权来源/);
  });

  it("⚠️ 授权判据在**每条**改状态的桥里各写一遍（抽 wrapper 会让变异无法逐条命中）", () => {
    const hits = SVC_CODE.match(/未授权来源：只有主窗口可以控制索引服务/g) ?? [];
    /* 7 条 = 启 / 停 / 收录 / 重建 / 清空 / 删站 / 写参数。
       ⚠️ 必须**剥注释**再数：文件头那段 JSDoc 里也写了这句原文（不剥会把 7 数成 8）。 */
    expect(hits).toHaveLength(7);
  });

  it("参数属于**这个索引**：面板必须把两组参数的区别写在界面上（否则用户以为只影响下次收录）", () => {
    expect(PANEL).toContain("属于<b>这个索引</b>");
    expect(PANEL).toContain("只影响之后新收录的页面");
  });
});
