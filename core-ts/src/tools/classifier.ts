









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



import { PROTECTED_DIRS_SET, SENSITIVE_FILENAMES_SET, CLASSIFIER_WRITE_BLOCK_SUFFIXES } from "shared/security-policy";

const SENSITIVE_FILES = SENSITIVE_FILENAMES_SET;



export const PROTECTED_SOURCE_DIRS = PROTECTED_DIRS_SET;






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
    return PROTECTED_SOURCE_DIRS.has(first);
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