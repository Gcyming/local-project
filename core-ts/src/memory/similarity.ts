/**
 * 记忆相似度 —— **单一产地**（store.ts / global.ts 共用，与 Python `core/memory.py::_tokens` 同判据）。
 *
 * 为什么单独成模块：`global.ts`（跨 agent 去重索引）与 `store.ts`（per-agent 写入）必须用
 * 同一套 token 化和同一个阈值，否则「TS 说重复、Python 说不重复」，跨语言就永不收敛。
 * 放在 store.ts 里会形成 store ↔ global 的循环 import。
 *
 * A-1139：此前 TS 侧只有 `a.split(/\s+/)` —— 中文没有空格 ⇒ 整句 1 个 token ⇒
 * 「用户喜欢用 Python 写脚本」vs「用户偏好使用 Python 编程」的 Jaccard 只有 0.20，
 * 够不着 0.75 去重阈值。实测后果：11658 条 lesson 只有 25 条不同内容（99.8% 重复）。
 * 这里与 Python 侧对齐：CJK 段补 **字符 unigram + 字符 bigram**，拉丁仍按空白分词。
 */

import { createHash } from "node:crypto";

export const DEDUP_THRESHOLD = 0.75;
export const LINK_THRESHOLD = 0.70;
export const MERGE_THRESHOLD = 0.68;

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

/** 文本 → token 集合（CJK 单字 + 双字；拉丁按空白分词）。与 Python `_tokens` 逐行对齐。 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const low = text.toLowerCase();
  for (const w of low.split(/\s+/)) if (w) out.add(w);
  for (const run of low.match(CJK_RUN_RE) ?? []) {
    for (const ch of run) out.add(ch);
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** Jaccard 相似度（token 化见 tokens()，对中文有效）。 */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = tokens(a);
  const setB = tokens(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export const LINK_TRAVERSAL_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "relation_exhaustive",
    /(?:所有|全部|一切|每一个|每个|每条|有哪些|有哪几|都有哪些|列举|列出|罗列|枚举|汇总|梳理).{0,24}(?:相关|有关|关联|相连|涉及|有关系|关系)|(?:相关|有关|关联|相连|涉及|有关系|关系).{0,24}(?:所有|全部|一切|每一个|每个|每条|有哪些|有哪几|都有哪些|列举|列出|罗列|枚举|汇总|梳理)/,
  ],
  [
    "explicit_multihop",
    /(?:多跳|跨跳|多层级|关联链路|关联链|关系链|关系图|图谱|上下游|传递依赖|间接影响|间接依赖|完整脉络|全貌|链路)|(?:multi[- ]?hop|transitive)/i,
  ],
  [
    "exhaustive_related_en",
    /\b(?:all|every|everything|related|associated|connected)\b.{0,40}\b(?:related|associated|connected|link|links)\b/i,
  ],
];

export function linkTraversalRule(query: string): string | null {
  const q = String(query ?? "").trim();
  if (!q) return null;
  for (const [name, pattern] of LINK_TRAVERSAL_RULES) {
    if (pattern.test(q)) return name;
  }
  return null;
}

/** 记忆稳定 ID（content 哈希，幂等，用于双向链接）。 */
export function memId(content: string): string {
  return "mem_" + createHash("md5").update(content, "utf8").digest("hex").slice(0, 8);
}

/** 去重/合并命中的最小公共判据（两边都只判断「> 阈值」）。 */
export interface SimilarHit<T> {
  hit: T | null;
  score: number;
}

/**
 * 在候选集里找相似度 > threshold 的条目。用 token 交集数**充分剪枝**：
 * Jaccard = |A∩B|/|A∪B| ≥ t 蕴含 |A∩B| ≥ t·|A|（因 |A∪B| ≥ |A|），
 * 所以「共享 token 数 < t·|A|」的条目一定不命中，可以直接跳过 —— 上限生效后
 * 条目变多时，这一步是写入路径不退化成长度平方的关键。
 */
export function findSimilar<T>(
  items: T[],
  content: string,
  category: string,
  threshold: number,
  opts: { categoryOf: (item: T) => string | undefined; contentOf: (item: T) => string },
): SimilarHit<T> {
  const cand = tokens(content.toLowerCase());
  if (!cand.size) return { hit: null, score: 0 };
  const need = Math.floor(cand.size * threshold);
  let best = 0;
  for (const item of items) {
    if (opts.categoryOf(item) !== category) continue;
    const existing = opts.contentOf(item) ?? "";
    const other = existing ? tokens(existing.toLowerCase()) : new Set<string>();
    if (!other.size) continue;
    let inter = 0;
    for (const tok of cand) if (other.has(tok)) inter++;
    if (inter < need) continue;
    const score = inter / (cand.size + other.size - inter);
    if (score > best) best = score;
    if (score > threshold) return { hit: item, score };
  }
  return { hit: null, score: best };
}

/**
 * 合并后的正文 = 基准内容 + 「补充」行（与 Python `_merged_content` 同语义）。
 * 合并是有损的（只保留一份正文），所以调用方必须把原文写进 `merge_trail` 留痕。
 */
export function mergedContent(base: string, candidate: string): string {
  const candTokens = tokens(candidate.toLowerCase());
  const baseTokens = tokens(base.toLowerCase());
  if (candTokens.size && [...candTokens].every((t) => baseTokens.has(t))) return base;
  if (base.includes(candidate.trim())) return base;
  return `${base}\n补充: ${candidate.trim()}`;
}
