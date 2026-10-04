


























export interface UpstreamNotice {
  kind: "retry" | "fallback" | "prefill";
  
  text: string;
  
  at: number;
}

let slot: UpstreamNotice | null = null;


export function describeUpstreamStatus(status: number | undefined): string {
  if (status === 429) { return "被限流（429）"; }
  if (typeof status === "number" && status > 0) { return `HTTP ${status}`; }
  return "网络抖动";
}







export function formatRetryNotice(info: { attempt: number; maxAttempts: number; waitMs: number; status?: number }): string {
  const secs = Math.max(1, Math.round(info.waitMs / 1000));
  const nth = Math.min(info.attempt + 1, info.maxAttempts);
  return `上游${describeUpstreamStatus(info.status)}，${secs}s 后重试（第 ${nth}/${info.maxAttempts} 次）`;
}


export function formatFallbackNotice(from: string, to: string): string {
  const f = (from || "").trim() || "当前模型";
  const t = (to || "").trim();
  return t ? `主模型不可用，已切换备用模型：${f} → ${t}` : `主模型不可用，已切换备用模型（原：${f}）`;
}











export function formatPrefillNotice(inputTokens: number, budgetMs: number): string {
  const k = Math.max(1, Math.round(inputTokens / 1000));
  const totalS = Math.max(1, Math.round(budgetMs / 1000));
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  const human = m > 0 ? `${m} 分${s > 0 ? ` ${s} 秒` : ""}` : `${s} 秒`;
  return `上游正在预填充 ≈${k}K tokens（冷缓存时较慢，此阶段不产生任何输出），首包最多等 ${human}`;
}


export function noteUpstream(kind: UpstreamNotice["kind"], text: string): void {
  const t = (text ?? "").trim();
  if (!t) { return; }
  slot = { kind, text: t, at: Date.now() };
}


export function takeUpstreamNotice(): UpstreamNotice | null {
  const v = slot;
  slot = null;
  return v;
}


export function peekUpstreamNotice(): UpstreamNotice | null {
  return slot;
}


export function resetUpstreamNoticeForTest(): void {
  slot = null;
}
