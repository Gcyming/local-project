/**
 * core-ts/src/services/novelty.ts — novelty 信号检测（Intelligence 11.2.4.6 语义移植）。
 * 移植自 core/novelty.py + slime_server.py._detect_novelty：
 * - bigrams：字符级 bigram 分词（中英文通吃，避免空格分词使中文 Jaccard 恒为 0）
 * - isShortConfirmation：短确认语守卫（<3 字符判非新主题）
 * - detectNovelty：与最近 5 条历史的 bigram Jaccard 最大相似度 < 0.15 → 新主题
 */

export function bigrams(text: string): Set<string> {
  const t = text.toLowerCase();
  if (t.length < 2) {
    return new Set();
  }
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    out.add(t.slice(i, i + 2));
  }
  return out;
}

export function isShortConfirmation(message: string): boolean {
  return message.trim().length < 3;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  return inter / (a.size + b.size - inter);
}

/** 历史记录读取器（注入点：config/history.jsonl 或测试内存实现） */
export type HistoryUserLoader = (agentId: string, limit: number) => Promise<Array<{ user: string }>>;

/**
 * novelty 信号：与最近 5 条历史的最大 bigram Jaccard < 0.15 → 新主题（零嵌入成本）。
 * 守卫：空/短确认语直接判非新主题；无历史 → 新主题；当前无 bigram → 非新主题。
 */
export async function detectNovelty(
  agentId: string,
  message: string,
  loadHistory: HistoryUserLoader,
): Promise<boolean> {
  if (isShortConfirmation(message)) {
    return false;
  }
  let records: Array<{ user: string }> = [];
  try {
    records = await loadHistory(agentId, 6);
  } catch {
    return false;
  }
  const prior = records.filter((r) => r.user && r.user !== message).map((r) => r.user).slice(-5);
  if (prior.length === 0) {
    return true; // 首次交互视为新主题
  }
  const cur = bigrams(message);
  if (cur.size === 0) {
    return false;
  }
  const sims: number[] = [];
  for (const p of prior) {
    const other = bigrams(p);
    if (other.size > 0) {
      sims.push(jaccard(cur, other));
    }
  }
  return sims.length === 0 ? true : Math.max(...sims) < 0.15;
}
