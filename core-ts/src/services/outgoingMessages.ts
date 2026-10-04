












































export interface WireMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}










export const EMPTY_CONTENT_PLACEHOLDER: Readonly<Record<string, string>> = {
  user: "（继续）",
  assistant: "（本轮无输出）",
  tool: "（无输出）",
  system: "",
};


export function placeholderForRole(role: string): string {
  const p = EMPTY_CONTENT_PLACEHOLDER[role];
  return typeof p === "string" && p ? p : "（继续）";
}











export function isEmptyWireContent(content: unknown): boolean {
  if (content === null || content === undefined) { return true; }
  if (typeof content === "string") { return content.trim() === ""; }
  if (Array.isArray(content)) { return content.length === 0; }
  return String(content).trim() === "";
}


export function hasToolCalls(msg: WireMessage): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}









export function sanitizeOutgoingMessages<T extends WireMessage>(messages: readonly T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) { return messages as T[]; }
  let changed = false;
  const out: T[] = [];
  for (const m of messages) {
    if (isEmptyWireContent(m?.content)) {
      
      if (m?.role === "system") { changed = true; continue; }
      changed = true;
      out.push({ ...m, content: placeholderForRole(String(m?.role ?? "")) } as T);
      continue;
    }
    out.push(m);
  }
  return changed ? out : (messages as T[]);
}





export function countEmptyContent(messages: readonly WireMessage[]): number {
  if (!Array.isArray(messages)) { return 0; }
  return messages.filter((m) => isEmptyWireContent(m?.content)).length;
}












export function sanitizeWirePayload<T extends object>(payload: T): T {
  if (!payload || typeof payload !== "object") { return payload; }
  const msgs = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) { return payload; }
  const safe = sanitizeOutgoingMessages(msgs as WireMessage[]);
  return safe === (msgs as WireMessage[]) ? payload : ({ ...payload, messages: safe } as T);
}
