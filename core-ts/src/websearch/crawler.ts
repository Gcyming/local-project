/**
 * core-ts/src/websearch/crawler.ts — 「自建全网索引」的爬虫（BFS + robots + 正文抽取）。
 *
 * ## 与 Python 那份的关系
 * 行为基准是 `core/websearch/crawler.py`（v3.2.0 随包那份），逐条对齐：
 *   · 只走 `http/https`，去 fragment，host 小写，去尾斜杠（`/` 本身保留）；
 *   · `SKIP_EXT` 跳过图片/样式/脚本/归档等扩展名；
 *   · **同主机礼貌延迟**（默认 1.0s），BFS 受 `maxPages` / `maxDepth` 双重限制；
 *   · robots.txt **取不到就宽松放行**（Python 是 `except: rp = None ⇒ True`），
 *     但取到了就必须遵守 —— 这是「请只抓取你有权抓取的站点」的落点；
 *   · 单页最多读 1.5MB（`MAX_BODY_BYTES`）。
 *
 * ## ⚠️ IO 全部可注入
 * `crawl()` 不直接发请求：抓取动作由调用方传进来的 `fetchPage` 完成
 * ⇒ 单测可以给一个假抓取器，把「去重 / 深度 / 延迟 / robots / 跳过扩展名」这些**行为**测出来，
 * 而不需要真的联网（联网测的是网络，不是爬虫逻辑）。
 */

/** 爬虫自我标识（与 Python `USER_AGENT` 一致）。 */
export const CRAWLER_UA = "SlimeMiniBot/1.0 (+https://slime.local; personal search engine)";

/** 单页最多读取的字节数。 */
export const MAX_BODY_BYTES = 1_500_000;

/** 不抓取的扩展名（图片 / 样式 / 脚本 / 归档 / 字体 / 媒体）。 */
export const SKIP_EXT_RE = /\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|map|json|xml|pdf|zip|gz|tar|mp3|mp4|avi|mov|wmv|woff2?|ttf|eot|exe|dmg|iso|7z|rar)(?:[?#].*)?$/i;

/**
 * 正文参数（**抽取 / 入库**侧；A-1140）。
 *
 * ## 参考的是什么
 * 全网搜索引擎对「正文」都有一道**质量闸**与一道**长度闸**：
 *   · 质量闸 = 太短的"页面"（导航页、跳转页、"请开启 JavaScript"页）不该进正文索引
 *     —— 它们进索引只会让结果里全是噪声（这是 `minBodyChars`）；
 *   · 长度闸 = 单页超长（论坛长贴、API 文档整本）会把倒排撑大，且尾部多是无关的
 *     评论/推荐位（这是 `maxBodyChars`）。
 *
 * ## ⚠️ 与 `IndexOptions` 的分工
 * 这一组是**抓取时**生效的（决定"这一页进不进索引、以什么内容进"）；
 * `IndexOptions` 是**建索引时**生效的（决定"进了索引的文字怎么切、怎么打分"）。
 * 所以：改了 `IndexOptions` ⇒ 重建索引即可（原文已存）；
 * 改了 `BodyOptions` ⇒ **只影响之后新收录的页**（已入库的正文是当时截好的）。
 */
export interface BodyOptions {
  /** 最短正文字数；低于它视为"没有正文"，**不收录**（默认 1 = 只挡空正文，与旧行为一致）。 */
  minBodyChars: number;
  /** 单页正文字数上限；0 = 不限（默认 0 = 不截断，与旧行为一致）。 */
  maxBodyChars: number;
}

/** 默认正文参数（**逐字等于旧行为**：空正文才跳过、不截断）。 */
export const DEFAULT_BODY_OPTIONS: BodyOptions = { minBodyChars: 1, maxBodyChars: 0 };

/**
 * 正文参数夹取（**唯一产地**；与 `clampIndexOptions` 对称，调用点在服务层）。
 * 上限 0 / 100000：个人索引里 10 万字的单页已经是极端值，再大就是"数据集"不是"搜索索引"。
 */
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

/** 抓取结果（IO 层的原子动作）。 */
export interface FetchedPage {
  ok: boolean;
  status?: number;
  url: string;
  title?: string;
  text?: string;
  html?: string;
  error?: string;
}

/** 调用方注入的抓取器（真网络 / 假数据，由调用方决定）。 */
export type FetchPage = (url: string, timeoutMs: number) => Promise<FetchedPage>;

/** 爬取进度回调（`progress(msg)`）。 */
export type CrawlProgress = (msg: string) => void;

export interface CrawlOptions {
  seeds: string[];
  maxPages?: number;
  maxDepth?: number;
  /** 同主机请求间隔（秒）。 */
  delay?: number;
  timeoutMs?: number;
  /** 只留这些域（空 = 不限制）。 */
  stayDomains?: string[];
  respectRobots?: boolean;
  /** 最短正文字数（低于则跳过；缺省 1 = 只挡空正文）。 */
  minBodyChars?: number;
  /** 单页正文字数上限（0 / 未给 = 不截断）。 */
  maxBodyChars?: number;
  progress?: CrawlProgress;
}

export interface CrawlResult {
  pages: { url: string; title: string; text: string }[];
  fetched: number;
  skipped: number;
}

/** URL 归一化：只留 http/https，去 fragment，host 小写，去尾斜杠。非法 ⇒ `null`。 */
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

/** 主机（小写），用于礼貌延迟与域限制。 */
export function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

/** 压缩空白（与 Python `clean_text` 一致）。 */
export function cleanText(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** 从 HTML 里抽 `<title>` 与可见正文（跳过 script/style/noscript/template/iframe/svg/canvas）。 */
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

/** 抽出页面里的链接（相对 → 绝对）。 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    if (!raw) { continue; }
    if (/^(mailto:|javascript:|tel:|#)/i.test(raw)) { continue; }
    try { out.push(new URL(raw, baseUrl).toString()); } catch { /* 忽略坏链接 */ }
  }
  return out;
}

/** robots.txt 的极简判定：取不到 ⇒ 放行；取到了就按 Disallow 前缀判。 */
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

/**
 * 广度优先爬取。
 *
 * ⚠️ 顺序与「责任」：去重靠 `seen`（入队即记），深度靠队列里的 `depth`，
 * 礼貌延迟按**主机**分别计时（同主机连续请求至少隔 `delay` 秒）。
 */
export async function crawl(fetchPage: FetchPage, opts: CrawlOptions): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(2000, Math.floor(opts.maxPages ?? 200)));
  const maxDepth = Math.max(1, Math.min(6, Math.floor(opts.maxDepth ?? 3)));
  const delay = Math.max(0.3, opts.delay ?? 1.0);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const respectRobots = opts.respectRobots !== false;
  /* ⚠️ 正文参数也在这里夹取（与 maxPages/maxDepth/delay 同一处）—— 因为 `crawl()` 也可能被
     直接调用（不经服务层）⇒ 夹取跟着函数走，才不会出现"某条入口忘了夹"的洞。 */
  const body = clampBodyOptions({ minBodyChars: opts.minBodyChars, maxBodyChars: opts.maxBodyChars });
  const stay = new Set((opts.stayDomains ?? []).map((d) => d.toLowerCase()));
  const progress = opts.progress ?? (() => { /* 静默 */ });

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
    /* 长度闸先截断（超长页只留前 `maxBodyChars` 字），质量闸再判空 —— 顺序不能反：
       先判后截会让"超长但有效"的页被误杀？不会；但先截后判能让 minBodyChars 的判定
       落在**真正入库的那段文字**上（否则"截出来是空"这种边界会以完整正文通过闸门）。 */
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
