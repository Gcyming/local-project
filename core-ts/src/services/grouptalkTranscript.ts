


































export interface SpeakerTurn {
  
  name: string;
  
  agentId?: string;
  
  content: string;
  
  failed?: boolean;
}


const SPEAKER_MARKER = /【([^】\n]{1,80})】/g;








export function formatSpeakerBlob(turns: SpeakerTurn[]): string {
  return turns.map((t) => `【${t.name}】${t.content}`).join("\n\n");
}












export function parseSpeakerBlob(text: string, opts?: { minTurns?: number }): SpeakerTurn[] | null {
  const s = (text ?? "").replace(/\r\n/g, "\n");
  if (!s.trim()) { return null; }
  const min = Math.max(1, opts?.minTurns ?? 2);

  SPEAKER_MARKER.lastIndex = 0;
  const hits: Array<{ name: string; start: number; end: number }> = [];
  for (let m = SPEAKER_MARKER.exec(s); m !== null; m = SPEAKER_MARKER.exec(s)) {
    hits.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  
  if (hits.length < min || s.slice(0, hits[0].start).trim() !== "") { return null; }

  const turns: SpeakerTurn[] = [];
  for (let i = 0; i < hits.length; i++) {
    const to = i + 1 < hits.length ? hits[i + 1].start : s.length;
    const content = s.slice(hits[i].end, to).trim();
    if (!content) { continue; }
    turns.push({ name: hits[i].name, content });
  }
  return turns.length > 0 ? turns : null;
}





export function isSpeechFailure(content: string): boolean {
  return /本次发言失败/.test(content ?? "");
}










export interface HistoryTurnLike {
  name: string;
  agentId?: string;
  content: string;
  failed?: boolean;
}


export interface ExpandableRecord {
  
  user?: string;
  
  ai?: string;
  
  timestamp: string;
  reasoning?: string;
  elapsed_ms?: number;
  timeline?: unknown;
  
  turns?: HistoryTurnLike[];
}


export interface ExpandedMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
  ts?: string;
  reasoning?: string;
  elapsedMs?: number;
  timeline?: unknown[];
  agentName?: string;
  agentId?: string;
  failed?: boolean;
}













export function parseSpeakerBlobForGroup(text: string, memberNames: ReadonlySet<string>): SpeakerTurn[] | null {
  const parsed = parseSpeakerBlob(text, { minTurns: 1 });
  if (!parsed) { return null; }
  return parsed.some((t) => memberNames.has(t.name)) ? parsed : null;
}












export function expandHistoryRecord(r: ExpandableRecord, groupNames?: ReadonlySet<string>): ExpandedMessage[] {
  const out: ExpandedMessage[] = [];
  if (r.user) {
    out.push({ role: "user", content: r.user, time: r.timestamp, ts: r.timestamp });
  }
  if (!r.ai) { return out; }
  const hasFirstAssistant = (): boolean => out.some((m) => m.role === "assistant");

  const turns: SpeakerTurn[] | null = r.turns?.length
    ? r.turns.map((t) => ({ name: t.name, agentId: t.agentId, content: t.content, failed: t.failed }))
    : (groupNames && groupNames.size > 0 ? parseSpeakerBlobForGroup(r.ai, groupNames) : null);

  if (!turns) {
    out.push({
      role: "assistant", content: r.ai, time: r.timestamp, ts: r.timestamp,
      reasoning: r.reasoning, elapsedMs: r.elapsed_ms, timeline: r.timeline as unknown[] | undefined,
    });
    return out;
  }

  for (const t of turns) {
    const first = !hasFirstAssistant();
    out.push({
      role: "assistant", content: t.content, time: r.timestamp, ts: r.timestamp,
      reasoning: first ? r.reasoning : undefined,
      elapsedMs: first ? r.elapsed_ms : undefined,
      timeline: first ? (r.timeline as unknown[] | undefined) : undefined,
      agentName: t.name,
      agentId: t.agentId,
      
      ...((t.failed ?? isSpeechFailure(t.content)) ? { failed: true } : {}),
    });
  }
  return out;
}

