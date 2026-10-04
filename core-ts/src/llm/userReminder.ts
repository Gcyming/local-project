











































export interface RemindableMessage {
  role?: string;
  content?: unknown;
}







export function foldUserReminder<T extends RemindableMessage>(messages: readonly T[], reminder: string): T[] {
  const out = messages.slice();
  const text = typeof reminder === "string" ? reminder.trim() : "";
  if (!text) { return out; }

  let idx = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]?.role === "user") { idx = i; break; }
  }
  if (idx < 0) {
    
    out.push({ role: "user", content: text } as T);
    return out;
  }

  const msg = out[idx]!;
  const cur = msg.content;
  if (typeof cur === "string") {
    out[idx] = { ...msg, content: cur.trim() ? `${cur}\n\n${text}` : text };
  } else if (Array.isArray(cur)) {
    
    out[idx] = { ...msg, content: [...(cur as unknown[]), { type: "text", text }] };
  } else {
    out[idx] = { ...msg, content: text };
  }
  return out;
}







export function hasOnlyLeadingSystem(messages: readonly RemindableMessage[]): boolean {
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i]?.role === "system") { return false; }
  }
  return true;
}
