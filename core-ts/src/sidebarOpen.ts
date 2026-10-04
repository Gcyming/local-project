


















export type SidebarOpenKind = "url" | "terminal" | "files";

export interface SidebarOpenRequest {
  kind: SidebarOpenKind;
  
  url?: string;
  
  name?: string;
  
  cmd?: string;
  
  root?: string;
  
  rel?: string;
  
  from?: "site" | "user";
  











  sessionId?: string;
}


export type SidebarOpener = (req: string | SidebarOpenRequest, name?: string) => void;

let sidebarOpenerRef: SidebarOpener | null = null;

export function setSidebarOpener(fn: SidebarOpener | null): void { sidebarOpenerRef = fn; }


export function hasSidebarOpener(): boolean { return sidebarOpenerRef !== null; }

const trimOrUndef = (v: unknown): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : undefined;
};








export function normalizeSidebarOpenRequest(
  req: string | SidebarOpenRequest,
  name?: string,
): SidebarOpenRequest | null {
  if (typeof req === "string") {
    const url = trimOrUndef(req);
    return url ? { kind: "url", url, name: trimOrUndef(name) } : null;
  }
  if (!req || typeof req !== "object") { return null; }
  const kind: SidebarOpenKind =
    req.kind === "terminal" || req.kind === "files" ? req.kind : "url";
  const nm = trimOrUndef(req.name) ?? trimOrUndef(name);
  

  const sid = trimOrUndef(req.sessionId);
  if (kind === "terminal") {
    return { kind, cmd: trimOrUndef(req.cmd), name: nm, sessionId: sid };
  }
  if (kind === "files") {
    return { kind, root: trimOrUndef(req.root), rel: trimOrUndef(req.rel), name: nm, sessionId: sid };
  }
  const url = trimOrUndef(req.url);
  return url ? { kind: "url", url, name: nm, from: req.from, sessionId: sid } : null;
}












export function sessionIdFromArgs(args: Record<string, unknown>): string | undefined {
  const s = String(args.sessionId ?? "").trim();
  return s.length > 0 ? s : undefined;
}














export function sidebarOpenMatchesSession(reqSid?: string, curSid?: string): boolean {
  const r = typeof reqSid === "string" ? reqSid.trim() : "";
  if (!r) { return true; }              
  const c = typeof curSid === "string" ? curSid.trim() : "";
  if (!c) { return false; }             
  return r === c;                        
}







export function fireSidebarOpen(req: string | SidebarOpenRequest, name?: string): boolean {
  if (!sidebarOpenerRef) { return false; }
  const normalized = normalizeSidebarOpenRequest(req, name);
  if (!normalized) { return false; }
  try {
    sidebarOpenerRef(normalized);
    return true;
  } catch {
    return false;
  }
}
