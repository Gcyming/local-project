/**
 * core-ts/src/claims.ts — 幻觉护栏核心（A-047 语义移植 / A-987 与 Python 同步重构）。
 *
 * ⚠️ 这是 `core/claims.py` 的**孪生实现**，两个引擎（Python CLI/服务 与 TS GUI/网关）各跑一份。
 * 铁律：**任何语义改动必须两边同时做**。历史上这里已经漂移过一次 —— TS 侧把盘符分支改成
 * "允许空格"但用了贪婪匹配，Python 侧还停在"排除空格"，于是同一段回复在两个引擎里得到
 * 完全相反的结论（Python 报幻觉、TS 不报）。A-987 起两侧统一为"惰性收尾到已知扩展名"。
 *
 * 能力清单：
 * - 检测回复中「已保存/已生成/已写入…」完成态声称引用的本地路径，核验真实存在性
 * - 证据性描述（**数字 + 字节/KB/MB**、文件大小/完整路径/时长）同样触发核验（A-048-R6）
 * - URL 段剔除、域名样式残片跳过（A-050-R）、裸文件名查 data/generated/（A-050-R2）
 * - 路径存在但声称字节数与真实值严重不符 → 假数值拦截（A-087/A-088）
 * - **含空格路径不再被截断**（A-987，见 PATH_RE 注释）
 * - **不确定就不指控**：截断碎片 / 散文碎片 / 围栏代码块一律放行（A-987，见 skipped 计数）
 * - 存在性核验带**大小写不敏感兜底**（A-987）
 * - `auditClaims()` 给出结构化结果（类别 + "是不是想写 X"建议），`findUnverifiedClaims()`
 *   保持旧的字符串返回以兼容既有调用方（merger / chat）
 */

import { access, realpath, stat, readdir } from "node:fs/promises";
import { isAbsolute, join, basename, resolve, sep } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

export { PROJECT_ROOT };

const CLAIM_VERBS = ["已保存", "保存到", "已生成", "已创建", "已写入", "已下载", "已导出"];
/** 证据性描述（短语型）。注意**不含**裸的 kb/mb/字节 —— 见 SIZE_CLAIM_HIT_RE */
const EVIDENCE_PHRASES = ["文件大小", "完整路径", "时长"];
// （Python 侧还保留了一份 `_EVIDENCE_HINTS` 常量：`slime_server.py` 从那里导入它。
//  TS 侧没有外部导入点，故不留这个无人使用的旧常量 —— 两边语义已由 EVIDENCE_PHRASES
//  + SIZE_CLAIM_HIT_RE 统一。）

const URL_RE = /https?:\/\/[^\s"'<>，。、]+/gi;
const DOMAIN_FRAGMENT_RE = /^[a-z0-9\u4e00-\u9fff-]+\.(?:cn|com|net|org|io|space|ai|top|xyz|cc|me)(?:[/\\]|$)/i;

/**
 * A-987（精度修复）：把 `字节/kb/mb` 当**裸子串**匹配会误触发 —— 英文 "number"/"Remember"
 * 里就含 "mb"。一段跟文件毫无关系的说明会让整段文本进入路径核验，凭空放大误报面。
 * 证据性描述的正确形态是"**数字 + 单位**"。
 */
const SIZE_CLAIM_HIT_RE = /\d[\d,]*\s*(?:字节|bytes?|kb|mb)\b/i;

/** 围栏代码块（``` 或 ~~~） */
const FENCED_BLOCK_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
/**
 * 是否跳过围栏代码块内的路径核验（默认 true）。
 * 依据：厂商共识里的"验证"针对的是**对工作结果的声称**；围栏块里绝大多数是**示例代码**
 * （`C:\Users\demo\output.png` 这类模板路径），核验它们纯属制造假阳性。
 * 行内反引号（`` `D:\…` ``）**不在此列** —— A-048-R6 的真实事故正是模型在表格里用
 * 行内反引号声称产出，那种必须继续拦。需要恢复旧行为时改这一个开关。
 */
const IGNORE_FENCED_BLOCKS = true;

/**
 * 已知扩展名：既是"这是个文件"的判据，也是**天然的终止符**。
 * 有了它才能做到"既允许路径含空格、又不把后面整句中文吞进来"。
 */
const KNOWN_EXT =
  "png|jpe?g|webp|gif|bmp|ico|svg|"
  + "mp4|mov|mkv|avi|webm|mp3|wav|m4a|"
  + "md|markdown|txt|rtf|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|"
  + "csv|tsv|xlsx?|docx?|pptx?|pdf|"
  + "py|pyi|ts|tsx|js|jsx|mjs|cjs|html?|css|scss|less|sh|bash|ps1|bat|cmd|"
  + "log|zip|tar|gz|7z|rar|npz|npy|pkl|db|sqlite|woff2?|ttf|otf|lock";

/**
 * 路径提取正则（单一捕获组）。
 *
 * A-987 根因（用户实测假指控）：盘符分支曾写成"排除空格"，**而项目自己就在
 * `D:\pilot project\`** —— `D:\pilot project\data\x.png` 被截断成 `D:\pilot`，相对分支
 * 还会再吐一个碎片 `project\data\x.png`，**每个真实文件都被报成"幻觉"**，而 Merger
 * 把这条当硬信号直接写进 errors。
 * 现在改为"**惰性收尾到第一个已知扩展名**"：扩展名是天然终止符，既容得下空格，
 * 又不会跨句吞并（`a.png 和 b.png` 必须切成两条，而不是拼成一条不存在的路径）。
 */
const PATH_RE = new RegExp(
  "(?<=[\\s\"'`：：（(])"
  + "("
  // ① 盘符绝对路径，允许空格，惰性收尾到第一个已知扩展名
  + "[A-Za-z]:[\\\\/][^\\n\"'`<>|]*?\\.(?:" + KNOWN_EXT + ")"
  // ② 盘符绝对路径，不含空格（兼容无扩展名的目录/自定义文件名）
  + "|[A-Za-z]:[\\\\/][^\\s\"'`<>\\uFF08\\uFF09)\\u3002，；、|]+"
  // ③ 相对路径 / 裸文件名，允许空格，同样惰性收尾
  + "|[\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff .\\\\/\\-]*?\\.(?:" + KNOWN_EXT + ")"
  + ")",
  "gi",
);
const SIZE_RE = /([\d,]+)\s*(字节|bytes?|KB|MB)/gi;
/** 候选尾部要剥离的分隔/句读（Windows 文件名本就不允许以 `.`/空格结尾，剥离无损） */
const TRAILING_JUNK_RE = /[ \t.,;:!?、，；：。！？)\]｝）】]+$/;
/** 绝对路径开头（①/② 的产物）：用于把"散文碎片"过滤限定在相对分支上 */
const ABS_HEAD_RE = /^[A-Za-z]:[\\/]/;

export interface ClaimIssue {
  path: string;
  /** "missing"（声称存在的文件不存在）| "size_mismatch"（数值不实） */
  kind: "missing" | "size_mismatch";
  /** "high"（可作硬信号）| "medium"（仅建议提示） */
  severity: "high" | "medium";
  detail: string;
  /** 同目录下最接近的真实文件名（"是不是想写 X？"） */
  suggestion?: string;
}

export interface ClaimAudit {
  issues: ClaimIssue[];
  /** 被跳过项计数（fenced_block / url / domain_fragment / prose_fragment / truncated_fragment /
   *  generated_dir / escape）—— 护栏可信度取决于"拦下的有多少是真警报"，这些数必须可归因 */
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

/**
 * 存在性核验（**大小写不敏感兜底**），命中返回盘上真实拼写的路径，否则 null。
 *
 * Windows / macOS 文件系统本身不区分大小写，但 `access()` 在大小写不一致时
 * （模型把 `D:\Pilot Project` 写成 `d:\pilot project`，或路径落在区分大小写的
 * 网络盘/容器挂载上）会失败 —— 据此报"文件不存在"就是假阳性。
 * 代价可控：只有直接命中失败才逐段回退匹配。
 */
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

/**
 * A-987（精度优先的核心兜底）：候选不存在，但它可能只是**被正则截断的碎片**。
 *
 * 判据：向上找到第一个存在的祖先目录；若"被截掉的那一段"仍是该目录下某个真实条目的
 * **前缀**，说明真实路径在这里被切断了（典型成因是路径含空格），判定为解析噪声。
 * 实例：`D:\pilot` 不存在，但 `D:\` 下有 `pilot project` → `"pilot"` 是它的前缀 → 放行。
 *
 * 代价：一个**恰好**是真实条目前缀的伪造路径会被放过（漏报）。刻意取舍 ——
 * 对照 Anthropic 的结论（FPR 86% 的护栏会被用户直接无视），
 * **对真实文件喊狼来了的代价远大于漏掉一条**。
 */
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

/**
 * A-987（精度）：候选里"**第一个空格出现在最后一个路径分隔符之前**"时，它更像被正则
 * 吞进来的散文/URL 残片（如 `3. See docs/x.md`），而不是一条路径。报出去只会是一条
 * 看不懂的垃圾路径，白白消耗护栏的可信度。
 *
 * ⚠️ 只对相对/裸文件名分支生效 —— 绝对路径有自己的强终止符，
 * `D:\a b\c d\x.png` 这类合法路径不能因为含空格被误杀。
 */
function looksLikeProseFragment(p: string): boolean {
  const sepIdx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const spIdx = p.indexOf(" ");
  return spIdx !== -1 && sepIdx !== -1 && spIdx < sepIdx;
}

/** 同目录下最接近的真实文件名（"是不是想写 X？"） */
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

/** 归一化编辑距离相似度（difflib.get_close_matches 的轻量等价物） */
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

/**
 * 核验回复中的完成态文件声称，返回**结构化**结果（含跳过计数）。
 * A-987：把"什么算一条声称"（解析/触发）与"怎么处置"（级别/文案）分开。
 */
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
    // 相对路径探测范围限制在项目内；绝对路径为用户明示位置，保留核验（A-047-SEC）
    if (!isAbs && resolved !== root && !resolved.startsWith(root + sep)) {
      audit.skipped.escape = (audit.skipped.escape ?? 0) + 1;
      continue;
    }
    const found = await resolveExisting(resolved);
    if (found === null) {
      // A-987：截断碎片（真实条目的前缀）→ 解析噪声，放行，绝不指控
      if (await looksLikeTruncatedFragment(resolved)) {
        audit.skipped.truncated_fragment = (audit.skipped.truncated_fragment ?? 0) + 1;
        continue;
      }
      // A-050-R2：裸文件名（真实存在于 data/generated/ 子目录）不算未核实声称
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
    // 已存在：realpath 防 symlink 逃逸（resolve 语义对齐 Python，A-047-SEC）
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

/** 找出回复中「声称已保存/生成」但实际不存在的本地路径（纯函数 + 真实核验） */
export async function findUnverifiedClaims(reply: string): Promise<string[]> {
  const audit = await auditClaims(reply);
  return audit.issues.filter((i) => i.severity === "high").map((i) => i.detail);
}
