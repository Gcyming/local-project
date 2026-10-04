






















export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
}


export type EngineId = "bing" | "baidu";



export type SearchAttempt =
  | { engine: EngineId; ok: true; items: SearchItem[]; captcha: boolean }
  | { engine: EngineId; ok: false; error: string };

export type OnlineSearchOutcome =
  | { ok: true; engine: EngineId; engineName: string; items: SearchItem[] }
  | { ok: false; error: string; captcha: boolean; attempts: SearchAttempt[] };

export interface SearchOptions {
  

  maxResults?: unknown;
  
  prewarm?: boolean;
}


export const BING_HOME = "https://cn.bing.com/";
export const BING_SEARCH = "https://cn.bing.com/search";
export const BAIDU_SEARCH = "https://www.baidu.com/s";

export const MAX_RESULTS = 10;
export const DEFAULT_RESULTS = 10;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) slime-agent";

export const ENGINE_NAMES: Record<EngineId, string> = {
  bing: "必应（国内）",
  baidu: "百度",
};


export const CAPTCHA_KEYWORDS = [
  "安全验证", "验证码", "滑块", "人机验证",
  "verify", "captcha", "robot", "unusual traffic", "challenge",
];

export const CAPTCHA_MSG =
  "[搜索引擎要求人机验证。请稍等 1 分钟后重试，或更换网络环境后再搜索。]";

const EMPTY_MSG = "[无搜索结果]";


const DELAY_MIN = 0.5, DELAY_MAX = 1.3;
const BACKOFF_MIN = 2.0, BACKOFF_MAX = 4.0;
const BACKOFF_WINDOW_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const PREWARM_TIMEOUT_MS = 10_000;


let _searchPrewarmed = false;
let _searchPrewarmPromise: Promise<void> | null = null;
let _captchaUntil = 0;

function _searchDelay(): Promise<void> {
  const inBackoff = Date.now() < _captchaUntil;
  const min = inBackoff ? BACKOFF_MIN : DELAY_MIN;
  const max = inBackoff ? BACKOFF_MAX : DELAY_MAX;
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms * 1000));
}

export async function searchPrewarm(): Promise<void> {
  if (_searchPrewarmed) { return; }
  if (_searchPrewarmPromise) { return _searchPrewarmPromise; }
  _searchPrewarmed = true; 
  _searchPrewarmPromise = (async () => {
    try {
      await fetch(BING_HOME, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
    } catch {  }
  })();
  return _searchPrewarmPromise;
}


export function isCaptchaHtml(html: string): boolean {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .toLowerCase();
  return CAPTCHA_KEYWORDS.some((k) => text.includes(k.toLowerCase()));
}

function markCaptcha(): void {
  _captchaUntil = Date.now() + BACKOFF_WINDOW_MS;
}


export function inCaptchaBackoff(): boolean {
  return Date.now() < _captchaUntil;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}


export function parseBingItems(html: string, maxResults: number): SearchItem[] {
  const items: SearchItem[] = [];
  const liRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null && items.length < maxResults) {
    const block = m[0];
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) { continue; }
    const link = titleMatch[1];
    const title = stripTags(titleMatch[2]);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    items.push({ title, url: link, snippet, source: hostOf(link) });
  }
  return items;
}


export function parseBaiduItems(html: string, maxResults: number): SearchItem[] {
  const items: SearchItem[] = [];
  const resultRe = /<h3[^>]*>[\s\S]*?<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = resultRe.exec(html)) !== null && items.length < maxResults) {
    const link = m[1];
    const title = stripTags(m[2]);
    if (!title || !link) { continue; }
    
    const afterLink = html.slice(m.index + m[0].length);
    const descMatch = afterLink.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = descMatch ? stripTags(descMatch[1]).slice(0, 200) : "";
    items.push({ title, url: link, snippet, source: hostOf(link) });
  }
  return items;
}





export function formatItemsForModel(items: SearchItem[]): string {
  if (!items.length) { return EMPTY_MSG; }
  return items.map((it) => `- ${it.title}\n  ${it.url}\n  ${it.snippet}`).join("\n");
}

function buildUrl(engine: EngineId, query: string, maxResults: number): string {
  return engine === "bing"
    ? `${BING_SEARCH}?q=${encodeURIComponent(query)}&count=${maxResults}`
    : `${BAIDU_SEARCH}?wd=${encodeURIComponent(query)}&rn=${maxResults}`;
}

function parseBy(engine: EngineId, html: string, maxResults: number): SearchItem[] {
  return engine === "bing" ? parseBingItems(html, maxResults) : parseBaiduItems(html, maxResults);
}

async function attempt(engine: EngineId, query: string, maxResults: number): Promise<SearchAttempt> {
  let html: string;
  try {
    const resp = await fetch(buildUrl(engine, query, maxResults), {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) { return { engine, ok: false, error: `HTTP ${resp.status}` }; }
    html = await resp.text();
  } catch (e) {
    return { engine, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const items = parseBy(engine, html, maxResults);
  
  const captcha = items.length === 0 && isCaptchaHtml(html);
  if (captcha) { markCaptcha(); }
  return { engine, ok: true, items, captcha };
}

function normalizeMax(v: unknown): number {
  const n = Number(v ?? DEFAULT_RESULTS);
  if (!Number.isFinite(n)) { return DEFAULT_RESULTS; }
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(n)));
}





export async function searchOnline(query: string, opts: SearchOptions = {}): Promise<OnlineSearchOutcome> {
  const q = String(query ?? "").trim();
  if (!q) { return { ok: false, error: "缺少查询词", captcha: false, attempts: [] }; }
  const maxResults = normalizeMax(opts.maxResults);
  if (opts.prewarm !== false) { await searchPrewarm(); }
  await _searchDelay();

  const attempts: SearchAttempt[] = [];
  const first = await attempt("bing", q, maxResults);
  attempts.push(first);
  if (first.ok && first.items.length > 0) {
    return { ok: true, engine: "bing", engineName: ENGINE_NAMES.bing, items: first.items };
  }
  if (first.ok) {
    
    if (first.captcha) { return { ok: false, error: CAPTCHA_MSG, captcha: true, attempts }; }
    return { ok: true, engine: "bing", engineName: ENGINE_NAMES.bing, items: [] };
  }

  const second = await attempt("baidu", q, maxResults);
  attempts.push(second);
  if (second.ok && second.items.length > 0) {
    return { ok: true, engine: "baidu", engineName: ENGINE_NAMES.baidu, items: second.items };
  }
  if (second.ok) {
    if (second.captcha) { return { ok: false, error: CAPTCHA_MSG, captcha: true, attempts }; }
    return { ok: true, engine: "baidu", engineName: ENGINE_NAMES.baidu, items: [] };
  }
  return { ok: false, error: formatAttemptErrors(attempts), captcha: false, attempts };
}


function formatAttemptErrors(attempts: SearchAttempt[]): string {
  const bing = attempts.find((a) => a.engine === "bing");
  const baidu = attempts.find((a) => a.engine === "baidu");
  const bingErr = bing && !bing.ok ? bing.error : "未知错误";
  if (baidu && !baidu.ok) { return `[错误] 搜索失败（Bing: ${bingErr}；百度: ${baidu.error}）`; }
  return `[错误] 搜索失败（Bing: ${bingErr}）`;
}





export async function searchOnlineText(query: string, opts: SearchOptions = {}): Promise<string> {
  const r = await searchOnline(query, opts);
  if (r.ok) {
    return r.items.length ? formatItemsForModel(r.items) : EMPTY_MSG;
  }
  if (r.captcha) { return CAPTCHA_MSG; }
  return r.error;
}
