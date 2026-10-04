
















import type { ApiFormat } from "./router.js";
import { LiveProbeCache, getSharedLiveProbe } from "./probe-live.js";
import { inferModelCapabilities, ThinkingParam, Endpoint } from "shared/model-capabilities";


export type NodeHealth = "ok" | "degraded" | "dead" | "unknown";


export interface GraphNode {
  provider: string;
  model: string;
  
  vendor?: string;
  
  endpoint: ApiFormat;
  
  thinking: { supported: boolean; param?: ThinkingParam; efforts?: string[] };
  
  context?: number;
  
  maxOut?: number;
  
  live?: {
    latencyMs?: number;
    contextWindow?: number;
    toolCalls?: boolean;
    reasoning?: boolean;
    lastErrorType?: string;
    modelDead?: boolean;
    ts?: number;
  };
  
  health: NodeHealth;
  
  notes: string[];
}


export interface GraphStatics {
  capsFor: (modelId: string) => {
    supported: boolean;
    efforts?: string[];
    vendor?: string;
    thinkingParam?: ThinkingParam;
    endpoint?: Endpoint;
    context?: number;
    maxOut?: number;
  };
}

export class CapabilityGraph {
  private statics: GraphStatics;
  private live: LiveProbeCache;

  constructor(opts?: { statics?: GraphStatics; live?: LiveProbeCache }) {
    this.statics = opts?.statics ?? { capsFor: (id) => inferModelCapabilities(id) };
    
    this.live = opts?.live ?? getSharedLiveProbe();
  }

  
  setLiveCache(cache: LiveProbeCache): void {
    this.live = cache;
  }

  
  resolve(provider: string, model: string, apiFormatOverride?: ApiFormat): GraphNode {
    const caps = this.statics.capsFor(model);
    const snap = this.live.get(provider, model) ?? null;

    
    let health: NodeHealth;
    if (snap?.modelDead === true) { health = "dead"; }
    else if (snap?.lastErrorType) { health = "degraded"; }
    else if (snap) { health = "ok"; }
    else { health = "unknown"; }

    
    const context = snap?.contextWindow ?? caps.context;

    const notes: string[] = [];
    notes.push(
      `端点=${apiFormatOverride ?? caps.endpoint ?? "openai"}` +
      (caps.vendor && caps.vendor !== "unknown" ? `；家族=${caps.vendor}` : "") +
      (caps.supported ? `；思考=${caps.thinkingParam ?? "reasoning_effort"}` : "；不支持思考"),
    );
    if (snap) {
      const bits: string[] = [];
      if (snap.latencyMs !== undefined) { bits.push(`实测延迟=${snap.latencyMs}ms`); }
      if (snap.toolCalls) { bits.push("支持工具调用"); }
      if (snap.reasoning) { bits.push("实测有思考输出"); }
      if (snap.contextWindow) { bits.push(`实测上下文≈${snap.contextWindow}`); }
      if (health === "dead") { bits.push(`已判失效（${snap.lastErrorType ?? "modelDead"}），引擎将剔除`); }
      else if (health === "degraded") { bits.push(`最近失败（${snap.lastErrorType}），降级候选`); }
      if (bits.length > 0) { notes.push(`实时层：${bits.join("；")}`); }
    } else {
      notes.push("实时层：无新鲜快照（TTL 过期或缺失），下轮转发自动重探");
    }

    return {
      provider,
      model,
      vendor: caps.vendor,
      endpoint: apiFormatOverride ?? caps.endpoint ?? "openai",
      thinking: {
        supported: caps.supported,
        param: caps.thinkingParam,
        efforts: caps.efforts ? [...caps.efforts] : undefined,
      },
      context,
      maxOut: caps.maxOut,
      live: snap ? {
        latencyMs: snap.latencyMs,
        contextWindow: snap.contextWindow,
        toolCalls: snap.toolCalls,
        reasoning: snap.reasoning,
        lastErrorType: snap.lastErrorType,
        modelDead: snap.modelDead,
        ts: snap.ts,
      } : undefined,
      health,
      notes,
    };
  }

  

  liveDead(provider: string, model: string): boolean {
    return this.live.isDead(provider, model);
  }

  




  rank(provider: string, models: string[], apiFormatOverride?: ApiFormat): string[] {
    const RANK: Record<NodeHealth, number> = { ok: 0, unknown: 1, degraded: 2, dead: 3 };
    return [...models].sort((a, b) => {
      const na = this.resolve(provider, a, apiFormatOverride);
      const nb = this.resolve(provider, b, apiFormatOverride);
      const dr = RANK[na.health] - RANK[nb.health];
      if (dr !== 0) { return dr; }
      
      if (na.health === "ok" && nb.health === "ok") {
        const la = na.live?.latencyMs ?? Number.POSITIVE_INFINITY;
        const lb = nb.live?.latencyMs ?? Number.POSITIVE_INFINITY;
        return la - lb;
      }
      return 0;
    });
  }

  
  explain(node: GraphNode): string {
    const live = node.live
      ? `；实时：${node.notes.find((n) => n.startsWith("实时层")) ?? "无"}`
      : "；实时：无快照（待重探）";
    const base = node.notes[0] ?? "";
    return `${node.provider}:${node.model} [${node.health}] ${base}${live}`;
  }
}


let sharedGraph: CapabilityGraph | null = null;


export function getSharedCapabilityGraph(): CapabilityGraph {
  if (!sharedGraph) { sharedGraph = new CapabilityGraph(); }
  return sharedGraph;
}


export function setSharedCapabilityGraph(graph: CapabilityGraph | null): void {
  sharedGraph = graph;
}
