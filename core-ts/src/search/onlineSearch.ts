/**
 * core-ts/src/search/onlineSearch.ts — **联网检索的唯一产地**（国内 Bing 优先 / 百度兜底）。
 *
 * ## 为什么必须收归（铁律 11：同一事实写在 N 个地方必然漂）
 * 联网检索这件事原先分散在三处，且**各自定义"结果长什么样"**：
 *   ① `tools/builtin.ts::webSearch` —— 返回**给模型看的一段文本**（`- 标题\n  链接\n  摘要`）；
 *   ② 用户搜索页的宿主契约 —— 要的是 `{ok, items:[{title,url,snippet,source}], engine}`；
 *   ③ 渲染层半成品 `searchEngineHost.ts` —— 又一套 `ENGINES` + CSS `selectors`（已被本文件取代并删除）。
 * 三套解析器意味着"Bing 改了 DOM 结构"要修三遍，而**漏修任何一处都是零报错的静默失效**
 * （页面显示"未解析出结果条目"、Agent 拿到 `[无搜索结果]`，谁都不会崩，只是悄悄变瞎）。
 * ⇒ 这里收敛成**一个解析器 + 两个形态适配器**（`formatItemsForModel` / 结构化 items）。
 *
 * ## 两个形态适配器（同一份 items，两种消费面）
 * · `searchOnlineText()` —— 工具链用（给模型读的紧凑文本，**逐字保持历史格式**，
 *   否则是 Agent 侧的静默行为变化）；
 * · `searchOnline()` —— 搜索页用（结构化 items，页面要渲染卡片、要分页、要 host 去重）。
 *
 * ## 反爬节奏为什么也在这里（而不是留在 tool 层）
 * 「预热 + 搜索间隔 + 验证码退避」是**对上游站点的行为**，与"谁发起检索"无关。
 * 若留在 `webSearch` 里，页面检索就完全不减速 ⇒ 同一个 IP 上两套节奏互相拆台，
 * 反而更容易被打验证码。⇒ 状态与节奏一并收归（进程内单例，两个消费面共享）。
 */
/** 一条检索结果。`source` = 站点域名（给页面渲染来源角标；文本形态不用它）。 */
export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/** 搜索引擎标识。 */
export type EngineId = "bing" | "baidu";

/** 一次上游尝试的结果。`error` 存**已格式化的**原因（`HTTP 500` / 异常消息），
 *  供 `searchOnlineText` 逐字重建历史文案。 */
export type SearchAttempt =
  | { engine: EngineId; ok: true; items: SearchItem[]; captcha: boolean }
  | { engine: EngineId; ok: false; error: string };

export type OnlineSearchOutcome =
  | { ok: true; engine: EngineId; engineName: string; items: SearchItem[] }
  | { ok: false; error: string; captcha: boolean; attempts: SearchAttempt[] };

export interface SearchOptions {
  /** 期望结果条数上限。**接受任意值**（工具入参天然是 unknown），内部归一化到 `1..MAX_RESULTS`。
   *  归一化对 `NaN` 兜底为默认值 —— 历史实现里 `Math.min/max` 遇 NaN 会拼出 `&count=NaN`。 */
  maxResults?: unknown;
  /** 是否做一次首页预热（复用连接 / 拿 Cookie）。默认 true。 */
  prewarm?: boolean;
}

// ── 引擎定义：URL 构造 + 解析器 + 展示名，**一处定义**（新增引擎只改这张表） ──
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

/** 中英文验证码特征（仅匹配可见文本，不匹配脚本文件名；BUG-034 对齐） */
export const CAPTCHA_KEYWORDS = [
  "安全验证", "验证码", "滑块", "人机验证",
  "verify", "captcha", "robot", "unusual traffic", "challenge",
];

export const CAPTCHA_MSG =
  "[搜索引擎要求人机验证。请稍等 1 分钟后重试，或更换网络环境后再搜索。]";

const EMPTY_MSG = "[无搜索结果]";

// ── 反爬节奏与验证码退避（语义移植自 core/search.py SearchEngine） ──
const DELAY_MIN = 0.5, DELAY_MAX = 1.3;
const BACKOFF_MIN = 2.0, BACKOFF_MAX = 4.0;
const BACKOFF_WINDOW_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const PREWARM_TIMEOUT_MS = 10_000;

// 进程内单例状态（连接复用 + 预热/退避共享，两个消费面共用）
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
  _searchPrewarmed = true; // await 前置位，防并发 tool_calls 双重预热
  _searchPrewarmPromise = (async () => {
    try {
      await fetch(BING_HOME, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
    } catch { /* 预热失败不影响搜索 */ }
  })();
  return _searchPrewarmPromise;
}

/** 仅匹配可见文本（去脚本/样式后小写子串匹配） */
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

/** 仅供测试观测：当前是否处于验证码退避窗口。 */
export function inCaptchaBackoff(): boolean {
  return Date.now() < _captchaUntil;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** 解析 Bing 搜索结果（li.b_algo 结构）→ 结构化条目。 */
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

/** 解析百度搜索结果 → 结构化条目。 */
export function parseBaiduItems(html: string, maxResults: number): SearchItem[] {
  const items: SearchItem[] = [];
  const resultRe = /<h3[^>]*>[\s\S]*?<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = resultRe.exec(html)) !== null && items.length < maxResults) {
    const link = m[1];
    const title = stripTags(m[2]);
    if (!title || !link) { continue; }
    // 百度摘要在后续 <p> 标签中
    const afterLink = html.slice(m.index + m[0].length);
    const descMatch = afterLink.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = descMatch ? stripTags(descMatch[1]).slice(0, 200) : "";
    items.push({ title, url: link, snippet, source: hostOf(link) });
  }
  return items;
}

/**
 * 给模型读的紧凑文本形态。
 * ⚠️ **格式是历史契约**：`- 标题\n  链接\n  摘要`，多条以 `\n` 分隔 —— 改它就是改 Agent 的输入。
 */
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
  // BUG-034 对齐：无结果时再做验证码检测（真验证码页必然无结果）
  const captcha = items.length === 0 && isCaptchaHtml(html);
  if (captcha) { markCaptcha(); }
  return { engine, ok: true, items, captcha };
}

function normalizeMax(v: unknown): number {
  const n = Number(v ?? DEFAULT_RESULTS);
  if (!Number.isFinite(n)) { return DEFAULT_RESULTS; }
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(n)));
}

/**
 * 联网检索（结构化）。**唯一入口** —— 两个消费面都走这里。
 * 顺序：国内 Bing → 失败则百度兜底（与历史行为一致）。
 */
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
    // Bing 通但无结果：验证码页才有必要退避并明确告知，否则就是真的没有结果
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

/** 两个引擎都失败时的文案（与历史 `webSearch` 的报错逐字一致）。 */
function formatAttemptErrors(attempts: SearchAttempt[]): string {
  const bing = attempts.find((a) => a.engine === "bing");
  const baidu = attempts.find((a) => a.engine === "baidu");
  const bingErr = bing && !bing.ok ? bing.error : "未知错误";
  if (baidu && !baidu.ok) { return `[错误] 搜索失败（Bing: ${bingErr}；百度: ${baidu.error}）`; }
  return `[错误] 搜索失败（Bing: ${bingErr}）`;
}

/**
 * 联网检索（文本）。给工具链用；输出**逐字保持**历史 `webSearch` 的格式。
 * ⚠️ 这里不做任何"顺便优化文案"—— 模型侧的输入变化是行为变化，不是格式美化。
 */
export async function searchOnlineText(query: string, opts: SearchOptions = {}): Promise<string> {
  const r = await searchOnline(query, opts);
  if (r.ok) {
    return r.items.length ? formatItemsForModel(r.items) : EMPTY_MSG;
  }
  if (r.captcha) { return CAPTCHA_MSG; }
  return r.error;
}
