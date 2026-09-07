/**
 * gui/src/renderer/pages/contextMath.ts — 上下文消耗 UI 的**纯计算**层（零 React 依赖、vitest 可直测）。
 * 供 ContextRing / ContextWindowBar 共用：环的色阶阈值、token 构成分段、8 源分桶占比。
 * 语义与右侧栏/环渲染一致（绿<60% / 黄 60-85% / 红 >85%）。
 */
export interface ComposeTokens {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
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

/** 环占比：clamp 0..1（cap=0 → 0）。 */
export function contextRatio(used: number, cap: number): number {
  if (!(cap > 0)) { return 0; }
  return Math.max(0, Math.min(1, used / cap));
}

/** 环百分比：0..100 取整。 */
export function contextPct(ratio: number): number {
  return Math.round(ratio * 100);
}

/** 环色阶：<60% 绿 / <85% 黄 / 其余红；返回 颜色变量 + 语义标签。 */
export function ringLevel(ratio: number): { color: string; label: string } {
  if (ratio < 0.6) { return { color: "var(--success)", label: "充足" }; }
  if (ratio < 0.85) { return { color: "var(--warning)", label: "接近上限" }; }
  return { color: "var(--danger)", label: "逼近硬阈值" };
}

/** token 四项构成分段（输入/缓存/输出/思考；分母防零，任意项为 0 不产出段）。 */
export function composeSegments(t: ComposeTokens): { segments: ComposeSegment[]; any: boolean } {
  const tot = Math.max(1,
    (t.promptTokens ?? 0) + (t.completionTokens ?? 0) + (t.reasoningTokens ?? 0) + (t.cacheReadTokens ?? 0));
  const seg = (n: number): number => ((n ?? 0) / tot) * 100;
  const items: ComposeSegment[] = [
    { label: "输入", pct: seg(t.promptTokens), color: "#4b9eff", n: t.promptTokens ?? 0 },
    { label: "缓存", pct: seg(t.cacheReadTokens), color: "#2ea8dc", n: t.cacheReadTokens ?? 0 },
    { label: "输出", pct: seg(t.completionTokens), color: "#9a7bff", n: t.completionTokens ?? 0 },
    { label: "思考", pct: seg(t.reasoningTokens), color: "#d29922", n: t.reasoningTokens ?? 0 },
  ];
  const any = items.some((i) => i.n > 0);
  return { segments: items, any };
}

/** 8 源分桶占比（对齐 computeContextBuckets；总 tokens>0 归一，否则全 0）。 */
export function bucketsSegments(buckets: Array<{ key: string; tokens: number }>): { segments: BucketSegment[]; any: boolean } {
  const total = buckets.reduce((s, b) => s + (b.tokens ?? 0), 0);
  const any = total > 0;
  const segments = buckets
    .map((b) => ({ key: b.key, pct: any ? Math.round(((b.tokens ?? 0) / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.pct - a.pct);
  return { segments, any };
}