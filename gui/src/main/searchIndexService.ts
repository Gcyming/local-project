



























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


export const SEARCH_INDEX_PORT = 8600;


const LOG_CAP = 60;

export interface SearchIndexDeps {
  
  userData: string;
  
  port?: number;
  
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
  
  sites?: SearchIndexSite[];
  
  params?: SearchParams;
  error?: string;
}


export interface SearchIndexSite { host: string; pages: number }







export interface SearchParams {
  
  index: IndexOptions;
  
  body: BodyOptions;
}


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
  
  paramsPath: string;
  
  params: SearchParams;
  index: SearchIndex;
  pages: IndexedPage[];
  byId: Map<number, IndexedPage>;
  
  byUrl: Map<string, IndexedPage>;
  
  fpByUrl: Map<string, string>;
  
  fpTaken: Set<string>;
  crawling: boolean;
  log: string[];
  lastCrawl: SearchIndexStatus["lastCrawl"];
  
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
      
      pushLog("索引文件读不出来，已按空库启动（重新爬取即可恢复）");
    }
  }
  return { pages };
}

function savePages(pagesPath: string, pages: IndexedPage[]): void {
  mkdirSync(dirname(pagesPath), { recursive: true });
  writeFileSync(pagesPath, JSON.stringify(pages), "utf8");
}









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
      


      expansions: r.expansions,
    });
    return;
  }
  send(res, 404, { ok: false, error: "not found" });
}


export interface CrawlStartOptions {
  maxPages?: unknown;
  maxDepth?: unknown;
  delay?: unknown;
  
  sameDomain?: unknown;
  
  respectRobots?: unknown;
}


export interface EffectiveCrawlOpts {
  maxPages: number;
  maxDepth: number;
  delay: number;
  sameDomain: boolean;
  respectRobots: boolean;
}










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

  
  const stayDomains = o.sameDomain
    ? [...new Set(seeds.map((s) => hostOf(s)).filter(Boolean))]
    : [];

  
  void (async () => {
    try {
      const r = await crawl(fetchPage, {
        seeds, maxPages: o.maxPages, maxDepth: o.maxDepth, delay: o.delay,
        stayDomains,
        respectRobots: o.respectRobots,
        
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


export interface UpsertStats { added: number; updated: number; dups: number; unchanged: number }








function upsertPages(incoming: { url: string; title: string; text: string }[]): UpsertStats {
  const stats: UpsertStats = { added: 0, updated: 0, dups: 0, unchanged: 0 };
  for (const p of incoming) {
    const fp = contentFingerprint(p.title, p.text);
    const existing = state.byUrl.get(p.url);
    if (existing) {
      if (state.fpByUrl.get(p.url) === fp) { stats.unchanged += 1; continue; } 
      state.fpTaken.delete(state.fpByUrl.get(p.url) ?? "");
      existing.title = p.title;
      existing.text = p.text;
      state.fpByUrl.set(p.url, fp);
      state.fpTaken.add(fp);
      stats.updated += 1;
      continue;
    }
    if (state.fpTaken.has(fp)) { stats.dups += 1; continue; } 
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
  try { payload = JSON.parse(body || "{}") as Record<string, unknown>; } catch {  }
  

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


export async function startSearchIndexService(deps: SearchIndexDeps): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (state.server) { return { ok: true, port: state.port }; }
  const { dir, pages, params: paramsPath } = pathsFor(deps.userData);
  state.pagesPath = pages;
  state.paramsPath = paramsPath;
  mkdirSync(dir, { recursive: true });
  const store = loadStore(pages);
  state.pages = store.pages;
  

  state.params = loadParams(paramsPath);
  


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


export async function stopSearchIndexService(): Promise<{ ok: boolean }> {
  const s = state.server;
  if (!s) { return { ok: true }; }
  state.server = null;
  await new Promise<void>((resolve) => { s.close(() => resolve()); });
  pushLog("服务已停止");
  return { ok: true };
}


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







export function getSearchIndexParams(): SearchParams {
  return { index: { ...state.params.index, stopwords: [...state.params.index.stopwords] }, body: { ...state.params.body } };
}










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








function clampNotice(rawIndex: Partial<IndexOptions>, rawBody: Partial<BodyOptions>, next: SearchParams): string | undefined {
  const pairs: [unknown, number][] = [
    [rawIndex.k1, next.index.k1],
    [rawIndex.b, next.index.b],
    [rawIndex.titleBoost, next.index.titleBoost],
    [rawIndex.wholeWordMaxLen, next.index.wholeWordMaxLen],
    [rawIndex.minTermLen, next.index.minTermLen],
    

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







export function rebuildSearchIndex(): { ok: boolean; pages: number; terms: number } {
  rebuild();
  savePages(state.pagesPath, state.pages);
  const st = indexStats(state.index);
  pushLog(`索引已重建：${st.pages} 页 · ${st.terms} 词（未重新抓取）`);
  return { ok: true, pages: st.pages, terms: st.terms };
}








export function clearSearchIndex(): { ok: boolean; removed: number } {
  const n = state.pages.length;
  state.pages = [];
  rebuild();
  savePages(state.pagesPath, state.pages);
  pushLog(`索引已清空：删除 ${n} 页`);
  return { ok: true, removed: n };
}








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







export function startSearchIndexCrawl(input: unknown, opts?: CrawlStartOptions): { ok: boolean; error?: string } {
  const seeds = normalizeSeeds(input);
  const s = seeds.join("\n");
  if (!s) { return { ok: false, error: "请填写要收录的网址（http/https 开头）" }; }
  if (!state.server) { return { ok: false, error: "索引服务未启动" }; }
  const r = beginCrawl(seeds, clampCrawlOpts(opts ?? {}), state.fetchPage ?? defaultFetchPage);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}















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
