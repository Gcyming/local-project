
























export interface LiveMonitorSnapshot {
  sessionId: string;
  used: number;
  cap: number;
  replyTokens: number;
  reasonTokens: number;
  elapsedMs: number;
  streaming: boolean;
  
  updatedAt: number;
}

const liveMonitor = { current: null as LiveMonitorSnapshot | null };


export function publishLiveMonitor(snap: Omit<LiveMonitorSnapshot, "updatedAt">): void {
  liveMonitor.current = { ...snap, updatedAt: Date.now() };
}


export function readLiveMonitor(sessionId: string, maxAgeMs = 3000): LiveMonitorSnapshot | null {
  const s = liveMonitor.current;
  if (!s) { return null; }
  if (sessionId && s.sessionId && s.sessionId !== sessionId) { return null; }
  if (Date.now() - s.updatedAt > maxAgeMs) { return null; }
  return s;
}
