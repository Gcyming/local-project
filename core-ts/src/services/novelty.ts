







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


export type HistoryUserLoader = (agentId: string, limit: number) => Promise<Array<{ user: string }>>;





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
    return true; 
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
