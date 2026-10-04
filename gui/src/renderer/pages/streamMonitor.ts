












export interface StreamMonitor {
  
  tokens: number;
  
  startedAt: number;
  
  model: string;
  
  replyChars: number;
  
  reasonChars: number;
}


export const CHARS_PER_TOKEN = 4;


export function createMonitor(startedAt: number, model = ""): StreamMonitor {
  return { tokens: 0, startedAt, model, replyChars: 0, reasonChars: 0 };
}


export function tokensFromChars(replyChars: number, reasonChars: number): number {
  const total = Math.max(0, replyChars) + Math.max(0, reasonChars);
  return Math.round(total / CHARS_PER_TOKEN);
}





export function bumpMonitor(
  m: StreamMonitor,
  replyDelta: number,
  reasonDelta: number,
  model?: string,
): StreamMonitor {
  if (replyDelta > 0) { m.replyChars += replyDelta; }
  if (reasonDelta > 0) { m.reasonChars += reasonDelta; }
  m.tokens = tokensFromChars(m.replyChars, m.reasonChars);
  if (model && !m.model) { m.model = model; }
  return m;
}


export function monitorElapsed(m: Pick<StreamMonitor, "startedAt"> | null | undefined, now: number): number {
  const start = m?.startedAt ?? 0;
  if (!start) { return 0; }
  return Math.max(0, now - start);
}
