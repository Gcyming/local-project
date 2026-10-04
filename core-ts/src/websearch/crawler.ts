


















export const CRAWLER_UA = "SlimeMiniBot/1.0 (+https://slime.local; personal search engine)";


export const MAX_BODY_BYTES = 1_500_000;


export const SKIP_EXT_RE = /\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|map|json|xml|pdf|zip|gz|tar|mp3|mp4|avi|mov|wmv|woff2?|ttf|eot|exe|dmg|iso|7z|rar)(?:[?#].*)?$/i;

















export interface BodyOptions {
  
  minBodyChars: number;
  
  maxBodyChars: number;
}


export const DEFAULT_BODY_OPTIONS: BodyOptions = { minBodyChars: 1, maxBodyChars: 0 };





export function clampBodyOptions(raw: unknown): BodyOptions {
  const o = (raw ?? {}) as Partial<BodyOptions>;
  const num = (v: unknown, d: number, lo: number, hi: number): number => {
    const n = Number(v);
    if (v === undefined || v === null || v === "" || !Number.isFinite(n)) { return d; }
    return Math.floor(Math.min(hi, Math.max(lo, n)));
  };
  return {
    minBodyChars: num(o.minBodyChars, DEFAULT_BODY_OPTIONS.minBodyChars, 0, 100_000),
    maxBodyChars: num(o.maxBodyChars, DEFAULT_BODY_OPTIONS.maxBodyChars, 0, 100_000),
  };
}


export interface FetchedPage {
  ok: boolean;
  status?: number;
  url: string;
  title?: string;
  text?: string;
  html?: string;
  error?: string;
}


export type FetchPage = (url: string, timeoutMs: number) => Promise<FetchedPage>;


export type CrawlProgress = (msg: string) => void;

export interface CrawlOptions {
  seeds: string[];
  maxPages?: number;
  maxDepth?: number;
  
  delay?: number;
  timeoutMs?: number;
  
  stayDomains?: string[];
  respectRobots?: boolean;
  
  minBodyChars?: number;
  
  maxBodyChars?: number;
  progress?: CrawlProgress;
}

export interface CrawlResult {
  pages: { url: string; title: string; text: string }[];
  fetched: number;
  skipped: number;
}


export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") { return null; }
  if (!u.hostname) { return null; }
  let path = u.pathname || "/";
  if (path !== "/" && path.endsWith("/")) { path = path.slice(0, -1); }
  const port = u.port ? ":" + u.port : "";
  return u.protocol + "//" + u.hostname.toLowerCase() + port + path + (u.search || "");
}


export function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}


export function cleanText(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}


export function extractPage(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/<[^>]*>/g, " ").trim();

  let body = html;
  body = body.replace(/<(script|style|noscript|template|iframe|svg|canvas)\b[\s\S]*?<\/\1>/gi, " ");
  body = body.replace(/<head\b[\s\S]*?<\/head>/i, " ");
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<br\s*\/?>/gi, " ");
  body = body.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ");
  body = body.replace(/<[^>]*>/g, " ");
  return { title: cleanText(decodeEntities(title)), text: cleanText(decodeEntities(body)) };
}


export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    if (!raw) { continue; }
    if (/^(mailto:|javascript:|tel:|#)/i.test(raw)) { continue; }
    try { out.push(new URL(raw, baseUrl).toString()); } catch {  }
  }
  return out;
}


export function robotsAllows(txt: string, url: string): boolean {
  const lines = txt.split(/\r?\n/);
  const groups: { agents: string[]; disallow: string[] }[] = [];
  let cur: { agents: string[]; disallow: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) { continue; }
    const kv = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!kv) { continue; }
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === "user-agent") {
      if (!cur || cur.disallow.length > 0) { cur = { agents: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (key === "disallow" && cur) {
      cur.disallow.push(val);
    }
  }
  let path: string;
  try { path = new URL(url).pathname + new URL(url).search; } catch { return true; }
  const want = ["slimeminibot", "*"];
  for (const w of want) {
    const g = groups.find((x) => x.agents.some((a) => a === w || a === "*"));
    if (!g) { continue; }
    for (const d of g.disallow) {
      if (d === "") { return true; }
      if (path.startsWith(d)) { return false; }
    }
    return true;
  }
  return true;
}







export async function crawl(fetchPage: FetchPage, opts: CrawlOptions): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(2000, Math.floor(opts.maxPages ?? 200)));
  const maxDepth = Math.max(1, Math.min(6, Math.floor(opts.maxDepth ?? 3)));
  const delay = Math.max(0.3, opts.delay ?? 1.0);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const respectRobots = opts.respectRobots !== false;
  

  const body = clampBodyOptions({ minBodyChars: opts.minBodyChars, maxBodyChars: opts.maxBodyChars });
  const stay = new Set((opts.stayDomains ?? []).map((d) => d.toLowerCase()));
  const progress = opts.progress ?? (() => {  });

  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  for (const s of opts.seeds) {
    const u = normalizeUrl(s);
    if (u && !seen.has(u)) { seen.add(u); queue.push({ url: u, depth: 0 }); }
  }

  const pages: { url: string; title: string; text: string }[] = [];
  const robotsCache = new Map<string, boolean>();
  const lastHit = new Map<string, number>();
  let fetched = 0;
  let skipped = 0;

  while (queue.length > 0 && fetched < maxPages) {
    const item = queue.shift()!;
    if (SKIP_EXT_RE.test(item.url)) { skipped += 1; continue; }
    if (item.depth > maxDepth) { skipped += 1; continue; }
    const host = hostOf(item.url);
    if (stay.size > 0 && !stay.has(host)) { skipped += 1; continue; }

    if (respectRobots) {
      let allowed = robotsCache.get(host);
      if (allowed === undefined) {
        const r = await fetchPage(new URL(item.url).origin + "/robots.txt", Math.min(timeoutMs, 5000));
        allowed = r.ok && r.html ? robotsAllows(r.html, item.url) : true;
        robotsCache.set(host, allowed);
      }
      if (!allowed) { skipped += 1; progress("robots 禁止：" + item.url); continue; }
    }

    const prev = lastHit.get(host) ?? 0;
    const wait = prev + delay * 1000 - Date.now();
    if (wait > 0) { await new Promise((r) => setTimeout(r, wait)); }
    lastHit.set(host, Date.now());

    const res = await fetchPage(item.url, timeoutMs);
    if (!res.ok || !res.html) { skipped += 1; progress("抓取失败：" + item.url); continue; }
    const parsed = extractPage(res.html);
    


    const text = body.maxBodyChars > 0 ? parsed.text.slice(0, body.maxBodyChars) : parsed.text;
    if (text.length < body.minBodyChars) {
      skipped += 1;
      progress(`正文过短（${parsed.text.length} 字 < ${body.minBodyChars}）：${item.url}`);
      continue;
    }
    const title = parsed.title;
    pages.push({ url: item.url, title, text });
    fetched += 1;
    progress(`[${fetched}/${maxPages}] d${item.depth} ${item.url} (${text.length} 字)`);

    if (item.depth < maxDepth) {
      for (const link of extractLinks(res.html, item.url)) {
        const u = normalizeUrl(link);
        if (!u || seen.has(u)) { continue; }
        if (stay.size > 0 && !stay.has(hostOf(u))) { continue; }
        seen.add(u);
        queue.push({ url: u, depth: item.depth + 1 });
      }
    }
  }

  return { pages, fetched, skipped };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
}
