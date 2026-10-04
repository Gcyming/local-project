
















































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


export const MARKET_QUERY_MAX_TERMS = 4;

export interface MarketQueryExpansion {
  
  query: string;
  
  terms: string[];
  
  raw: string;
  
  mapped: boolean;
  






  unrecognized: boolean;
}


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

  
  let cnHits = 0;
  for (const [cn, en] of MARKET_CN_TO_EN) {
    if (terms.length >= MARKET_QUERY_MAX_TERMS) { break; }
    if (raw.includes(cn)) { cnHits += 1; push(en); }
  }
  
  for (const w of raw.match(/[A-Za-z][A-Za-z0-9@/_.:-]*|\d+/g) ?? []) { push(w); }

  if (terms.length === 0) {
    
    return { query: raw, terms: [], raw, mapped: false, unrecognized: true };
  }
  return { query: terms.join(" "), terms, raw, mapped: cnHits > 0, unrecognized: false };
}









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


export const MARKET_TAG_MAX = 3;







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
