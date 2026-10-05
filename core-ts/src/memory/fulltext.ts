import { DEFAULT_INDEX_OPTIONS, queryTerms, tokenize } from "../websearch/engine.js";

export const FTS_K1 = DEFAULT_INDEX_OPTIONS.k1;
export const FTS_B = DEFAULT_INDEX_OPTIONS.b;
export const RRF_K = 60;

export interface FullTextHit {
  index: number;
  score: number;
}

export interface FusedHit {
  key: string;
  score: number;
}

export function fulltextSearch(query: string, docs: string[], topK = 5): FullTextHit[] {
  const q = String(query ?? "").trim();
  if (!q || topK <= 0 || !docs.length) return [];
  const terms = queryTerms(q);
  if (!terms.length) return [];

  const counts: Map<string, number>[] = [];
  const lengths: number[] = [];
  for (const doc of docs) {
    const tf = new Map<string, number>();
    for (const t of tokenize(String(doc ?? ""))) tf.set(t, (tf.get(t) ?? 0) + 1);
    counts.push(tf);
    let n = 0;
    for (const v of tf.values()) n += v;
    lengths.push(n);
  }

  const nDocs = docs.length;
  let totalLen = 0;
  for (const n of lengths) totalLen += n;
  const avdl = totalLen / nDocs || 1;

  const df = new Map<string, number>();
  for (const tf of counts) {
    for (const t of terms) {
      if (tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const scored: FullTextHit[] = [];
  for (let i = 0; i < nDocs; i += 1) {
    const tf = counts[i];
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const d = df.get(t) ?? 0;
      const idf = Math.log(1 + (nDocs - d + 0.5) / (d + 0.5));
      const denom = f + FTS_K1 * (1 - FTS_B + (FTS_B * (lengths[i] || 1)) / avdl);
      score += (idf * (f * (FTS_K1 + 1))) / denom;
    }
    if (score > 0) scored.push({ index: i, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, Math.max(0, topK));
}

export function rrfFuse(channels: string[][], k = RRF_K): FusedHit[] {
  const acc = new Map<string, number>();
  for (const channel of channels) {
    channel.forEach((key, rank) => {
      if (!key) return;
      acc.set(key, (acc.get(key) ?? 0) + 1 / (k + rank + 1));
    });
  }
  const out: FusedHit[] = [];
  for (const [key, score] of acc) out.push({ key, score });
  out.sort((a, b) => (b.score - a.score) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}