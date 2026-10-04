




export interface ComposeTokens {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  






  cacheReadInPrompt?: boolean;
}

export interface ComposeSegment {
  label: string;
  color: string;
  pct: number;
  n: number;
}

export interface BucketCount {
  key: string;
  tokens: number;
}

export interface BucketSegment {
  key: string;
  pct: number;
}


export function contextRatio(used: number, cap: number): number {
  if (!(cap > 0)) { return 0; }
  return Math.max(0, Math.min(1, used / cap));
}


export function contextPct(ratio: number): number {
  return Math.round(ratio * 100);
}


export function ringLevel(ratio: number): { color: string; label: string } {
  if (ratio < 0.6) { return { color: "var(--success)", label: "充足" }; }
  if (ratio < 0.85) { return { color: "var(--warning)", label: "接近上限" }; }
  return { color: "var(--danger)", label: "逼近硬阈值" };
}
























export interface UsageComposition {
  
  inputSide: number;
  
  cacheRead: number;
  
  outputSide: number;
  
  reasoning: number;
  
  total: number;
  
  cacheInPrompt: boolean;
}

export function usageComposition(t: ComposeTokens): UsageComposition {
  const prompt = Math.max(0, t.promptTokens ?? 0);
  const completion = Math.max(0, t.completionTokens ?? 0);
  const reasoning = Math.max(0, t.reasoningTokens ?? 0);
  const cacheRead = Math.max(0, t.cacheReadTokens ?? 0);
  
  const cacheInPrompt = t.cacheReadInPrompt ?? true;
  const inputSide = prompt + (cacheInPrompt ? 0 : cacheRead);
  const outputSide = Math.max(completion, reasoning);
  return { inputSide, cacheRead, outputSide, reasoning, total: inputSide + outputSide, cacheInPrompt };
}






export function composeSegments(t: ComposeTokens): { segments: ComposeSegment[]; any: boolean } {
  const c = usageComposition(t);
  const seg = (n: number): number => (c.total > 0 ? (n / c.total) * 100 : 0);
  const missIn = Math.max(0, c.inputSide - c.cacheRead);
  const visibleOut = Math.max(0, c.outputSide - c.reasoning);
  const items: ComposeSegment[] = [
    { label: "输入", pct: seg(missIn), color: "#4b9eff", n: missIn },
    { label: "缓存", pct: seg(c.cacheRead), color: "#2ea8dc", n: c.cacheRead },
    { label: "输出", pct: seg(visibleOut), color: "#9a7bff", n: visibleOut },
    { label: "思考", pct: seg(c.reasoning), color: "#d29922", n: c.reasoning },
  ];
  const any = items.some((i) => i.n > 0);
  return { segments: items, any };
}


export function bucketsSegments(buckets: Array<{ key: string; tokens: number }>): { segments: BucketSegment[]; any: boolean } {
  const total = buckets.reduce((s, b) => s + (b.tokens ?? 0), 0);
  const any = total > 0;
  const segments = buckets
    .map((b) => ({ key: b.key, pct: any ? Math.round(((b.tokens ?? 0) / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.pct - a.pct);
  return { segments, any };
}


export type TokenBase = 1000 | 1024;




























export function pickTokenBase(cap: number): TokenBase {
  if (!Number.isFinite(cap) || cap <= 0) { return 1000; }
  const off = (b: number): number => Math.abs(cap / b - Math.round(cap / b));
  
  return off(1024) < off(1000) ? 1024 : 1000;
}












export function fmtTokens(n: number, cap?: number | null): string {
  if (!Number.isFinite(n)) { return "0"; }
  const v = Math.max(0, n);
  const base: TokenBase = cap != null && Number.isFinite(cap) && cap > 0 ? pickTokenBase(cap) : 1000;
  const million = base * base;
  
  const unit = (val: number, decimals: number, suffix: string): string =>
    `${val.toFixed(decimals).replace(/\.0+$/, "")}${suffix}`;
  if (v < base) { return String(Math.round(v)); }
  if (v < million) { return unit(v / base, v < 10 * base ? 1 : 0, "K"); }
  return unit(v / million, 1, "M");
}


function positiveNum(v: number | string | null | undefined): number | undefined {
  if (v == null || v === "") { return undefined; }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

























export function kInputBase(cur: number | string | null | undefined): TokenBase {
  return pickTokenBase(positiveNum(cur) ?? 0);
}


export function tokensToKInput(cur: number | string | null | undefined): string {
  const n = positiveNum(cur);
  return n == null ? "" : String(Math.round(n / pickTokenBase(n)));
}


export function kInputToTokens(text: string, base: TokenBase): number | undefined {
  const n = positiveNum(text);
  return n == null ? undefined : n * base;
}





export function kInputTitle(what: string, base: TokenBase): string {
  return `${what}（单位 K token；本行 1 K = ${base} token，输入 32 = ${32 * base} token）`;
}
