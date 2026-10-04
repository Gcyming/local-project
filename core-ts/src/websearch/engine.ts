/**
 * core-ts/src/websearch/engine.ts — 「自建全网索引」的**纯逻辑**（切分 / 倒排 / BM25 / 摘要）。
 *
 * ## 为什么把它写进 slime（而不是继续 spawn `core/websearch/*.py`）
 * 用户要求「把这些进程写进 slime，而非接线」：外部 Python 进程意味着
 *   ① 依赖用户机器上存在 Python；② 三条命令（crawler → indexer → server）要手动串；
 *   ③ 进程生命周期不在 slime 手里（僵尸占端口、崩溃无人知）。
 * ⇒ 这里用 TypeScript 实现**同一套行为**，由主进程直接起 HTTP 服务，一键启停。
 *
 * ## ⚠️ 行为基准是 Python 那份（不是我拍的）
 * 本文件的每个公式都对齐 `core/websearch/indexer.py`（v3.2.0 随包那份）：
 *   · 切分：`[a-z0-9]+` 按词；CJK 走**二元切分**，长度 ≤ 4 的中文串额外保留整词；
 *   · BM25：`k1=1.5`、`b=0.75`、`idf = ln(1 + (N - df + 0.5)/(df + 0.5))`；
 *   · 标题命中加权 `titleBoost = 3.0`（`eff_tf = tf + 3 * title_tf`，Python 侧叫 `TITLE_BOOST`）；
 *   · 两轮打分：先用「doc_len = avdl」粗排，再对候选按**真实长度**精修；
 *   · **AND 优先**：命中全部查询词的排前面；不足一页时才用部分命中补足
 *     （⚠️ 若全命中的已经够一页，部分命中会被**丢掉** —— 这是 Python 侧既有行为，照抄）。
 * 改任何一个常量都等于改检索结果，属**行为变更**，必须同步改这里的注释与守卫。
 *
 * ## ⚠️ A-1140：这些常量现在是**默认值**，可以被用户改（`IndexOptions`）
 * 用户要求「分词 / 正文参数可调」（以全网权威搜索引擎为参考）⇒ 上面那些数字从"写死的常量"
 * 变成 `DEFAULT_INDEX_OPTIONS` 的默认值。
 *
 * ⚠️ 曾经这里还有 `BM25_K1` / `BM25_B` / `TITLE_BOOST` 三个"派生别名"，A-1140 收尾时**删掉了**：
 * 打分实现一律读 `o.k1` / `o.b` / `o.titleBoost`（`o` = 索引自带的那份），别名**没有任何实现侧
 * 消费点**，只剩两个 spec 的 `toBe` 断言撑着 ⇒ 它们是纯测试面出口，留着就是第二产地的种子。
 * ⇒ 现在打分口径**只有一处可改**：`DEFAULT_INDEX_OPTIONS`。守卫改锚 `DEFAULT_INDEX_OPTIONS.*`。
 * 两条不可动摇的约束：
 *   ① **默认值必须逐字等于 Python 基准** —— 不改参数的用户，行为与以前一字不差；
 *   ② 参数挂在 `SearchIndex.opts` 上（索引自描述），检索只读索引自带那一份 —— 见下面的长注释。
 *
 * ## 为什么是纯函数
 * 无 IO、无时钟、无全局状态 ⇒ 可以逐条单测（含 BM25 数值），
 * 也让「服务层」只负责 HTTP 与落盘（`gui/src/main/searchIndexService.ts`）。
 */

/**
 * 索引参数（**分词 / 打分**两类）。默认值 = `core/websearch/indexer.py` 那份基准，逐字一致。
 *
 * ## 为什么要做成参数（A-1140）
 * 用户要求把「分词 / 正文参数可调」补齐，并**以全网权威搜索引擎为参考**：
 *   · 分词侧对应 Lucene/Elasticsearch 的 **analyzer**（`tokenizer` + `stopwords`）；
 *   · 打分侧对应 Lucene 的 **BM25Similarity**（`k1` / `b` 两个公开旋钮，默认 1.2 / 0.75）；
 *   · `titleBoost` 是本项目的等价物：把标题命中当作"额外重复 titleBoost 次"
 *     （ES 里的 `title^3` 权重提升同宗，只是一个写在 query 里、一个写在索引侧）。
 *
 * ## ⚠️ 索引必须**自带**它当初是用哪套参数建的
 * 中文「二元切分 + 长度≤N 保留整词」让**分词口径**成为索引的一部分：
 * 用 A 套参数建的倒排里只有 bigram，用 B 套参数切出来的查询词是整词 ⇒ 命中数永远是 0，
 * 而**没有任何一处会报错**（用户看到的是"加了参数之后再也搜不到了"）。
 * ⇒ `SearchIndex.opts` 是**唯一产地**：`searchIndex` 只读索引自带的这一份，
 *   不接受调用方另外传一份（那样就有两个产地，迟早漂）。
 *
 * ## ⚠️ 默认值不许动
 * 它们是**行为基准**（对齐 Python 那份）。改任何一项都等于改检索结果，
 * 属行为变更，必须同步改注释 + 守卫（`tests/gui/a1140-search-params.spec.ts`）。
 */
export interface IndexOptions {
  /** BM25 k1：词频饱和点（越大越"奖励高频词"；Lucene 默认 1.2，本项目基准 1.5）。 */
  k1: number;
  /** BM25 b：文档长度归一强度，0 = 不归一、1 = 完全归一（Lucene 默认 0.75）。 */
  b: number;
  /** 标题命中加权（`eff_tf = tf + titleBoost * title_tf`）。 */
  titleBoost: number;
  /** 中文「额外保留整词」的最大长度；超过则只留二元（0 = 不保留整词）。 */
  wholeWordMaxLen: number;
  /** 最短词长（**只作用于英文/数字**；CJK 单字照旧保留）。 */
  minTermLen: number;
  /** 停用词（小写比较；**索引侧与查询侧同时剔除**，否则两边口径不同 ⇒ 搜不到）。 */
  stopwords: string[];
  /**
   * ⚠️ **下面三个是「查询期」参数**（不动倒排）⇒ 改完**不需要 `rebuild()`**
   * —— 与上面的分词/打分参数**正相反**（那组改了必须重建，否则同一个库里两套口径）。
   * 混在一起放是因为 `index.opts` 是参数的**唯一通道**（`searchIndex` 只读索引自带那一份）；
   * 但面板上的说明必须把这两类分开写，否则用户改完模糊参数去重建索引、白等一场。
   */
  /**
   * 近似检索：查询词**精确零命中**时允许的最大编辑距离（0 = 关闭）。
   *
   * ⚠️ 上限写死 **2**（`clampIndexOptions` 夹取）—— 这是 Lucene 的硬约束：
   * `FuzzyQuery` 的 `maxEdits` 超过 2 之后自动机会与**大量**词项相交，
   * 精度崩、性能也崩（官方原话：higher distances are generally not useful）。
   * 实测标定：`flare→fare` = 1 次编辑，`cloud→clude` = 2 次（cloud→cloude→clude）⇒ 2 是必需的。
   */
  fuzzyMaxEdits: number;
  /**
   * 短于这个长度的词**不做**近似扩展（默认 3）。
   *
   * 为什么：① 中文走二元切分 ⇒ 词长普遍是 2，对 2 字词做 1 次编辑等于"换掉一半"，
   * 召回的全是噪音；② Lucene.NET 文档明确提醒「长度 1~2 的词常常匹配不上」
   * （要求编辑距离 < 较短词长）。
   */
  fuzzyMinTermLen: number;
  /** 每个查询词最多扩展出几个近似词（Lucene 的 `max_expansions`，默认 50）。封顶是为了"词典再大也不会慢"。 */
  fuzzyMaxExpansions: number;
}

/** 默认索引参数（= Python 基准）。**唯一产地** —— 打分口径只有这一处可改。 */
export const DEFAULT_INDEX_OPTIONS: IndexOptions = {
  k1: 1.5,
  b: 0.75,
  titleBoost: 3.0,
  wholeWordMaxLen: 4,
  minTermLen: 1,
  stopwords: [],
  /* ⚠️ 上面六个逐字等于 `core/websearch/indexer.py` 那份**行为基准**；
     下面三个是本仓新增的**查询期**能力（Python 侧没有）⇒ 它们默认开着**不影响**既有检索结果：
     `expandQueryTerms` 只在"某个词精确零命中"时才启用近似（精确命中的查询走的还是原来那条路）。 */
  fuzzyMaxEdits: 2,
  fuzzyMinTermLen: 3,
  fuzzyMaxExpansions: 50,
};

/**
 * 参数夹取（**唯一产地**；调用点在服务层 `searchIndexService.setSearchIndexParams`）。
 *
 * ⚠️ 范围参考权威实现而不是拍脑袋：
 *   · `k1 ∈ [0, 3]`   —— Lucene 的 `BM25Similarity(k1, b)` 允许 0~∞，实用区间 1~2；留 3 的上限挡住"数值爆炸"；
 *   · `b ∈ [0, 1]`    —— Lucene 明确要求 b 在 [0,1]；
 *   · `titleBoost ∈ [0, 10]` —— 对应 ES 的 `field^boost`，10 倍已是很强的提升；
 *   · `wholeWordMaxLen ∈ [0, 8]` —— 中文词组极少超过 8 字；0 表示不要整词、只留二元；
 *   · `minTermLen ∈ [1, 5]` —— 1 = 不过滤（基准行为）；
 *   · `stopwords` 去重、小写、去空、单条 ≤ 20 字符、最多 200 条（个人索引不需要一本词典）。
 */
export function clampIndexOptions(raw: unknown): IndexOptions {
  const o = (raw ?? {}) as Partial<IndexOptions>;
  const num = (v: unknown, d: number, lo: number, hi: number): number => {
    const n = Number(v);
    if (v === undefined || v === null || v === "" || !Number.isFinite(n)) { return d; }
    return Math.min(hi, Math.max(lo, n));
  };
  const words = Array.isArray(o.stopwords)
    ? [...new Set(
      o.stopwords
        .map((s) => String(s ?? "").trim().toLowerCase())
        .filter((s) => s.length > 0 && s.length <= 20),
    )].slice(0, 200)
    : [];
  return {
    k1: num(o.k1, DEFAULT_INDEX_OPTIONS.k1, 0, 3),
    b: num(o.b, DEFAULT_INDEX_OPTIONS.b, 0, 1),
    titleBoost: num(o.titleBoost, DEFAULT_INDEX_OPTIONS.titleBoost, 0, 10),
    wholeWordMaxLen: Math.floor(num(o.wholeWordMaxLen, DEFAULT_INDEX_OPTIONS.wholeWordMaxLen, 0, 8)),
    minTermLen: Math.floor(num(o.minTermLen, DEFAULT_INDEX_OPTIONS.minTermLen, 1, 5)),
    stopwords: words,
    /* ⚠️ `fuzzyMaxEdits` 的上界 **2** 不许放宽：Lucene 的 `FuzzyQuery` 就是这个硬上限
       （再大只会把整本词典都召回来）。下界 0 = 关闭近似。 */
    fuzzyMaxEdits: Math.floor(num(o.fuzzyMaxEdits, DEFAULT_INDEX_OPTIONS.fuzzyMaxEdits, 0, 2)),
    fuzzyMinTermLen: Math.floor(num(o.fuzzyMinTermLen, DEFAULT_INDEX_OPTIONS.fuzzyMinTermLen, 1, 8)),
    fuzzyMaxExpansions: Math.floor(num(o.fuzzyMaxExpansions, DEFAULT_INDEX_OPTIONS.fuzzyMaxExpansions, 1, 200)),
  };
}

/** `/search` 回包里的 `engine` 字段（页面顶栏会显示「来自 X」）。 */
export const SEARCH_ENGINE_NAME = "Slime 自建全网索引";

/** 一条 item 的 `source`（与 Python 侧一致，页面据此标注来源徽标）。 */
export const SEARCH_ITEM_SOURCE = "自建索引";

/** CJK 区间：`[㐀-䶿一-鿿豈-﫿]`（U+3400-4DBF / U+4E00-9FFF / U+F900-FAFF）。 */
const TOKEN_RE = /[a-z0-9]+|[㐀-䶿一-鿿豈-﫿]+/g;

/** 被索引的一页（Python 侧 `pages` 表的行）。 */
export interface IndexedPage {
  id: number;
  url: string;
  title: string;
  text: string;
}

/** 倒排索引（可 JSON 落盘，规模在千页量级足够）。 */
export interface SearchIndex {
  /**
   * ⚠️ **建这份倒排时用的那套参数**（A-1140）。检索必须读它，不接受调用方另传一份：
   * 中文整词/二元的取舍让"分词口径"成为索引的一部分，两边不一致 ⇒ 命中数永远是 0 且不报错。
   */
  opts: IndexOptions;
  /** 文档数 N。 */
  docs: number;
  /** 平均文档长度 avdl。 */
  avdl: number;
  /** term → 出现它的文档数。 */
  df: Record<string, number>;
  /** term → 倒排链。 */
  postings: Record<string, { doc: number; tf: number; titleTf: number }[]>;
  /** docId → 文档长度（正文 token 数 + 标题 token 数）。 */
  docLen: Record<string, number>;
}

/** 检索结果条目（形状与 Python `/search` 的 items 一致，页面零改动）。 */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
}

/** 停用词集合（小写）。⚠️ 每次 `tokenize` 现建 —— 参数是**纯数据**，缓存它会让"参数对象换了一份但内容一样"变成误命中。 */
function stopSetOf(opts: IndexOptions): Set<string> {
  const list = opts.stopwords ?? [];
  return list.length === 0 ? EMPTY_STOP : new Set(list.map((s) => s.toLowerCase()));
}

const EMPTY_STOP: Set<string> = new Set();

/**
 * 分词：英文/数字按词；中文按**二元切分**（长度 ≤ `wholeWordMaxLen` 的中文串额外保留整词）。
 * ⚠️ 先 `toLowerCase()`：索引侧与查询侧必须用同一口径，否则中英混排搜不到。
 * ⚠️ 停用词在**这里**剔除（而不是在 `buildIndex` 外面）—— 索引侧与查询侧都走这一个函数，
 *   两处各剔一次迟早漏一处，症状同样是"搜不到"而不是报错。
 */
export function tokenize(text: string, opts: IndexOptions = DEFAULT_INDEX_OPTIONS): string[] {
  const out: string[] = [];
  const s = String(text ?? "").toLowerCase();
  const stop = stopSetOf(opts);
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(s); m !== null; m = TOKEN_RE.exec(s)) {
    const w = m[0];
    if (w.charCodeAt(0) < 0x2e80) {
      /* 英文/数字：受 `minTermLen` 与停用词双重约束。 */
      if (w.length >= opts.minTermLen && !stop.has(w)) { out.push(w); }
      continue;
    }
    if (w.length === 1) { if (!stop.has(w)) { out.push(w); } continue; }
    for (let i = 0; i < w.length - 1; i += 1) {
      const t = w.slice(i, i + 2);
      if (!stop.has(t)) { out.push(t); }
    }
    if (w.length <= opts.wholeWordMaxLen && !stop.has(w)) { out.push(w); }
  }
  return out;
}

/** 查询侧分词：去重并保持顺序（BM25 的「命中几个查询词」按这个集合算）。 */
export function queryTerms(query: string, opts: IndexOptions = DEFAULT_INDEX_OPTIONS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(query, opts)) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/* ══════════ 查询语法（A-1139）══════════════════════════════════════════════
 * 参考全网搜索引擎的**最小可用子集**（不做完整 Google 语法，只做高频三种）：
 *   · `"精确短语"`  —— 页面里必须**原样出现**这段文字（不分词，硬过滤）；
 *   · `site:example.com` —— 只在这个主机（含子域）里找；
 *   · `-排除词`     —— 命中即剔除该页（标题或正文出现就算命中）。
 *
 * ⚠️ 三个都是**硬过滤**（不参与打分）：短语/排除是布尔判定，没有"权重"可言；
 *   把它们做成加权会让"为什么这一页排第一"变得不可解释。
 *   打分仍只由正词的 BM25 决定 —— 这样 a1138 的 golden 分数守卫继续有效。
 *
 * ⚠️ 与旧行为的**唯一**差异：以前 `-alpha` / `site:x` 会被 TOKEN_RE 当成普通词
 *   （`alpha` / `site` / `x`）参与检索。现在它们是**指令**。这是有意的行为变更，
 *   已同步进守卫（见 tests/gui/a1138-search-index.spec.ts 的查询语法组）。
 */
export interface ParsedQuery {
  /** 正词（展开后的 token；BM25 打分与「命中全部」都按它算）。 */
  terms: string[];
  /** 必须原样出现的短语（已小写）。 */
  phrases: string[];
  /** 命中即剔除的词（已小写，未分词 —— 按**原文子串**判，`-测试` 能剔掉"测试机"）。 */
  excludes: string[];
  /** `site:` 限定的主机（已小写、去协议与路径）；`null` = 不限。 */
  site: string | null;
}

/** 解析查询串 → 结构化查询。纯函数，无 IO。`opts` 必须是**建索引时那一份**（见 `SearchIndex.opts`）。 */
export function parseQuery(raw: string, opts: IndexOptions = DEFAULT_INDEX_OPTIONS): ParsedQuery {
  const phrases: string[] = [];
  const excludes: string[] = [];
  let site: string | null = null;

  /* ① 先把 `"..."` 整段摘出来（避免短语里的空格被当成分隔符、`-` 被当成排除符）。 */
  const rest = String(raw ?? "").replace(/"([^"]*)"/g, (_m, p: string) => {
    const t = String(p).trim().toLowerCase();
    if (t) { phrases.push(t); }
    return " ";
  });

  const words: string[] = [];
  for (const w of rest.split(/\s+/)) {
    if (!w) { continue; }
    const low = w.toLowerCase();
    if (low.startsWith("site:") && low.length > "site:".length) {
      site = low.slice("site:".length).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
      continue;
    }
    if (low.startsWith("-") && low.length > 1) { excludes.push(low.slice(1)); continue; }
    words.push(w);
  }

  return { terms: queryTerms(words.join(" "), opts), phrases, excludes, site };
}

/** 主机（小写、去 `www.`）。engine 不 import crawler（保持纯逻辑层的自足）。 */
function hostOfUrl(url: string): string {
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/** `site:` 判定：完全相等或**是其子域**（`site:example.com` 要能命中 `a.example.com`）。 */
function siteMatches(url: string, site: string): boolean {
  const h = hostOfUrl(url);
  return h === site || h.endsWith("." + site);
}

/** 一页是否通过硬过滤（短语必须出现、排除词不得出现、站点必须匹配）。 */
function passesFilters(url: string, title: string, text: string, q: ParsedQuery): boolean {
  if (q.site && !siteMatches(url, q.site)) { return false; }
  const lowText = String(text ?? "").toLowerCase();
  const lowTitle = String(title ?? "").toLowerCase();
  for (const ph of q.phrases) {
    if (!lowText.includes(ph) && !lowTitle.includes(ph)) { return false; }
  }
  for (const ex of q.excludes) {
    if (lowText.includes(ex) || lowTitle.includes(ex)) { return false; }
  }
  return true;
}

/**
 * 编辑距离（**Damerau–Levenshtein / optimal string alignment**，相邻换位算 1 次）。
 *
 * 为什么用带换位的版本：Lucene 的 `FuzzyQuery` 默认 `transpositions=true`，
 * 而"手抖打反两个字母"（`tihs` / `teh`）在真实输入里非常常见 —— 不认换位会白白漏掉。
 *
 * `max` 是**上界**：一旦确定超过就提前返回 `max + 1`（不返回真实距离）——
 * 词典要逐个扫，这一条决定了性能（配合"长度差 > max 直接跳过"的剪枝）。
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) { return 0; }
  if (Math.abs(a.length - b.length) > max) { return max + 1; }
  const n = b.length;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1
        && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
        && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) { rowMin = v; }
    }
    if (rowMin > max) { return max + 1; }
    prev2 = prev;
    prev = cur;
  }
  return prev[n] > max ? max + 1 : prev[n];
}

/** 一次近似扩展的记录（**降级要看得见**：页面据此提示"没有精确匹配，已按哪些词检索"）。 */
export interface TermExpansion {
  /** 用户输入的词（原样）。 */
  from: string;
  /** 词典里真正命中的词。 */
  to: string;
  /** 编辑距离（≥1）。 */
  edits: number;
}

/** `expandQueryTerms` 的结果：`effective` 是**实际要查的词典词**，`src` 把它映射回用户输入的词。 */
export interface QueryPlan {
  effective: string[];
  /** effective 词 → 用户输入的词（命中计数按**用户词**算 ⇒ AND 优先的判据不受近似影响）。 */
  src: Map<string, string>;
  /** effective 词 → 分数权重（精确 = 1；近似按编辑距离衰减）。 */
  weight: Map<string, number>;
  expansions: TermExpansion[];
}

/**
 * 查询词展开（**唯一产地**）：精确优先，**只有精确零命中的词**才去找近似词。
 *
 * ## 为什么是"未命中才近似"
 * ① 用户要的正是"记错一两个字时还能搜到"——能精确命中的查询根本不需要近似；
 * ② 这样**精确命中的查询结果与以前逐字一致**（既有 golden 分数 / AND 优先守卫继续有效），
 *    近似只作为兜底出现，不会把好结果冲淡。
 *
 * ## 权重（对齐 Lucene 的 fuzzy 打分思路）
 * `w = 1 - edits / max(len(查询词), len(词项))`：改一个字母只掉一点分，改两个掉更多 ⇒
 * 近似命中永远排在精确命中之后，且"越像的越前"。
 *
 * ## ⚠️ 关键词是"用户词"，不是"词典词"
 * `src` 把 effective 映射回用户输入 —— 命中计数/AND 优先仍按用户词算。
 * 否则"用户输了 2 个词、其中一个走了近似"会被算成 3 个词，`full` 集合永远为空 ⇒ AND 优先静默失效。
 */
export function expandQueryTerms(
  index: SearchIndex,
  terms: string[],
  opts: IndexOptions = DEFAULT_INDEX_OPTIONS,
): QueryPlan {
  const effective: string[] = [];
  const src = new Map<string, string>();
  const weight = new Map<string, number>();
  const expansions: TermExpansion[] = [];
  const maxEdits = Math.max(0, Math.min(2, Math.floor(opts.fuzzyMaxEdits ?? 0)));
  const minLen = Math.max(1, Math.floor(opts.fuzzyMinTermLen ?? 3));
  const maxExp = Math.max(1, Math.floor(opts.fuzzyMaxExpansions ?? 50));

  const push = (term: string, from: string, w: number): void => {
    effective.push(term);
    src.set(term, from);
    weight.set(term, w);
  };

  /* 词典只需要在"真有词未命中"时才取 —— 全部精确命中时一个字节都不扫。 */
  let dict: string[] | null = null;

  for (const t of terms) {
    if (index.df[t] !== undefined) { push(t, t, 1); continue; }
    if (maxEdits <= 0 || t.length < minLen) { continue; }  // 太短的词不做近似（中文 bigram / 2 字母词）
    if (dict === null) { dict = Object.keys(index.df); }
    const cands: TermExpansion[] = [];
    for (const c of dict) {
      const d = editDistance(t, c, maxEdits);
      if (d >= 1 && d <= maxEdits) { cands.push({ from: t, to: c, edits: d }); }
    }
    /* 排序：距离优先 ⇒ 再按"词典里更常见的词"（df 大）⇒ 最后按字典序（**稳定**：同一个查询永远同一批词）。 */
    cands.sort((x, y) => x.edits - y.edits
      || (index.df[y.to] ?? 0) - (index.df[x.to] ?? 0)
      || (x.to < y.to ? -1 : x.to > y.to ? 1 : 0));
    for (const c of cands.slice(0, maxExp)) {
      if (src.has(c.to)) { continue; }   // 已被别的用户词认领 ⇒ 不重复计入（否则同一文档被计两次分）
      push(c.to, t, 1 - c.edits / Math.max(t.length, c.to.length));
      expansions.push(c);
    }
  }
  return { effective, src, weight, expansions };
}

/**
 * 内容指纹（用于**跨 URL 的重复内容**判定：镜像站 / 转载 / 同页多参数）。
 * djb2 变体，32 位十六进制；碰撞概率在"千页量级的个人索引"里可忽略。
 *
 * ⚠️ 只取**正文前 4000 字符 + 标题**：超长页面尾部通常是评论/推荐位，
 *   把它们算进指纹会让"同一篇文章的两个转载版本"因为评论不同而被当成两篇。
 */
export function contentFingerprint(title: string, text: string): string {
  const s = (String(title ?? "") + "\u0000" + String(text ?? "").slice(0, 4000)).replace(/\s+/g, " ");
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * 由页面集合建倒排索引（全量重建；增量不在本版范围内）。
 *
 * ⚠️ **不在这里夹取 `opts`**：`buildIndex` 是纯函数，参数由调用方负责（服务层是唯一夹取点）。
 *   在这里悄悄夹取 = 静默降级（用户填了 k1=5 却按 3 生效，界面上看不出来）。
 */
export function buildIndex(pages: IndexedPage[], opts: IndexOptions = DEFAULT_INDEX_OPTIONS): SearchIndex {
  const df: Record<string, number> = {};
  const postings: Record<string, { doc: number; tf: number; titleTf: number }[]> = {};
  const docLen: Record<string, number> = {};
  let totalLen = 0;

  for (const p of pages) {
    const bodyTf = new Map<string, number>();
    for (const t of tokenize(p.text, opts)) { bodyTf.set(t, (bodyTf.get(t) ?? 0) + 1); }
    const titleTf = new Map<string, number>();
    for (const t of tokenize(p.title, opts)) { titleTf.set(t, (titleTf.get(t) ?? 0) + 1); }

    const len = countTokens(bodyTf) + countTokens(titleTf);
    docLen[String(p.id)] = len;
    totalLen += len;

    for (const t of new Set([...bodyTf.keys(), ...titleTf.keys()])) {
      const chain = postings[t] ?? (postings[t] = []);
      chain.push({ doc: p.id, tf: bodyTf.get(t) ?? 0, titleTf: titleTf.get(t) ?? 0 });
      df[t] = chain.length;
    }
  }

  return { opts, docs: pages.length, avdl: pages.length ? totalLen / pages.length : 0, df, postings, docLen };
}

function countTokens(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) { n += v; }
  return n;
}

/** `idf = ln(1 + (N - df + 0.5) / (df + 0.5))`（只需 df，`term` 只用于取 df ⇒ 不进签名）。 */
function idfOf(index: SearchIndex, df: number): number {
  return Math.log(1 + (index.docs - df + 0.5) / (df + 0.5));
}

/**
 * BM25 检索。返回与 Python `/search` 同形状的载荷（**不含** `took_ms`，计时由服务层加）。
 *
 * @param byId  docId → 页面（取 url/title/text 用；检索本身只碰索引）
 */
export function searchIndex(
  index: SearchIndex,
  byId: Map<number, IndexedPage> | Record<string, IndexedPage>,
  query: string,
  page = 0,
  size = 10,
): { total: number; items: SearchHit[]; terms: string[]; expansions: TermExpansion[] } {
  /* ⚠️ 参数取**索引自带**那一份（`index.opts`）。`?? DEFAULT` 只兜底"手工拼的索引对象"
     （本仓的落盘只有 pages.json，倒排每次由 `rebuild()` 重建 ⇒ 正常路径上 opts 一定在）。 */
  const o = index.opts ?? DEFAULT_INDEX_OPTIONS;
  const q = parseQuery(query, o);
  const terms = q.terms;
  /* A-1143：**精确优先、未命中才近似**的词项展开（唯一产地）。
     全部精确命中时 `effective` 与 `terms` 逐项相同、权重恒为 1 ⇒ 下面的打分与旧实现**逐字一致**。 */
  const plan = expandQueryTerms(index, terms, o);
  const empty = { total: 0, items: [] as SearchHit[], terms, expansions: [] as TermExpansion[] };
  if (index.docs === 0) { return empty; }

  const lookup = (doc: number): IndexedPage | undefined =>
    (byId instanceof Map ? byId.get(doc) : byId[String(doc)]);
  const hasFilters = q.phrases.length > 0 || q.excludes.length > 0 || q.site !== null;

  /** 分页 + 组装（两条路径共用，避免"筛选逻辑"写两遍）。 */
  const slice = (ordered: [number, number][]): { total: number; items: SearchHit[]; terms: string[]; expansions: TermExpansion[] } => {
    const items: SearchHit[] = [];
    for (const [doc, score] of ordered.slice(page * size, page * size + size)) {
      const pg = lookup(doc);
      if (!pg) { continue; }
      items.push({
        url: pg.url,
        title: pg.title || pg.url,
        /* ⚠️ 摘要用**用户输入的词**（不是近似词）：高亮"用户以为自己在搜的东西"，
           否则页面上会亮出一个用户根本没打过的词。近似提示走 `expansions`。 */
        snippet: makeSnippet(pg.text, [...terms, ...q.phrases]),
        score: Math.round(score * 1000) / 1000,
        source: SEARCH_ITEM_SOURCE,
      });
    }
    return { total: ordered.length, items, terms, expansions: plan.expansions };
  };

  /* 只有过滤器、没有正词（`site:x` / `-词` / `"短语"` 单独用）⇒ **全量扫描**。
     这是这三个指令唯一正确的实现：倒排索引只按词进，没有"按主机"或"按不包含"的入口。
     个人索引是千页量级，全扫可接受；排序按 id **倒序**（id 是追加式递增 ⇒ 新收录的在前）。 */
  if (terms.length === 0) {
    if (!hasFilters) { return empty; }
    const all: [number, number][] = [];
    const each = byId instanceof Map ? [...byId.values()] : Object.values(byId);
    for (const p of each) {
      if (p && passesFilters(p.url, p.title, p.text, q)) { all.push([p.id, 0]); }
    }
    all.sort((a, b) => b[0] - a[0]);
    return slice(all);
  }

  const scores = new Map<number, number>();
  /** doc → 命中的**词典词**（effective）。⚠️ 第二轮要拿它回查 postings ⇒ 必须存 effective，
      而"命中几个**用户词**"另算（`srcHitCount`）—— 两者混用会静默算错 AND 优先。 */
  const hitTerms = new Map<number, Set<string>>();
  /** 一个 doc 覆盖了几个**用户输入的词**（近似命中算它对应的那个用户词）。 */
  const srcHitCount = (doc: number): number => {
    const s = hitTerms.get(doc);
    if (!s) { return 0; }
    const uniq = new Set<string>();
    for (const t of s) { uniq.add(plan.src.get(t) ?? t); }
    return uniq.size;
  };

  /* 第一轮：按 avdl 近似粗排（Python 用 `BM25_B * 1.0`）。
     ⚠️ 这一轮的分数**只用来筛候选、不进最终结果** —— 下一轮会把每个候选的分数整段重算。
     所以这里**不乘近似权重**（乘了也观察不到：实测过，删掉它守卫不红 ⇒ 那是死代码，铁律 9）。
     权重只作用在第二轮。 */
  for (const t of plan.effective) {
    const df = index.df[t];
    if (df === undefined) { continue; }
    const idf = idfOf(index, df);
    for (const p of index.postings[t] ?? []) {
      const effTf = p.tf + o.titleBoost * p.titleTf;
      if (effTf <= 0) { continue; }
      const denom = effTf + o.k1 * (1 - o.b + o.b * 1);
      scores.set(p.doc, (scores.get(p.doc) ?? 0) + (idf * (effTf * (o.k1 + 1))) / denom);
      const s = hitTerms.get(p.doc) ?? new Set<string>();
      s.add(t);
      hitTerms.set(p.doc, s);
    }
  }
  if (scores.size === 0) { return empty; }

  /* 第二轮：对候选按**真实文档长度**精修（这才是精确 BM25）。 */
  for (const [doc] of scores) {
    const pg = lookup(doc);
    if (!pg) { continue; }
    const docLen = (index.docLen[String(doc)] ?? 0) || 1;
    const avdl = index.avdl || 1;
    let s = 0;
    for (const t of hitTerms.get(doc) ?? []) {
      const df = index.df[t];
      if (df === undefined) { continue; }
      const pr = (index.postings[t] ?? []).find((x) => x.doc === doc);
      if (!pr) { continue; }
      const effTf = pr.tf + o.titleBoost * pr.titleTf;
      const denom = effTf + o.k1 * (1 - o.b + (o.b * docLen) / avdl);
      s += (idfOf(index, df) * (effTf * (o.k1 + 1))) / denom * (plan.weight.get(t) ?? 1);
    }
    scores.set(doc, s);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  /* 硬过滤**排在分页之前**：否则"第 1 页被过滤光了"却还有第 2 页，分页会显得莫名其妙地空。
     ⚠️ 无过滤时 `eligible` **就是** `ranked`（同一个数组的引用）⇒ 老行为逐字节不变，
     a1138 的 golden 分数 / AND 优先守卫继续有效。 */
  const eligible = hasFilters
    ? ranked.filter(([doc]) => {
      const pg = lookup(doc);
      return !!pg && passesFilters(pg.url, pg.title, pg.text, q);
    })
    : ranked;
  const full = eligible.filter(([doc]) => srcHitCount(doc) === terms.length);
  const need = page * size + size;
  const ordered = full.length >= 1
    ? (full.length < need ? [...full, ...eligible.filter((kv) => !full.includes(kv))] : full)
    : eligible;

  return slice(ordered);
}

/**
 * 摘要：以**首个命中词**为中心截取（前端负责高亮）。
 * `width=90` ⇒ 命中词前 45 字、后 135 字（与 Python 一致）。
 */
export function makeSnippet(text: string, terms: string[], width = 90): string {
  if (!text) { return ""; }
  const low = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = low.indexOf(t.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) { idx = i; }
  }
  if (idx < 0) { return text.slice(0, width * 2); }
  const start = Math.max(0, idx - Math.floor(width / 2));
  const end = Math.min(text.length, idx + Math.floor((width * 3) / 2));
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/** `/status` 用的统计（形状与 Python `stats()` 一致）。 */
export function indexStats(index: SearchIndex): { pages: number; terms: number } {
  return { pages: index.docs, terms: Object.keys(index.df).length };
}

/** 空索引（`pages.json` 还没建出来时的初值 ⇒ 服务照常起，只是搜不到东西）。 */
export function emptyIndex(opts: IndexOptions = DEFAULT_INDEX_OPTIONS): SearchIndex {
  return { opts, docs: 0, avdl: 0, df: {}, postings: {}, docLen: {} };
}
