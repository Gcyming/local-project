























import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";


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

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");



describe("A-1140 ① 默认参数 = 行为基准（改默认值 = 改所有人的检索结果）", () => {
  it("`DEFAULT_INDEX_OPTIONS` 逐字等于 Python 基准；**打分口径只有这一处**", () => {
    expect(DEFAULT_INDEX_OPTIONS).toEqual({
      k1: 1.5, b: 0.75, titleBoost: 3.0, wholeWordMaxLen: 4, minTermLen: 1, stopwords: [],
      

      fuzzyMaxEdits: 2, fuzzyMinTermLen: 3, fuzzyMaxExpansions: 50,
    });
    



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
    

    expect(buildIndex([]).opts).toEqual(DEFAULT_INDEX_OPTIONS);
    expect(emptyIndex().opts).toEqual(DEFAULT_INDEX_OPTIONS);
  });

  it("`DEFAULT_BODY_OPTIONS` 等于旧行为：只挡空正文、不截断", () => {
    expect(DEFAULT_BODY_OPTIONS).toEqual({ minBodyChars: 1, maxBodyChars: 0 });
  });
});



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



describe("A-1140 ③ 分词参数", () => {
  it("`wholeWordMaxLen` 控制中文整词：0 ⇒ 只留二元", () => {
    expect(tokenize("上下文压", { ...DEFAULT_INDEX_OPTIONS, wholeWordMaxLen: 0 }))
      .toEqual(["上下", "下文", "文压"]);
    

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
    
    const en = { ...DEFAULT_INDEX_OPTIONS, stopwords: ["the"] };
    expect(tokenize("The alpha", en)).toEqual(["alpha"]);
  });
});



describe("A-1140 ④ 参数挂在索引上（`SearchIndex.opts`）", () => {
  it("`buildIndex` 把参数**钉在索引上**（不是丢掉、也不是复制一份默认值）", () => {
    const o = { ...DEFAULT_INDEX_OPTIONS, k1: 2.2, stopwords: ["压缩"] };
    expect(buildIndex([], o).opts).toBe(o);
  });

  it("⚠️ 查询侧用的是**索引自带**那份参数（判据：停用词把查询词也剔光了）", () => {
    const ps: IndexedPage[] = [{ id: 1, url: "https://a.test/1", title: "压缩技术", text: "压缩 算法 说明" }];
    const o = { ...DEFAULT_INDEX_OPTIONS, stopwords: ["压缩"] };

    const r = searchIndex(buildIndex(ps, o), mapOf(ps), "压缩", 0, 10);
    

    expect(r.terms, "查询侧没剔停用词 ⇒ 它用的不是索引自带的那份参数").toEqual([]);
    expect(r.total).toBe(0);

    
    expect(searchIndex(buildIndex(ps), mapOf(ps), "压缩", 0, 10).total).toBeGreaterThan(0);
  });

  it("⚠️ 第二个可区分输入：`wholeWordMaxLen`（防止只对停用词特判就算通过）", () => {
    const ps: IndexedPage[] = [{ id: 1, url: "https://a.test/1", title: "", text: "上下文压 入门" }];
    const r = searchIndex(buildIndex(ps, { ...DEFAULT_INDEX_OPTIONS, wholeWordMaxLen: 0 }), mapOf(ps), "上下文压", 0, 10);
    expect(r.terms, "查询侧切出了整词 ⇒ 它没读索引自带的分词参数").toEqual(["上下", "下文", "文压"]);
    expect(searchIndex(buildIndex(ps), mapOf(ps), "上下文压", 0, 10).terms).toContain("上下文压");
  });
});



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
    
    const idf = Math.round(Math.log(1 + (2 - 2 + 0.5) / (2 + 0.5)) * 1000) / 1000;
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBe(idf);
    expect(hits[1]!.score).toBe(idf);

    const on = searchIndex(buildIndex(ps), m, "alpha", 0, 10).items;
    expect(on[0]!.url, "默认 k1=1.5 时词频高的应当更高").toBe("https://a.test/1");
    expect(on[0]!.score).toBeGreaterThan(on[1]!.score);
  });
});



describe("A-1140 ⑥ 正文参数", () => {
  const html = (title: string, text: string): string =>
    `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;
  
  function fakeFetch(body: Record<string, string>): FetchPage {
    return async (url) => {
      if (url.endsWith("/robots.txt")) { return { ok: false, url, error: "no robots" }; }
      const h = body[url];
      return h === undefined ? { ok: false, url, error: "404" } : { ok: true, url, html: h };
    };
  }

  it("`minBodyChars` 把「太短的页」挡在索引外（并计进 `skipped`，不静默）", async () => {
    const body = {
      "https://a.test/1": html("甲", "苹果"),                 
      "https://a.test/2": html("乙", "橘子香蕉西瓜"),           
    };
    const r = await crawl(fakeFetch(body), {
      seeds: ["https://a.test/1", "https://a.test/2"], delay: 0.3, minBodyChars: 5,
    });
    expect(r.pages.map((p) => p.url)).toEqual(["https://a.test/2"]);
    expect(r.skipped, "被闸掉的页没有计入 skipped（用户查不出为什么少了一页）").toBeGreaterThan(0);

    
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



describe("A-1140 ⑦ 服务层（真起服务）", () => {
  let dir = "";
  let port = 0;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slime-idx-param-")); __resetSearchIndexForTest(); });
  afterEach(async () => {
    await stopSearchIndexService();
    __resetSearchIndexForTest();
    try { rmSync(dir, { recursive: true, force: true }); } catch {  }
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
    
    const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { params: unknown };
    expect(st.params).toEqual(eff);

    const saved = JSON.parse(readFileSync(join(dir, "search-index", "params.json"), "utf8")) as unknown;
    expect(saved, "没落盘 ⇒ 重启后参数丢").toEqual(eff);

    
    const clean = setSearchIndexParams({ index: { k1: 2 }, body: { maxBodyChars: 100 } });
    expect(clean.notice).toBeUndefined();
  });

  it("⚠️ 改分词参数 ⇒ **对已收录的页面立即生效**（不是只影响下次收录）", async () => {
    await boot(fakeFetch({ "https://a.test/1": html("压缩技术", "压缩 算法 说明") }));
    await crawlNow(["https://a.test/1"]);
    expect(await hits("压缩"), "收录没成功").toBe(1);

    

    expect(setSearchIndexParams({ index: { ...DEFAULT_INDEX_OPTIONS, stopwords: ["压缩"] } }).ok).toBe(true);
    expect(await hits("压缩"), "改完参数没有重建索引 ⇒ 老页面仍在用旧口径").toBe(0);

    
    expect(setSearchIndexParams({ index: { ...DEFAULT_INDEX_OPTIONS, stopwords: [] } }).ok).toBe(true);
    expect(await hits("压缩")).toBe(1);
  });

  it("⚠️ 收录**进行中**拒绝改参数（否则这批页用了哪套分词没人说得清）", async () => {
    let hold = true;
    
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
    
    expect(setSearchIndexParams({ index: { k1: 2 } }).ok).toBe(true);
  });

  it("⚠️ 正文参数**真的接到了收录里**（两道闸都从全局参数取，不是摆设）", async () => {
    


    const body = {
      "https://a.test/1": html("甲", "苹果"),                  
      "https://a.test/2": html("乙", "橘子香蕉西瓜"),            
      "https://a.test/3": html("丙", "樱桃"),                  
    };
    await boot(fakeFetch(body));

    
    expect(setSearchIndexParams({ body: { minBodyChars: 5 } }).ok).toBe(true);
    await crawlNow(["https://a.test/1", "https://a.test/2"]);
    expect(await hits("橘子"), "正常长度的页应当照收").toBe(1);
    expect(await hits("苹果"), "太短的页没被挡住 ⇒ 全局正文参数没接到收录里").toBe(0);

    
    expect(setSearchIndexParams({ body: { minBodyChars: 1, maxBodyChars: 1 } }).ok).toBe(true);
    await crawlNow(["https://a.test/3"]);
    expect(await hits("樱"), "只留了首字 ⇒ 正文上限没接上").toBe(1);
    expect(await hits("樱桃"), "整段都入库了 ⇒ 正文上限没接上").toBe(0);
  });

  it("重启服务后参数从 `params.json` **恢复**（不恢复 = 每次开机都要重设）", async () => {
    await boot();
    expect(setSearchIndexParams({ index: { k1: 2.5, minTermLen: 3 }, body: { minBodyChars: 20 } }).ok).toBe(true);
    await stopSearchIndexService();
    
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
    
    expect(searchIndexStatus().params).toEqual(eff);
  });
});



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
    



    expect(PANEL, "保存完没有把生效值拉回来回显")
      .toMatch(/const onSaveParams = useCallback[\s\S]{0,400}?setDirty\(false\);\s*await refresh\(\);/);
  });

  it("⚠️ **被夹取要看得见**：主进程回的 `notice` 必须落到界面（不能被成功文案盖掉）", () => {
    expect(PANEL, "notice 被吞了 ⇒ 用户填了 999 被夹到 8 而界面上没有任何痕迹")
      .toMatch(/setNotice\(\{ ok: true, text: r\.notice \?/);
    
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
    

    expect(hits).toHaveLength(7);
  });

  it("参数属于**这个索引**：面板必须把两组参数的区别写在界面上（否则用户以为只影响下次收录）", () => {
    expect(PANEL).toContain("属于<b>这个索引</b>");
    expect(PANEL).toContain("只影响之后新收录的页面");
  });
});
