







































export interface SteerItem {
  
  id: string;
  
  text: string;
}


const buffers = new Map<string, SteerItem[]>();


export const STEER_MAX_PENDING = 8;


export const STEER_TEXT_MAX = 2000;







export function pushSteer(sessionId: string, item: SteerItem): number {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  const text = typeof item?.text === "string" ? item.text.trim() : "";
  if (!sid || !text) { return 0; }
  const list = buffers.get(sid) ?? [];
  list.push({ id: String(item.id ?? ""), text: text.slice(0, STEER_TEXT_MAX) });
  
  while (list.length > STEER_MAX_PENDING) { list.shift(); }
  buffers.set(sid, list);
  return list.length;
}








export function drainSteers(sessionId: string | undefined): SteerItem[] {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return []; }
  const list = buffers.get(sid);
  if (!list || list.length === 0) { return []; }
  buffers.delete(sid);
  return list;
}








export function clearSteers(sessionId: string | undefined): void {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return; }
  buffers.delete(sid);
}


export function pendingSteerCount(sessionId: string | undefined): number {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return 0; }
  return buffers.get(sid)?.length ?? 0;
}

















export function dropSteer(sessionId: string | undefined, id: string | number): boolean {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return false; }
  const list = buffers.get(sid);
  if (!list || list.length === 0) { return false; }
  const key = String(id ?? "");
  const idx = list.findIndex((it) => it.id === key);
  if (idx < 0) { return false; }
  list.splice(idx, 1);
  if (list.length === 0) { buffers.delete(sid); }
  return true;
}


export function resetSteerBusForTest(): void {
  buffers.clear();
}
