



















import { access, realpath, stat, readdir } from "node:fs/promises";
import { isAbsolute, join, basename, resolve, sep } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

export { PROJECT_ROOT };

const CLAIM_VERBS = ["已保存", "保存到", "已生成", "已创建", "已写入", "已下载", "已导出"];

const EVIDENCE_PHRASES = ["文件大小", "完整路径", "时长"];




const URL_RE = /https?:\/\/[^\s"'<>，。、]+/gi;
const DOMAIN_FRAGMENT_RE = /^[a-z0-9\u4e00-\u9fff-]+\.(?:cn|com|net|org|io|space|ai|top|xyz|cc|me)(?:[/\\]|$)/i;






const SIZE_CLAIM_HIT_RE = /\d[\d,]*\s*(?:字节|bytes?|kb|mb)\b/i;


const FENCED_BLOCK_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;







const IGNORE_FENCED_BLOCKS = true;





const KNOWN_EXT =
  "png|jpe?g|webp|gif|bmp|ico|svg|"
  + "mp4|mov|mkv|avi|webm|mp3|wav|m4a|"
  + "md|markdown|txt|rtf|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|"
  + "csv|tsv|xlsx?|docx?|pptx?|pdf|"
  + "py|pyi|ts|tsx|js|jsx|mjs|cjs|html?|css|scss|less|sh|bash|ps1|bat|cmd|"
  + "log|zip|tar|gz|7z|rar|npz|npy|pkl|db|sqlite|woff2?|ttf|otf|lock";











const PATH_RE = new RegExp(
  "(?<=[\\s\"'`：：（(])"
  + "("
  
  + "[A-Za-z]:[\\\\/][^\\n\"'`<>|]*?\\.(?:" + KNOWN_EXT + ")"
  
  + "|[A-Za-z]:[\\\\/][^\\s\"'`<>\\uFF08\\uFF09)\\u3002，；、|]+"
  
  + "|[\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff .\\\\/\\-]*?\\.(?:" + KNOWN_EXT + ")"
  + ")",
  "gi",
);
const SIZE_RE = /([\d,]+)\s*(字节|bytes?|KB|MB)/gi;

const TRAILING_JUNK_RE = /[ \t.,;:!?、，；：。！？)\]｝）】]+$/;

const ABS_HEAD_RE = /^[A-Za-z]:[\\/]/;

export interface ClaimIssue {
  path: string;
  
  kind: "missing" | "size_mismatch";
  
  severity: "high" | "medium";
  detail: string;
  
  suggestion?: string;
}

export interface ClaimAudit {
  issues: ClaimIssue[];
  

  skipped: Record<string, number>;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}









async function resolveExisting(p: string): Promise<string | null> {
  if (await pathExists(p)) {
    return p;
  }
  try {
    const parsed = resolve(p);
    const root = parsed.slice(0, parsed.length - parsed.replace(/^[A-Za-z]:[\\/]|^[/\\]/, "").length);
    let cur = root || "/";
    const rest = parsed.slice(root.length).split(/[\\/]+/).filter(Boolean);
    for (const part of rest) {
      const entries = await readdir(cur);
      const actual = entries.find((e) => e.toLowerCase() === part.toLowerCase());
      if (actual === undefined) {
        return null;
      }
      cur = join(cur, actual);
    }
    return (await pathExists(cur)) ? cur : null;
  } catch {
    return null;
  }
}












async function looksLikeTruncatedFragment(raw: string): Promise<boolean> {
  const { dirname, basename: base } = await import("node:path");
  let cur = resolve(raw);
  for (let i = 0; i < 16; i += 1) {
    const parent = dirname(cur);
    if (parent === cur) {
      return false;
    }
    const frag = base(cur);
    if (await pathExists(parent)) {
      if (frag.length < 2) {
        return false;
      }
      try {
        const entries = await readdir(parent);
        return entries.some((e) => e !== frag && e.startsWith(frag));
      } catch {
        return false;
      }
    }
    cur = parent;
  }
  return false;
}









function looksLikeProseFragment(p: string): boolean {
  const sepIdx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const spIdx = p.indexOf(" ");
  return spIdx !== -1 && sepIdx !== -1 && spIdx < sepIdx;
}


async function closestSibling(raw: string): Promise<string | undefined> {
  try {
    const { dirname, basename: base } = await import("node:path");
    const parent = dirname(resolve(raw));
    const name = base(resolve(raw));
    const entries = (await readdir(parent)).filter((e) => e !== name);
    if (entries.length === 0) {
      return undefined;
    }
    let best: { name: string; score: number } | undefined;
    for (const e of entries) {
      const score = similarity(name.toLowerCase(), e.toLowerCase());
      if (score >= 0.7 && (best === undefined || score > best.score)) {
        best = { name: e, score };
      }
    }
    return best?.name;
  } catch {
    return undefined;
  }
}


function similarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (!a.length || !b.length) {
    return 0;
  }
  let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

async function existsInGenerated(name: string): Promise<boolean> {
  const gen = join(PROJECT_ROOT, "data", "generated");
  if (!(await pathExists(gen))) {
    return false;
  }
  try {
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

async function checkSizeClaim(reply: string, path: string, abs: string): Promise<ClaimIssue | null> {
  const mult: Record<string, number> = { 字节: 1, bytes: 1, kb: 1024, mb: 1024 * 1024 };
  const sizes: Array<{ bytes: number; raw: string }> = [];
  for (const m of reply.matchAll(SIZE_RE)) {
    const claimed = Number(m[1]!.replace(/,/g, ""));
    if (Number.isNaN(claimed)) {
      continue;
    }
    sizes.push({ bytes: claimed * (mult[m[2]!.toLowerCase()] ?? 1), raw: m[0] });
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
  let best = sizes[0]!;
  for (const s of sizes) {
    if (Math.abs(s.bytes - real) < Math.abs(best.bytes - real)) {
      best = s;
    }
  }
  if (Math.abs(best.bytes - real) > Math.max(real * 0.15, 512)) {
    return {
      path,
      kind: "size_mismatch",
      severity: "high",
      detail: `${path}（声称 ${best.bytes} 字节，实际 ${real} 字节，数值不实）`,
    };
  }
  return null;
}





export async function auditClaims(reply: string): Promise<ClaimAudit> {
  const audit: ClaimAudit = { issues: [], skipped: {} };
  if (!reply) {
    return audit;
  }

  let text = reply;
  if (IGNORE_FENCED_BLOCKS) {
    let n = 0;
    text = text.replace(FENCED_BLOCK_RE, () => {
      n += 1;
      return " ";
    });
    if (n > 0) {
      audit.skipped.fenced_block = n;
    }
  }

  const lower = text.toLowerCase();
  const hasClaimVerb = CLAIM_VERBS.some((v) => text.includes(v));
  const hasEvidence = EVIDENCE_PHRASES.some((h) => text.includes(h)) || SIZE_CLAIM_HIT_RE.test(text);
  if (!hasClaimVerb && !hasEvidence) {
    return audit;
  }
  void lower;

  let urlHits = 0;
  const cleaned = text.replace(URL_RE, () => {
    urlHits += 1;
    return " ";
  });
  if (urlHits > 0) {
    audit.skipped.url = urlHits;
  }

  const seen = new Set<string>();
  for (const m of cleaned.matchAll(PATH_RE)) {
    const p = m[1]!.trim().replace(TRAILING_JUNK_RE, "");
    if (!p) {
      continue;
    }
    if (DOMAIN_FRAGMENT_RE.test(p)) {
      audit.skipped.domain_fragment = (audit.skipped.domain_fragment ?? 0) + 1;
      continue;
    }
    if (!ABS_HEAD_RE.test(p) && looksLikeProseFragment(p)) {
      audit.skipped.prose_fragment = (audit.skipped.prose_fragment ?? 0) + 1;
      continue;
    }
    const isAbs = isAbsolute(p);
    const root = resolve(PROJECT_ROOT);
    const resolved = resolve(isAbs ? p : join(PROJECT_ROOT, p));
    
    if (!isAbs && resolved !== root && !resolved.startsWith(root + sep)) {
      audit.skipped.escape = (audit.skipped.escape ?? 0) + 1;
      continue;
    }
    const found = await resolveExisting(resolved);
    if (found === null) {
      
      if (await looksLikeTruncatedFragment(resolved)) {
        audit.skipped.truncated_fragment = (audit.skipped.truncated_fragment ?? 0) + 1;
        continue;
      }
      
      if (!/[/\\]/.test(p) && (await existsInGenerated(basename(p)))) {
        audit.skipped.generated_dir = (audit.skipped.generated_dir ?? 0) + 1;
        continue;
      }
      if (seen.has(p)) {
        continue;
      }
      seen.add(p);
      audit.issues.push({
        path: p,
        kind: "missing",
        severity: "high",
        detail: p,
        suggestion: await closestSibling(resolved),
      });
      continue;
    }
    
    let abs: string;
    try {
      abs = await realpath(found);
    } catch {
      continue;
    }
    const sizeIssue = await checkSizeClaim(text, p, abs);
    if (sizeIssue !== null && !seen.has(sizeIssue.detail)) {
      seen.add(sizeIssue.detail);
      audit.issues.push(sizeIssue);
    }
  }
  return audit;
}


export async function findUnverifiedClaims(reply: string): Promise<string[]> {
  const audit = await auditClaims(reply);
  return audit.issues.filter((i) => i.severity === "high").map((i) => i.detail);
}
