









export type RiskLevel = "auto" | "confirm" | "block";

import { resolve, sep } from "node:path";

export interface AssessInput {
  kind: "terminal" | "write" | "network" | "read";
  
  command?: string;
  
  commandArgs?: string;
  
  path?: string;
  
  size?: number;
  
  url?: string;
}

export interface AssessResult {
  level: RiskLevel;
  reason: string;
  matched: string;
}


const READONLY_CMDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "grep", "rg", "find", "pwd", "whoami",
  "date", "echo", "printf", "env", "printenv", "which", "type", "git", "git status",
  "git log", "git diff", "git branch", "git remote", "df", "du", "ps", "top", "free",
  "uname", "getconf", "stat", "file", "wc", "sort", "uniq", "cut", "sed -n", "cksum", "sha1sum", "sha256sum",
]);


const BLOCK_PATTERNS: Array<RegExp> = [
  /\brm\s+-rf\s+(?:\/|\*|\.\s*$|~\/?\*)/,
  /\bsudo\s+rm\b/,
  /\b(dd|mkfs\.|fdisk|partition|format)\b/,
  /\b(chmod|chown)\s+-R\b/,
  /\bmv\b.*\.git\b.*--/,
  /\bcurl\b.*[\s|\|]\s*(?:sh|bash)\s*$/,
  /\bwget\b.*\|\s*(?:sh|bash)/,
  /\bkill\s+-9\b/,
  /\b:\(\)\s*\{\s*:\|\s*:&/,
  /\b(apt|brew|pip|npm|yarn|pnpm)\s+(?:install|remove|purge|update|upgrade)\s+--?[a-z]*global/,
  /\b(?:curl|wget|http)\b.*https?:\/\/(?:127\.0\.0\.1|localhost|169\.254|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|metadata\.google)/i,
];


const CONFIRM_PATTERNS: Array<RegExp> = [
  /\b(rm|rmdir)\b/,
  /\b(mv|cp)\b/,
  /\bsudo\b/,
  /\b(curl|wget)\b(?!.*--?output\s*[-\w./]+$)/,
  /\bcurl\b/,
  /\bsh\b|\bbash\b/,
  /\bchmod\b|\bchown\b/,
  /\bnpm\b|\byarn\b|\bpnpm\b|\bpip\b|\bapt\b|\bbrew\b/,
  /\bmkdir\b/,
  /\bkill\b/,
];



import {
  PROTECTED_DIRS_SET,
  PROTECTED_PATH_EXEMPTIONS,
  CONTRIBUTION_RESERVED_ASSETS,
  CONTRIBUTION_OWNER_MARKERS,
  CONTRIBUTION_OWNER_FIELD,
  CONTRIBUTION_OWNER_VALUE,
  SENSITIVE_FILENAMES_SET,
  CLASSIFIER_WRITE_BLOCK_SUFFIXES,
} from "shared/security-policy";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SENSITIVE_FILES = SENSITIVE_FILENAMES_SET;



export const PROTECTED_SOURCE_DIRS = PROTECTED_DIRS_SET;

/** A-1197：受保护目录的豁免子路径（小写 POSIX 相对路径；来自 shared/security-policy.yaml）。
 *  存在意义见 security-policy.yaml §④：打包形态下「slime 根」= 运行时数据根，
 *  `config` 这条为源码写的保护会把用户自助贡献目录（技能/插件）一并封死。 */
const EXEMPT_REL_PATHS: readonly string[] = PROTECTED_PATH_EXEMPTIONS.map((p) => p.toLowerCase());

/** A-1197 收口：永不放行的资产目录（内置插件同名目录）+ 来源声明的字段/取值。
 *  全部来自 shared/security-policy.yaml §⑤ —— 双端同源，此处不手写第二份。 */
const RESERVED_ASSETS: readonly string[] = CONTRIBUTION_RESERVED_ASSETS.map((p) => p.toLowerCase());
const OWNER_MARKERS: readonly string[] = CONTRIBUTION_OWNER_MARKERS.map((p) => p.toLowerCase());
const OWNER_FIELD = CONTRIBUTION_OWNER_FIELD.trim().toLowerCase();
const OWNER_VALUE = CONTRIBUTION_OWNER_VALUE.trim().toLowerCase();

/** 把 `<豁免根>/<资产目录>` 这一层「资产目录」抠出来（判据判在它身上，不判在文件上）。
 *  config/plugins/demo-tool/plugin.json       → config/plugins/demo-tool
 *  config/plugins/demo-tool/skills/x/SKILL.md → config/plugins/demo-tool（**不是** skills/x）
 *  返回 null = 不在任何豁免根下，不归本判据管。
 *  ⚠️ 只认**恰好一层**资产目录，这是刻意的：若取「最深目录」，那么
 *  「改别人插件 skills/ 下的某个技能」会被当成一个新资产目录而被放行。 */
function contributionAssetDir(relPosix: string): string | null {
  for (const ex of EXEMPT_REL_PATHS) {
    if (!ex) { continue; }
    if (relPosix === ex) { return ex; }
    const prefix = `${ex}/`;
    if (!relPosix.startsWith(prefix)) { continue; }
    const seg = relPosix.slice(prefix.length).split("/").filter(Boolean);
    return seg.length > 0 ? `${ex}/${seg[0]}` : ex;
  }
  return null;
}

/** 读资产目录里的来源声明：命中 contribution_owner_field == contribution_owner_value，才算「自己建的」。
 *  ⚠️ 解析口径按扩展名分两类并集中写在这里（双端「同口径」的根据就在这段）：
 *    · plugin.json / manifest.json —— JSON：正则取 `"origin"\s*:\s*"…"`（不引 JSON 解析器：
 *      只要一个字段的值，坏 JSON 当读不到反而更稳）；
 *    · manifest.yaml / SKILL.md —— YAML：只认**顶层** `origin: value`（行首无缩进），
 *      免得把嵌套字段或正文里出现的字样误当成声明。
 *  fail-closed：判不出来一律 false —— 宁可拦一次让 Agent 换写法，也不给「读不到标记 ⇒ 放行」。 */
function assetDeclaresAgentOrigin(assetDirAbs: string): boolean {
  for (const marker of OWNER_MARKERS) {
    const file = join(assetDirAbs, marker);
    let text: string;
    try {
      if (!existsSync(file)) { continue; }
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (marker.endsWith(".json")) {
      const m = new RegExp(`"${OWNER_FIELD}"\\s*:\\s*"([^"]*)"`, "i").exec(text);
      if (m && m[1].trim().toLowerCase() === OWNER_VALUE) { return true; }
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = new RegExp(`^${OWNER_FIELD}\\s*:\\s*(.+?)\\s*$`, "i").exec(line);
      if (m) {
        return m[1].trim().replace(/^["']|["']$/g, "").toLowerCase() === OWNER_VALUE;
      }
    }
  }
  return false;
}


export function isProtectedSourcePath(target: string, root: string): boolean {
  if (!target || !root) return false;
  try {
    const isAbs = target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target);
    const abs = isAbs ? resolve(target) : resolve(root, target);
    const r = resolve(root);
    const norm = r.endsWith(sep) ? r : r + sep;
    if (abs !== r && !abs.startsWith(norm)) return false;
    const rel = abs === r ? "" : abs.slice(norm.length);
    const first = rel.split(sep)[0]?.toLowerCase() ?? "";
    if (!PROTECTED_SOURCE_DIRS.has(first)) return false;
    // A-1197：命中受保护的一级目录后，再看是否落在豁免子路径里（含其下全部）。
    // 只做「目录前缀」匹配：allow 的是资产目录本身，不放开任何父目录。
    if (EXEMPT_REL_PATHS.length > 0) {
      const relPosix = rel.split(sep).join("/").toLowerCase();
      const assetRel = contributionAssetDir(relPosix);
      if (assetRel !== null) {
        // A-1197 收口：豁免 ≠ 整目录随便写。三条判据（判在**资产目录**层）见 security-policy.yaml §⑤：
        //   ① 目录不存在 ⇒ 放行（这就是「新建」）；
        //   ② 已存在、但自带 agent 来源声明 ⇒ 放行（这就是「迭代自己刚建的那个」）；
        //   ③ 命中内置保留资产目录 ⇒ 拦（永不放行，与来源标记无关）。
        // 其余（既有、无声明、或声明不是 agent）⇒ 拦 ⇒ 改别人/改内置的写入仍有保护。
        for (const rv of RESERVED_ASSETS) {
          if (assetRel === rv || assetRel.startsWith(`${rv}/`)) { return true; }
        }
        const assetAbs = resolve(r, assetRel);
        if (!existsSync(assetAbs)) { return false; }
        return !assetDeclaresAgentOrigin(assetAbs);
      }
      for (const ex of EXEMPT_REL_PATHS) {
        if (ex && (relPosix === ex || relPosix.startsWith(`${ex}/`))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function assessAction(input: AssessInput): AssessResult {
  if (input.kind === "read") {
    return { level: "auto", reason: "只读访问", matched: "read-all" };
  }

  if (input.kind === "terminal") {
    const cmd = (input.command ?? "").trim().toLowerCase();
    const args = (input.commandArgs ?? "").toLowerCase();
    const full = `${cmd} ${args}`.trim();
    
    for (const re of BLOCK_PATTERNS) {
      if (re.test(full)) { return { level: "block", reason: `命令命中高危特征：${args.slice(0, 60)}`, matched: re.source }; }
    }
    if (READONLY_CMDS.has(cmd) || [...READONLY_CMDS].some((c) => c.includes(" ") && full.startsWith(c))) {
      return { level: "auto", reason: `只读命令 ${cmd}`, matched: "readonly" };
    }
    for (const re of CONFIRM_PATTERNS) {
      if (re.test(full)) { return { level: "confirm", reason: `写/变更类命令 ${args.slice(0, 60)}`, matched: re.source }; }
    }
    return { level: "confirm", reason: `未知命令 ${cmd}`, matched: "unknown" };
  }

  if (input.kind === "write") {
    const p = input.path ?? "";
    const base = p.split(/[\\/]/).pop() ?? "";
    if (/\.\./.test(p)) { return { level: "block", reason: `路径含越权片段（..）：${p.slice(0, 60)}`, matched: "traversal" }; }
    if (SENSITIVE_FILES.has(base) || CLASSIFIER_WRITE_BLOCK_SUFFIXES.some((s) => base.endsWith(s))) {
      return { level: "block", reason: `敏感文件禁止写入：${base}`, matched: "sensitive" };
    }
    if (typeof input.size === "number" && input.size > 5 * 1024 * 1024) {
      return { level: "confirm", reason: `大文件写入 ${(input.size / 1024 / 1024).toFixed(1)}MB`, matched: "large-write" };
    }
    return { level: "auto", reason: `工作区内普通写入 ${p.slice(0, 60)}`, matched: "normal-write" };
  }

  
  const url = (input.url ?? "").toLowerCase();
  if (/^https:\/\//.test(url)) { return { level: "auto", reason: `HTTPS 访问 ${url.slice(0, 60)}`, matched: "https" }; }
  


  if (/169\.254\.169\.254|metadata\.google|metadata\.azure/.test(url)) {
    return { level: "block", reason: `云元数据地址禁止访问（可读取实例凭据）${url.slice(0, 60)}`, matched: "cloud-metadata" };
  }
  










  if (/^(http|ws):\/\//.test(url) || /127\.0\.0\.1|localhost|\[::1\]/.test(url)) {
    return { level: "confirm", reason: `非 HTTPS / 本地地址访问 ${url.slice(0, 60)}`, matched: "lan-insecure" };
  }
  return { level: "confirm", reason: `非标准网络访问 ${url.slice(0, 60)}`, matched: "unknown-net" };
}


export function splitCommand(line: string): { command: string; commandArgs: string } {
  const t = line.trim();
  const seg = t.split(/[\s]+/);
  return { command: seg[0] ?? "", commandArgs: seg.slice(1).join(" ") };
}