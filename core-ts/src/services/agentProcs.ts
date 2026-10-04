















































export type AgentProcKind = "screen-host" | "http-server";


export const AGENT_PROC_KINDS: readonly AgentProcKind[] = ["screen-host", "http-server"];


export const AGENT_PROC_KIND_LABELS: Record<AgentProcKind, string> = {
  "screen-host": "图形控制宿主",
  "http-server": "本地服务",
};








export function isAgentStartedKind(kind: string): kind is AgentProcKind {
  return (AGENT_PROC_KINDS as readonly string[]).includes(kind);
}


export interface ScreenHostSource {
  
  pid?: number;
  
  startedAt: number;
}
export interface HttpServerSource {
  id: string;
  port: number;
  host?: string;
  dir: string;
  startedAt: number;
  
  requests?: number;
  
















  origin?: "agent" | "restored" | "builtin";
}
export interface AgentProcSources {
  
  screenHost?: ScreenHostSource | null;
  httpServers?: readonly HttpServerSource[];
}


export interface AgentProcEntry {
  kind: AgentProcKind;
  
  id: string;
  
  kindLabel: string;
  
  label: string;
  
  detail: string;
  
  startedAt?: number;
  
  elapsed: string;
  
  status: string;
}

export interface AgentProcView {
  
  count: number;
  
  any: boolean;
  entries: AgentProcEntry[];
}



export function formatElapsed(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(now)) { return ""; }
  const ms = now - startedAt;
  if (ms < 1000) { return "刚刚"; }
  const sec = Math.floor(ms / 1000);
  if (sec < 60) { return `${sec} 秒`; }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const rest = sec % 60;
    return rest === 0 ? `${min} 分` : `${min} 分 ${rest} 秒`;
  }
  const hr = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin === 0 ? `${hr} 小时` : `${hr} 小时 ${restMin} 分`;
}


function shortenPath(p: string, max = 46): string {
  if (p.length <= max) { return p; }
  const keep = max - 1;
  const head = Math.ceil(keep / 3);
  const tail = keep - head;
  return `${p.slice(0, head)}…${p.slice(p.length - tail)}`;
}






export function buildAgentProcView(src: AgentProcSources, now: number): AgentProcView {
  const entries: AgentProcEntry[] = [];

  const host = src.screenHost;
  if (host) {
    entries.push({
      kind: "screen-host",
      id: "",
      kindLabel: AGENT_PROC_KIND_LABELS["screen-host"],
      label: "PowerShell 图形控制宿主",
      detail: host.pid !== undefined ? `pid ${host.pid}` : "常驻进程中",
      startedAt: host.startedAt,
      elapsed: formatElapsed(host.startedAt, now),
      status: "常驻",
    });
  }

  for (const s of src.httpServers ?? []) {
    














    if (s.origin !== undefined && s.origin !== "agent") { continue; }
    entries.push({
      kind: "http-server",
      id: s.id,
      kindLabel: AGENT_PROC_KIND_LABELS["http-server"],
      label: `127.0.0.1:${s.port}${s.host && s.host !== "127.0.0.1" ? `（${s.host}）` : ""}`,
      detail: shortenPath(s.dir) + (typeof s.requests === "number" ? `  ·  ${s.requests} 次请求` : ""),
      startedAt: s.startedAt,
      elapsed: formatElapsed(s.startedAt, now),
      status: "监听中",
    });
  }

  const rank = (k: AgentProcKind): number => AGENT_PROC_KINDS.indexOf(k);
  entries.sort((x, y) => {
    const d = rank(x.kind) - rank(y.kind);
    if (d !== 0) { return d; }
    return (x.startedAt ?? 0) - (y.startedAt ?? 0);
  });

  return { count: entries.length, any: entries.length > 0, entries };
}


export type AgentProcStopAction = "dispose-screen-host" | "stop-http-server";


export const AGENT_PROC_STOP_ACTIONS: Record<AgentProcKind, AgentProcStopAction> = {
  "screen-host": "dispose-screen-host",
  "http-server": "stop-http-server",
};

export interface AgentProcStopRequest { kind: string; id?: string }
export type AgentProcStopPlan =
  | { ok: true; action: AgentProcStopAction; id: string }
  | { ok: false; reason: string };










export function planAgentProcStop(req: AgentProcStopRequest): AgentProcStopPlan {
  const kind = req?.kind;
  if (!isAgentStartedKind(kind)) {
    return { ok: false, reason: `未知的后台资源类别：${String(kind ?? "(空)")}` };
  }
  if (kind === "screen-host") {
    return { ok: true, action: AGENT_PROC_STOP_ACTIONS[kind], id: "" };
  }
  const id = typeof req.id === "string" ? req.id.trim() : "";
  if (!id) {
    return { ok: false, reason: `${AGENT_PROC_KIND_LABELS[kind]}缺少 id（无法确定要停哪一个）` };
  }
  return { ok: true, action: AGENT_PROC_STOP_ACTIONS[kind], id };
}
