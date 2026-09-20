/**
 * core-ts/src/model_introspect.ts — 本地 llama-server 的「能力**问询**」层（计划 S1）。
 *
 * ── 为什么存在 ────────────────────────────────────────────────
 * 在此之前，"本地模型的上限是多少"是**推断**出来的：依次试 `agent.max_context` →
 * 本地模型条目的 `ctx_len` → `slime.toml [model_server.chat].ctx_len` → provider 规格 →
 * 最后落到 `shared/model-capabilities` 的**家族能力表**。
 *
 * 家族能力表写的是模型**训练时**的窗口（qwen3 = 524K），而 llama-server 实际只按
 * `-c 8192` 分配 KV cache。于是界面显示"还剩 480K"，请求发出去被上游 400 顶回：
 *   `request (13811 tokens) exceeds the available context size (8192 tokens)`
 * —— 用户看到的是"明明没满却发不出去"（A-1018 ③）。
 *
 * 根因不是"哪个数字填错了"，而是**真值来源选错了**：上限这件事，服务器自己就有权威答案。
 * 这次改成**问服务器**，只读两个端点：
 *   GET /props       → `default_generation_settings.n_ctx`   —— 本次服务的**有效窗口**
 *   GET /v1/models   → `data[].meta.n_ctx` / `n_ctx_train`   —— 有效窗口 + **训练上限**
 *
 * ── 实测（llama.cpp b10509，本机 llama-server，2026-09-19）────
 *   `llama-server -m qwen3-1.7b-q8_0.gguf -c 8192`
 *   就绪 → `/props` 200，`default_generation_settings.n_ctx = 8192`，`total_slots = 4`
 *          `/v1/models` 200，`data[0].meta = {n_ctx: 8192, n_ctx_train: 40960, n_vocab: 151936, …}`
 *   加载中 → **三个端点全部** HTTP 503，响应体都是同一个信封：
 *          `{"error":{"message":"Loading model","type":"unavailable_error","code":503}}`
 *   ⚠️ 注意最后这条：`/health` **不豁免**。别指望它返回 `{"status":"loading model"}` ——
 *      实测它给的也是上面那个 `unavailable_error` 信封。所以"加载中"不是一个需要靠
 *      超时去猜的中间态，而是**可查询的一等状态**；把它当成 `down` 会让 UI 在加载期间
 *      显示"模型未启动"，把用户引向"重试启动"这个错误动作。
 *
 * ── 与 `gguf_meta.ts` 的关系 ──────────────────────────────────
 * `GgufKvGeometry.nativeContextLength` 也能给出训练上限（读模型文件即可，不用起服务），
 * 但它是**静态**的：改不了"本次服务实际给了多少 KV"。两者用途不同 ——
 * 显示/解释用 gguf，判"能不能装下"必须用本模块的 `effectiveCtx`。
 *
 * 纯函数、无 IO、可单测；发请求的职责在调用方（`gui/src/main/localServerProbe.ts`）。
 */

/** 本地服务三态。**`loading` 是一等状态，不是 `down` 的变体。**
 *  （实测依据见文件头：加载期三端点全 503 且信封一致，只能靠"此前是否 ready"或不区分来分辨 ——
 *   故本模块把 HTTP 503 + `unavailable_error` 明确归为 `loading`。） */
export type LocalServerState = "ready" | "loading" | "down";

/** llama-server 未就绪时的统一错误信封。三个端点共用同一份（实测）。 */
export interface UnavailableEnvelope {
  error: { message: string; type: string; code: number };
}

/** 恰好等于 `{"error":{"message":"Loading model","type":"unavailable_error","code":503}}` */
export function isUnavailableEnvelope(body: unknown): body is UnavailableEnvelope {
  if (!body || typeof body !== "object") { return false; }
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") { return false; }
  const e = err as { type?: unknown; code?: unknown };
  return e.type === "unavailable_error" || e.code === 503;
}

/**
 * HTTP 状态码 + 响应体 → 服务状态。
 *
 * ⚠️ `httpStatus === null` 表示**根本没连上**（fetch 抛异常 / 超时 / 端口没人监听）。
 *    这和"连上了但 503"是两件事：前者是 `down`，后者是 `loading`。
 *    把两者合并会让"模型正在加载"被报成"模型没起来"，用户于是去点"重试启动"，
 *    反而把正在加载的进程杀掉重启 —— 这正是静默失效的一种。
 */
export function classifyLocalServer(httpStatus: number | null, body: unknown): LocalServerState {
  if (httpStatus === null) { return "down"; }
  /* ⚠️ 信封先于状态码判断：万一某个版本"状态码 200 + 错误信封"，
     按状态码会把它当成就绪，然后拿着 null 的 n_ctx 去算上下文占用。
     信封是**内容**层面的否定，比传输层的 200 更强。 */
  if (isUnavailableEnvelope(body) || httpStatus === 503) { return "loading"; }
  if (httpStatus === 200) { return "ready"; }
  /* 其余（401/404/500…）不是我们的服务或真的坏了 → 当作不可用。
     注意**不**归为 loading：那会让 UI 无限显示"加载中"。 */
  return "down";
}

/** 本地服务的能力快照（就绪时才有数字；加载/不可用时数字为 null） */
export interface LocalServerCapability {
  state: LocalServerState;
  /** **有效上下文窗口**（llama-server 的 `n_ctx`）= 可以安全发出去的最大 token 数。
   *  这是"能不能装下"的**唯一**判据。null 表示还不知道（加载中/连不上）。 */
  effectiveCtx: number | null;
  /** **训练上限**（`n_ctx_train`）。仅供展示与解释，**绝不可**当作可用窗口。 */
  trainCtx: number | null;
  /** 服务端模型别名（S4 的 `--alias` 命名寻址用它；未设别名时是模型路径） */
  alias: string | null;
  /** 模型文件路径（`/props.model_path`） */
  modelPath: string | null;
  /** 量化类型（`/props.model_ftype`，如 `Q8_0`） */
  ftype: string | null;
  /** 并行槽位数（`/props.total_slots`） */
  totalSlots: number | null;
  /** 多模态（`/props.modalities`） */
  vision: boolean | null;
  audio: boolean | null;
  video: boolean | null;
  /** 工具调用能力（`/props.chat_template_caps`）—— 模板**真的**支持才算数 */
  supportsTools: boolean | null;
  supportsParallelToolCalls: boolean | null;
  /** llama.cpp 构建号（诊断用：不同版本的端点字段会变） */
  buildInfo: string | null;
  /** 是否处于休眠（`/props.is_sleeping`；S4 的 idle TTL 会用到） */
  sleeping: boolean | null;
  /** 词表大小 / 参数量（展示用） */
  vocabSize: number | null;
  paramCount: number | null;
  /** 判据链条（诊断：哪个端点贡献了哪个字段） */
  signals: string[];
}

/** 全空快照（"什么都还不知道"）—— 用常量而不是 scattered `null`，方便断言。 */
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

/* ── 取值工具：**0 不是合法值** ─────────────────────────────
 * 上下文窗口/槽位数这类量，0 与 negative 都只可能是"字段缺失被写成了 0"（见项目铁律
 * 「`0` ≠ `undefined`，一律 `??`」）。若把 0 当合法值返回，调用方会拿它去算
 * `used / 0 = Infinity`，界面显示"剩余 0%"或 NaN —— 比"不知道"糟得多。 */

/** 取正整数；非有限/非整数/≤0 → null */
function posInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) { return null; }
  const n = Math.trunc(v);
  return n > 0 ? n : null;
}

/** 取布尔；非布尔 → null（**不做 truthy 强转**：字符串 "false" 会被转成 true） */
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 按顺序取第一条合法的正整数，并把**实际命中的字段名**写进 signals。
 *  传 `[字段全名, 值]` 而不是裸值 —— 否则 signals 会指认一个没命中的字段名，
 *  排查时被误导（A-1019 的教训：取样/定位错位比没有信号更糟）。 */
function pick(signals: string[], ...candidates: Array<[string, unknown]>): number | null {
  for (const [label, value] of candidates) {
    const n = posInt(value);
    if (n !== null) { signals.push(`${label}=${n}`); return n; }
  }
  return null;
}

/* ── /props ───────────────────────────────────────────────── */

/**
 * 解析 `/props` 响应体。**不认识的结构一律返回空对象，不猜、不抛。**
 *
 * 实测就绪态顶层键（b10509）：`default_generation_settings` / `total_slots` / `model_alias` /
 * `model_ftype` / `model_path` / `modalities` / `chat_template_caps` / `build_info` /
 * `is_sleeping` / `endpoint_slots` / `endpoint_props` / `endpoint_metrics` / `ui` /
 * `chat_template` / `bos_token` / `eos_token` / `media_marker` / `ui_settings` / `cors_proxy_enabled`。
 *
 * ⚠️ `/props` **没有** `n_ctx_train` —— 训练上限只在 `/v1/models[].meta` 里。
 *    别在这里造一个"从 n_ctx 反推"的假字段。
 */
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
    /* tools 与 tool_calls 是**两个**字段：模板要能渲染 <tools> 且能吐 <tool_call> 才算数。
       `supports_tools` 是模板级、`supports_tool_calls` 是消息级，任一为 false 就是不能用。 */
    const t = boolOrNull(caps.supports_tools);
    const tc = boolOrNull(caps.supports_tool_calls);
    out.supportsTools = t === null && tc === null ? null : Boolean(t !== false && tc !== false);
    out.supportsParallelToolCalls = boolOrNull(caps.supports_parallel_tool_calls);
  }

  out.sleeping = boolOrNull(root.is_sleeping);
  out.signals = signals;
  return out;
}

/* ── /v1/models ───────────────────────────────────────────── */

/**
 * 解析 `/v1/models` 响应体，取出**被服务的那个**模型的能力字段。
 *
 * 实测结构（llama.cpp b10509 同时给两套）：
 *   `models[]`  —— llama.cpp 自有形状，id 在 `name`/`model`
 *   `data[]`    —— OpenAI 兼容形状，id 在 `id`，**几何参数在 `meta`**
 * 我们要的是 `data[].meta.{n_ctx,n_ctx_train,n_vocab,n_params}`。
 *
 * 顺带兼容起别的本地服务的**通用字段名**（vLLM 的 `max_model_len`、部分网关的
 * `context_length`）—— 这些不是给 llama.cpp 用的，而是给 S5"删掉家族能力表"铺路：
 * 删表之后，非 llama.cpp 的本地/兼容服务也得有个真实来源，否则又退回"猜"。
 *
 * @param alias 期望的模型别名（S4 的命名寻址）。给了就在 `data[]` 里精确匹配 `id`，
 *              匹配不到则退回第一条并记一条 signal —— **不退化成猜**。
 */
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
    /* `models[]`（llama.cpp 自有形状）没有 meta，只有 id —— 至少把 alias 捡回来，
       数字留给 /props。**不要**因此去读 GGUF 文件反推（那是另一条真相源）。 */
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

  /* 有效窗口：meta.n_ctx（llama.cpp）→ context_length / max_model_len（vLLM 等）。
     ⚠️ **不读** gguf 的 native ctx —— 那是训练上限，不是分配量。 */
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

/* ── 合并 ─────────────────────────────────────────────────── */

export interface LocalCapabilityInput {
  /** `/props` 响应体（未取到传 undefined） */
  props?: unknown;
  /** `/v1/models` 响应体（未取到传 undefined） */
  models?: unknown;
  /** `/props` 的 HTTP 状态码；null = 连不上 */
  propsStatus?: number | null;
  /** `/v1/models` 的 HTTP 状态码；null = 连不上 */
  modelsStatus?: number | null;
  /** 期望的模型别名（S4） */
  alias?: string;
}

/**
 * 把两个端点的响应合成一份能力快照。
 *
 * 状态判定优先用 `/props`：它是"生成设置"的镜像，比模型清单更贴近"现在能不能用"。
 * 两个端点都取不到状态（都没发请求）→ 按 `down`，**不假装 ready**。
 *
 * 数字冲突（`/props` 与 `/v1/models` 给的 `n_ctx` 不一致）以 `/props` 为准并记 signal：
 * 它是服务**当前**的生成设置，而模型清单可能来自缓存/另一个实例。
 */
export function readLocalCapability(input: LocalCapabilityInput): LocalServerCapability {
  const props = parsePropsPayload(input.props);
  const models = parseModelsPayload(input.models, input.alias);

  const pStatus = input.propsStatus ?? null;
  const mStatus = input.modelsStatus ?? null;

  /* 状态：优先 /props；它没说话（undefined → null）就用 /v1/models 的。 */
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

  /* 数字：/props 优先。 */
  let effectiveCtx = props.effectiveCtx ?? models.effectiveCtx ?? null;
  if (props.effectiveCtx !== undefined && models.effectiveCtx !== undefined
      && props.effectiveCtx !== models.effectiveCtx) {
    signals.push(`n_ctx 冲突：/props=${props.effectiveCtx} vs /v1/models=${models.effectiveCtx} → 采用 /props`);
  }
  const trainCtx = models.trainCtx ?? null;

  /* A-1018 ③ 的**显式反例**：有效窗口大于训练上限。llama.cpp 允许这么配（RoPE 外推），
     但此时"训练上限"再也不能被当作可用量展示 —— 记下来，供 UI 解释。 */
  if (effectiveCtx !== null && trainCtx !== null && effectiveCtx > trainCtx) {
    signals.push(`有效窗口 ${effectiveCtx} 超过训练上限 ${trainCtx}（RoPE 外推），以有效窗口为准`);
  }

  /* 就绪却没有数字 = 我们这个解析器不认识这个版本的服务端。
     这是**回归信号**（llama.cpp 改字段名了），要能被看见，而不是静悄悄返回 null。 */
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

/* ── 窗口上限的**唯一**决策点 ─────────────────────────────── */

/** 窗口上限的判据来源（诊断 + 守卫锚点） */
export type WindowCapSource =
  /** 用户/Agent 显式配置 —— 最高优先，允许**故意**小于服务器窗口（省显存/省钱） */
  | "agent"
  /** 服务端自述（`/props` 的 `n_ctx`）—— 权威 */
  | "server"
  /** `slime.toml` 的 `ctx_len` —— **同域**兜底：它就是启动时下发的 `-c` */
  | "planned"
  /** 远端 provider 的模型规格 `context_window` */
  | "provider"
  /** 无来源 → 调用方必须自行兜底（渲染层不许再落家族能力表） */
  | "none";

export interface WindowCapResolution {
  ctx: number | undefined;
  source: WindowCapSource;
  signals: string[];
}

/**
 * 会话上下文窗口上限的**唯一**决策函数（A-933 语义，S1 重写）。
 *
 * 优先级（高 → 低）：
 *   1. `agentMaxContext`  —— 显式覆盖（对齐 Claude Code 可自定义窗口阈值）
 *   2. `serverCtx`        —— **问服务器**（`/props.n_ctx`）。这是本文件存在的理由
 *   3. `plannedCtx`       —— `slime.toml` 的 `ctx_len`。**只在服务器问不到时**用；
 *                            它不是"另一个真相源"，而是同一个值的**输入侧**（`-c` 的来源）。
 *   4. `providerSpecCtx`  —— 远端模型的 provider 规格
 *
 * ⚠️ **这里永远不读家族能力表**。表里是训练窗口（qwen3 = 524K），不是分配量（8192），
 *    混用就是 A-1018 ③（"界面显示还有余量、请求被上游拒收"）。S5 会把渲染层那侧也删干净。
 */
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

/* ── 展示辅助 ─────────────────────────────────────────────── */

/** 千分位（界面文案用；避免各处重复写 `toLocaleString` 造成不一致） */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * 人话描述"这次能装多少"，**并在有效窗口 ≠ 训练上限时把两者都写出来**。
 * 这是 A-1018 ③ 的正面表达：用户看到"本次 8,192（模型训练上限 40,960）"就不会
 * 再以为还有 30K 余量。
 */
export function describeWindowCap(cap: Pick<LocalServerCapability, "state" | "effectiveCtx" | "trainCtx">): string {
  if (cap.state === "loading") { return "模型加载中…"; }
  if (cap.state === "down") { return "本地服务未启动"; }
  if (cap.effectiveCtx === null) { return "上下文窗口未知"; }
  const eff = fmt(cap.effectiveCtx);
  if (cap.trainCtx === null || cap.trainCtx === cap.effectiveCtx) { return `本次 ${eff}`; }
  return `本次 ${eff}（模型训练上限 ${fmt(cap.trainCtx)}）`;
}
