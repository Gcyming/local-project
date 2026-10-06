










import { ModelRouter, RouteEntry, providerKeyOfRoute, type ClientFactory, type ApiFormat } from "../router.js";
import { ChatClient } from "../llm/client.js";
import { getSharedRpmLimiter } from "../llm/rpmLimiter.js";
import { ChatMessage, ChatRequest } from "shared/schemas";
import { inferModelCapabilities, resolveEffectivePricing, isAggregatorGateway } from "shared/model-capabilities";
import { getSharedCapabilityGraph } from "../probe-graph.js";
import { OutputFilter, StreamFilter } from "../filter.js";
import { ToolLoop, sandboxGateFrom, type AskUserHook } from "../tool_loop.js";
import { ToolRegistry, getRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/builtin.js";
import { SandboxManager } from "../sandbox.js";

import { readTodos, planReminderText } from "./todoStore.js";

import { foldUserReminder } from "../llm/userReminder.js";

import { takeUpstreamNotice } from "../llm/upstreamNotice.js";
import { AgentRegistry, AgentState } from "./agents.js";

import { DELEGATION_GUIDANCE } from "./subagentCatalog.js";
import {
  ChatEngine,
  ChatEngineCall,
  ChatEngineResult,
  EngineChunk,
  ContextBuckets,
} from "./chat.js";
import { IDENTITY_CONSTRAINT, HONESTY_PROTOCOL, InjectionHooks, NOOP_HOOKS, foldStateSegment, joinSystemSegments, type SystemSegments } from "../session.js";
import { recallGateDecision } from "../memory/recall_gate.js";
import { decrypt } from "../encryption.js";
import { getModelServer } from "../model_server.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import { loadSlimeMemories, type SilamAffectState, type SilamBrain, type SilamReplyResult } from "./silam_brain.js";



import { findLocalModelSpec, type LocalModelSpec } from "../local_models.js";




import { readFallbackPool, resolveFallbackTargets, type FallbackPoolConfig } from "./fallbackPool.js";
import { appendUsage, computeRecordCost, defaultCacheReadInPrompt } from "./usage.js";
import { buildCompressSummaryPrompt, buildSummaryInput, clipToTokenBudget, estimateHistoryTokens, estimateTokensLocal, fitSummaryPrior, summaryPromptScaffoldTokens, SUMMARIZE_INPUT_CAP, SUMMARIZE_OUTPUT_CAP, summarizeOutputCap } from "./context_compress.js";


import { buildResumeBlock, parseComprehend, planEngineSend, LOCAL_PREFLIGHT_MARKER, type EngineSendGuard } from "./context_loop.js";

export interface ProviderConfig {
  api_base: string;
  api_key: string;
  model: string;
  
  api_format?: ApiFormat;
  
  models?: Array<{ id?: unknown; selected?: unknown; api_format?: unknown; rpm?: unknown; [k: string]: unknown }>;
  




  rpm?: number;
  [key: string]: unknown;
}


const MODEL_POOL_MAX = 8;





export interface SlimeEngineOptions {
  registry: AgentRegistry;
  
  providers?: Record<string, ProviderConfig>;
  



  fallbackPool?: FallbackPoolConfig;
  
  fallbackPoolRoot?: string;
  hooks?: InjectionHooks;
  tools?: ToolRegistry;
  sandbox?: SandboxManager;
  
  clientFactory?: ClientFactory;
  
  defaultReply?: (agent: AgentState) => string;
  logger?: Pick<Console, "warn" | "info" | "debug">;
  
  onAskUser?: AskUserHook;
  
  silamBrain?: SilamBrain | null;
  
  silamMemoryLoader?: (agentId: string) => Promise<string[]>;
  
  silamPersistRoot?: string;
  


  onSilamEvolve?: (agentId: string, state: SilamAffectState) => void;
}

function defaultReplyText(agent: AgentState): string {
  return (
    `你好，我是 ${agent.name}，${agent.role}。\n\n` +
    `当前未配置 API Provider，请先通过 CLI 向导或 API 配置模型服务。\n` +
    `使用 \`py slime_cli.py wizard\` 或 \`POST /providers\` 添加 Provider。`
  );
}


export function estimateTokens(text: string): number {
  return Math.round(text.length * 0.6);
}


function tok(text: string): number {
  return text ? estimateTokens(text) : 0;
}


export function computeContextBuckets(parts: Partial<Record<keyof ContextBuckets, string | null | undefined>>): ContextBuckets {
  return {
    system: tok(parts.system ?? ""),
    rules: tok(parts.rules ?? ""),
    memory: tok(parts.memory ?? ""),
    workspace: tok(parts.workspace ?? ""),
    planning: tok(parts.planning ?? ""),
    tools: tok(parts.tools ?? ""),
    history: tok(parts.history ?? ""),
    message: tok(parts.message ?? ""),
  };
}









function effectiveMaxTokens(agent: AgentState, requested?: number): number | undefined {
  const isThinking =
    !!(agent.reasoning_effort && agent.reasoning_effort !== "none") ||
    /reason|thinking|r1|qwen3|deepseek/i.test(`${agent.model_choice ?? ""}`);
  const model = `${agent.model_choice ?? ""}`.toLowerCase();
  
  
  const cap = model.includes("agnes") ? 65000 : undefined;
  let value = requested;
  if (isThinking) { value = Math.max(requested ?? 0, 16384); }
  if (cap !== undefined && value !== undefined) { value = Math.min(value, cap); }
  return value;
}


function withModel(payload: ChatRequest, route: RouteEntry): ChatRequest {
  if (payload.model || !route.model) {
    return payload;
  }
  return { ...payload, model: route.model };
}


const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   
const MAX_IMAGES_PER_REQUEST = 4;          











export function isChatCapableModel(id: string): boolean {
  const s = (id ?? "").toLowerCase();
  if (!s) { return false; }
  
  const NON_CHAT = /(^|[-_/])(image|img|video|tts|speech|audio|whisper|asr|voice|rerank(?:er)?|embed(?:ding)?|ocr|moderation|dall-e|dalle|stable-diffusion|flux|sora|midjourney|mj|bge|gte|m3e|e5|voyage)([-_/]|$)/;
  if (NON_CHAT.test(s)) { return false; }
  
  if (/-(image|video|audio|tts|embedding)s?-\d/.test(s)) { return false; }
  return true;
}


export function sanitizeImages(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.startsWith("data:image/")) {
      continue;
    }
    const comma = item.indexOf(",");
    if (comma < 0) {
      continue;
    }
    const payload = item.slice(comma + 1);
    if (!payload) {
      continue;
    }
    const approxBytes = Math.floor((payload.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      continue;
    }
    out.push(item);
    if (out.length >= MAX_IMAGES_PER_REQUEST) {
      break;
    }
  }
  return out;
}


export interface SilamPersistOptions {
  
  root?: string;
  
  minChange?: number;
  
  minIntervalMs?: number;
  
  now?: number;
}








export function persistSilamAffect(
  agentId: string,
  state: SilamAffectState,
  opts: SilamPersistOptions = {},
): boolean {
  try {
    const root = opts.root ?? PROJECT_ROOT;
    const dir = resolve(root, "Knowledge", "Agent Memory", agentId);
    const p = resolve(dir, "silam.json");
    const now = opts.now ?? Date.now();
    if (existsSync(p)) {
      try {
        const prev = JSON.parse(readFileSync(p, "utf8")) as {
          fear?: number; desire?: number; n_nodes?: number; step?: number; updated_at?: number;
        };
        const minChange = opts.minChange ?? 0.2;
        const changed =
          Math.abs((prev.fear ?? 0) - state.fear) >= minChange ||
          Math.abs((prev.desire ?? 0) - state.desire) >= minChange ||
          (prev.n_nodes ?? -1) !== state.n_nodes ||
          (prev.step ?? -1) !== state.step;
        const fresh = now - (prev.updated_at ?? 0) < (opts.minIntervalMs ?? 5 * 60 * 1000);
        if (fresh && !changed) {
          return false; 
        }
      } catch {
        
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        {
          fear: state.fear,
          desire: state.desire,
          n_nodes: state.n_nodes,
          step: state.step,
          lang_loaded: state.langLoaded,
          updated_at: now,
          content: `SILAM 成长快照：恐惧 ${state.fear.toFixed(2)}，渴望 ${state.desire.toFixed(2)}，成长树节点 ${state.n_nodes}，步数 ${state.step}。`,
        },
        null,
        2,
      ),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}





export function buildSilamTraitSignals(state: SilamAffectState): Array<{ name: string; signal: number }> {
  const out: Array<{ name: string; signal: number }> = [];
  const { fear, desire } = state;
  if (fear >= 0.6) {
    out.push({ name: "谨慎", signal: 1 });
  } else if (fear <= 0.2) {
    out.push({ name: "谨慎", signal: -1 });
  }
  if (desire >= 0.6) {
    out.push({ name: "进取", signal: 1 });
  } else if (desire <= 0.2) {
    out.push({ name: "进取", signal: -1 });
  }
  return out;
}

export class SlimeEngine implements ChatEngine {
  private registry: AgentRegistry;
  private providers: Record<string, ProviderConfig>;
  
  private fallbackPoolOverride: FallbackPoolConfig | undefined;
  
  private fallbackPoolRoot: string | undefined;
  private hooks: InjectionHooks;
  private tools: ToolRegistry;
  private sandbox: SandboxManager | null;
  private clientFactory: ClientFactory;
  private defaultReply: (agent: AgentState) => string;
  private logger: Pick<Console, "warn" | "info" | "debug">;
  private onAskUser: AskUserHook | undefined;
  private silamBrain: SilamBrain | null;
  
  private silamMemoryLoader: ((agentId: string) => Promise<string[]>) | undefined;
  
  private silamPersistRoot: string | undefined;
  
  private onSilamEvolve: ((agentId: string, state: SilamAffectState) => void) | undefined;

  
  get providersCount(): number {
    return Object.keys(this.providers).length;
  }

  
  get providerKeys(): string[] {
    return Object.keys(this.providers);
  }

  
  public refreshProviders(opts: { projectRoot?: string; passFile?: string } = {}): void {
    this.providers = (decrypt("config/providers.enc.json", { projectRoot: opts.projectRoot, passFile: opts.passFile }) ?? {}) as Record<string, ProviderConfig>;
  }

  






  private currentFallbackPool(): FallbackPoolConfig {
    return this.fallbackPoolOverride ?? readFallbackPool(this.fallbackPoolRoot ?? PROJECT_ROOT);
  }

  














  private bindManualRpm(): void {
    const norm = (u: string | undefined): string => {
      const s = (u ?? "").trim().replace(/\/+$/, "");
      return s.endsWith("/v1") ? s.slice(0, -3) : s;
    };
    
    const byBase = new Map<string, { key: string; cfg: ProviderConfig }>();
    for (const [k, c] of Object.entries(this.providers)) {
      const b = norm(c?.api_base);
      if (b) { byBase.set(b, { key: k, cfg: c }); }
    }
    getSharedRpmLimiter().setManualRpmOf((key, model) => {
      const hit = byBase.get(norm(key));
      if (!hit) { return null; }
      
      const models = Array.isArray(hit.cfg.models) ? hit.cfg.models : [];
      const m = model ? models.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === model) : undefined;
      const fromModel = m && typeof m === "object" ? (m as { rpm?: unknown }).rpm : undefined;
      const fromVendor = (hit.cfg as { rpm?: unknown }).rpm;
      const raw = fromModel ?? fromVendor;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    });
  }

  
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  
  get sandboxManager(): SandboxManager | null {
    return this.sandbox;
  }

  constructor(opts: SlimeEngineOptions) {
    this.registry = opts.registry;
    this.providers = opts.providers ?? ((decrypt() ?? {}) as Record<string, ProviderConfig>);
    
    this.fallbackPoolOverride = opts.fallbackPool;
    this.fallbackPoolRoot = opts.fallbackPoolRoot;
    this.hooks = opts.hooks ?? NOOP_HOOKS;
    this.tools = opts.tools ?? getRegistry();
    this.sandbox = opts.sandbox ?? null;
    // 默认工厂必须带上 rateLimit：不带就等于**默认路径完全绕过 RPM 限流器**
    // （fetchWithRetry 里`if (rateLimit)` 才acquire），并发一上来就是硬打上游，
    // 很容易撞限流甚至被风控判定为滥用。key与 createRouteClient 保持同一口径。
    this.clientFactory =
      opts.clientFactory ?? ((route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        timeoutMs: route.timeoutMs,
        rateLimit: { key: providerKeyOfRoute(route), model: route.model },
      }));
    this.defaultReply = opts.defaultReply ?? defaultReplyText;
    this.logger = opts.logger ?? console;
    this.onAskUser = opts.onAskUser;
    this.silamBrain = opts.silamBrain ?? null;
    
    this.silamMemoryLoader = opts.silamMemoryLoader;
    
    this.silamPersistRoot = opts.silamPersistRoot;
    
    this.onSilamEvolve = opts.onSilamEvolve;
    registerBuiltinTools(this.tools);
  }

  
  private readonly silamAffect = new Map<string, SilamAffectState>();

  
  getSilamAffect(agentId: string): SilamAffectState | undefined {
    return this.silamAffect.get(agentId);
  }

  


















  private recordUsage(opts: ChatEngineCall, route: RouteEntry | undefined, payload: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    
    cacheReadInPrompt?: boolean;
    elapsedMs: number;
    success: boolean;
    error?: string;
  }): void {
    const modelId = route?.model;
    
    if (!modelId || modelId === "none" || modelId === "silam" || modelId === "silam-brain") { return; }
    const providerKey = route?.name?.split(":")[0] ?? "unknown";
    const cfg = this.providers[providerKey];
    const rawSpec = cfg?.models?.find((m) => m?.id === modelId);
    const spec = rawSpec as {
      price_in_usd?: number; price_out_usd?: number;
      price_cache_read_usd?: number; price_cache_write_usd?: number;
      price_source?: string;
      








      price_tiers?: import("shared/model-capabilities").ModelPriceTiers;
    } | undefined;
    
    
    const at = new Date();
    const ts = at.toISOString();
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const eff = resolveEffectivePricing(modelId, route?.baseUrl ?? "", spec, at);
    const priceIn = eff.priceIn;
    const priceOut = eff.priceOut;
    const priceCacheRead = eff.priceCacheRead;
    const priceCacheWrite = eff.priceCacheWrite;
    
    const cacheReadInPrompt = payload.cacheReadInPrompt
      ?? defaultCacheReadInPrompt(providerKey, modelId);
    const cost = computeRecordCost(
      payload.promptTokens, payload.completionTokens, payload.reasoningTokens,
      payload.cacheReadTokens, payload.cacheCreationTokens,
      priceIn, priceOut, priceCacheRead, priceCacheWrite,
      cacheReadInPrompt,
    );
    void appendUsage({
      ts,
      agent_id: opts.agent.id,
      session_id: opts.sessionId ?? "default",
      model: modelId,
      provider_key: providerKey,
      prompt_tokens: payload.promptTokens,
      completion_tokens: payload.completionTokens,
      reasoning_tokens: payload.reasoningTokens,
      cache_read_tokens: payload.cacheReadTokens,
      cache_creation_tokens: payload.cacheCreationTokens,
      cache_read_in_prompt: cacheReadInPrompt,
      
      price_tier: eff.tiered ? eff.tierId : undefined,
      elapsed_ms: payload.elapsedMs,
      cost_usd: cost,
      success: payload.success,
      error: payload.error,
    }).catch(() => {  });
  }

  
  private async refreshSilamAffect(agentId: string): Promise<void> {
    try {
      const st = await this.silamBrain?.getState?.();
      if (st) {
        this.silamAffect.set(agentId, st);
        
        persistSilamAffect(agentId, st, this.silamPersistRoot ? { root: this.silamPersistRoot } : {});
        
        try {
          this.onSilamEvolve?.(agentId, st);
        } catch {
          
        }
      }
    } catch {
      
    }
  }

  






  private fallbackNotice(agent: AgentState, error: string | null): string {
    return `⚠️ 选中的模型「${agent.model_choice || "(空)"}」不可用，本轮由 SILAM 离线大脑兜底应答。\n原因：${error ?? "无可用路由"}`;
  }

  

  private async silamReply(opts: ChatEngineCall): Promise<SilamReplyResult | null> {
    if (!this.silamBrain?.enabled) {
      return null;
    }
    const history = (opts.history ?? [])
      .slice(-8)
      .map((m) => ({
        role: String(m.role ?? ""),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      }));
    let slimeMemory: string[] | undefined;
    try {
      
      const mem = this.silamMemoryLoader
        ? await this.silamMemoryLoader(opts.agent.id)
        : await loadSlimeMemories(opts.agent.id, 6);
      if (mem.length > 0) {
        slimeMemory = mem;
      }
    } catch {
      
    }
    try {
      const result = await this.silamBrain.reply({
        agentName: opts.agent.name,
        agentRole: opts.agent.role,
        userMessage: opts.message,
        history,
        slimeMemory,
      });
      
      void this.refreshSilamAffect(opts.agent.id);
      return result;
    } catch (e) {
      this.logger.warn(`[engine] SILAM 大脑兑底异常（降级默认提示）: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  
  private wantsSilam(agent: AgentState): boolean {
    return agent.model_choice === "silam" || agent.model_choice.startsWith("silam:");
  }

  
  private silamUnavailableText(agent: AgentState): string {
    return (
      `你好，我是 ${agent.name}，${agent.role}。\n\n` +
      `已选择 SILAM 离线大脑，但它当前不可用。请检查：\n` +
      `- slime.toml [silam] 需 enabled=true 且 as_brain=true\n` +
      `- 兑底 sidecar 是否存在（sidecar/silam_brain_sidecar.py，自动发现情感脑 80M 与语言脑 d16）`
    );
  }

  



  private observeTutorDemo(opts: ChatEngineCall, reply: string): void {
    try {
      if (reply && reply.trim()) {
        this.silamBrain?.observe?.(opts.message, reply);
      }
    } catch (e) {
      this.logger.warn(
        `[engine] 观战辅导员示范失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  
  public async resolveProviderKey(agent: AgentState): Promise<string | null> {
    let current = agent;
    const visited = new Set<string>([agent.id]);
    while (current) {
      if (current.model_choice.startsWith("api:")) {
        
        const rest = current.model_choice.slice(4);
        const sep = rest.indexOf(":");
        return sep >= 0 ? rest.slice(0, sep) : rest;
      }
      if (current.parent_id && !visited.has(current.parent_id)) {
        visited.add(current.parent_id);
        const parent = await this.registry.findAgent(current.parent_id);
        if (!parent) {
          break;
        }
        current = parent;
      } else {
        break;
      }
    }
    return null;
  }

  

  private findLocalModel(id: string): LocalModelSpec | undefined {
    return findLocalModelSpec(this.providers as unknown as Record<string, unknown>, id);
  }

  
  private async ensureLocalModel(id: string, signal?: AbortSignal): Promise<
    { ok: true; port: number; state: string } | { ok: false; error: string }
  > {
    const spec = this.findLocalModel(id);
    if (!spec) {
      return { ok: false, error: `本地模型「${id}」未注册。请在 设置 → 模型供应商 → 本地模型 中添加一个有效的 .gguf 模型。` };
    }
    if (!spec.path || !existsSync(spec.path)) {
      return { ok: false, error: `本地模型「${id}」的模型文件不存在（${spec.path ?? "路径为空"}）。请重新添加该模型或检查文件是否被移动/删除。` };
    }
    const mgr = getModelServer();
    if (!mgr) {
      return { ok: false, error: `本地模型启动器（llama-server）未初始化。请在 设置 → 心智中枢 → 依赖 中配置并定位 llama-server.exe。` };
    }
    const result = await mgr.ensure("chat", spec.path, id, {
      gpuLayers: spec.gpu_layers,
      ctxLen: spec.ctx_len,
      signal,
    });
    if (!result.ok || !result.port) {
      return { ok: false, error: `本地模型「${id}」加载失败：${result.error ?? "未知原因（llama-server 未在超时内就绪）"}。若为新下载的模型，请确认 .gguf 文件完整未损坏。` };
    }
    return { ok: true, port: result.port, state: result.state ?? "ready" };
  }

  
  private async resolveRouteInternal(agent: AgentState, signal?: AbortSignal): Promise<{ router: ModelRouter | null; error: string | null }> {
    const header = `你好，我是 ${agent.name}，${agent.role}。\n\n`;

    
    
    
    
    
    this.bindManualRpm();

    if (agent.model_choice.startsWith("api:")) {
      
      const rest = agent.model_choice.slice(4);
      const sep = rest.indexOf(":");
      const key = sep >= 0 ? rest.slice(0, sep) : rest;
      const explicitModel = sep >= 0 ? rest.slice(sep + 1).trim() : "";
      const cfg = this.providers[key];
      if (!cfg) {
        return { router: null, error: `${header}未找到已配置的 Provider「${key}」。请到 设置 → 模型供应商 添加/核对该 API（Agent 的模型字段须为 api:<与配置一致的名称>）。` };
      }

      
      
      
      
      
      
      const base = (cfg.api_base ?? "").replace(/\/+$/, "");
      
      
      
      
      
      const primaryBase = base.endsWith("/v1") ? base.slice(0, -3) : base;

      const enabledOf = (c: ProviderConfig): string[] => {
        const out: string[] = [];
        const raw = Array.isArray(c.models) ? c.models : [];
        for (const m of raw) {
          const id = m?.id;
          if (typeof id === "string" && id && m.selected !== false && isChatCapableModel(id)) out.push(id);
        }
        return out;
      };

      const primaryEnabled = enabledOf(cfg);
      const primaryModel = explicitModel || cfg.model || primaryEnabled[0] || undefined;

      const router = new ModelRouter(undefined, this.clientFactory);
      
      
      router.setReasoningParamsResolver((modelId, kind, baseUrl) =>
        this.reasoningParamsForModel(modelId, kind, agent.reasoning_effort, baseUrl));
      
      
      router.setDeadModelCheck((providerKey, modelId) => getSharedCapabilityGraph().liveDead(providerKey, modelId));
      let order: string[] = [];

      
      
      const modelFormatsOf = (c: ProviderConfig): Map<string, ApiFormat> | undefined => {
        const arr = c.models;
        if (!Array.isArray(arr)) { return undefined; }
        const m = new Map<string, ApiFormat>();
        for (const entry of arr) {
          if (!entry || typeof entry !== "object") { continue; }
          const id = typeof entry.id === "string" ? entry.id : undefined;
          const f = entry.api_format;
          if (id && (f === "openai" || f === "anthropic" || f === "auto")) { m.set(id, f as ApiFormat); }
        }
        return m.size > 0 ? m : undefined;
      };
      const pushGroup = (baseUrl: string, apiKey: string | undefined, models: Array<string | undefined>, nameKey: string, bias: number, apiFormat?: ApiFormat, modelFormats?: Map<string, ApiFormat>): void => {
        const list = models.length > 0 ? models : [undefined]; 
        list.forEach((model, i) => {
          
          const fmt: ApiFormat | undefined = model ? (modelFormats?.get(model) ?? apiFormat) : apiFormat;
          router.add({
            name: model ? `${nameKey}:${model}` : nameKey,
            baseUrl,
            apiKey,
            model,
            kind: "cloud",
            priority: bias - i,
            roles: ["chat", "embedding"],
            api_format: fmt,
          });
        });
      };

      
      order = [...new Set([primaryModel, ...primaryEnabled].filter((x): x is string => typeof x === "string" && Boolean(x)))].slice(0, MODEL_POOL_MAX);
      pushGroup(primaryBase, cfg.api_key || undefined, order, key, 1000, cfg.api_format, modelFormatsOf(cfg));

      
      
      
      
      
      
      
      
      
      const poolTargets = resolveFallbackTargets(this.currentFallbackPool(), this.providers, key, {
        isChatCapable: isChatCapableModel,
      });
      let bias = 900;
      for (const t of poolTargets) {
        pushGroup(t.base, t.apiKey, [t.model], t.provider, bias, t.apiFormat);
        bias -= 1;
      }

      if (router.list().length === 0) {
        return { router: null, error: `${header}Provider「${key}」没有可用的模型（未配置模型列表或全部未启用）。请到 设置 → 模型供应商 编辑启用至少一个模型。` };
      }
      this.logger.info?.(
        poolTargets.length > 0
          ? `[engine] 路由候选 ${router.list().length} 个（仅首选供应商「${key}」＋用户降级池 ${poolTargets.length} 个：${poolTargets.map((t) => `${t.provider}:${t.model}`).join(" → ")}）`
          : `[engine] 路由候选 ${router.list().length} 个（仅首选供应商「${key}」，未配置全局降级池）`,
      );
      if (!cfg.api_key) {
        this.logger.warn(`[engine] Provider「${key}」未配置 API Key，上游可能返回 401（模型 ${primaryModel ?? "默认"}）。`);
      }
      return { router, error: null };
    }

    if (agent.model_choice.startsWith("local:")) {
      const id = agent.model_choice.slice("local:".length).trim();
      const local = await this.ensureLocalModel(id, signal);
      if (!local.ok) {
        return { router: null, error: header + local.error };
      }
      const router = new ModelRouter(undefined, this.clientFactory);
      
      
      router.setReasoningParamsResolver((modelId, kind, baseUrl) =>
        this.reasoningParamsForModel(modelId, kind, agent.reasoning_effort, baseUrl));
      
      
      router.setDeadModelCheck((providerKey, modelId) => getSharedCapabilityGraph().liveDead(providerKey, modelId));
      router.add({
        name: id,
        baseUrl: `http://127.0.0.1:${local.port}`,
        kind: "local",
        priority: 100,
        roles: ["chat", "embedding"],
      });
      return { router, error: null };
    }

    if (agent.model_choice === "inherit") {
      const key = await this.resolveProviderKey(agent);
      if (key) {
        const inherit = { ...agent, model_choice: `api:${key}` };
        return this.resolveRouteInternal(inherit, signal);
      }
      return { router: null, error: `${header}「${agent.name}」当前采用「继承」模型，但其父链上未配置任何 API Provider（` + "`py slime_cli.py wizard` 或 `POST /providers` 可添加）。" };
    }

    return { router: null, error: `${header}未知的模型选择：「${agent.model_choice}」。请在设置中为该 Agent 显式选择 API 或本地模型。` };
  }

  
  public async routerFor(agent: AgentState): Promise<ModelRouter | null> {
    return (await this.resolveRouteInternal(agent)).router;
  }

  
  private async gatedRetrieveSegments(agentId: string, userMessage?: string): Promise<string[]> {
    if (typeof userMessage === "string") {
      const decision = recallGateDecision(userMessage);
      if (!decision.retrieve) {
        this.logger.info(
          `[engine] 记忆检索门控未命中(${decision.signal})，跳过本轮检索式召回` +
          `（L1 固定前缀不受影响；msg=${JSON.stringify(userMessage.slice(0, 40))}）`,
        );
        return [];
      }
      this.logger.info(`[engine] 记忆检索门控命中(${decision.signal})，执行本轮检索式召回`);
    } else {
      this.logger.info("[engine] 本轮无用户消息可判（后台/子代理路径），召回门控回落无条件召");
    }
    return this.hooks.retrieveSegments(agentId, "用户最近的需求");
  }

  
  private async workspaceInventorySegment(ws: string): Promise<string> {
    let inventory = "";
    try {
      const listing = await this.tools.callTool("file_list", { path: ".", _workspace: ws });
      if (listing && !listing.startsWith("[错误]") && listing !== "[空目录]") {
        const lines = listing.split("\n");
        inventory = lines.length > 80 ? `${lines.slice(0, 80).join("\n")}\n…（共 ${lines.length} 项）` : listing;
      } else if (listing !== "[空目录]") {
        inventory = `（目录清单获取失败：${listing}）`;
      }
    } catch {
      inventory = "（目录清单获取失败）";
    }
    return (
      `📦 你的工作目录（workspace）已设置为：\`${ws}\`\n` +
        `以下是该目录当前的内容清单（预加载，无需再调用 file_list 即可了解概貌）：\n${inventory || "（空目录）"}\n` +
        `所有文件操作（file_list/file_read/file_write/code_check）默认以该目录为工作区，文件路径可使用该目录内的相对路径或绝对路径。\n` +
        `如需深入查看子目录/文件内容，请调用 file_list/file_read 继续探查。`
    );
  }

  async buildSystemSegments(
    agent: AgentState,
    customSystemPrompt?: string,
    workspaceOverride?: string,
    userMessage?: string,
  ): Promise<SystemSegments> {
    const parts: string[] = [
      IDENTITY_CONSTRAINT(agent.name, agent.role),
      HONESTY_PROTOCOL,
      (customSystemPrompt?.trim() ? customSystemPrompt : agent.identity_prompt).trim() ||
        `你是 ${agent.name}，你的角色是：${agent.role}。`,
    ];
    
    
    
    const effort = agent.reasoning_effort;
    if (effort && effort !== "none") {
      parts.push(
        "输出规范（必须严格遵守）：如果需要进行内部思考/推理，请把全部思考过程完整放在 " +
          "`<thinking>...</thinking>` 标签内，标签之外的内容才是最终回答。思考标签内的内容不会展示给用户。" +
          "严禁把思考过程直接写进正文——正文中不得出现「用户说…」「我需要…」「我应该…」「根据我的角色设定…」" +
          "等思考性文字。直接输出最终回答。",
      );
    }
    parts.push(...this.hooks.fixedSegments(agent));
    
    
    
    
    parts.push(
      "任务执行规范（务必遵守）：\n" +
        "1) **何时规划**：当任务需要 3 步以上、涉及多个文件、或需要多轮工具协作时，" +
        "**动手前先调用一次 `todo_write`**，把任务拆成 3-6 个明确阶段（祈使句、可验证），全部先标 pending。" +
        "单步任务（一句话问答、单次查询、只改一个已知位置）不要规划，直接做。\n" +
        "2) **单一进行中**：任何时刻**最多一项** in_progress。开始某个阶段前把它置为 in_progress，" +
        "不要一次把好几项都置为 in_progress。\n" +
        "3) **完成即刻标记**：一个阶段真正做完（已改完、已验证）就**立刻**再调一次 `todo_write` " +
        "把该项改成 completed、并把下一项改成 in_progress；**不要攒着一起改**，" +
        "也不要在没做完、报错未解决、验证没过时谎报 completed。\n" +
        "4) **已完成项留在列表里**：不要删掉，保留才能体现进度（用户正是靠这张表看你还剩多少）。" +
        "计划整体改版时才用 action=replace 重写。\n" +
        "分阶段执行能显著提高结果的可靠性与可追踪性，也让用户随时看得见进度。",
    );
    
    
    
    
    parts.push(DELEGATION_GUIDANCE);
    
    const mind = (this.hooks.volatileSegments?.(agent) ?? [])
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
    const memory = (await this.gatedRetrieveSegments(agent.id, userMessage)).join("\n\n");
    const ws = workspaceOverride ?? (agent.sandbox_override && typeof agent.sandbox_override === "object" ? String(agent.sandbox_override.workspace ?? "") : "");
    const workspace = ws ? await this.workspaceInventorySegment(ws) : "";
    const volatile = [mind, memory, workspace].filter((s) => s.trim().length > 0).join("\n\n");
    if (volatile) {
      this.logger.info(
        `[engine] 易变段已移出 system（第 0 条消息）改挂末段 user 消息：` +
          `L2 心智段 ${mind.trim() ? "有" : "无"} / L3 记忆 ${memory.trim() ? "有" : "无"} / 工作目录清单 ${workspace ? "有" : "无"}，` +
          `稳定前缀字节不变（设计 §1.3 前缀缓存）`,
      );
    }
    return { stable: parts.join("\n\n"), volatile, memory, workspace };
  }

  async buildSystem(agent: AgentState, customSystemPrompt?: string, workspaceOverride?: string, userMessage?: string): Promise<string> {
    return joinSystemSegments(await this.buildSystemSegments(agent, customSystemPrompt, workspaceOverride, userMessage));
  }

  
  listTools(): Array<{ function?: { name?: string } }> {
    return this.tools.listTools() as Array<{ function?: { name?: string } }>;
  }

  
  private toolSchemas(toolsOnly?: string[]): ChatRequest["tools"] {
    
    const names = toolsOnly === undefined
      ? this.tools.listToolNames()
      : toolsOnly.filter((n) => this.tools.listToolNames().includes(n));
    if (names.length === 0) {
      return undefined;
    }
    return this.tools.listTools().filter((t) =>
      (t as { function?: { name?: string } }).function?.name &&
      names.includes((t as { function: { name: string } }).function.name),
    ) as ChatRequest["tools"];
  }

  private buildMessages(call: ChatEngineCall, system: string, volatileSegment = ""): ChatMessage[] {
    const images = sanitizeImages(call.images);
    


    const reminder = planReminderText(call.sessionId ? readTodos(call.sessionId) : []);
    let out: ChatMessage[];
    if (images.length === 0) {
      
      out = [
        { role: "system", content: system },
        ...call.history,
        { role: "user", content: call.message },
      ];
    } else {
      
      const blocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: "text", text: call.message },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ];
      const userMsg = { role: "user", content: blocks } as unknown as ChatMessage;
      out = [
        { role: "system", content: system },
        ...call.history,
        userMsg,
      ];
    }
    
    
    
    
    
    if (reminder) { out = foldUserReminder(out, reminder); }
    if (volatileSegment) { out = foldStateSegment(out, volatileSegment); }
    




    return out;
  }

  





  







  private guardSend(opts: ChatEngineCall, messages: ChatMessage[], tools?: unknown): EngineSendGuard {
    const estimated =
      estimateHistoryTokens(messages as Array<{ role: string; content: unknown }>) +
      estimateTokensLocal(tools ? JSON.stringify(tools) : "");
    return planEngineSend({ estimatedInput: estimated, windowCap: opts.windowCap });
  }

  
  private agentWorkspace(agent: AgentState): string {
    const ov = agent.sandbox_override;
    if (!ov || typeof ov !== "object") { return ""; }
    return typeof ov.workspace === "string" ? ov.workspace : "";
  }

  
  private effectiveWorkspace(opts: ChatEngineCall): string {
    return (opts.workspace ?? "").trim() || this.agentWorkspace(opts.agent);
  }

  







  








  private reasoningParamsForModel(modelIdRaw: string, kind: string, effortRaw: string | undefined, baseUrl: string = ""): Record<string, unknown> {
    
    if (kind === "local") {
      return { chat_template_kwargs: { enable_thinking: true } };
    }
    const caps = inferModelCapabilities(modelIdRaw ?? "");
    
    if (!caps.supported) {
      return {};
    }
    const familyProto = caps.thinkingParam ?? "reasoning_effort";
    
    
    
    const proto = isAggregatorGateway(baseUrl) ? "reasoning_effort" : familyProto;
    if (proto === "chat_template_kwargs") {
      return { chat_template_kwargs: { enable_thinking: true } };
    }
    if (proto === "enable_thinking") {
      return { enable_thinking: true, return_reasoning: true };
    }
    if (proto === "thinking") {
      
      
      
      return { thinking: { type: "enabled" } };
    }
    
    
    const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max", "minimal"];
    const safeEffort = effortRaw && VALID_EFFORTS.includes(effortRaw) ? effortRaw : "medium";
    return { reasoning_effort: safeEffort };
  }

  
  private reasoningParams(agent: AgentState, route: RouteEntry | undefined): Record<string, unknown> {
    return this.reasoningParamsForModel(
      route?.model ?? route?.name ?? "",
      route?.kind ?? "cloud",
      agent.reasoning_effort,
      route?.baseUrl ?? "",
    );
  }

  async chat(opts: ChatEngineCall): Promise<ChatEngineResult> {
    const started = Date.now();
    
    if (this.wantsSilam(opts.agent)) {
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        return {
          reply: brain.reply,
          replyRaw: brain.reply,
          reasoning: brain.reasoning ?? null,
          model: "silam",
          promptTokens: estimateTokens(opts.message),
          completionTokens: estimateTokens(brain.reply),
          elapsedMs: Date.now() - started,
        };
      }
      const reply = this.silamUnavailableText(opts.agent);
      return { reply, replyRaw: reply, model: "none", promptTokens: 0, completionTokens: 0, elapsedMs: Date.now() - started };
    }
    const { router, error } = await this.resolveRouteInternal(opts.agent, opts.signal);
    if (!router) {
      this.logger.warn(`[engine] 无可路由模型（${opts.agent.model_choice}）：${error ?? "无可用路由"}`);
      
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        
        const notice = this.fallbackNotice(opts.agent, error);
        return {
          reply: brain.reply,
          replyRaw: brain.reply,
          reasoning: brain.reasoning ? `${notice}\n\n${brain.reasoning}` : notice,
          model: "silam-brain",
          promptTokens: estimateTokens(opts.message),
          completionTokens: estimateTokens(brain.reply),
          elapsedMs: Date.now() - started,
        };
      }
      return {
        reply: error ?? this.defaultReply(opts.agent),
        model: "none",
        promptTokens: 0,
        completionTokens: 0,
        elapsedMs: Date.now() - started,
      };
    }
    const segments = await this.buildSystemSegments(opts.agent, opts.systemPrompt, opts.workspace, opts.message);
    const messages = this.buildMessages(opts, segments.stable, segments.volatile);
    const tools = this.toolSchemas(opts.toolsOnly);

    
    
    const guard = this.guardSend(opts, messages, tools);
    if (!guard.allow) {
      this.logger.warn(`[engine] 上下文保险门拦截（未发送）: ${guard.reason}`);
      
      
      
      const blocked = `${LOCAL_PREFLIGHT_MARKER}\n⚠️ 本次请求**未发送** —— 上下文装不下该模型的窗口。\n\n${guard.reason}`;
      return {
        reply: blocked,
        replyRaw: blocked,
        model: "none",
        promptTokens: 0,
        completionTokens: 0,
        elapsedMs: Date.now() - started,
      };
    }

    if (tools && tools.length > 0) {
      
      const route = router.select("chat");
      const loop = new ToolLoop(router, this.tools, {
        sandbox: this.sandbox ? sandboxGateFrom(this.sandbox) : undefined,
        workspace: this.effectiveWorkspace(opts),
        onAskUser: this.onAskUser,
        networkEnabled: opts.networkEnabled,
      });
      const result = await loop.run({ agentId: opts.agent.id, agentName: opts.agent.name, messages, initialToolCalls: [], tools, maxTokens: effectiveMaxTokens(opts.agent, opts.maxTokens), sessionId: opts.sessionId, signal: opts.signal, maxToolCalls: opts.maxToolCalls, maxTotalTokens: opts.maxTotalTokens, maxWallClockMs: opts.maxWallClockMs, maxRounds: opts.maxRounds });
      const filtered = new OutputFilter().filter(result.raw, opts.agent.name);
      
      this.observeTutorDemo(opts, result.raw);
      this.recordUsage(opts, route, {
        promptTokens: result.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completionTokens: result.usage?.completion_tokens ?? estimateTokens(result.raw),
        reasoningTokens: 0,
        cacheReadTokens: result.usage?.cache_read_tokens ?? 0,
        cacheCreationTokens: result.usage?.cache_creation_tokens ?? 0,
        ...(typeof result.usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: result.usage.cache_read_in_prompt } : {}),
        elapsedMs: Date.now() - started,
        success: true,
      });
      return {
        reply: filtered.filtered || result.raw,
        replyRaw: result.raw,
        model: route?.model ?? route?.name ?? "none",
        promptTokens: result.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completionTokens: result.usage?.completion_tokens ?? estimateTokens(result.raw),
        ...(typeof result.usage?.cache_read_tokens === "number" ? { cacheReadTokens: result.usage.cache_read_tokens } : {}),
        ...(typeof result.usage?.cache_creation_tokens === "number" ? { cacheCreationTokens: result.usage.cache_creation_tokens } : {}),
        ...(typeof result.usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: result.usage.cache_read_in_prompt } : {}),
        elapsedMs: Date.now() - started,
      };
    }

    const payload: ChatRequest = { messages, max_tokens: effectiveMaxTokens(opts.agent, opts.maxTokens) };
    const route = router.select("chat");
    Object.assign(payload, this.reasoningParams(opts.agent, route));
    const { response, routeName } = await router.chat(withModel(payload, route!), opts.signal);
    const raw = response.choices[0]?.message?.content ?? "";
    const filtered = new OutputFilter().filter(raw, opts.agent.name);
    const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number; reasoning_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; cache_read_in_prompt?: boolean } | undefined;
    
    const rt = typeof usage?.reasoning_tokens === "number"
      ? usage.reasoning_tokens
      : typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : undefined;
    
    this.observeTutorDemo(opts, raw);
    this.recordUsage(opts, route, {
      promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completionTokens: usage?.completion_tokens ?? estimateTokens(raw),
      reasoningTokens: rt ?? 0,
      cacheReadTokens: usage?.cache_read_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_tokens ?? 0,
      ...(typeof usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: usage.cache_read_in_prompt } : {}),
      elapsedMs: Date.now() - started,
      success: true,
    });
    return {
      reply: filtered.filtered || raw,
      replyRaw: raw,
      model: response.model ?? routeName,
      promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completionTokens: usage?.completion_tokens ?? estimateTokens(raw),
      ...(typeof rt === "number" ? { reasoningTokens: rt } : {}),
      ...(typeof usage?.cache_read_tokens === "number" ? { cacheReadTokens: usage.cache_read_tokens } : {}),
      ...(typeof usage?.cache_creation_tokens === "number" ? { cacheCreationTokens: usage.cache_creation_tokens } : {}),
      ...(typeof usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: usage.cache_read_in_prompt } : {}),
      elapsedMs: Date.now() - started,
    };
  }

  








  async summarizeContext(
    agent: AgentState,
    messages: Array<{ role: string; content: unknown }>,
    opts?: { maxInputTokens?: number; priorSummary?: string },
  ): Promise<{ summary: string; inputTokens: number; elided: number; truncated: boolean } | null> {
    try {
      const { router, error } = await this.resolveRouteInternal(agent);
      if (!router) {
        this.logger.warn(`[engine] 摘要轮无可路由模型（${agent.model_choice}）：${error ?? "无可用路由"}`);
        return null;
      }
      const requestedBudget = Number.isFinite(opts?.maxInputTokens) && (opts?.maxInputTokens ?? 0) > 0
        ? Math.floor(opts?.maxInputTokens as number)
        : SUMMARIZE_INPUT_CAP;
      const sys = (
        "你是一个专业的会话上下文压缩器。只做一件事：把用户提供的对话历史压缩成结构化中文摘要，保留接续任务所需的关键信息。" +
        "不要回答摘要之外的内容、不要自我介绍。"
      );
      const fixedTokens = estimateTokensLocal(sys) + summaryPromptScaffoldTokens();
      const fit = fitSummaryPrior(opts?.priorSummary, requestedBudget, fixedTokens);
      if (fit.truncated) {
        this.logger.warn(
          `[engine] 既有摘要（priorSummary）本身超出摘要轮预算 ${requestedBudget} ⇒ 已头尾截断到 ${fit.priorTokens} tokens，` +
          `对话摘录让出预算后为 ${fit.conversationBudget}（递进链优先保住 prior，不静默超窗）`,
        );
      }
      if (fit.overBudget) {
        this.logger.warn(
          `[engine] 摘要轮预算 ${requestedBudget} tokens 装不下「系统提示+模板+既有摘要+最小对话摘录」` +
          `⇒ 实际请求会超预算，请换窗口更大的模型`,
        );
      }
      const budget = fit.conversationBudget;
      const { text: excerpt, elided } = buildSummaryInput(messages, budget);
      const text = clipToTokenBudget(excerpt, budget);
      const inputTokens = fixedTokens + fit.priorTokens + estimateTokensLocal(text);
      const route = router.select("chat");
      const ask = (maxOut: number): ChatRequest => {
        const p: ChatRequest = {
          messages: [
            { role: "system", content: sys },
            { role: "user", content: buildCompressSummaryPrompt(text, fit.prior) },
          ],
          max_tokens: maxOut,
        };
        Object.assign(p, this.reasoningParams(agent, route));
        return p;
      };
      
      
      let maxOut = summarizeOutputCap(inputTokens);
      const r1 = await router.chat(withModel(ask(maxOut), route!));
      let raw = r1.response.choices[0]?.message?.content ?? "";
      let truncated = r1.response.choices[0]?.finish_reason === "length";
      if (truncated && maxOut < SUMMARIZE_OUTPUT_CAP) {
        
        
        this.logger.warn(`[engine] 摘要轮触达输出上限（max_tokens=${maxOut}）⇒ 抬到 ${SUMMARIZE_OUTPUT_CAP} 重试一次`);
        maxOut = SUMMARIZE_OUTPUT_CAP;
        const r2 = await router.chat(withModel(ask(maxOut), route!));
        const t2 = r2.response.choices[0]?.message?.content ?? "";
        if (t2.trim()) {
          raw = t2;
          truncated = r2.response.choices[0]?.finish_reason === "length";
        }
      }
      const trimmed = raw.trim();
      if (!trimmed) { return null; }
      if (truncated) {
        this.logger.warn(
          `[engine] 摘要轮即便抬满 ${SUMMARIZE_OUTPUT_CAP} token 仍被截断 ⇒ 标记 truncated=true` +
          "（摘要不完整，早期细节可能未进摘要；上层必须如实告知，不许当完整摘要使用）",
        );
      }
      return { summary: trimmed, inputTokens, elided, truncated };
    } catch (e) {
      this.logger.warn(`[engine] 摘要轮失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  




  async comprehendContext(
    agent: AgentState,
    summary: string,
    opts?: { archivePath?: string },
  ): Promise<{ comprehend: string; raw: string } | null> {
    try {
      const { router, error } = await this.resolveRouteInternal(agent);
      if (!router) {
        this.logger.warn(`[engine] 理解环无可路由模型（${agent.model_choice}）：${error ?? "无可用路由"}`);
        return null;
      }
      const payload: ChatRequest = {
        messages: [
          {
            role: "system",
            content: "你只做一件事：回读给定的工作摘要，用被动陈述语气自述当前状态。不要执行任何动作、不要调用工具、不要给出指令。",
          },
          { role: "user", content: buildResumeBlock(summary, opts?.archivePath) },
        ],
        max_tokens: 800,
      };
      const route = router.select("chat");
      Object.assign(payload, this.reasoningParams(agent, route));
      const { response } = await router.chat(withModel(payload, route!));
      const raw = (response.choices[0]?.message?.content ?? "").trim();
      if (!raw) { return null; }
      const parsed = parseComprehend(raw);
      if (!parsed.ok) {
        
        this.logger.warn(
          `[engine] 理解环输出不合格：missing=[${parsed.missing.join(",")}] injected=${parsed.injected}${parsed.injectionSample ? ` sample=${parsed.injectionSample}` : ""}`,
        );
        return null;
      }
      return { comprehend: raw, raw };
    } catch (e) {
      this.logger.warn(`[engine] 理解环失败（非阻塞降级）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async *stream(opts: ChatEngineCall): AsyncGenerator<EngineChunk> {
    const started = Date.now();
    




    takeUpstreamNotice();
    
    let displayText = "";
    
    if (this.wantsSilam(opts.agent)) {
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        
        if (brain.reasoning) {
          yield { type: "reasoning", content: brain.reasoning };
        }
        yield {
          type: "done",
          reply: brain.reply,
          reply_raw: brain.reply,
          reasoning: brain.reasoning ?? null,
          model: "silam",
          prompt_tokens: estimateTokens(opts.message),
          completion_tokens: estimateTokens(brain.reply),
          elapsed_ms: Date.now() - started,
        };
        return;
      }
      const reply = this.silamUnavailableText(opts.agent);
      yield { type: "done", reply, reply_raw: reply, model: "none", prompt_tokens: 0, completion_tokens: 0, elapsed_ms: Date.now() - started };
      return;
    }
    const { router, error } = await this.resolveRouteInternal(opts.agent, opts.signal);
    if (!router) {
      this.logger.warn(`[engine] 无可路由模型（${opts.agent.model_choice}）：${error ?? "无可用路由"}`);
      
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        
        
        const notice = this.fallbackNotice(opts.agent, error);
        yield { type: "reasoning", content: brain.reasoning ? `${notice}\n\n${brain.reasoning}` : notice };
        yield {
          type: "done",
          reply: brain.reply,
          reply_raw: brain.reply,
          reasoning: brain.reasoning ?? null,
          model: "silam-brain",
          prompt_tokens: estimateTokens(opts.message),
          completion_tokens: estimateTokens(brain.reply),
          elapsed_ms: Date.now() - started,
        };
        return;
      }
      const reply = error ?? this.defaultReply(opts.agent);
      yield { type: "done", reply, reply_raw: reply, model: "none", prompt_tokens: 0, completion_tokens: 0, elapsed_ms: Date.now() - started };
      return;
    }
    const segments = await this.buildSystemSegments(opts.agent, opts.systemPrompt, opts.workspace, opts.message);
    const messages = this.buildMessages(opts, segments.stable, segments.volatile);
    const tools = this.toolSchemas(opts.toolsOnly);
    
    const buckets = computeContextBuckets({
      system: segments.stable,
      memory: segments.memory,
      workspace: segments.workspace,
      tools: tools ? JSON.stringify(tools) : "",
      history: JSON.stringify(opts.history),
      message: opts.message,
    });
    
    
    
    const guard = this.guardSend(opts, messages, tools);
    if (!guard.allow) {
      this.logger.warn(`[engine] 上下文保险门拦截（未发送）: ${guard.reason}`);
      
      yield { type: "error", message: `${LOCAL_PREFLIGHT_MARKER}\n⚠️ 本次请求**未发送** —— 上下文装不下该模型的窗口。\n\n${guard.reason}` };
      return;
    }

    if (tools && tools.length > 0) {
      
      
      const route = router.select("chat");
      const loop = new ToolLoop(router, this.tools, {
        sandbox: this.sandbox ? sandboxGateFrom(this.sandbox) : undefined,
        workspace: this.effectiveWorkspace(opts),
        onAskUser: this.onAskUser,
        networkEnabled: opts.networkEnabled,
      });
      const liveQueue: EngineChunk[] = [];
      let loopDone = false;
      let loopError: Error | null = null;
      const loopPromise = loop
        .runStream({
          agentId: opts.agent.id,
          agentName: opts.agent.name,
          messages,
          initialToolCalls: [],
          tools,
          maxTokens: effectiveMaxTokens(opts.agent, opts.maxTokens),
          sessionId: opts.sessionId,
          signal: opts.signal,
          maxToolCalls: opts.maxToolCalls,
          maxTotalTokens: opts.maxTotalTokens,
          maxWallClockMs: opts.maxWallClockMs,
          maxRounds: opts.maxRounds,
          onEvent: (ev) => {
            if (ev.type === "reasoning") {
              liveQueue.push({ type: "reasoning", content: ev.content });
            } else if (ev.type === "chunk") {
              liveQueue.push({ type: "chunk", content: ev.content });
            } else if (ev.type === "steer") {
              
              
              
              liveQueue.push({ type: "steer", content: ev.text, steerId: ev.id });
            } else if (ev.type === "tool-start") {
              
              liveQueue.push({ type: "tool-start", name: ev.name, args: ev.args, toolId: ev.id });
            } else {
              liveQueue.push({ type: "tool", name: ev.name, args: ev.args, result: ev.result, toolId: ev.id });
            }
          },
        })
        .then((r) => {
          loopDone = true;
          return r;
        })
        .catch((e: unknown) => {
          loopDone = true;
          loopError = e instanceof Error ? e : new Error(String(e));
          throw e;
        });

      
      
      
      
      
      
      
      
      void loopPromise.catch(() => {  });

      
      while (!loopDone) {
        
        
        const notice = takeUpstreamNotice();
        if (notice) { liveQueue.push({ type: "notice", content: notice.text }); }
        while (liveQueue.length > 0) {
          yield liveQueue.shift()!;
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      while (liveQueue.length > 0) {
        yield liveQueue.shift()!;
      }
      if (loopError) {
        if (opts.signal?.aborted) {
          this.recordUsage(opts, route, {
            promptTokens: estimateTokens(JSON.stringify(messages)),
            completionTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            elapsedMs: Date.now() - started,
            success: false,
            error: "user-aborted",
          });
          yield {
            type: "done",
            reply: "（生成已被中断）",
            reply_raw: "",
            model: route?.model ?? route?.name ?? "none",
            prompt_tokens: estimateTokens(JSON.stringify(messages)),
            completion_tokens: 0,
            elapsed_ms: Date.now() - started,
          };
          return;
        }
        throw loopError;
      }
      const result = await loopPromise;
      const filtered = new OutputFilter().filter(result.raw, opts.agent.name);
      const display = filtered.filtered || result.raw;
      
      this.observeTutorDemo(opts, result.raw);
      
      const loopUsage = result.usage;
      this.recordUsage(opts, route, {
        promptTokens: loopUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completionTokens: loopUsage?.completion_tokens ?? estimateTokens(result.raw),
        reasoningTokens: loopUsage?.reasoning_tokens ?? 0,
        cacheReadTokens: loopUsage?.cache_read_tokens ?? 0,
        cacheCreationTokens: loopUsage?.cache_creation_tokens ?? 0,
        ...(typeof loopUsage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: loopUsage.cache_read_in_prompt } : {}),
        elapsedMs: Date.now() - started,
        success: true,
      });
      yield {
        type: "done",
        reply: display,
        reply_raw: result.raw,
        model: route?.model ?? route?.name ?? "none",
        ctxBuckets: buckets,
        prompt_tokens: loopUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completion_tokens: loopUsage?.completion_tokens ?? estimateTokens(result.raw),
        ...(typeof loopUsage?.reasoning_tokens === "number" ? { reasoning_tokens: loopUsage.reasoning_tokens } : {}),
        ...(typeof loopUsage?.cache_read_tokens === "number" ? { cache_read_tokens: loopUsage.cache_read_tokens } : {}),
        ...(typeof loopUsage?.cache_creation_tokens === "number" ? { cache_creation_tokens: loopUsage.cache_creation_tokens } : {}),
        
        
        ...(typeof result.lastUsage?.prompt_tokens === "number" ? { window_prompt_tokens: result.lastUsage.prompt_tokens } : {}),
        ...(typeof result.lastUsage?.cache_read_tokens === "number" ? { window_cache_read_tokens: result.lastUsage.cache_read_tokens } : {}),
        ...(typeof result.lastUsage?.cache_creation_tokens === "number" ? { window_cache_creation_tokens: result.lastUsage.cache_creation_tokens } : {}),
        
        ...(typeof result.lastUsage?.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: result.lastUsage.cache_read_in_prompt } : {}),
        elapsed_ms: Date.now() - started,
      };
      return;
    }

    
    const filter = new OutputFilter();
    const streamFilter = new StreamFilter();
    const payload = { messages, max_tokens: effectiveMaxTokens(opts.agent, opts.maxTokens) } as ChatRequest;
    const route = router.select("chat");
    Object.assign(payload, this.reasoningParams(opts.agent, route));

    
    
    const liveQueue: EngineChunk[] = [];
    let streamDone = false;
    let streamError: Error | null = null;
    const streamPromise = router.chatStream(
      withModel(payload, route!),
      (delta) => {
        const emitted = streamFilter.push(delta, filter, opts.agent.name);
        if (emitted) {
          liveQueue.push({ type: "chunk", content: emitted });
          displayText += emitted;
        }
      },
      opts.signal,
      (reasoning) => {
        liveQueue.push({ type: "reasoning", content: reasoning });
      },
    ).then((r) => {
      streamDone = true;
      return r;
    }).catch((e: unknown) => {
      streamDone = true;
      streamError = e instanceof Error ? e : new Error(String(e));
      throw e;
    });

    
    
    
    void streamPromise.catch(() => {  });

    
    while (!streamDone) {
      
      const notice = takeUpstreamNotice();
      if (notice) { liveQueue.push({ type: "notice", content: notice.text }); }
      while (liveQueue.length > 0) {
        yield liveQueue.shift()!;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    while (liveQueue.length > 0) {
      yield liveQueue.shift()!;
    }
    
    const tail = streamFilter.flush(filter, opts.agent.name);
    if (tail) {
      yield { type: "chunk", content: tail };
      displayText += tail;
    }
    if (streamError) {
      if (opts.signal?.aborted) {
        
        const partial = displayText;
        this.recordUsage(opts, route, {
          promptTokens: estimateTokens(JSON.stringify(messages)),
          completionTokens: estimateTokens(partial),
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          elapsedMs: Date.now() - started,
          success: false,
          error: "user-aborted",
        });
        yield {
          type: "done",
          reply: partial || "（生成已被中断）",
          reply_raw: partial,
          model: (route as { model?: string; name?: string } | undefined)?.model ?? (route as { name?: string } | undefined)?.name ?? "unknown",
          prompt_tokens: estimateTokens(JSON.stringify(messages)),
          completion_tokens: estimateTokens(partial),
          elapsed_ms: Date.now() - started,
        };
        return;
      }
      throw streamError;
    }
    const raw = await streamPromise;
    
    this.observeTutorDemo(opts, raw.text);
    
    
    const streamUsage = raw.usage;
    this.recordUsage(opts, route, {
      promptTokens: streamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completionTokens: streamUsage?.completion_tokens ?? estimateTokens(raw.text),
      reasoningTokens: streamUsage?.reasoning_tokens ?? 0,
      cacheReadTokens: streamUsage?.cache_read_tokens ?? 0,
      cacheCreationTokens: streamUsage?.cache_creation_tokens ?? 0,
      ...(typeof streamUsage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: streamUsage.cache_read_in_prompt } : {}),
      elapsedMs: Date.now() - started,
      success: true,
    });
    yield {
      type: "done",
      reply: displayText,
      reply_raw: raw.text,
      model: raw.model,
      ctxBuckets: buckets,
      prompt_tokens: streamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completion_tokens: streamUsage?.completion_tokens ?? estimateTokens(raw.text),
      ...(typeof streamUsage?.reasoning_tokens === "number" ? { reasoning_tokens: streamUsage.reasoning_tokens } : {}),
      ...(typeof streamUsage?.cache_read_tokens === "number" ? { cache_read_tokens: streamUsage.cache_read_tokens } : {}),
      ...(typeof streamUsage?.cache_creation_tokens === "number" ? { cache_creation_tokens: streamUsage.cache_creation_tokens } : {}),
      
      
      ...(typeof streamUsage?.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: streamUsage.cache_read_in_prompt } : {}),
      
      
      ...(raw.finishReason ? { finish_reason: raw.finishReason } : {}),
      elapsed_ms: Date.now() - started,
    };
  }
}


export function createEngine(opts: SlimeEngineOptions): SlimeEngine {
  return new SlimeEngine(opts);
}