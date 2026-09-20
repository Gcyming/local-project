/**
 * core-ts/src/probe-graph.ts — 探针层第 3 层：能力知识图谱（统一查询收口，纯逻辑可注入）。
 *
 * 定位（对齐用户诉求："最大程度拓展 slime 对所有模型的适配性"）：
 * 把三层知识融成一张可查询的图——
 *   ① 静态能力表（shared/model-capabilities：33 家族协议/端点/思考参数/上下文兜底，唯一真相源）
 *   ② 第 1 层厂商指纹（probe.ts 的 VendorKind，按 baseUrl 归类）
 *   ③ 第 2 层实时快照（LiveProbeCache：实测延迟/工具/reasoning/失效标志，网关转发后刷新）
 * 引擎选模型、UI 展示模型健康态、网关诊断面板，全部从这里读，不再散落启发式。
 *
 * 设计原则：
 * - 纯逻辑、无 IO、无网络：静态层/实时层均以「函数/缓存」注入，缺省挂全局单例，便于单测 mock。
 * - 融合优先级：**实时 > 静态**（实测的 context/失效位覆盖静态兜底），静态是离线底线（上游拉不到也能用）。
 * - health 四态：ok（有新鲜成功快照）/ degraded（有新鲜错误快照但未判死）/ dead（modelDead，应剔除）
 *   / unknown（无新鲜快照，TTL 过期或缺失 → 需重探）。
 */

import type { ApiFormat } from "./router.js";
import { LiveProbeCache, getSharedLiveProbe } from "./probe-live.js";
import { inferModelCapabilities, ThinkingParam, Endpoint } from "shared/model-capabilities";

/** 图谱节点健康态（实时层决定；unknown = 快照过期/缺失，该重探） */
export type NodeHealth = "ok" | "degraded" | "dead" | "unknown";

/** 图谱节点（三层融合后的单一视图——引擎/UI/网关诊断面板的统一读表结果） */
export interface GraphNode {
  provider: string;
  model: string;
  /** 静态层：模型家族（model-capabilities 的 vendor，如 openai/claude/qwen） */
  vendor?: string;
  /** 端点格式（路由显式覆盖 > 静态层 endpoint > 缺省 openai） */
  endpoint: ApiFormat;
  /** 静态层：思考能力（支持位 + 协议 + 等级） */
  thinking: { supported: boolean; param?: ThinkingParam; efforts?: string[] };
  /** 上下文窗口（实时实测 contextWindow > 静态兜底 context） */
  context?: number;
  /** 最大输出（静态层兜底；实时层暂无输出位） */
  maxOut?: number;
  /** 实时层：最近一次成功转发的实测位（无新鲜快照时 undefined） */
  live?: {
    latencyMs?: number;
    contextWindow?: number;
    toolCalls?: boolean;
    reasoning?: boolean;
    lastErrorType?: string;
    modelDead?: boolean;
    ts?: number;
  };
  /** 融合后的健康态（见 NodeHealth 注释） */
  health: NodeHealth;
  /** 人类可读融合信号（explain 的展开形式，UI 直接展示） */
  notes: string[];
}

/** 静态能力层注入口（缺省 = shared/model-capabilities 的 inferModelCapabilities 单一真相源） */
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
    // 缺省挂进程级共享实时缓存（网关写、引擎读同一份；测试可注入独立实例隔离）
    this.live = opts?.live ?? getSharedLiveProbe();
  }

  /** 实时层换绑（测试/自定义 TTL 场景） */
  setLiveCache(cache: LiveProbeCache): void {
    this.live = cache;
  }

  /** 三层融合出一个模型的统一节点。apiFormatOverride = 路由显式配置的端点（优先于静态层）。 */
  resolve(provider: string, model: string, apiFormatOverride?: ApiFormat): GraphNode {
    const caps = this.statics.capsFor(model);
    const snap = this.live.get(provider, model) ?? null;

    // health 判定（实时层驱动；无新鲜快照 → unknown，由引擎/网关下轮重探）
    let health: NodeHealth;
    if (snap?.modelDead === true) { health = "dead"; }
    else if (snap?.lastErrorType) { health = "degraded"; }
    else if (snap) { health = "ok"; }
    else { health = "unknown"; }

    // 上下文融合：实时实测（prompt_tokens×2 估算）> 静态兜底
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

  /** 该 provider:model 是否被实时层判定为模型级失效（未过期 + modelDead=true）。
   *  引擎前置剔除 / UI 灰显失效模型直接查这个，比 resolve().health 更省一次融合。 */
  liveDead(provider: string, model: string): boolean {
    return this.live.isDead(provider, model);
  }

  /**
   * 候选模型推荐排序（引擎选模型 / UI "推荐" 排序用）：
   * ok（按实测延迟升序，无延迟排最后）→ unknown → degraded → dead（彻底垫底）。
   * 返回重排后的模型名数组（不剔除任何模型——剔除是 router 前置钩子的职责，这里只排序）。
   */
  rank(provider: string, models: string[], apiFormatOverride?: ApiFormat): string[] {
    const RANK: Record<NodeHealth, number> = { ok: 0, unknown: 1, degraded: 2, dead: 3 };
    return [...models].sort((a, b) => {
      const na = this.resolve(provider, a, apiFormatOverride);
      const nb = this.resolve(provider, b, apiFormatOverride);
      const dr = RANK[na.health] - RANK[nb.health];
      if (dr !== 0) { return dr; }
      // 同档：ok 档按实测延迟升序（无实测的排最后）；其余档保持原相对顺序
      if (na.health === "ok" && nb.health === "ok") {
        const la = na.live?.latencyMs ?? Number.POSITIVE_INFINITY;
        const lb = nb.live?.latencyMs ?? Number.POSITIVE_INFINITY;
        return la - lb;
      }
      return 0;
    });
  }

  /** 单行人类可读解释（日志/状态面板/诊断接口用） */
  explain(node: GraphNode): string {
    const live = node.live
      ? `；实时：${node.notes.find((n) => n.startsWith("实时层")) ?? "无"}`
      : "；实时：无快照（待重探）";
    const base = node.notes[0] ?? "";
    return `${node.provider}:${node.model} [${node.health}] ${base}${live}`;
  }
}

// ── 进程级共享单例（与 LiveProbeCache 单例同源：网关/引擎/UI 读同一张图）────────────
let sharedGraph: CapabilityGraph | null = null;

/** 获取（必要时创建）进程级共享能力图谱。缺省：静态=官方能力表，实时=共享 LiveProbeCache。 */
export function getSharedCapabilityGraph(): CapabilityGraph {
  if (!sharedGraph) { sharedGraph = new CapabilityGraph(); }
  return sharedGraph;
}

/** 注入/复位共享图谱（测试隔离用） */
export function setSharedCapabilityGraph(graph: CapabilityGraph | null): void {
  sharedGraph = graph;
}
