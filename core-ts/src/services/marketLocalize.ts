/**
 * marketLocalize.ts — A-1106：MCP 广场的**中文可用性**（纯逻辑，唯一出处）。
 *
 * ## 用户报障
 *
 *   「官方 MCP 全是英文，太不能用了」
 *
 * ## 两层原因（第二层比第一层更致命）
 *
 *   ① **语言**：官方 registry 的 `description` 是英文原文，且卡片上连
 *      「这是什么类别」都没有中文线索 ⇒ 中文用户扫一遍完全不知道哪条有用。
 *   ② **相关性**：`searchMcpRegistry` 无检索词时拿的是 registry 的
 *      **字母序前 60 条**（`ac.` / `ad.` / `ag.` / `agency.` 开头的长尾目录项）。
 *      而中文用户**没法输入英文检索词** ⇒ 只能看这堆长尾 ⇒ 就算全翻成中文也没用。
 *
 *   所以本模块给两件事，各自一个纯函数：
 *    · `expandMarketQuery` —— 中文输入展开成**上游认得的英文检索词**
 *      （让 registry 真正退化成"你搜什么给什么"的检索后端，而不是默认视图）。
 *    · `localizeServerTags` —— 按 name/description 的关键词打**中文类别标签**
 *      （不翻译整句，避免产出半中半英的怪句子；标签是确定性的、可测的）。
 *
 * ## 为什么不调模型翻译
 *
 *   翻译整句要花用户的 API 额度、要等 1~3 秒、还引入一条会失败的联网路径。
 *   而"用户真正要的是**找到**那条 server"这件事，靠**中文检索 + 中文类别标签**
 *   就能解决 —— 且零成本、零延迟、离线可用。描述保留英文原文（它是 registry 的
 *   一手字段，翻译反而会引入失真）。
 *
 * ## 判据纪律
 *
 *   · **不许编造**：标签只来自关键词命中，没命中就返回空数组（不猜、不补）。
 *   · **不许静默**：中文输入一个词都没识别出来时 `unrecognized=true`，
 *     调用方**必须如实告知**（否则用户以为搜过了，其实搜的是中文、上游搜不到任何东西）。
 */

/* ────────────────────── ① 中文 → 英文检索词 ────────────────────── */

/**
 * 中文关键词 → 上游检索词。
 *
 * 取值依据：这些词是 MCP 生态里**真实存在的 server 类别**（filesystem / fetch / playwright /
 * puppeteer / github / gitlab / brave-search / google-maps / memory / sqlite / time /
 * sequential-thinking / everything 等官方与主流实现），不是凭空想的需求清单。
 *
 * ⚠️ **键一律 ≥ 2 个汉字**：单字键（如「云」）会被「云南」「云端」之类无关输入命中，
 *    给上游塞一个错误的检索词。宁可少收几个词，也不要搜错方向。
 * ⚠️ 命中方式用**子串包含**（`input.includes(key)`）而不是分词 —— 本仓不引分词器，
 *    子串包含对「我要找个浏览器自动化的」这类口语输入天然可用（命中「浏览器」+「自动化」）。
 */
export const MARKET_CN_TO_EN: ReadonlyArray<readonly [string, string]> = [
  ["浏览器", "browser"],
  ["爬虫", "crawler"],
  ["网页", "web"],
  ["网络", "network"],
  ["抓取", "fetch"],
  ["自动化", "automation"],
  ["文件", "filesystem"],
  ["目录", "filesystem"],
  ["数据库", "database"],
  ["数据", "data"],
  ["搜索", "search"],
  ["地图", "maps"],
  ["地理", "geo"],
  ["记忆", "memory"],
  ["知识库", "knowledge"],
  ["表格", "spreadsheet"],
  ["文档", "document"],
  ["代码", "code"],
  ["仓库", "git"],
  ["版本", "git"],
  ["邮件", "email"],
  ["消息", "message"],
  ["通知", "notification"],
  ["翻译", "translate"],
  ["图片", "image"],
  ["图像", "image"],
  ["截图", "screenshot"],
  ["时间", "time"],
  ["日历", "calendar"],
  ["金融", "finance"],
  ["股票", "stock"],
  ["存储", "storage"],
  ["云服务", "cloud"],
  ["命令行", "shell"],
  ["终端", "terminal"],
  ["日志", "log"],
  ["监控", "monitor"],
  ["测试", "test"],
  ["安全", "security"],
  ["思维", "thinking"],
];

/** 站内流式输入里最多带几个检索词（多了上游多半按 AND 收窄到 0 条） */
export const MARKET_QUERY_MAX_TERMS = 4;

export interface MarketQueryExpansion {
  /** 真正发给上游的检索词。**入参非空时永不为空**（识别不出来时退回原输入） */
  query: string;
  /** 识别出的英文关键词（按加入顺序去重） */
  terms: string[];
  /** 原输入（trim 后） */
  raw: string;
  /** terms 里是否有词来自中英词典（false = 纯英文透传） */
  mapped: boolean;
  /**
   * 非空输入、但**一个词都没识别出来**（纯中文且词典没收录，如「量子纠缠」）。
   *
   * ⚠️ 此时 `query` 退回原输入 —— 上游大概率搜不到东西。调用方**必须**把这件事
   *    如实告诉用户（「未收录这个词，换个说法或直接输英文」），
   *    否则用户只会看到"搜了没结果"，不知道是自己输的词没被认出来。
   */
  unrecognized: boolean;
}

/** 按词典把中文输入展开成上游检索词；英文/数字原样保留。 */
export function expandMarketQuery(input: string): MarketQueryExpansion {
  const raw = (input ?? "").trim();
  if (raw === "") {
    return { query: "", terms: [], raw: "", mapped: false, unrecognized: false };
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    const k = t.toLowerCase();
    if (t === "" || seen.has(k) || terms.length >= MARKET_QUERY_MAX_TERMS) { return; }
    seen.add(k);
    terms.push(t);
  };

  // ① 先收**中文词典命中**（保证「浏览器 playwright」这类混合输入里，中文的意图优先）
  let cnHits = 0;
  for (const [cn, en] of MARKET_CN_TO_EN) {
    if (terms.length >= MARKET_QUERY_MAX_TERMS) { break; }
    if (raw.includes(cn)) { cnHits += 1; push(en); }
  }
  // ② 再收输入里**用户自己写的英文/数字词**（保持左到右顺序；`@scope/pkg` 这类包名也保留）
  for (const w of raw.match(/[A-Za-z][A-Za-z0-9@/_.:-]*|\d+/g) ?? []) { push(w); }

  if (terms.length === 0) {
    // 一个词都没识别出来 —— 退回原输入（不发明检索词），并标记为"未收录"
    return { query: raw, terms: [], raw, mapped: false, unrecognized: true };
  }
  return { query: terms.join(" "), terms, raw, mapped: cnHits > 0, unrecognized: false };
}

/* ────────────────────── ② 中文类别标签 ────────────────────── */

/**
 * 关键词 → 中文类别标签。**按特异性从高到低排**（先命中的更具体）。
 *
 * ⚠️ 这条规则是"**只加标签、不翻译整句**"：整句翻译要调模型（花额度、会失败、有延迟），
 *    而用户扫列表时真正缺的是"这条大概是什么类别"这一层信息 —— 类别能确定性判定。
 */
export const MARKET_TAG_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(playwright|puppeteer|selenium|chromium|webdriver|browseruse|browser-use)\b/i, "浏览器自动化"],
  [/\b(browser|chrome|firefox|webkit|safari)\b/i, "浏览器"],
  [/\b(filesystem|file system|files?\b|directory|folder)\b/i, "文件读写"],
  [/\b(sqlite|postgres|postgresql|mysql|mongodb|database|sql\b)\b/i, "数据库"],
  [/\b(git|github|gitlab|bitbucket|repository|repo\b)\b/i, "代码仓库"],
  [/\b(search|brave|serp|duckduckgo|bing)\b/i, "联网搜索"],
  [/\bmap|geocod|geospatial|geo\b/i, "地图位置"],
  [/\b(memory|knowledge graph|knowledge base|rag\b|embedding|vector)\b/i, "记忆知识库"],
  [/\b(spreadsheet|excel|xlsx|csv|sheet)\b/i, "表格数据"],
  [/\b(document|pdf|markdown|docx|office)\b/i, "文档处理"],
  [/\b(fetch|scrape|crawl|http\b|http request)\b/i, "网页抓取"],
  [/\b(email|gmail|smtp|imap|mail)\b/i, "邮件"],
  [/\b(slack|discord|telegram|whatsapp|message|chat\b|notification)\b/i, "消息通知"],
  [/\b(translate|translation|i18n|localization)\b/i, "翻译"],
  [/\b(image|vision|ocr|screenshot|photo)\b/i, "图像"],
  [/\b(calendar|schedule|time\b|clock|timezone)\b/i, "时间日程"],
  [/\b(finance|stock|trading|crypto|price|market\b)\b/i, "金融行情"],
  [/\b(cloud|aws|azure|gcp|s3\b|storage|bucket)\b/i, "云与存储"],
  [/\b(shell|terminal|bash|command|exec\b|process)\b/i, "命令行"],
  [/\b(log|monitor|observability|trace|metric)\b/i, "日志监控"],
  [/\b(test|testing|qa\b|assert)\b/i, "测试"],
  [/\b(security|vulnerab|audit|secret|credential)\b/i, "安全审计"],
  [/\b(thinking|reasoning|planning)\b/i, "思维推理"],
];

/** 一张卡片最多显示几个标签（多了把布局撑坏） */
export const MARKET_TAG_MAX = 3;

/**
 * 按 name + description 判中文类别标签（`MARKET_TAG_RULES` 的**唯一消费者**）。
 *
 * 没命中任何规则 ⇒ 返回**空数组**（不编造、不补一个「其他」——「其他」不提供任何信息，
 * 只是让卡片看起来"有标签"，那是装饰不是判据）。
 */
export function localizeServerTags(name: string, description: string): string[] {
  const hay = `${name ?? ""} ${description ?? ""}`;
  if (hay.trim() === "") { return []; }
  const out: string[] = [];
  for (const [re, tag] of MARKET_TAG_RULES) {
    if (out.length >= MARKET_TAG_MAX) { break; }
    if (out.includes(tag)) { continue; }
    if (re.test(hay)) { out.push(tag); }
  }
  return out;
}
