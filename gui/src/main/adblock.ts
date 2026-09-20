/**
 * gui/src/main/adblock.ts — 内嵌浏览器的广告/跟踪器拦截（A-1018）。
 *
 * ── 为什么是"网络层拦截"（调研结论，附权威来源）──────────────────────────────
 * 主流浏览器/扩展的广告拦截都落在**同一个位置：请求发出之前**：
 *   · 拦截器挂在浏览器暴露的请求钩子上，观察每个资源请求，决定放行 / 重定向 / 直接取消；
 *     取消 = 浏览器假装这个资源从不存在 —— 对图片广告、视频贴片、脚本注入的广告一视同仁。
 *   · 规则来自社区维护的**过滤列表**。EasyList 是最主流的一份，语法是纯文本 URL 模式 + 修饰符：
 *       `||exampleadnetwork.com^`        阻塞该域及其子域
 *       `/banner[0-9]+\.jpg$`            阻塞匹配的路径
 *       `@@||trustedpartner.com^$script` 白名单（例外）
 *       `$third-party` / `$script` 等修饰符限定范围
 * 来源（本轮取证）：
 *   · Electron 官方 `webRequest.onBeforeRequest` 文档 —— 主进程、按 session 生效，
 *     listener 收到 `details{url,resourceType,referrer,frame,…}`，callback 回 `{cancel:true}` 即拦截。
 *     ⚠️ 官方明确写着 **"Only the last attached listener will be used"** —— 同一事件只能有一个监听器，
 *        所以本模块**只允许注册一次**（见 installed 标记），分头注册会把前一个静默顶掉。
 *   · EasyList 过滤器语法（上面三条模式）——社区通用写法。
 *
 * ── 本实现的边界（诚实交代，不吹）────────────────────────────────────────────
 * 我们**没有**内置完整的 EasyList（那是个几十万行、需要定期更新、还带复杂修饰符与正则引擎的工程）。
 * 本模块实现的是 EasyList 的**核心子集**：`||host^` 域名阻塞 / `@@` 例外 / 纯域名行 / 注释，
 * 足以挡掉绝大多数广告与跟踪域；同时支持用户把任意 EasyList 派生列表丢进
 * `config/adblock/*.txt`（自动加载，按上面的子集解析）。**这是 v1，不是 uBlock Origin。**
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 拦截器生效配置：`config/adblock/settings.json`（缺省 = 开启） */
export interface AdblockSettings {
  enabled: boolean;
}

const SETTINGS_REL = "config/adblock/settings.json";
const RULES_DIR_REL = "config/adblock";

/** 内置基础列表：高频广告/跟踪域（**故意短而保守** —— 只放几乎不可能是正常内容服务的域）。
 *  更全的覆盖请把 EasyList 派生列表放进 `config/adblock/*.txt`。
 *  ⚠️ 不要往里塞"看起来像广告"的通用词（`ads`、`track` 这类裸词会误伤正常站点）。 */
const BUILTIN_RULES = [
  "||doubleclick.net^",
  "||googlesyndication.com^",
  "||googleadservices.com^",
  "||google-analytics.com^",
  "||googletagmanager.com^",
  "||googletagservices.com^",
  "||adservice.google.com^",
  "||amazon-adsystem.com^",
  "||adnxs.com^",
  "||rubiconproject.com^",
  "||pubmatic.com^",
  "||openx.net^",
  "||criteo.com^",
  "||criteo.net^",
  "||taboola.com^",
  "||outbrain.com^",
  "||scorecardresearch.com^",
  "||quantserve.com^",
  "||zedo.com^",
  "||adform.net^",
  "||smartadserver.com^",
  "||casalemedia.com^",
  "||sharethrough.com^",
  "||yieldmo.com^",
  "||moatads.com^",
  "||adsafeprotected.com^",
  "||media.net^",
  "||serving-sys.com^",
  "||teads.tv^",
  "||3lift.com^",
];

interface Rule {
  /** 阻塞规则（域名后缀匹配） */
  block: Set<string>;
  /** 例外规则（`@@||host^`） */
  allow: Set<string>;
}

/** 解析 ABP 子集：`||host^` / `host` / `@@||host^`；`!`、`#` 开头为注释；其余形态忽略（不猜）。 */
export function parseRules(text: string, into: Rule): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("#")) { continue; }
    let body = line;
    const isAllow = body.startsWith("@@");
    if (isAllow) { body = body.slice(2); }
    // 只认域名锚定形态：`||host^`（可带 `$modifier` 尾巴，修饰符本版忽略——不做假承诺）
    const m = /^\|\|([^/^$*|]+)\^?(?:\$.*)?$/.exec(body);
    if (m) {
      const host = m[1].trim().toLowerCase();
      if (host) { (isAllow ? into.allow : into.block).add(host); }
      continue;
    }
    // 纯域名行（hosts 风格 / 简易列表）
    if (!isAllow && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(body)) {
      into.block.add(body.toLowerCase());
    }
  }
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** 该 URL 是否应被拦截（纯函数，可直测）。allow 优先级高于 block。 */
export function shouldBlock(url: string, rule: Rule): boolean {
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") { return false; }
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) { return false; }
  for (const a of rule.allow) { if (hostMatches(host, a)) { return false; } }
  for (const b of rule.block) { if (hostMatches(host, b)) { return true; } }
  return false;
}

/** 读设置（缺省开启；文件损坏/不存在都按开启处理，并在需要时落一份默认文件出来）。 */
export function readAdblockSettings(root: string): AdblockSettings {
  const p = join(root, SETTINGS_REL);
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<AdblockSettings>;
    return { enabled: j.enabled !== false };
  } catch {
    try {
      mkdirSync(join(root, RULES_DIR_REL), { recursive: true });
      if (!existsSync(p)) {
        writeFileSync(p, JSON.stringify({ enabled: true, note: "false 可关闭广告拦截；规则文件放同目录 *.txt" }, null, 2), "utf8");
      }
    } catch { /* 落盘失败不影响拦截（按默认开启） */ }
    return { enabled: true };
  }
}

/** 汇总内置 + 用户列表（`config/adblock/*.txt`） */
export function loadRules(root: string): Rule {
  const rule: Rule = { block: new Set(), allow: new Set() };
  parseRules(BUILTIN_RULES.join("\n"), rule);
  const dir = join(root, RULES_DIR_REL);
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".txt")) { continue; }
      parseRules(readFileSync(join(dir, f), "utf8"), rule);
    }
  } catch { /* 目录不存在 → 只用内置列表 */ }
  return rule;
}

export interface AdblockSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] } | null,
      listener: ((d: { url: string }, cb: (r: { cancel?: boolean }) => void) => void) | null,
    ): void;
  };
}

export interface AdblockStats {
  blocked: number;
  rules: number;
  enabled: boolean;
}

let installed = false;
let stats: AdblockStats = { blocked: 0, rules: 0, enabled: false };

/** 统计（供 IPC / 日志查；也让"拦截真的发生了"可观测，而不是只写个开关自述） */
export function adblockStats(): AdblockStats {
  return { ...stats };
}

/**
 * 给某 session 装上拦截（**幂等**：Electron 官方规定同一事件只有一个监听器，
 * 重复注册会把上一个静默顶掉 —— 所以这里必须只装一次）。
 * @param root 项目/数据根（config 所在目录）
 */
export function installAdBlocker(session: AdblockSession, root: string, log: (s: string) => void = console.info): void {
  if (installed) { return; }
  installed = true;
  const settings = readAdblockSettings(root);
  if (!settings.enabled) {
    stats = { blocked: 0, rules: 0, enabled: false };
    log("[adblock] 已关闭（config/adblock/settings.json → enabled:false），本次不安装拦截器");
    return;
  }
  const rule = loadRules(root);
  stats = { blocked: 0, rules: rule.block.size, enabled: true };
  try {
    session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      if (shouldBlock(details.url, rule)) {
        stats.blocked += 1;
        callback({ cancel: true });
        return;
      }
      callback({});
    });
    log(`[adblock] 已启用：${rule.block.size} 条域名规则（${rule.allow.size} 条例外）；用户列表目录 config/adblock/*.txt`);
  } catch (e) {
    stats = { blocked: 0, rules: 0, enabled: false };
    log(`[adblock] 安装失败（不阻断浏览）：${e instanceof Error ? e.message : String(e)}`);
  }
}
