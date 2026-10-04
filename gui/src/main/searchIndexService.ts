/**
 * gui/src/main/searchIndexService.ts — 「自建全网索引」服务的**唯一产地**（A-1138）。
 *
 * ## 为什么不再 spawn Python
 * 用户要求「把这些进程写进 slime，而非接线」。原来那条路要外部 Python + 三条命令串起来，
 * 由此带来三个**静默失效**点：
 *   ① 用户机器上没有 Python ⇒ 服务永远起不来，页面只是「少一块补充命中」；
 *   ② 进程生命周期不在 slime 手里 ⇒ 主程序退出后僵尸占住 8600，下次启动绑定失败；
 *   ③ 崩溃无人知（没有 stderr 归属）。
 * ⇒ 现在爬虫 / 索引 / 服务**全在 slime 进程内**（引擎在 `core-ts/src/websearch/`），
 *    一键启停、状态可见、崩溃有归因。
 *
 * ## 对页面是**零改动**的
 * 服务仍监听 `127.0.0.1:8600`，路由与回包形状逐字对齐 `core/websearch/server.py`
 * （`/health`、`/status`、`/search`、`/crawl`，CORS 全开）⇒
 * `apps/local-search-engine/index.html` 一个字都不用改，而且这条路已实测可达
 * （webview 内 fetch 127.0.0.1:8600，见 2026-09-30 日志 §16 ④）。
 *
 * ## ⚠️ 三条硬纪律
 *  1. **端口占用要出声**：`EADDRINUSE` 不能降级成「静默没起来」（否则页面永远少一块，无人知晓）。
 *  2. **落盘必须持久**：`userData/search-index/`（安装目录可能只读）。
 *  3. **爬取是后台活**：`/crawl` 立刻返回 `started`，进度走 `/status` 的 `log`，绝不卡住请求。
 *
 * ## ⚠️ A-1140 追加的第四条
 *  4. **两套参数不许混**：`CrawlStartOptions`（每站收录）与 `SearchParams`（全局：分词/打分/正文）
 *     是**不同生命周期**的东西 —— 前者用完即弃、后者落盘且改完要重建。混用会让用户在
 *     "改完参数只影响下次收录"与"改完整个库都变了"之间反复猜。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ipcMain } from "electron";

import { IPC_CHANNELS } from "../shared/ipc.js";

import {
  buildIndex,
  clampIndexOptions,
  contentFingerprint,
  DEFAULT_INDEX_OPTIONS,
  emptyIndex,
  indexStats,
  searchIndex,
  SEARCH_ENGINE_NAME,
  type IndexOptions,
  type IndexedPage,
  type SearchIndex,
} from "../../../core-ts/src/websearch/engine.js";
import {
  clampBodyOptions,
  crawl,
  CRAWLER_UA,
  DEFAULT_BODY_OPTIONS,
  hostOf,
  MAX_BODY_BYTES,
  normalizeUrl,
  type BodyOptions,
  type FetchPage,
} from "../../../core-ts/src/websearch/crawler.js";
import { decodeHtmlBytes } from "../../../core-ts/src/text/encoding.js";

/** 默认端口（与 Python 版一致 ⇒ 页面零改动）。 */
export const SEARCH_INDEX_PORT = 8600;

/** 日志最多保留多少条（`/status` 回带）。 */
const LOG_CAP = 60;

export interface SearchIndexDeps {
  /** 落盘根（**必须是持久可写目录**，通常 `app.getPath("userData")`）。 */
  userData: string;
  /** 端口，默认 8600。 */
  port?: number;
  /** 抓取器（默认走 Node 原生 http/https；测试可注入假实现）。 */
  fetchPage?: FetchPage;
}

export interface SearchIndexStatus {
  running: boolean;
  port: number;
  pages: number;
  terms: number;
  crawling: boolean;
  log: string[];
  lastCrawl: { ok: boolean; fetched?: number; error?: string } | null;
  /** A-1139：按站点的页数分布（设置页据此列出"已收录的站点"并可逐站删除）。 */
  sites?: SearchIndexSite[];
  /** A-1140：当前生效的全局参数（设置页据此回显输入框）。 */
  params?: SearchParams;
  error?: string;
}

/** 一个站点在索引里的份额（`host` 含端口，与 `crawler.hostOf` 同一口径）。 */
export interface SearchIndexSite { host: string; pages: number }

/**
 * 这个索引的**全局参数**（A-1140）。与"每站收录参数"（`CrawlStartOptions`）是两件事：
 *   · 每站收录参数是**这一次抓取**的（页数 / 深度 / 间隔 / 同域 / robots），用完即弃；
 *   · 全局参数是**这个索引**的（分词 / 打分 / 正文），落盘持久、改了要重建。
 * 混在一起会让用户以为"改完参数只影响下一次收录"，而实际上它连已有结果一起改了。
 */
export interface SearchParams {
  /** 分词 / 打分（建索引时生效 ⇒ 改完**立即**对全库生效）。 */
  index: IndexOptions;
  /** 正文抽取（**抓取时**生效 ⇒ 改完只影响之后新收录的页）。 */
  body: BodyOptions;
}

/** 默认全局参数（= 与 Python 基准 / 旧行为逐字一致的那一份）。 */
export function defaultSearchParams(): SearchParams {
  return { index: { ...DEFAULT_INDEX_OPTIONS, stopwords: [] }, body: { ...DEFAULT_BODY_OPTIONS } };
}

interface Store {
  pages: IndexedPage[];
}

const state: {
  server: Server | null;
  port: number;
  pagesPath: string;
  /** A-1140：全局参数落盘位置（`userData/search-index/params.json`）。 */
  paramsPath: string;
  /** A-1140：当前生效的全局参数（**唯一产地** —— 建索引与抓取都读它）。 */
  params: SearchParams;
  index: SearchIndex;
  pages: IndexedPage[];
  byId: Map<number, IndexedPage>;
  /** A-1139：url → 页面（**按 URL 覆盖**而不是重复入库；也是"这一页收过没有"的唯一判据）。 */
  byUrl: Map<string, IndexedPage>;
  /** A-1139：url → 内容指纹（判断"这一页的内容变了没有"，变了才重写）。 */
  fpByUrl: Map<string, string>;
  /** A-1139：已占用的内容指纹集合（**跨 URL 去重**：镜像站/转载只留先收录的那份）。 */
  fpTaken: Set<string>;
  crawling: boolean;
  log: string[];
  lastCrawl: SearchIndexStatus["lastCrawl"];
  /** 当前生效的抓取器 —— 由 `startSearchIndexService` 写入，供 IPC 那条入口复用。 */
  fetchPage: FetchPage | null;
} = {
  server: null,
  port: SEARCH_INDEX_PORT,
  pagesPath: "",
  paramsPath: "",
  params: defaultSearchParams(),
  index: emptyIndex(),
  pages: [],
  byId: new Map(),
  byUrl: new Map(),
  fpByUrl: new Map(),
  fpTaken: new Set(),
  crawling: false,
  log: [],
  lastCrawl: null,
  fetchPage: null,
};

function pushLog(msg: string): void {
  state.log.push(msg);
  if (state.log.length > LOG_CAP) { state.log = state.log.slice(-LOG_CAP); }
}

/* ── 落盘 ── */
function pathsFor(userData: string) {
  const dir = join(userData, "search-index");
  return { dir, pages: join(dir, "pages.json"), params: join(dir, "params.json") };
}

function loadStore(pagesPath: string): Store {
  const pages: IndexedPage[] = [];
  if (existsSync(pagesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pagesPath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          const o = p as Partial<IndexedPage>;
          if (typeof o?.url === "string") {
            pages.push({ id: pages.length + 1, url: o.url, title: String(o.title ?? ""), text: String(o.text ?? "") });
          }
        }
      }
    } catch {
      /* 坏文件 ⇒ 当作空库，不静默：写一条日志，服务照起 */
      pushLog("索引文件读不出来，已按空库启动（重新爬取即可恢复）");
    }
  }
  return { pages };
}

function savePages(pagesPath: string, pages: IndexedPage[]): void {
  mkdirSync(dirname(pagesPath), { recursive: true });
  writeFileSync(pagesPath, JSON.stringify(pages), "utf8");
}

/**
 * 读全局参数（A-1140）。
 *
 * ⚠️ 读进来**一定过夹取**：`params.json` 是用户可以手改的文件（也是旧版本留下的文件）。
 *   直接把越界值塞进索引 ⇒ `k1=1e9` 之类的值会让打分变成 NaN/Infinity，
 *   而搜索结果**不会报错**，只会排序莫名其妙。
 * ⚠️ 坏文件 ⇒ 回默认值 + **写一条日志**（不静默：用户改坏了要能查出来为什么"参数被重置了"）。
 */
function loadParams(paramsPath: string): SearchParams {
  if (!existsSync(paramsPath)) { return defaultSearchParams(); }
  try {
    const parsed = JSON.parse(readFileSync(paramsPath, "utf8")) as Partial<SearchParams>;
    return { index: clampIndexOptions(parsed?.index), body: clampBodyOptions(parsed?.body) };
  } catch {
    pushLog("参数文件读不出来，已按默认参数启动");
    return defaultSearchParams();
  }
}

function saveParams(): void {
  if (!state.paramsPath) { return; }
  mkdirSync(dirname(state.paramsPath), { recursive: true });
  writeFileSync(state.paramsPath, JSON.stringify(state.params, null, 2), "utf8");
}

/**
 * 由 `state.pages` 全量重建**所有派生结构**（倒排索引 + 三个映射）。
 *
 * ⚠️ 这里是**唯一产地**：加载、爬完、重建、清空、按站删除、**改参数**六条路径全走它。
 *   早先只有 `index` / `byId` 两个派生结构，现在多了 `byUrl` / `fpByUrl` / `fpTaken` ——
 *   如果哪条路径自己拼一份，就会出现"索引里没有但 byUrl 里有"这种**不报错**的半死状态
 *   （表现为：搜索漏结果 / 去重悄悄失效 / 按站删除删不干净）。
 *
 * ⚠️ A-1140：倒排必须用 `state.params.index` 建 —— `SearchIndex.opts` 因此**自带**这套参数，
 *   检索只读索引自带那一份 ⇒ 索引与查询永远同口径（否则中文整词/二元不一致 = 永远搜不到）。
 */
function rebuild(): void {
  state.index = buildIndex(state.pages, state.params.index);
  state.byId = new Map(state.pages.map((p) => [p.id, p]));
  state.byUrl = new Map(state.pages.map((p) => [p.url, p]));
  state.fpByUrl = new Map();
  state.fpTaken = new Set();
  for (const p of state.pages) {
    const fp = contentFingerprint(p.title, p.text);
    state.fpByUrl.set(p.url, fp);
    state.fpTaken.add(fp);
  }
}

/* ── 默认抓取器（Node 原生，限 1.5MB，带 UA）── */
const defaultFetchPage: FetchPage = (url, timeoutMs) => new Promise((resolve) => {
  const lib = url.startsWith("https:") ? httpsRequest : httpRequest;
  let req: ReturnType<typeof lib>;
  try {
    req = lib(url, { headers: { "User-Agent": CRAWLER_UA }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        if (size + c.length > MAX_BODY_BYTES) { req.destroy(); return; }
        size += c.length; chunks.push(c);
      });
      res.on("end", () => {
        /* ⚠️ **不能**写 `Buffer.concat(chunks).toString("utf8")` —— 中文站点里大量页面是
           GB2312/GBK（`<meta charset=gb2312>`）或干脆不声明，按 UTF-8 解会把整页正文变成
           `����` 入库，而**入库不报错**：搜索结果里全是乱码摘要，看起来像"搜索引擎不行"。
           ⇒ 统一走 `decodeHtmlBytes`：先用页面自己声明的 charset，其次严格 UTF-8，最后 GB18030。 */
        const { text } = decodeHtmlBytes(Buffer.concat(chunks));
        resolve({ ok: true, status: res.statusCode ?? 0, url, html: text });
      });
      res.on("error", () => resolve({ ok: false, url, error: "响应流出错" }));
    });
  } catch (e) {
    resolve({ ok: false, url, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  req.on("timeout", () => { req.destroy(); resolve({ ok: false, url, error: "超时" }); });
  req.on("error", (e: Error) => resolve({ ok: false, url, error: e.message }));
  req.end();
});

/* ── HTTP 服务 ── */
function send(res: ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function handleGet(url: URL, res: ServerResponse): void {
  if (url.pathname === "/health") { send(res, 200, { ok: true }); return; }
  if (url.pathname === "/status") {
    const st = indexStats(state.index);
    send(res, 200, { ok: true, pages: st.pages, terms: st.terms, db: state.pagesPath, crawling: state.crawling, last_crawl: state.lastCrawl, log: state.log.slice(-10), params: state.params });
    return;
  }
  if (url.pathname === "/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) { send(res, 200, { ok: false, error: "缺少 q 参数", items: [], total: 0 }); return; }
    const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
    const size = Math.min(50, Math.max(1, Number(url.searchParams.get("size") ?? 10) || 10));
    const t0 = Date.now();
    const r = searchIndex(state.index, state.byId, q, page, size);
    send(res, 200, {
      ok: true, engine: SEARCH_ENGINE_NAME, total: r.total, took_ms: Date.now() - t0,
      items: r.items, terms: r.terms,
      /* A-1143：**降级要看得见** —— 有近似命中时必须让调用方（页面/网关）知道
         "这几个词没精确匹配，是按哪些词检索出来的"。没有它，用户会以为索引里真有 `clude`。
         ⚠️ 新增字段是**向后兼容**的（Python 侧没有它，页面忽略未知字段 ⇒ 零改动）。 */
      expansions: r.expansions,
    });
    return;
  }
  send(res, 404, { ok: false, error: "not found" });
}

/** 一次爬取的**参数**（HTTP `/crawl` 与渲染层 IPC 共用同一套夹取，见 `clampCrawlOpts`）。 */
export interface CrawlStartOptions {
  maxPages?: unknown;
  maxDepth?: unknown;
  delay?: unknown;
  /** 只抓种子所在的域（默认 true —— 个人搜索引擎几乎不会想顺着外链爬到全互联网）。 */
  sameDomain?: unknown;
  /** 遵守 robots.txt（默认 true；关掉 = 明确表示"这些站我有权抓"）。 */
  respectRobots?: unknown;
}

/** 夹取后的**生效参数**（`clampCrawlOpts` 的返回，也是日志/回包对外公布的那一份）。 */
export interface EffectiveCrawlOpts {
  maxPages: number;
  maxDepth: number;
  delay: number;
  sameDomain: boolean;
  respectRobots: boolean;
}

/**
 * 参数夹取（**唯一产地**）：两处入口若各写一遍，迟早一处改了范围另一处没改。
 *
 * ⚠️ 范围不是随手拍的，对齐业界爬虫的通用约束（Scrapy `AUTOTHROTTLE`、Googlebot 的
 *    「crawl rate」在站长工具里的上限）：
 *   · `maxPages ≤ 2000` —— 个人索引的落盘是**整份 JSON 重写**，再大就不是"搜索索引"而是"数据集"了；
 *   · `delay ≥ 0.3s`  —— 再快就是对别人服务器的压力；这条**只允许放宽不允许收紧到 0**；
 *   · `maxDepth ≤ 6`   —— 深于 6 层的页面在个人站点上基本都是归档/分页垃圾。
 */
function clampCrawlOpts(o: CrawlStartOptions): EffectiveCrawlOpts {
  const num = (v: unknown, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const bool = (v: unknown, d: boolean): boolean => {
    if (v === undefined || v === null || v === "") { return d; }
    if (typeof v === "boolean") { return v; }
    return !(v === "false" || v === "0" || v === 0 || v === false);
  };
  return {
    maxPages: Math.min(2000, Math.max(1, Math.floor(num(o.maxPages, 100)))),
    maxDepth: Math.min(6, Math.max(1, Math.floor(num(o.maxDepth, 3)))),
    delay: Math.max(0.3, num(o.delay, 1.0)),
    sameDomain: bool(o.sameDomain, true),
    respectRobots: bool(o.respectRobots, true),
  };
}

/**
 * 把用户输入归一成**一组**种子 URL（批量收录的入口）。
 *
 * 接受：单个字符串（**按换行/逗号/空格**切，所以"从记事本粘一列网址"直接可用）、
 *      字符串数组。逐条 `normalizeUrl`（非法/非 http(s) 的**丢掉**，不抛），并去重。
 *
 * ⚠️ 返回**空数组**是合法输入（"用户什么都没填"）—— 由调用方决定报什么错，
 *   这里不抛、不猜（同一条判据只留一处）。
 */
export function normalizeSeeds(input: unknown): string[] {
  const raw: string[] = typeof input === "string"
    ? input.split(/[\r\n,，;；\s]+/)
    : Array.isArray(input) ? input.map((x) => String(x ?? "")) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const u = normalizeUrl(String(s ?? "").trim());
    if (!u || seen.has(u)) { continue; }
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * 真正把爬取**跑起来**（HTTP `/crawl` 与渲染层 IPC 共用这一处）。
 * 立刻返回，进度写 `state.log`（后台跑，绝不卡住调用方）。
 *
 * ⚠️ 入库是 **upsert + 双去重**（A-1139）：
 *   · 同一 URL 再爬到 ⇒ **更新**那一页（内容没变就什么都不做）——而不是又插一条；
 *   · 不同 URL 但内容指纹相同（镜像站 / 转载 / 带 tracking 参数的同一页）⇒ **只留先收录的那份**，
 *     并把它记进日志（"跳过了 N 条重复内容"）。这类重复**不会报错**，只会让结果页全是同一条，
 *     是搜索引擎最容易"看起来能用其实不能用"的地方。
 */
function beginCrawl(
  seeds: string[],
  o: EffectiveCrawlOpts,
  fetchPage: FetchPage,
): { ok: boolean; error?: string; status?: number } {
  if (state.crawling) { return { ok: false, error: "已有爬取任务进行中", status: 409 }; }

  state.crawling = true;
  state.log = [];
  pushLog(`开始爬取：${seeds.length} 个种子，上限 ${o.maxPages} 页 / 深度 ${o.maxDepth} / 间隔 ${o.delay}s`
    + `${o.sameDomain ? " · 仅同域" : ""}${o.respectRobots ? " · 遵守 robots" : " · 忽略 robots"}`);
  for (const s of seeds.slice(0, 10)) { pushLog("  种子 " + s); }
  if (seeds.length > 10) { pushLog(`  …另有 ${seeds.length - 10} 个种子`); }

  /* `sameDomain` ⇒ 用种子所在的主机集合当白名单（crawler 的 stayDomains 是**主机**粒度）。 */
  const stayDomains = o.sameDomain
    ? [...new Set(seeds.map((s) => hostOf(s)).filter(Boolean))]
    : [];

  /* 后台跑：请求立刻返回，进度走 /status。 */
  void (async () => {
    try {
      const r = await crawl(fetchPage, {
        seeds, maxPages: o.maxPages, maxDepth: o.maxDepth, delay: o.delay,
        stayDomains,
        respectRobots: o.respectRobots,
        /* A-1140：正文参数从**全局参数**取（不是这次收录的参数）—— 它属于"这个索引"。 */
        minBodyChars: state.params.body.minBodyChars,
        maxBodyChars: state.params.body.maxBodyChars,
        progress: (m) => pushLog(m),
      });
      const stats = upsertPages(r.pages);
      rebuild();
      savePages(state.pagesPath, state.pages);
      state.lastCrawl = { ok: true, fetched: stats.added + stats.updated };
      pushLog(`完成：新增 ${stats.added} 页 / 更新 ${stats.updated} 页 / 跳过重复内容 ${stats.dups} 条 / 抓取失败或跳过 ${r.skipped} 条`);
      pushLog(`当前索引：${indexStats(state.index).pages} 页 · ${indexStats(state.index).terms} 词`);
    } catch (e) {
      state.lastCrawl = { ok: false, error: e instanceof Error ? e.message : String(e) };
      pushLog("失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      state.crawling = false;
    }
  })();

  return { ok: true };
}

/** 入库统计（`beginCrawl` 的日志与 `lastCrawl` 都用它）。 */
export interface UpsertStats { added: number; updated: number; dups: number; unchanged: number }

/**
 * 把爬到的页面**并入**索引（upsert + 跨 URL 内容去重）。
 *
 * ⚠️ `state.fpByUrl` / `state.fpTaken` 必须与 `state.pages` **同步维护**；
 *   它们由 `rebuild()` 全量重建，所以这里的增量更新与 `rebuild()` 是同一套语义
 *   （单测里两条路径都会被走到：`upsertPages` 之后紧跟着 `rebuild()`）。
 */
function upsertPages(incoming: { url: string; title: string; text: string }[]): UpsertStats {
  const stats: UpsertStats = { added: 0, updated: 0, dups: 0, unchanged: 0 };
  for (const p of incoming) {
    const fp = contentFingerprint(p.title, p.text);
    const existing = state.byUrl.get(p.url);
    if (existing) {
      if (state.fpByUrl.get(p.url) === fp) { stats.unchanged += 1; continue; } // 内容一个字没变
      state.fpTaken.delete(state.fpByUrl.get(p.url) ?? "");
      existing.title = p.title;
      existing.text = p.text;
      state.fpByUrl.set(p.url, fp);
      state.fpTaken.add(fp);
      stats.updated += 1;
      continue;
    }
    if (state.fpTaken.has(fp)) { stats.dups += 1; continue; } // 别处已收录同样内容（镜像/转载）
    const page: IndexedPage = { id: state.pages.length + 1, url: p.url, title: p.title, text: p.text };
    state.pages.push(page);
    state.byUrl.set(p.url, page);
    state.fpByUrl.set(p.url, fp);
    state.fpTaken.add(fp);
    stats.added += 1;
  }
  return stats;
}

function handlePost(req: IncomingMessage, res: ServerResponse, body: string, fetchPage: FetchPage): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/crawl") { send(res, 404, { ok: false, error: "not found" }); return; }
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(body || "{}") as Record<string, unknown>; } catch { /* 空 body ⇒ 走默认 */ }
  /* A-1139：`seeds`（数组 / 多行字符串）与旧的单个 `seed` 都接受 —— 页面那边只发 `seed`，
     所以这里不能只认 `seeds`（那就是把已经能用的调用方改坏）。 */
  const seeds = normalizeSeeds(payload.seeds ?? payload.seed);
  if (seeds.length === 0) { send(res, 400, { ok: false, error: "缺少 seed" }); return; }
  const o = clampCrawlOpts({
    maxPages: payload.max_pages, maxDepth: payload.max_depth, delay: payload.delay,
    sameDomain: payload.same_domain, respectRobots: payload.respect_robots,
  });
  const r = beginCrawl(seeds, o, fetchPage);
  if (!r.ok) { send(res, r.status ?? 400, { ok: false, error: r.error, log: state.log.slice(-5) }); return; }
  send(res, 200, {
    ok: true, started: true, seed: seeds[0], seeds,
    max_pages: o.maxPages, max_depth: o.maxDepth, delay: o.delay,
    same_domain: o.sameDomain, respect_robots: o.respectRobots,
  });
}

/** 启动服务（幂等：已在跑就直接返回当前端口）。 */
export async function startSearchIndexService(deps: SearchIndexDeps): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (state.server) { return { ok: true, port: state.port }; }
  const { dir, pages, params: paramsPath } = pathsFor(deps.userData);
  state.pagesPath = pages;
  state.paramsPath = paramsPath;
  mkdirSync(dir, { recursive: true });
  const store = loadStore(pages);
  state.pages = store.pages;
  /* ⚠️ A-1140：参数**必须先于 `rebuild()`** 载入 —— 倒排是用这套参数建的，
     顺序反了就会拿默认参数建一次索引、再被覆盖，而**不会有任何报错**。 */
  state.params = loadParams(paramsPath);
  /* ⚠️ 派生结构（index / byId / byUrl / fpByUrl / fpTaken）由 `rebuild()` **统一**建，
     这里不再自己拼 —— 加载路径少建一个映射，症状是"去重悄悄失效"或"按站删不干净"，
     两者都**不报错**，只会在用户那边表现为"搜索结果里有重复"。 */
  rebuild();
  state.port = deps.port ?? SEARCH_INDEX_PORT;

  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  state.fetchPage = fetchPage;
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") { send(res, 204, ""); return; }
    if (req.method === "GET") { handleGet(new URL(req.url ?? "/", "http://127.0.0.1"), res); return; }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", () => handlePost(req, res, body, fetchPage));
      return;
    }
    send(res, 405, { ok: false, error: "method not allowed" });
  });

  /* ⚠️ 端口占用必须**出声**：静默没起来 = 页面永远少一块补充命中，且没人知道为什么。 */
  /* ⚠️ `port: 0` = 让系统分配（测试用）⇒ 绑定后必须把**实际端口**写回 `state.port`，
     否则调用方拿到的是 0，照着 `127.0.0.1:0` 去连 ⇒ `EADDRNOTAVAIL`（且不报端口冲突）。 */
  const bound = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      resolve({ ok: false, error: e.code === "EADDRINUSE" ? `端口 ${state.port} 已被占用` : String(e.message) });
    });
    server.listen(state.port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") { state.port = addr.port; }
      resolve({ ok: true });
    });
  });
  if (!bound.ok) {
    state.server = null;
    return { ok: false, error: bound.error };
  }
  state.server = server;
  pushLog(`服务已启动：http://127.0.0.1:${state.port}（${indexStats(state.index).pages} 页）`);
  return { ok: true, port: state.port };
}

/** 停止服务（幂等）。 */
export async function stopSearchIndexService(): Promise<{ ok: boolean }> {
  const s = state.server;
  if (!s) { return { ok: true }; }
  state.server = null;
  await new Promise<void>((resolve) => { s.close(() => resolve()); });
  pushLog("服务已停止");
  return { ok: true };
}

/** 状态（渲染层与 `/status` 共用同一份事实）。 */
export function searchIndexStatus(): SearchIndexStatus {
  const st = indexStats(state.index);
  return {
    running: state.server !== null,
    port: state.port,
    pages: st.pages,
    terms: st.terms,
    crawling: state.crawling,
    log: state.log.slice(-10),
    lastCrawl: state.lastCrawl,
    sites: searchIndexSites(),
    params: getSearchIndexParams(),
  };
}

/**
 * 读**当前生效**的全局参数（返回副本：调用方拿到后改它不该影响运行中的索引）。
 *
 * ⚠️ 回的是**夹取后**的生效值，不是文件里的原始值 —— 面板的输入框直接显示它，
 *   这样"我填了 999 结果被夹到 2000"这种事用户是**看得见**的（铁律：降级要看得见）。
 */
export function getSearchIndexParams(): SearchParams {
  return { index: { ...state.params.index, stopwords: [...state.params.index.stopwords] }, body: { ...state.params.body } };
}

/**
 * 改全局参数（**唯一入口**）：夹取 → 落盘 → **立即重建索引** → 记日志。
 *
 * ⚠️ 为什么改完就重建：分词参数（整词长度 / 最短词长 / 停用词）决定倒排里存的是哪些 term，
 *   不重建的话新参数只对**之后**收录的页生效，同一个库里两套口径 ⇒ 一部分页永远搜不到。
 *   重建只是重算内存里的倒排（原文都在 `pages.json`），千页量级是毫秒级，不值得省。
 * ⚠️ 抓取中**拒绝**改：爬完那一下会用 `state.params` 重建，中途换参数会让"这批页用了哪套参数"
 *   变成一个没人说得清的问题（而且日志里也对不上）。
 */
export function setSearchIndexParams(raw: unknown): { ok: boolean; error?: string; pages?: number; terms?: number; notice?: string } {
  if (state.crawling) { return { ok: false, error: "正在收录中，请等收录结束后再改参数" }; }
  const p = (raw ?? {}) as { index?: Partial<IndexOptions>; body?: Partial<BodyOptions> };
  const next: SearchParams = { index: clampIndexOptions(p.index), body: clampBodyOptions(p.body) };
  const notice = clampNotice(p.index ?? {}, p.body ?? {}, next);
  state.params = next;
  saveParams();
  rebuild();
  savePages(state.pagesPath, state.pages);
  const st = indexStats(state.index);
  pushLog(`参数已更新：整词长度 ${state.params.index.wholeWordMaxLen} / 最短词长 ${state.params.index.minTermLen} / 停用词 ${state.params.index.stopwords.length} 个 / k1 ${state.params.index.k1} / b ${state.params.index.b} / 标题加权 ${state.params.index.titleBoost} / 近似距离 ${state.params.index.fuzzyMaxEdits}`);
  pushLog(`已按新参数重建索引：${st.pages} 页 · ${st.terms} 词`);
  return notice ? { ok: true, pages: st.pages, terms: st.terms, notice } : { ok: true, pages: st.pages, terms: st.terms };
}

/**
 * 夹取是否**真的**改动了什么（铁律 31：降级要看得见）。
 *
 * ⚠️ 只在真被改时提示 —— 每次都喊「已夹取」会让提示变成噪音，用户就再也不看了
 *   （与"失败必须显示"是同一类纪律：提示的价值来自它**稀有**）。
 * ⚠️ 空值/缺省跳过：没填 ≠ 填错，缺省是"用默认值"，不是"被夹取"。
 */
function clampNotice(rawIndex: Partial<IndexOptions>, rawBody: Partial<BodyOptions>, next: SearchParams): string | undefined {
  const pairs: [unknown, number][] = [
    [rawIndex.k1, next.index.k1],
    [rawIndex.b, next.index.b],
    [rawIndex.titleBoost, next.index.titleBoost],
    [rawIndex.wholeWordMaxLen, next.index.wholeWordMaxLen],
    [rawIndex.minTermLen, next.index.minTermLen],
    /* A-1143：三个近似检索参数也必须进这张表 —— 漏一个，用户填 99 被夹到 2 时**没有任何提示**
       （"被夹取要看得见"这条就只在那一项上静默失效了）。 */
    [rawIndex.fuzzyMaxEdits, next.index.fuzzyMaxEdits],
    [rawIndex.fuzzyMinTermLen, next.index.fuzzyMinTermLen],
    [rawIndex.fuzzyMaxExpansions, next.index.fuzzyMaxExpansions],
    [rawBody.minBodyChars, next.body.minBodyChars],
    [rawBody.maxBodyChars, next.body.maxBodyChars],
  ];
  for (const [raw, got] of pairs) {
    if (raw === undefined || raw === null || raw === "") { continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n !== got) { return "填写的数值超出允许范围，已夹取到最接近的合法值"; }
  }
  return undefined;
}

/** 按站点统计（页数降序；同页数按域名升序，保证顺序**稳定**而不是随 Map 插入序漂）。 */
export function searchIndexSites(): SearchIndexSite[] {
  const m = new Map<string, number>();
  for (const p of state.pages) {
    const h = hostOf(p.url) || "(未知)";
    m.set(h, (m.get(h) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([host, pages]) => ({ host, pages }))
    .sort((a, b) => b.pages - a.pages || a.host.localeCompare(b.host));
}

/**
 * **重建索引**：只重算倒排与派生结构，**不动已收录的页面**。
 *
 * 用途：改了打分公式 / 索引文件被外部改坏 / 怀疑映射与页面不同步时，用它把索引恢复到
 * "与 pages.json 一致"的状态。它**不抓任何东西**（与"重新收录"是两件事，别混）。
 */
export function rebuildSearchIndex(): { ok: boolean; pages: number; terms: number } {
  rebuild();
  savePages(state.pagesPath, state.pages);
  const st = indexStats(state.index);
  pushLog(`索引已重建：${st.pages} 页 · ${st.terms} 词（未重新抓取）`);
  return { ok: true, pages: st.pages, terms: st.terms };
}

/**
 * **清空索引**（不可撤销）。
 *
 * ⚠️ 这里**不做二次确认**：确认属于界面的事（`SearchIndexPanel` 的 confirm），
 *   主进程只负责"被要求清空就真的清空"。两处都做确认会让"确认"变成两个产地，
 *   一处改了措辞另一处没改，用户看到的是两套说法。
 */
export function clearSearchIndex(): { ok: boolean; removed: number } {
  const n = state.pages.length;
  state.pages = [];
  rebuild();
  savePages(state.pagesPath, state.pages);
  pushLog(`索引已清空：删除 ${n} 页`);
  return { ok: true, removed: n };
}

/**
 * **按站点删除**（`host` 粒度：`example.com` 与该主机的端口一并算一个站）。
 *
 * ⚠️ 删完必须**重新编号** `id`：`id` 是 `byId` 的键，而新增页面的 id 来自
 *   `state.pages.length + 1` —— 如果留下空号（删掉 id=1 后剩 [2,3]），下一批新增
 *   就会算出 id=3，**与已存在的 3 撞号**，于是 byId 里一页被另一页顶掉（静默丢结果）。
 */
export function removeSearchIndexSite(host: string): { ok: boolean; removed: number; error?: string } {
  const h = String(host ?? "").trim().toLowerCase();
  if (!h) { return { ok: false, removed: 0, error: "缺少要删除的站点域名" }; }
  const keep = state.pages.filter((p) => (hostOf(p.url) || "").toLowerCase() !== h);
  const removed = state.pages.length - keep.length;
  state.pages = keep.map((p, i) => ({ ...p, id: i + 1 }));
  rebuild();
  savePages(state.pagesPath, state.pages);
  pushLog(`已删除站点 ${h}：${removed} 页`);
  return { ok: true, removed };
}

/**
 * 渲染层「开始收录」入口（设置页那个按钮）。
 * 与 HTTP `/crawl` **共用** `clampCrawlOpts` + `beginCrawl` —— 两处入口各写一套校验迟早会漂。
 *
 * `input` 可以是单个网址、**多行文本**（批量收录）或字符串数组 ⇒ 统一走 `normalizeSeeds`。
 */
export function startSearchIndexCrawl(input: unknown, opts?: CrawlStartOptions): { ok: boolean; error?: string } {
  const seeds = normalizeSeeds(input);
  const s = seeds.join("\n");
  if (!s) { return { ok: false, error: "请填写要收录的网址（http/https 开头）" }; }
  if (!state.server) { return { ok: false, error: "索引服务未启动" }; }
  const r = beginCrawl(seeds, clampCrawlOpts(opts ?? {}), state.fetchPage ?? defaultFetchPage);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * 注册渲染层的**九条**一键控制（sender 判据复用注入的 `isMainSender`，**不在这里重抄一份**）。
 *
 * 九条 = 启 / 停 / 状态 / 收录 / 重建 / 清空 / 删站（A-1138·A-1139）+ 读参数 / 写参数（A-1140）。
 * 其中**七条**会改动状态（状态与读参数两条只读，未授权时回 `null`）。
 *
 * ⚠️ 为什么不用 guest 白名单：这几条的 sender 是主窗口，dev 模式下其 origin 是
 * `http://localhost:PORT`（另一个端口）⇒ 用 guest 判据会被**误拒且无报错**
 * （A-1137 已实证过一次，见 `searchBridge.ts::isTrustedMainSender` 的注释）。
 *
 * ⚠️ 七条的授权判据是**同一句**（"未授权来源：只有主窗口可以控制索引服务"）。
 *   不要为了"少写几遍"抽成一个 wrapper —— 那样变异测试就再也无法**逐条**命中
 *   （mut-a1138 的 M29/M31 靠这段原文定位）。重复 7 行换"每条都能被单独打坏"是划算的。
 */
export function registerSearchIndexIpc(deps: SearchIndexDeps & {
  isMainSender: (sender: Electron.WebContents) => boolean;
}): void {
  const trusted = (event: { sender: Electron.WebContents }): boolean => {
    try { return deps.isMainSender(event.sender); } catch { return false; }
  };
  ipcMain.handle(IPC_CHANNELS.search_index_start, async (event) => {
    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }
    return startSearchIndexService(deps);
  });
  ipcMain.handle(IPC_CHANNELS.search_index_stop, async (event) => {
    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }
    return stopSearchIndexService();
  });
  ipcMain.handle(IPC_CHANNELS.search_index_status, (event) => {
    if (!trusted(event)) { return null; }
    return searchIndexStatus();
  });
  /* A-1139：收录载荷可以是 `{ seeds, opts }`，也可以是**裸字符串/数组**（兼容老调用方）。
     两种形态都在 `startSearchIndexCrawl` 里归一（`normalizeSeeds` 是唯一产地）。 */
  ipcMain.handle(IPC_CHANNELS.search_index_crawl, (event, payload: unknown) => {
    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }
    const p = (payload ?? {}) as { seeds?: unknown; seed?: unknown; opts?: CrawlStartOptions };
    if (typeof payload === "string" || Array.isArray(payload)) { return startSearchIndexCrawl(payload); }
    return startSearchIndexCrawl(p.seeds ?? p.seed, p.opts);
  });
  ipcMain.handle(IPC_CHANNELS.search_index_rebuild, (event) => {
    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }
    return rebuildSearchIndex();
  });
  ipcMain.handle(IPC_CHANNELS.search_index_clear, (event) => {
    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }
    return clearSearchIndex();
  });
  ipcMain.handle(IPC_CHANNELS.search_index_removeSite, (event, host: unknown) => {
    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }
    return removeSearchIndexSite(String(host ?? ""));
  });
  ipcMain.handle(IPC_CHANNELS.search_index_params_get, (event) => {
    if (!trusted(event)) { return null; }
    return getSearchIndexParams();
  });
  ipcMain.handle(IPC_CHANNELS.search_index_params_set, (event, p: unknown) => {
    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }
    return setSearchIndexParams(p);
  });
}

/** 仅供测试：把进程内状态清干净（真实运行时不需要）。 */
export function __resetSearchIndexForTest(): void {
  state.server = null;
  state.pages = [];
  state.byId = new Map();
  state.byUrl = new Map();
  state.fpByUrl = new Map();
  state.fpTaken = new Set();
  state.index = emptyIndex();
  state.params = defaultSearchParams();
  state.crawling = false;
  state.log = [];
  state.lastCrawl = null;
  state.port = SEARCH_INDEX_PORT;
  state.fetchPage = null;
}
