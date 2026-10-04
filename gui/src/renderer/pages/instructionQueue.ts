
































export type InsertMode = "interrupt" | "queue" | "steer";

export interface QueuedInstruction {
  
  id: number;
  text: string;
  mode: InsertMode;
  
  images: string[];
  
  sessionId: string;
  agentId: string;
  networkEnabled?: boolean;
  createdAt: number;
}


let seq = 0;
export function nextQueueId(): number {
  seq += 1;
  return seq;
}


export function enqueue(list: QueuedInstruction[], item: QueuedInstruction): QueuedInstruction[] {
  return [...list, item];
}


export function peek(list: QueuedInstruction[]): QueuedInstruction | null {
  return list.length > 0 ? list[0] : null;
}








export function takeNext(
  list: QueuedInstruction[],
  sessionId: string,
): { item: QueuedInstruction; rest: QueuedInstruction[] } | null {
  const head = peek(list);
  if (!head) { return null; }
  if (!sessionId || head.sessionId !== sessionId) { return null; }
  return { item: head, rest: list.slice(1) };
}


export function setMode(list: QueuedInstruction[], id: number, mode: InsertMode): QueuedInstruction[] {
  return list.map((q) => (q.id === id ? { ...q, mode } : q));
}







export function promote(list: QueuedInstruction[], id: number): QueuedInstruction[] {
  const idx = list.findIndex((q) => q.id === id);
  if (idx <= 0) { return list; }
  const hit = list[idx]!;
  return [hit, ...list.slice(0, idx), ...list.slice(idx + 1)];
}


export function removeAt(list: QueuedInstruction[], id: number): QueuedInstruction[] {
  return list.filter((q) => q.id !== id);
}


export function clearAll(): QueuedInstruction[] {
  return [];
}








export function summarize(list: QueuedInstruction[]): string {
  return list.length > 0 ? `${list.length} 条待发` : "";
}




























export const STREAM_ALIVE_MS = 60_000;









export const STEER_ACK_MS = 15_000;


export function shouldDeferToSteer(i: {
  
  forceNewTurn?: boolean;
  
  streamActive: boolean;
  
  streamSession: string;
  
  targetSession: string;
  
  lastActivityAt: number;
  
  now: number;
}): boolean {
  if (i.forceNewTurn) { return false; }
  if (!i.streamActive) { return false; }
  
  if (!i.streamSession || i.streamSession !== i.targetSession) { return false; }
  return i.now - i.lastActivityAt < STREAM_ALIVE_MS;
}
