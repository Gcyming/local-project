







































export type LocalServerState = "ready" | "loading" | "down";


export interface UnavailableEnvelope {
  error: { message: string; type: string; code: number };
}


export function isUnavailableEnvelope(body: unknown): body is UnavailableEnvelope {
  if (!body || typeof body !== "object") { return false; }
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") { return false; }
  const e = err as { type?: unknown; code?: unknown };
  return e.type === "unavailable_error" || e.code === 503;
}









export function classifyLocalServer(httpStatus: number | null, body: unknown): LocalServerState {
  if (httpStatus === null) { return "down"; }
  


  if (isUnavailableEnvelope(body) || httpStatus === 503) { return "loading"; }
  if (httpStatus === 200) { return "ready"; }
  

  return "down";
}


export interface LocalServerCapability {
  state: LocalServerState;
  

  effectiveCtx: number | null;
  
  trainCtx: number | null;
  
  alias: string | null;
  
  modelPath: string | null;
  
  ftype: string | null;
  
  totalSlots: number | null;
  
  vision: boolean | null;
  audio: boolean | null;
  video: boolean | null;
  
  supportsTools: boolean | null;
  supportsParallelToolCalls: boolean | null;
  
  buildInfo: string | null;
  
  sleeping: boolean | null;
  
  vocabSize: number | null;
  paramCount: number | null;
  
  signals: string[];
}


export function emptyCapability(state: LocalServerState = "down"): LocalServerCapability {
  return {
    state,
    effectiveCtx: null, trainCtx: null, alias: null, modelPath: null, ftype: null,
    totalSlots: null, vision: null, audio: null, video: null,
    supportsTools: null, supportsParallelToolCalls: null,
    buildInfo: null, sleeping: null, vocabSize: null, paramCount: null,
    signals: [],
  };
}







function posInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) { return null; }
  const n = Math.trunc(v);
  return n > 0 ? n : null;
}


function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}




function pick(signals: string[], ...candidates: Array<[string, unknown]>): number | null {
  for (const [label, value] of candidates) {
    const n = posInt(value);
    if (n !== null) { signals.push(`${label}=${n}`); return n; }
  }
  return null;
}














export function parsePropsPayload(body: unknown): Partial<LocalServerCapability> {
  const out: Partial<LocalServerCapability> = {};
  const signals: string[] = [];
  const root = asRecord(body);
  if (!root) { out.signals = signals; return out; }

  const dgs = asRecord(root.default_generation_settings);
  const nCtx = pick(signals, ["props.default_generation_settings.n_ctx", dgs?.n_ctx]);
  if (nCtx !== null) { out.effectiveCtx = nCtx; }
  if (dgs && dgs.n_ctx !== undefined && posInt(dgs.n_ctx) === null) {
    signals.push("props.default_generation_settings.n_ctx 存在但非正数 → 丢弃（0 不等于有效窗口）");
  }

  const slots = posInt(root.total_slots);
  if (slots !== null) { out.totalSlots = slots; signals.push(`props.total_slots=${slots}`); }

  const alias = strOrNull(root.model_alias);
  if (alias) { out.alias = alias; }
  const path = strOrNull(root.model_path);
  if (path) { out.modelPath = path; }
  const ftype = strOrNull(root.model_ftype);
  if (ftype) { out.ftype = ftype; }
  const build = strOrNull(root.build_info);
  if (build) { out.buildInfo = build; }

  const mods = asRecord(root.modalities);
  if (mods) {
    out.vision = boolOrNull(mods.vision);
    out.audio = boolOrNull(mods.audio);
    out.video = boolOrNull(mods.video);
  }

  const caps = asRecord(root.chat_template_caps);
  if (caps) {
    

    const t = boolOrNull(caps.supports_tools);
    const tc = boolOrNull(caps.supports_tool_calls);
    out.supportsTools = t === null && tc === null ? null : Boolean(t !== false && tc !== false);
    out.supportsParallelToolCalls = boolOrNull(caps.supports_parallel_tool_calls);
  }

  out.sleeping = boolOrNull(root.is_sleeping);
  out.signals = signals;
  return out;
}


















export function parseModelsPayload(body: unknown, alias?: string): Partial<LocalServerCapability> {
  const out: Partial<LocalServerCapability> = {};
  const signals: string[] = [];
  const root = asRecord(body);
  if (!root) { out.signals = signals; return out; }

  const data = Array.isArray(root.data) ? root.data : [];
  const entries = data.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  let entry: Record<string, unknown> | undefined = entries[0];
  if (alias) {
    const hit = entries.find((e) => e.id === alias);
    if (hit) { entry = hit; signals.push(`models 命中别名 ${alias}`); }
    else if (entries.length > 0) { signals.push(`models 无别名 ${alias}，退回 data[0]`); }
  }
  if (!entry) {
    

    const legacy = Array.isArray(root.models) ? root.models : [];
    const first = legacy.map(asRecord).find((r): r is Record<string, unknown> => r !== null);
    const nm = strOrNull(first?.name) ?? strOrNull(first?.model);
    if (nm) { out.alias = nm; signals.push("models[] 仅提供名称，无几何参数"); }
    out.signals = signals;
    return out;
  }

  const meta = asRecord(entry.meta) ?? {};
  const id = strOrNull(entry.id);
  if (id) { out.alias = id; }

  

  const eff = pick(
    signals,
    ["models.data[].meta.n_ctx", meta.n_ctx],
    ["models.data[].context_length", entry.context_length],
    ["models.data[].max_model_len", entry.max_model_len],
    ["models.data[].max_context_length", entry.max_context_length],
  );
  if (eff !== null) { out.effectiveCtx = eff; }

  const train = pick(
    signals,
    ["models.data[].meta.n_ctx_train", meta.n_ctx_train],
    ["models.data[].context_length_train", entry.context_length_train],
  );
  if (train !== null) { out.trainCtx = train; }

  const vocab = posInt(meta.n_vocab);
  if (vocab !== null) { out.vocabSize = vocab; }
  const params = posInt(meta.n_params);
  if (params !== null) { out.paramCount = params; }
  const ft = strOrNull(meta.ftype);
  if (ft) { out.ftype = ft; }

  out.signals = signals;
  return out;
}



export interface LocalCapabilityInput {
  
  props?: unknown;
  
  models?: unknown;
  
  propsStatus?: number | null;
  
  modelsStatus?: number | null;
  
  alias?: string;
}










export function readLocalCapability(input: LocalCapabilityInput): LocalServerCapability {
  const props = parsePropsPayload(input.props);
  const models = parseModelsPayload(input.models, input.alias);

  const pStatus = input.propsStatus ?? null;
  const mStatus = input.modelsStatus ?? null;

  
  const pState = pStatus !== null || input.props !== undefined
    ? classifyLocalServer(pStatus, input.props)
    : null;
  const mState = mStatus !== null || input.models !== undefined
    ? classifyLocalServer(mStatus, input.models)
    : null;
  const state: LocalServerState = pState ?? mState ?? "down";

  const signals: string[] = [];
  if (state === "loading") {
    signals.push("服务未就绪：llama-server 返回 503 unavailable_error（模型加载中）");
  } else if (state === "down") {
    signals.push("服务不可达（未启动 / 端口无监听 / 超时）");
  }

  
  let effectiveCtx = props.effectiveCtx ?? models.effectiveCtx ?? null;
  if (props.effectiveCtx !== undefined && models.effectiveCtx !== undefined
      && props.effectiveCtx !== models.effectiveCtx) {
    signals.push(`n_ctx 冲突：/props=${props.effectiveCtx} vs /v1/models=${models.effectiveCtx} → 采用 /props`);
  }
  const trainCtx = models.trainCtx ?? null;

  

  if (effectiveCtx !== null && trainCtx !== null && effectiveCtx > trainCtx) {
    signals.push(`有效窗口 ${effectiveCtx} 超过训练上限 ${trainCtx}（RoPE 外推），以有效窗口为准`);
  }

  

  if (state === "ready" && effectiveCtx === null) {
    signals.push("服务已就绪但解析不出 n_ctx —— 端点半结构可能变了（检查 /props 与 /v1/models 的字段名）");
  }
  effectiveCtx = state === "ready" ? effectiveCtx : null;

  return {
    state,
    effectiveCtx,
    trainCtx: state === "ready" ? trainCtx : null,
    alias: props.alias ?? models.alias ?? null,
    modelPath: props.modelPath ?? null,
    ftype: props.ftype ?? models.ftype ?? null,
    totalSlots: props.totalSlots ?? null,
    vision: props.vision ?? null,
    audio: props.audio ?? null,
    video: props.video ?? null,
    supportsTools: props.supportsTools ?? null,
    supportsParallelToolCalls: props.supportsParallelToolCalls ?? null,
    buildInfo: props.buildInfo ?? null,
    sleeping: props.sleeping ?? null,
    vocabSize: models.vocabSize ?? null,
    paramCount: models.paramCount ?? null,
    signals: [...signals, ...(props.signals ?? []), ...(models.signals ?? [])],
  };
}




export type WindowCapSource =
  
  | "agent"
  
  | "server"
  
  | "planned"
  
  | "provider"
  
  | "none";

export interface WindowCapResolution {
  ctx: number | undefined;
  source: WindowCapSource;
  signals: string[];
}














export function resolveWindowCap(input: {
  agentMaxContext?: number | null;
  serverCtx?: number | null;
  plannedCtx?: number | null;
  providerSpecCtx?: number | null;
}): WindowCapResolution {
  const signals: string[] = [];
  const agent = posInt(input.agentMaxContext);
  if (agent !== null) {
    return { ctx: agent, source: "agent", signals: [`agent.max_context=${agent}（显式覆盖，优先于服务端）`] };
  }
  const server = posInt(input.serverCtx);
  if (server !== null) {
    return { ctx: server, source: "server", signals: [`/props n_ctx=${server}（服务端自述，权威）`] };
  }
  const planned = posInt(input.plannedCtx);
  if (planned !== null) {
    signals.push("服务端未就绪，回落到 slime.toml ctx_len（同域：它就是启动时下发的 -c）");
    return { ctx: planned, source: "planned", signals };
  }
  const provider = posInt(input.providerSpecCtx);
  if (provider !== null) {
    return { ctx: provider, source: "provider", signals: [`provider 规格 context_window=${provider}`] };
  }
  return { ctx: undefined, source: "none", signals: ["无可用来源；调用方不得回落到家族能力表"] };
}




function fmt(n: number): string {
  return n.toLocaleString("en-US");
}






export function describeWindowCap(cap: Pick<LocalServerCapability, "state" | "effectiveCtx" | "trainCtx">): string {
  if (cap.state === "loading") { return "模型加载中…"; }
  if (cap.state === "down") { return "本地服务未启动"; }
  if (cap.effectiveCtx === null) { return "上下文窗口未知"; }
  const eff = fmt(cap.effectiveCtx);
  if (cap.trainCtx === null || cap.trainCtx === cap.effectiveCtx) { return `本次 ${eff}`; }
  return `本次 ${eff}（模型训练上限 ${fmt(cap.trainCtx)}）`;
}
