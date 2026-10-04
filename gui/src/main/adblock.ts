
























import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";


export interface AdblockSettings {
  enabled: boolean;
}

const SETTINGS_REL = "config/adblock/settings.json";
const RULES_DIR_REL = "config/adblock";




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
  
  block: Set<string>;
  
  allow: Set<string>;
}


export function parseRules(text: string, into: Rule): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("#")) { continue; }
    let body = line;
    const isAllow = body.startsWith("@@");
    if (isAllow) { body = body.slice(2); }
    
    const m = /^\|\|([^/^$*|]+)\^?(?:\$.*)?$/.exec(body);
    if (m) {
      const host = m[1].trim().toLowerCase();
      if (host) { (isAllow ? into.allow : into.block).add(host); }
      continue;
    }
    
    if (!isAllow && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(body)) {
      into.block.add(body.toLowerCase());
    }
  }
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}


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
    } catch {  }
    return { enabled: true };
  }
}


export function loadRules(root: string): Rule {
  const rule: Rule = { block: new Set(), allow: new Set() };
  parseRules(BUILTIN_RULES.join("\n"), rule);
  const dir = join(root, RULES_DIR_REL);
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".txt")) { continue; }
      parseRules(readFileSync(join(dir, f), "utf8"), rule);
    }
  } catch {  }
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


export function adblockStats(): AdblockStats {
  return { ...stats };
}






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
