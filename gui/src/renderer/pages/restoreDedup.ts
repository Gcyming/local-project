















export function normalizeForCompare(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, "");
}





export function isCoveredByHistory(candidate: string | undefined | null, historyAssistantTexts: string[]): boolean {
  const c = normalizeForCompare(candidate);
  if (!c) { return false; }
  for (const h of historyAssistantTexts) {
    const n = normalizeForCompare(h);
    if (!n) { continue; }
    if (n === c || n.includes(c) || c.includes(n)) { return true; }
  }
  return false;
}

export interface RestoreDedupInput {
  
  liveContent?: string | null;
  
  settledContent?: string | null;
  
  historyAssistantTexts: string[];
  
  streamConfirmedDead?: boolean;
}

export interface RestoreDedupResult {
  
  keepLive: boolean;
  
  keepSettled: boolean;
}


export function decideRestoreKeep(input: RestoreDedupInput): RestoreDedupResult {
  const live = input.liveContent ?? "";
  const settled = input.settledContent ?? "";
  const keepLive =
    normalizeForCompare(live).length > 0
    && !input.streamConfirmedDead
    && !isCoveredByHistory(live, input.historyAssistantTexts);
  const keepSettled =
    normalizeForCompare(settled).length > 0
    && !isCoveredByHistory(settled, input.historyAssistantTexts);
  return { keepLive, keepSettled };
}
