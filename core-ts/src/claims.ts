/**
 * core-ts/src/claims.ts — 幻觉护栏核心（A-047 语义移植）。
 * - 检测回复中「已保存/已生成/已写入…」完成态声称引用的本地路径，核验真实存在性
 * - 证据性描述（文件大小/字节/完整路径/时长）同样触发核验（A-048-R6 规避动词检测）
 * - URL 段剔除、域名样式残片跳过（A-050-R）、裸文件名查 data/generated/（A-050-R2）
 * - 路径存在但声称字节数与真实值严重不符 → 假数值拦截（A-087/A-088）
 */

import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, basename, resolve, sep } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

export { PROJECT_ROOT };

const CLAIM_VERBS = ["已保存", "保存到", "已生成", "已创建", "已写入", "已下载", "已导出"];
const EVIDENCE_HINTS = ["字节", "kb", "mb", "文件大小", "完整路径", "时长"];

const URL_RE = /https?:\/\/[^\s"'<>，。、]+/gi;
const DOMAIN_FRAGMENT_RE = /^[a-z0-9\u4e00-\u9fff-]+\.(?:cn|com|net|org|io|space|ai|top|xyz|cc|me)(?:[/\\]|$)/i;
// 路径提取正则（TS 移植修订：盘符分支允许空格——项目路径本身可含空格，
// Python 原版 `\s` 排除在无空格环境正确，但 D:\pilot project 这类路径会被截断成 "D:\pilot"）
const PATH_RE = new RegExp(
  "(?<=[\\s\"'`：：（(])"
  + "([A-Za-z]:[\\\\/][^\"'`<>\uFF08\uFF09)\u3002，。]+"
  + "|[\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff .\\\\/\\-]*\\.(?:png|jpe?g|webp|gif|mp4|md|txt|json|yaml|csv|py|log))",
  "gi",
);
const SIZE_RE = /([\d,]+)\s*(字节|bytes?|KB|MB)/gi;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function existsInGenerated(name: string): Promise<boolean> {
  const gen = join(PROJECT_ROOT, "data", "generated");
  if (!(await pathExists(gen))) {
    return false;
  }
  try {
    const { readdir } = await import("node:fs/promises");
    for (const sub of await readdir(gen, { withFileTypes: true })) {
      if (sub.isDirectory() && (await pathExists(join(gen, sub.name, name)))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function checkSizeClaim(reply: string, path: string, abs: string): Promise<string | null> {
  const mult: Record<string, number> = { 字节: 1, bytes: 1, kb: 1024, mb: 1024 * 1024 };
  const sizes: Array<{ bytes: number; raw: string }> = [];
  for (const m of reply.matchAll(SIZE_RE)) {
    const claimed = Number(m[1].replace(/,/g, ""));
    if (Number.isNaN(claimed)) {
      continue;
    }
    sizes.push({ bytes: claimed * (mult[m[2].toLowerCase()] ?? 1), raw: m[0] });
  }
  if (sizes.length === 0) {
    return null;
  }
  let real = 0;
  try {
    real = (await stat(abs)).size;
  } catch {
    return null;
  }
  if (real <= 0) {
    return null;
  }
  let best = sizes[0];
  for (const s of sizes) {
    if (Math.abs(s.bytes - real) < Math.abs(best.bytes - real)) {
      best = s;
    }
  }
  if (Math.abs(best.bytes - real) > Math.max(real * 0.15, 512)) {
    return `${path}（声称 ${best.bytes} 字节，实际 ${real} 字节，数值不实）`;
  }
  return null;
}

/** 找出回复中「声称已保存/生成」但实际不存在的本地路径（纯函数 + 真实核验） */
export async function findUnverifiedClaims(reply: string): Promise<string[]> {
  if (!reply) {
    return [];
  }
  const lower = reply.toLowerCase();
  const hasClaimVerb = CLAIM_VERBS.some((v) => reply.includes(v));
  const hasEvidence = EVIDENCE_HINTS.some((h) => lower.includes(h));
  if (!hasClaimVerb && !hasEvidence) {
    return [];
  }
  const cleaned = reply.replace(URL_RE, " ");
  const claims: string[] = [];
  const seen = new Set<string>();
  for (const m of cleaned.matchAll(PATH_RE)) {
    const p = m[1].trim();
    if (!p) {
      continue;
    }
    if (DOMAIN_FRAGMENT_RE.test(p)) {
      continue;
    }
    const isAbs = isAbsolute(p);
    const root = resolve(PROJECT_ROOT);
    const resolved = resolve(isAbs ? p : join(PROJECT_ROOT, p));
    // 相对路径探测范围限制在项目内；绝对路径为用户明示位置，保留核验（A-047-SEC）
    if (!isAbs && resolved !== root && !resolved.startsWith(root + sep)) {
      continue;
    }
    if (!(await pathExists(resolved))) {
      // A-050-R2：模型只转述裸文件名（真实存在于 data/generated/ 子目录）不算未核实声称
      if (!/[/\\]/.test(p) && (await existsInGenerated(basename(p)))) {
        continue;
      }
      if (!seen.has(p)) {
        seen.add(p);
        claims.push(p);
      }
      continue;
    }
    // 已存在：realpath 防 symlink 逃逸（resolve 语义对齐 Python，A-047-SEC）
    let abs: string;
    try {
      abs = await realpath(resolved);
    } catch {
      continue;
    }
    const sizeIssue = await checkSizeClaim(reply, p, abs);
    if (sizeIssue && !seen.has(sizeIssue)) {
      seen.add(sizeIssue);
      claims.push(sizeIssue);
    }
  }
  return claims;
}