/**
 * shared/model-capabilities.ts — 模型能力单一真相源（双栈共用）。
 *
 * 背景（A-918+ 单源合并）：此前「推理等级」有两条互相漂移的数据链——
 *   - gui/src/main/providers.ts 的 inferThinkingSupport（ID 正则硬编码，deepseek 只匹配 reasoner/r1）
 *   - gui/src/renderer/reasoning.ts 的 REASONING_PRESETS（供应商预设，deepseek=low/high/max）
 * 两份数据不一致、都覆盖不了新模型 ID（如 deepseek-v4-pro），导致「思考能力误判 / 推理等级缺失」。
 *
 * 本文件为唯一来源，提供：
 *   - MODEL_CAPABILITIES：按供应商组织的模型能力预制表（thinking 支持 + 推理等级 + 思考协议）
 *   - inferModelCapabilities(modelId)：按 ID 正则匹配返回能力（上游拉取失败时的兜底）
 *   - sortEfforts(levels)：按共识顺序稳定排序
 *
 * 合并策略（用户指定）：上游 /models 拉取到的配置优先；上游未提供时回退本表。
 *
 * ⚠️ 定位：本表是 slime 的**离线兜底底线**——当上游 /models 拉取失败时，用户仍能正常使用。
 * 必须覆盖**全部主流模型家族**（国际 + 国内），协议随各厂商官方文档更新（官方文案改了就同步改这里）。
 * 维护方式：新增模型 → 在对应 vendor 的 models 数组加一条 { match, thinking, efforts, thinkingParam }；
 *          新增供应商 → 加一个顶层 vendor 条目。数据与业务逻辑完全分离，可持续更新。
 */

/** 单条模型能力预制（match 为大小写不敏感正则） */
export interface ModelCapability {
  /** 模型 ID 匹配正则（不区分大小写） */
  match: string;
  /** 是否支持 thinking/reasoning */
  thinking: boolean;
  /** 推理等级（升序，业界共识顺序；缺省 = 仅开/关，无等级） */
  efforts?: string[];
  /**
   * 开启思考所使用的**请求参数协议**（缺省 "reasoning_effort"，向后兼容）：
   *   - "reasoning_effort"    ：OpenAI GPT-5/o、Gemini、Grok、Kimi、MiniMax、Mistral、DeepSeek、GLM 等
   *   - "chat_template_kwargs"：llama.cpp 系 / Agnes / NVIDIA Nemotron / Meta Llama / 腾讯混元
   *                            （`chat_template_kwargs.enable_thinking`）
   *   - "enable_thinking"     ：通义千问 DashScope 兼容模式（`enable_thinking` + `return_reasoning`）
   *   - "thinking"            ：字节豆包 / 智谱 GLM 风格（`thinking:{type:"enabled"}`，无 budget）
   *
   * 为什么需要这个字段：**「支持思考」与「怎么开思考」是两件事**。早期实现对所有家族统一发
   * `reasoning_effort`，对不认该参数的家族要么被忽略（→ 永远没有思考文本），要么直接 400
   * （→ 整个请求失败）。把开关协议也做成数据，新增模型时一眼能填对。
   *
   * 维护提醒：本表是**上游 /models 拉取失败时的离线兜底**，协议随各厂商官方文档更新，
   * 改动时请同步更新上面这份协议说明。
   */
  thinkingParam?: ThinkingParam;
  /**
   * 模型家族的**原生端点格式**（缺省 "openai"）：
   *   - "responses" ：OpenAI GPT-5/6（官方走 /v1/responses）
   *   - "anthropic" ：Claude（官方走 /v1/messages）
   *   - "google"    ：Gemini（官方走 generateContent）
   *   - "openai"    ：其余绝大多数（chat/completions）
   * 注意：仅对「官方原生端点」生效；中转站/聚合网关统一 openai（chat/completions，见 isAggregatorGateway）。
   */
  endpoint?: Endpoint;
  /**
   * 上下文窗口（token）与最大输出（token）——**上游 /models 未提供元数据时的兜底值**。
   * 模型级优先于供应商级（VendorCapabilities.context / maxOut）。
   *
   * 为什么放在这里：此前上下文/输出由 providers.ts 的 inferModelDefaults 单独维护一张
   * 「gpt-4 时代」的正则表，与能力表长期脱节——实测 gpt-6-astra / gemini-3.8-flash 因旧正则
   * （`gpt[-_]4o`、`gemini[-_](2\.0|1\.5|...)`）不匹配而兜底成「无上下文」。
   * 两表合并为同一真相源，杜绝漂移。
   */
  context?: number;
  maxOut?: number;
  /**
   * 兜底定价（**USD / 1M tokens**，与 providers.enc.json 的 `price_in_usd` 同单位同语义）。
   * 上游 /models 或网关 /api/pricing 回传价格时**以上游为准**，本字段只是离线兜底。
   *
   * 维护铁律（A-970 定价事故的教训）：
   *   1. **只填已核实的官方刊例价**（注明核实日期与来源）。核实不了就留空 → UI 显示
   *      「未定价 · 可填写」，让用户自己填。**宁可留空，也不要填猜测值**：错的低价会让
   *      成本统计长期失真，而且因为"看起来有数字"而极难被发现。
   *   2. 单位一律 USD/1M tokens。**不要**写人民币再想当然地 ÷ 汇率——历史事故：
   *      deepseek 的美元价 0.14/0.28 被当成人民币再 ÷7.25，成本统计整体缩水 7.25 倍。
   *   3. 单价为 0 是**有意义的取值**（官方限时免费），与"未定价（undefined）"必须区分开。
   *   4. 上下架/调价频繁，改动时同步更新注释里的核实日期。
   */
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /**
   * 峰谷分时定价规格（**可选**，见 `ModelPriceTiers`）。
   * 填了它 → 单价随请求时刻变化，`resolveModelPriceTier(modelId, ts)` 给出该时刻的真实档位；
   * 上面的平铺字段退化为"无时刻信息时的兜底价"（填**高峰标准价**，不要填均值）。
   */
  priceTiers?: ModelPriceTiers;
}

/** 开启思考的请求参数协议 */
export type ThinkingParam = "reasoning_effort" | "chat_template_kwargs" | "enable_thinking" | "thinking";

/** 模型家族的原生端点格式 */
export type Endpoint = "openai" | "anthropic" | "responses" | "google";

/* ═══════════════ 分时（峰谷）定价 ═══════════════ */

/**
 * 分时定价的**时段窗**（按 `ModelPriceTiers.timezone` 的**墙上时间**判定，与用户本机时区无关）。
 * 左闭右开：`[startMin, endMin)` —— 09:00 判在高峰、12:00 判在高峰之外，边界不重叠。
 */
export interface PriceTierWindow {
  /** 生效星期（0=周日 … 6=周六）；缺省 = 每天 */
  days?: number[];
  /** 当天起算分钟数（0..1439），含 */
  startMin: number;
  /** 当天起算分钟数（0..1439），不含 */
  endMin: number;
}

/** 一个分时档位（如「高峰」「空闲」），档位自带该时段的单价 */
export interface ModelPriceTier {
  /** 档位 id（写进 usage 记录的 `price_tier`，用于事后核对"这条为什么贵"）：如 "peak" / "offpeak" */
  id: string;
  /** 展示名（UI 用）：如 "高峰时段" */
  label?: string;
  /** 生效时段；**缺省 = 兜底档**（其余所有时段），一个规格里应恰有一个 */
  windows?: PriceTierWindow[];
  priceIn: number;
  priceOut: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
}

/**
 * 分时定价规格（挂在 `ModelCapability.priceTiers` / `VendorCapabilities.priceTiers`）。
 *
 * 为什么要有这个字段：**峰谷分时已是主流计价模式**（DeepSeek 等），而 `priceIn/priceOut`
 * 是单一数值、表达不了时段。旧写法只能取"峰谷均值"——那是个**在任何真实时段都不存在**的价格，
 * 单条记录最多偏 ±33%（且偏差方向随机，看不出来）。把时段做成数据后，
 * 每条记录按**自己 ts 所在档位**计价，误差从 ±33% 收敛到 0。
 *
 * 维护铁律：**只为已核实的官方分时规则填此字段**（注释写清核实日期与来源）。
 * 平铺字段 `priceIn/priceOut/...` 此时应填**高峰标准价**（真实存在的档位，而不是均值），
 * 它只在"没有时间信息"的场景兜底（如面板展示、无法确定时刻的历史记录）。
 */
export interface ModelPriceTiers {
  /**
   * 判定所用时区（IANA 名，如 "Asia/Shanghai"）。
   * ⚠️ 必须是**供应商的计费时区**，不是用户本机时区 —— 用户在国外跑，账单仍按供应商的钟。
   * 非法时区名时退回兜底档（不会崩、也不会静默记 0）。
   */
  timezone: string;
  /** 档位表：取**首个** windows 命中的档；都不命中 → 取无 windows 的兜底档 */
  tiers: ModelPriceTier[];
}

/**
 * 明确「非对话」模型 ID 特征（命中则不支持思考，也不发思考参数）：
 *   - 检索/排序/审核：embedding、rerank、moderation
 *   - 音频：tts / text-to-speech / asr / whisper / transcrib / speech
 *   - 图像/视频生成：image、video、dall-e、stable-diffusion、sdxl、flux、midjourney、sora、imagen
 * 这些模型不会返回 reasoning_content，发思考参数只会触发 400。
 */
const NON_CHAT_MODEL_RE = /(embedding|rerank|re-?rank|moderation|tts|text-to-speech|speech|asr|whisper|transcrib|dall-?e|stable-?diffusion|sdxl|flux|midjourney|sora|imagen|image|video|audio)/i;

/**
 * 已知「中转站 / 聚合网关」域名特征（OpenAI 兼容端点）。
 * 中转站聚合多家模型，其 OpenAI 兼容端点只认 reasoning_effort（转发时再转成各家原生协议）；
 * 而官方原生端点（DashScope 的 enable_thinking、agnes/nemotron 的 chat_template_kwargs、豆包的 thinking.type）
 * 必须保留家族协议。因此「同一模型名」在中转站 vs 官方下的思考开关协议不同，不能混淆。
 * 维护：新增中转站 → 在此追加域名特征；随各中转站官方文档更新。
 */
const AGGREGATOR_HOST_RE = /(openrouter|siliconflow|together|groq|opencode|one[-_]?api|agi[-_]?anyi|fireworks|anyscale|deepbricks|monsterapi|openai\.com\/zen)/i;

/** 判断 baseUrl 是否为「中转站 / 聚合网关」（OpenAI 兼容，思考参数统一 reasoning_effort） */
export function isAggregatorGateway(baseUrl: string): boolean {
  return AGGREGATOR_HOST_RE.test((baseUrl ?? "").toLowerCase());
}

/** 本地 / 内网端点特征：loopback、通配地址、容器内主机名、私有网段 */
const LOCAL_ENDPOINT_RE = /^(https?:\/\/)?(\[[0-9a-f:]+\]|localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)/i;
const PRIVATE_ENDPOINT_RE = /^https?:\/\/(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./i;

/**
 * 判断 baseUrl 是否为**本地 / 内网推理端点**：跑在自己的机器（或内网）上，没有按 token 计费的账单。
 *
 * 为什么放进共享层：**两个地方必须给出同一个答案** ——
 *   1. `inferPricingFromUrl`（gui/main/providers.ts）：本地端点 → 显式价 0（"免费"而非"未定价"）；
 *   2. `recordUsage`（core-ts/services/engine.ts）：本地端点 → **不得**套用官方刊例价/分时价。
 * 两份正则各写一遍，就会出现"面板说免费、引擎却按官方价记账"的分裂 —— 本文件存在的全部理由
 * 就是消灭这种双份真相源。
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const url = (baseUrl ?? "").trim();
  return LOCAL_ENDPOINT_RE.test(url) || PRIVATE_ENDPOINT_RE.test(url);
}

/** 供应商能力组 */
export interface VendorCapabilities {
  /** 供应商 key（deepseek/openai/claude/...） */
  key: string;
  /** 展示名 */
  label: string;
  /** 该供应商的模型能力预制（按顺序匹配，首个命中即返回） */
  models: ModelCapability[];
  /**
   * 供应商级兜底：上下文窗口（token）与最大输出（token）。
   * 当命中的模型条目未单独标 context/maxOut 时使用（上游 /models 未给元数据时的兜底）。
   */
  context?: number;
  maxOut?: number;
  /** 供应商级兜底定价（USD/1M tokens）：模型条目未单独标价时使用（语义见 ModelCapability 同名字段） */
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /** 供应商级分时规格（模型条目未单独标时分时时使用；语义见 ModelPriceTiers） */
  priceTiers?: ModelPriceTiers;
}

/** 推理强度行业共识顺序（2026 全网调研）：none ≤ minimal ≤ low ≤ medium ≤ high ≤ xhigh ≤ max */
export const EFFORT_RANK: Record<string, number> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, maximal: 7, adaptive: 8, auto: 9,
};

/**
 * DeepSeek 的**计费时区**与**高峰时段窗**（官方 2026-09-16 英文定价页）。
 *
 * 高峰 = 北京时间（Asia/Shanghai，UTC+8，无夏令时）周一至周五 09:00-12:00 与 14:00-18:00；
 * 其余（含午休 12:00-14:00、夜间、整个周末）为空闲，空闲价为高峰价的一半。
 *
 * ⚠️ 时区必须是 `Asia/Shanghai` 而非 `UTC`：把高峰窗按 UTC 解释会让国内的账单整体错 8 小时
 *    （北京时间 09:30 的高峰请求，UTC 墙上时钟是 01:30 → 会被判成空闲，成本直接腰斩）。
 *    这也是本字段存 IANA 名而不是固定偏移的原因 —— 便于将来接有夏令时的厂商。
 */
const DEEPSEEK_TZ = "Asia/Shanghai";
const DEEPSEEK_PEAK_WINDOWS: PriceTierWindow[] = [
  { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 12 * 60 },
  { days: [1, 2, 3, 4, 5], startMin: 14 * 60, endMin: 18 * 60 },
];

/**
 * 主流模型能力预制表（单一真相源；上游 /models 拉取失败时的离线兜底）。
 * 覆盖国际 + 国内主流家族；「思考协议」按官方文档标注，随官方文案更新。
 * 注意：数组顺序即匹配优先级（首个命中返回），有前缀包含关系的家族需靠前（如 muse 在 spark 前）。
 */
export const MODEL_CAPABILITIES: VendorCapabilities[] = [
  // ────────── 国际 · 云厂商 API（OpenAI 兼容，reasoning_effort 为主）──────────
  {
    key: "openai",
    label: "OpenAI（GPT-5 / o 系列）",
    context: 1000000,
    maxOut: 128000,
    models: [
      // GPT-5 及更高（GPT-6/7/...）：统一推理模型，reasoning_effort 开思考；官方走 /v1/responses
      { match: "gpt[-_]?[5-9]", thinking: true, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], endpoint: "responses" },
      // o 系列（o1/o3/o4/o5/...）：边界锚定避免误匹配含 "o" 的其它 ID
      { match: "(^|[^a-z0-9])o[1-9]([^a-z0-9]|$)", thinking: true, efforts: ["low", "medium", "high"] },
      // ── 旧模型（gpt-4o 世代）：仍活在大量历史 usage 记录与供应商预设里 ──
      // 必须补上**各自真实**的上下文，否则会落到供应商级兜底（context=1M）——
      // gpt-4o 实际只有 128K，被吹成 1M 会污染上下文计量与自动压缩阈值。
      // 价格 USD/1M，OpenAI 官方长期稳定刊例（核实 2026-09-16）：4o $2.5/$10、4o-mini $0.15/$0.6、4-turbo $10/$30。
      { match: "gpt[-_]4o[-_]?mini", thinking: false, context: 128000, maxOut: 16384, priceIn: 0.15, priceOut: 0.6 },
      { match: "gpt[-_]4o", thinking: false, context: 128000, maxOut: 16384, priceIn: 2.5, priceOut: 10 },
      { match: "gpt[-_]4[-_]?turbo", thinking: false, context: 128000, maxOut: 4096, priceIn: 10, priceOut: 30 },
      // ⚠️ GPT-5 及更高（含 o 系列）**刻意不定价**：官方按「短 / 长上下文」分档（如 5.5 短档
      //    $5/$30、长档 $10/$45），一个正则键表达不了两档价。宁可让面板显示「未定价」由用户
      //    按实际档位手填（Provider 面板已提供单价输入列），也不填一个平均价 ——
      //    长上下文场景误差可达 2 倍，而"看起来有数字"的错价几乎不会被发现。
    ],
  },
  {
    key: "claude",
    label: "Anthropic Claude",
    context: 200000,
    maxOut: 64000,
    models: [
      // Anthropic Messages 原生用 thinking.budget_tokens；OpenAI 兼容端点用 reasoning_effort。
      // 官方走 /v1/messages（endpoint=anthropic）；走 AnthropicClient 时 toAnthropicThinking 归一 thinking.budget_tokens。
      // 定价（USD/1M，官方刊例；opus/sonnet/haiku 三档价差 5x，必须拆成独立条目——此前合并成一条会把
      // Opus 当 Sonnet 计价，成本低估 5 倍）：Opus $15/$75、Sonnet $3/$15、Haiku $0.8/$4。
      { match: "claude.*opus", thinking: true, efforts: ["low", "medium", "high", "xhigh", "max"], endpoint: "anthropic", priceIn: 15, priceOut: 75, priceCacheRead: 1.5, priceCacheWrite: 18.75 },
      { match: "claude.*haiku", thinking: true, efforts: ["low", "medium", "high"], endpoint: "anthropic", priceIn: 0.8, priceOut: 4, priceCacheRead: 0.08, priceCacheWrite: 1 },
      { match: "claude[-_](opus|sonnet)", thinking: true, efforts: ["low", "medium", "high", "xhigh", "max"], endpoint: "anthropic", priceIn: 3, priceOut: 15, priceCacheRead: 0.3, priceCacheWrite: 3.75 },
      { match: "claude", thinking: true, efforts: ["low", "medium", "high"], endpoint: "anthropic" },
    ],
  },
  {
    key: "gemini",
    label: "Google Gemini",
    context: 1048576,
    maxOut: 65536,
    models: [
      // Google OpenAI 兼容端点支持 reasoning_effort（low/medium/high）；官方原生走 generateContent（endpoint=google）
      { match: "gemini", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google" },
    ],
  },
  {
    key: "grok",
    label: "xAI Grok",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "grok", thinking: true, efforts: ["low", "medium", "high", "xhigh"] },
    ],
  },
  {
    key: "mistral",
    label: "Mistral（含 Mixtral）",
    context: 131072,
    maxOut: 32768,
    models: [
      { match: "mistral|mixtral", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "cohere",
    label: "Cohere Command",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "cohere|command", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "amazon",
    label: "Amazon Nova / Titan",
    context: 200000,
    maxOut: 65536,
    models: [
      { match: "amazon|nova[-_.]|titan", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },

  // ────────── 国际 · 开源 / 本地（llama.cpp 族，chat_template_kwargs.enable_thinking）──────────
  {
    key: "llama",
    label: "Meta Llama",
    context: 131072,
    maxOut: 32768,
    models: [
      // llama.cpp：enable_thinking=true via chat_template_kwargs（Llama 4 起支持 reasoning）
      { match: "llama", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "gemma",
    label: "Google Gemma（开源）",
    context: 131072,
    maxOut: 65536,
    models: [
      // 开源 Gemma 走 llama.cpp/vLLM：chat_template_kwargs.enable_thinking
      { match: "gemma", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "gpt-oss",
    label: "OpenAI gpt-oss（开源）",
    context: 131072,
    maxOut: 65536,
    models: [
      // gpt-oss 开源权重走 llama.cpp：chat_template_kwargs（注意不被上面 gpt[-_]?[5-9] 命中）
      { match: "gpt[-_]?oss", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "nemotron",
    label: "NVIDIA Nemotron",
    context: 131072,
    maxOut: 65536,
    models: [
      // NGC/SGLang 官方文档：思考开关是 chat_template_kwargs.enable_thinking（默认开启），不是 reasoning_effort
      { match: "nemotron", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "granite",
    label: "IBM Granite",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "granite", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "phi",
    label: "Microsoft Phi",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "phi[-_]?[0-9]", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },

  // ────────── 国内 · 云厂商 API ──────────
  {
    key: "deepseek",
    label: "DeepSeek（V4）",
    context: 1048576,
    maxOut: 65536,
    models: [
      // DeepSeek 全系（v2/v3/v4/chat/reasoner/r1）识别为思考模型；medium 内部映射 high
      //
      // 定价（USD/1M tokens）：来源为官方**英文**定价页
      // https://api-docs.deepseek.com/quick_start/pricing 的美元刊例价，核实于 2026-09-16。
      //   ⚠️ 该站中英两版**计价货币不同**：中文页（/zh-cn/…）单位是人民币「元」，
      //      英文页才是美元 $。本表一律取英文页 —— 拿错页就是下面那条历史事故。
      // 官方为**峰谷分时**（空闲价 = 高峰价的一半；高峰时段 = 北京时间周一至周五
      // 09:00-12:00 与 14:00-18:00，其余为空闲）→ 见 priceTiers（DEEPSEEK_PEAK_WINDOWS）。
      //   deepseek-flash  : 命中 0.003/0.006 · 未命中输入 0.15/0.30 · 输出 0.60/1.20（空闲/高峰）
      //   deepseek-v4-pro : 命中 0.022/0.044 · 未命中输入 0.66/1.32 · 输出 1.98/3.96（空闲/高峰）
      // 平铺字段（priceIn/priceOut/priceCacheRead）填**高峰标准价** —— 真实存在的档位，
      // 只在"没有时刻信息"时兜底（面板展示 / 无法确定时刻的历史行）。
      // ⚠️ 这里**曾经**填峰谷均值（= 高峰 × 0.75）：均值在任何真实时段都不存在，
      //    单条记录最多偏 ±33%，且偏差方向随机。有了 priceTiers 后已不再需要这种妥协。
      // ⚠️ 顺序：`deepseek.*pro` 必须排在宽泛的 `deepseek` 之前（首个命中即返回）。
      // ⚠️ 历史事故：此处曾写成 `0.14 / 7.25`（把**美元**刊例价又当成人民币除了一次汇率），
      //    导致成本整体缩水 7.25 倍，而且浮点常量看不出换算来源、极难发现。
      //    要引入汇率换算前，先停下来确认单位到底是 USD 还是 CNY（中文页是 CNY，别拿错页）。
      {
        match: "deepseek.*pro", thinking: true, efforts: ["low", "high", "max"],
        priceIn: 1.32, priceOut: 3.96, priceCacheRead: 0.044,
        priceTiers: {
          timezone: DEEPSEEK_TZ,
          tiers: [
            { id: "peak", label: "高峰时段", windows: DEEPSEEK_PEAK_WINDOWS, priceIn: 1.32, priceOut: 3.96, priceCacheRead: 0.044 },
            { id: "offpeak", label: "空闲时段", priceIn: 0.66, priceOut: 1.98, priceCacheRead: 0.022 },
          ],
        },
      },
      // 兜底档：flash / chat / reasoner / v2 / v3 / r1 全系。旧端点 deepseek-chat / deepseek-reasoner
      // 已于 2026-07-24 下线，官方说明其请求由 DeepSeek-V4.1-Flash 提供服务并按 Flash 价计费 ——
      // 历史记录按 Flash 价回填与该说明一致。
      {
        match: "deepseek", thinking: true, efforts: ["low", "high", "max"],
        priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006,
        priceTiers: {
          timezone: DEEPSEEK_TZ,
          tiers: [
            { id: "peak", label: "高峰时段", windows: DEEPSEEK_PEAK_WINDOWS, priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006 },
            { id: "offpeak", label: "空闲时段", priceIn: 0.15, priceOut: 0.6, priceCacheRead: 0.003 },
          ],
        },
      },
    ],
  },
  {
    key: "qwen",
    label: "通义千问 Qwen",
    context: 131072,
    maxOut: 32768,
    models: [
      // DashScope 兼容模式：enable_thinking 开思考、return_reasoning 直接回传思考文本
      { match: "qwen", thinking: true, efforts: ["low", "medium", "xhigh"], thinkingParam: "enable_thinking" },
    ],
  },
  {
    key: "glm",
    label: "智谱 GLM",
    context: 128000,
    maxOut: 16384,
    models: [
      // GLM OpenAI 兼容端点认 reasoning_effort（原生 API 用 thinking.type，但 OpenAI 兼容走 reasoning_effort）
      // ⚠️ 顺序修正：旧本地表把宽泛的 `glm[-_]4[-_]` 排在前，`glm-4-flash` 永远命中不到后面那条
      //    "免费档" → 免费模型被当付费计价。**窄条目必须排前**（同 muse 必须先于 spark 的教训）。
      // glm-4-flash 官方免费 → 显式 0（免费，非"未定价"）
      { match: "glm.*flash", thinking: true, efforts: ["low", "medium", "high"], priceIn: 0, priceOut: 0 },
      // glm-4 系按「¥0.6/M 输入、¥1.7/M 输出」换算（@7.25 CNY/USD）→ $0.083 / $0.234
      { match: "glm", thinking: true, efforts: ["low", "medium", "high"], priceIn: 0.083, priceOut: 0.234 },
    ],
  },
  {
    key: "kimi",
    label: "Moonshot Kimi",
    context: 262144,
    maxOut: 65536,
    models: [
      { match: "kimi", thinking: true, efforts: ["low", "high", "max"] },
    ],
  },
  {
    key: "minimax",
    label: "MiniMax（M 系 / abab）",
    context: 1000000,
    maxOut: 65536,
    models: [
      { match: "minimax|abab", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "doubao",
    label: "字节豆包 Doubao",
    context: 262144,
    maxOut: 65536,
    models: [
      // 火山引擎官方：thinking:{type:"enabled"|"disabled"|"auto"} 控制思考（无 budget_tokens）
      { match: "doubao", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "thinking" },
    ],
  },
  {
    key: "hunyuan",
    label: "腾讯混元 Hunyuan",
    context: 131072,
    maxOut: 65536,
    models: [
      // 混元 chat template：apply_chat_template(enable_thinking=True) → chat_template_kwargs 族
      { match: "hunyuan", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "ernie",
    label: "百度文心 Ernie",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "ernie", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "baichuan",
    label: "百川 Baichuan",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "baichuan", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "sensechat",
    label: "商汤 SenseChat / SenseNova",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "sensechat|sensenova", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "yi",
    label: "零一万物 Yi",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "yi[-_.]", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "minicpm",
    label: "面壁 MiniCPM",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "minicpm", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "skywork",
    label: "昆仑万维 Skywork",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "skywork", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "step",
    label: "阶跃星辰 Step",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "step[-_]", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },

  // ────────── 其它 / 社区 / 网关模型 ──────────
  {
    key: "muse",
    label: "Muse Spark",
    context: 131072,
    maxOut: 65536,
    models: [
      // 顺序依赖：必须在 spark 之前，否则 muse-spark-* 会误命中讯飞星火
      { match: "muse", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "spark",
    label: "讯飞星火 Spark",
    context: 131072,
    maxOut: 65536,
    models: [
      // 讯飞星火 spark-max/pro/lite/x1 等；muse-spark 已被上方 muse 家族优先命中
      { match: "spark[-_.]", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "agnes",
    label: "Agnes（自研 SILAM）",
    context: 524288,
    maxOut: 65536,
    models: [
      // 官方文档 Thinking 模式：OpenAI 兼容格式用 chat_template_kwargs.enable_thinking（实测有效）
      //
      // ── 定价（核实日期 2026-09-16；agnes-ai.com/zh-Hans/docs/pricing）──
      // ⚠️ 历史 bug 锚点：旧本地表对 Agnes **一律**返回 {0,0}（理由"当前免费"），把 agnes-2.5-pro
      //    也当免费 —— 而 Pro 档按刊例价正常计费（$0.45/$0.90），成本被静默清零。
      //    正确做法：只有真正处于 0 元档的模型写 0，其余写真实刊例价。
      // agnes-2.5-pro-beta：独立 Beta 价 $0.10/$0.30（缓存命中 $0.01）
      { match: "agnes.*pro.*beta", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs", priceIn: 0.1, priceOut: 0.3, priceCacheRead: 0.01 },
      // agnes-2.5-pro：按 Pro 系列刊例价计费 $0.45/$0.90（缓存命中 $0.045）
      { match: "agnes.*pro", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs", priceIn: 0.45, priceOut: 0.9, priceCacheRead: 0.045 },
      // agnes-*-flash（2.0 / 2.5 / 3.0）：官方**限时免费**（现价 $0；刊例价 $0.05/$0.15/命中 $0.005）。
      // 显式 0 = 免费，与 undefined（未定价）语义不同：免费模型成本恒为 0 是**正确结果**而非缺失。
      { match: "agnes", thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs", priceIn: 0, priceOut: 0, priceCacheRead: 0 },
    ],
  },
  {
    key: "note",
    label: "点点笔记 / 小红书（dots）",
    // 官方公布窗口 512K（此前误写 131072 → 上游未回传窗口时会被锁死显示 128K，用户实测）。
    context: 524288,
    maxOut: 65536,
    models: [
      // dots3 系默认即产出 reasoning_content（实测四种参数下均有思考，任意参数均安全）
      // match 放宽：dots / dots3 / dots.llm1 / dot4 / dot-4 都要命中（此前只写 "dots"，
      // 「dot4」这类写法不命中 → 退化到 128K 默认值）
      // 定价（核实日期 2026-09-16）：Dots 官方开放平台（dots.ai/platform，即本项目在用的
      // note3-prev-api.askdiandian.com）**限时免费** → 显式 0。第三方托管（如 DeepInfra）为
      // $2/$6/命中$0.20，走第三方域名时以该上游回传的 pricing 为准。官方免费期结束后需改这里。
      { match: "(^|[^a-z])dot[-_.]?s?(\\d|[^a-z]|$)", thinking: true, efforts: ["low", "medium", "high"], priceIn: 0, priceOut: 0, priceCacheRead: 0 },
    ],
  },
  {
    key: "mimo",
    label: "小米 MiMo",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "mimo", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "ling",
    label: "Ling",
    context: 131072,
    maxOut: 65536,
    models: [
      { match: "ling[-_]?\\d", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
];

/**
 * 定价待补清单（**已核实留空 = 故意不填，不是遗漏**）。
 *
 * 上述厂商中，下面这些**尚未核实官方刊例价**，故 `priceIn/priceOut` 刻意留空 ——
 * 命中它们时 `inferModelPricing` 返回 `{}`，UI 显示「未定价 · 可填写」，
 * 由用户在供应商面板手填真实单价（填完点「重算历史成本」即可回填已有记录）。
 *
 *   kimi/moonshot · qwen(通义) · minimax · doubao(豆包) · hunyuan(混元) · ernie(文心)
 *   baichuan · sensechat(商汤) · yi(零一) · minicpm · skywork · step(阶跃)
 *   muse · spark(讯飞) · mimo(小米) · ling · grok · mistral · cohere · amazon
 *   llama · gemma · gpt-oss · nemotron · granite · phi
 *   openai 的 GPT-5+ 与 o 系列（同族多档价差大，单一正则无法区分）
 *
 * 核实方法（**必须走官方文档，不要凭印象**）：
 *   1. 打开该厂商官方定价页，抄「输入（缓存未命中）/ 输出 / 缓存命中」三项；
 *   2. 若官方以人民币计价，**显式除以当日汇率并在注释里写出换算过程**（浮点常量看不出来源）；
 *   3. **若有峰谷/分时价 → 填 `priceTiers`（时刻档位 + 计费时区），平铺字段填高峰标准价**。
 *      ⚠️ 不要再取"峰谷均值"：均值在任何真实时段都不存在，单条最多偏 ±33%（旧做法，已废弃）。
 *      若是限时免费，写 0 并注明"限时"；
 *   4. 在注释里写上核实日期。宁可一直留空，也不要填一个"看起来合理"的猜测值 ——
 *      错的低价会让成本统计长期失真，且因为"有数字"而极难被发现。
 */

/**
 * 定价兜底查询。
 *
 * ⚠️ 为什么是**独立函数**而不是给 inferModelCapabilities 加字段：后者被大量 `toEqual`
 * 精确断言锁定（见 tests/core-ts/model-capabilities.spec.ts），在返回值上追加字段会一次性
 * 打破全部断言。两者共用同一张 MODEL_CAPABILITIES 表，数据仍只有一份，不会漂移。
 *
 * 返回语义（**关键：区分「免费」与「未知」**）：
 *   - `{}`（各字段均 undefined）→ **未定价**：没有可信价格 → UI 显示「未定价 · 可填写」
 *   - `{ priceIn: 0, priceOut: 0 }`   → **免费**：官方现价就是 0，成本恒为 0 是**正确结果**
 *   把两者混为一谈，正是"一堆模型显示未定价、却看不出哪些是真免费"的根源。
 *
 * 单位：USD / 1M tokens（与 providers.enc.json 的 price_in_usd 语义一致）。
 * 优先级：上游 /models 或网关 /api/pricing > 用户已保存值 > 本表（离线兜底）。
 */
export interface ModelPricing {
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /** 命中的供应商 key（排障与 UI「价格来自内置价目表」提示用） */
  vendor?: string;
}

/** 命中的模型条目（家族 + 模型级），供定价相关函数共用同一套匹配逻辑 */
interface PricingEntry { vendor: VendorCapabilities; model: ModelCapability }

/**
 * 按模型 ID 找首个命中的定价条目（大小写不敏感；非对话模型直接不参与 token 定价）。
 * 抽成独立函数的原因：`inferModelPricing` 与 `resolveModelPriceTier` **必须命中同一条目**，
 * 两份匹配循环会再次漂移出"一个认一个不认"的经典 bug（本文件就是为消除双份真相源而生）。
 */
function findPricingEntry(modelId: string): PricingEntry | undefined {
  const id = (modelId ?? "").toLowerCase();
  if (!id) { return undefined; }
  // 非对话模型（图像/音频/视频/embedding）按次或按秒计费，套 token 单价没有意义
  if (NON_CHAT_MODEL_RE.test(id)) { return undefined; }
  for (const v of MODEL_CAPABILITIES) {
    for (const m of v.models) {
      try {
        if (new RegExp(m.match, "i").test(id)) { return { vendor: v, model: m }; }
      } catch {
        // 非法正则该条目跳过（数据维护错误不影响其它匹配）
        continue;
      }
    }
  }
  return undefined;
}

/** 把条目的平铺价（模型级 > 供应商级）整理成 ModelPricing；全 undefined 时返回 `{}` */
function flatPricing(entry: PricingEntry): ModelPricing {
  const { vendor: v, model: m } = entry;
  const priceIn = m.priceIn ?? v.priceIn;
  const priceOut = m.priceOut ?? v.priceOut;
  const priceCacheRead = m.priceCacheRead ?? v.priceCacheRead;
  const priceCacheWrite = m.priceCacheWrite ?? v.priceCacheWrite;
  // 命中家族但该家族未定价 → 仍然是「未定价」，不能返回 {priceIn: undefined} 让上层误当已解析
  if (priceIn === undefined && priceOut === undefined
    && priceCacheRead === undefined && priceCacheWrite === undefined) {
    return {};
  }
  return { priceIn, priceOut, priceCacheRead, priceCacheWrite, vendor: v.key };
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** `Intl.DateTimeFormat` 实例缓存：格式化器构造相当贵，而逐条记录都要算一次 */
const zonedFmtCache = new Map<string, Intl.DateTimeFormat | null>();

/**
 * 取某时刻在指定 IANA 时区下的**墙上时钟**（星期 + 当天分钟数）。
 * 用 `Intl` 而非手写偏移：零依赖、自带 IANA 库、将来接有夏令时的厂商不用改代码。
 * `hourCycle: "h23"` 而非 `hour12: false` —— 后者在部分实现下把午夜给成 "24"，会算出 1440 分钟。
 * 时区名非法（手误 / 精简版 Node 无完整 ICU）→ 返回 undefined，由调用方退回兜底档。
 */
function zonedWallClock(date: Date, timeZone: string): { weekday: number; minute: number } | undefined {
  if (!Number.isFinite(date.getTime())) { return undefined; }
  let fmt = zonedFmtCache.get(timeZone);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit",
      });
    } catch {
      fmt = null; // 非法时区名：缓存 null 记下"这个时区不可用"，避免每条记录都抛一次
    }
    zonedFmtCache.set(timeZone, fmt);
  }
  if (!fmt) { return undefined; }
  try {
    const parts = fmt.formatToParts(date);
    const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
    const weekday = WEEKDAY_INDEX[pick("weekday")];
    const hour = Number(pick("hour"));
    const minute = Number(pick("minute"));
    if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) { return undefined; }
    return { weekday, minute: hour * 60 + minute };
  } catch {
    return undefined;
  }
}

/** 判断墙上时钟是否落在任一窗口内（左闭右开；`days` 缺省 = 每天） */
function inAnyWindow(windows: PriceTierWindow[], clock: { weekday: number; minute: number }): boolean {
  for (const w of windows) {
    if (w.days && w.days.length > 0 && !w.days.includes(clock.weekday)) { continue; }
    if (clock.minute >= w.startMin && clock.minute < w.endMin) { return true; }
  }
  return false;
}

/**
 * 按时刻挑档位：**首个 windows 命中的档**胜出；都不命中 → 无 windows 的兜底档。
 * 时区不可用时同样落到兜底档（**不会记 0**：宁可退回高峰标准价，也不要凭空把成本清零）。
 * 连兜底档都没有（数据缺 windows 也没标兜底）→ 取第一档，保证"有分时规格就一定有价"。
 */
export function resolveTierId(
  tiers: ModelPriceTier[], at: Date | string | number, timezone: string,
): ModelPriceTier | undefined {
  if (tiers.length === 0) { return undefined; }
  const ts = at instanceof Date ? at : new Date(at);
  const clock = zonedWallClock(ts, timezone);
  if (clock) {
    for (const t of tiers) {
      if (t.windows && t.windows.length > 0 && inAnyWindow(t.windows, clock)) { return t; }
    }
  }
  return tiers.find((t) => !t.windows || t.windows.length === 0) ?? tiers[0];
}

/** 分时档位解析结果（`tiered=false` 表示该模型没有分时规格，走平铺价） */
export interface TierResolution {
  /** 命中的档位 id（如 "peak"/"offpeak"）；无分时规格时为 "flat" */
  tierId: string;
  /** 档位展示名（无分时规格时 undefined） */
  label?: string;
  /** 判定所用 IANA 时区（无分时规格时 undefined） */
  timezone?: string;
  /** 该时刻生效的单价（含 vendor）；查不到价时为 `{}` */
  pricing: ModelPricing;
  /** 是否走了分时规格 */
  tiered: boolean;
}

/**
 * 解析「某模型在**某时刻**」的生效单价（分时定价的入口）。
 *
 * ⚠️ `at` 的含义：**请求发生的那一刻**，而不是"现在"。历史记录回填必须传该记录的 `ts`，
 * 否则会把半年前的深夜请求按今天此刻的高峰价重算 —— 分时定价的全部价值就在这个参数上。
 *
 * `at` 缺省时**不猜时刻**，直接返回平铺价（= 高峰标准价）。这是刻意的：
 *   - 面板展示 / enrichModels 这类"没有具体请求"的场景需要确定性结果，不能随时间跳动（否则测试必炸）；
 *   - 需要真实档位的地方（engine.recordUsage / 历史回填）本来就拿得到 ts，显式传即可。
 */
export function resolveModelPriceTier(modelId: string, at?: Date | string | number): TierResolution {
  const entry = findPricingEntry(modelId);
  if (!entry) { return { tierId: "flat", pricing: {}, tiered: false }; }
  const flat = flatPricing(entry);
  const spec = entry.model.priceTiers ?? entry.vendor.priceTiers;
  if (!spec || spec.tiers.length === 0 || at === undefined) {
    return { tierId: "flat", pricing: flat, tiered: false };
  }
  const tier = resolveTierId(spec.tiers, at, spec.timezone);
  if (!tier) { return { tierId: "flat", pricing: flat, tiered: false }; }
  // 档位缺项时回落到平铺价对应项：档位半成品不该让成本记 0（宁可高估，不可静默为零）
  return {
    tierId: tier.id,
    label: tier.label,
    timezone: spec.timezone,
    tiered: true,
    pricing: {
      priceIn: tier.priceIn ?? flat.priceIn,
      priceOut: tier.priceOut ?? flat.priceOut,
      priceCacheRead: tier.priceCacheRead ?? flat.priceCacheRead,
      priceCacheWrite: tier.priceCacheWrite ?? flat.priceCacheWrite,
      vendor: entry.vendor.key,
    },
  };
}

/**
 * 依据模型 ID 查内置兜底价（首个命中的家族条目；家族未定价则返回空对象）。
 * 传了 `at` 时返回**该时刻**的档位价（分时定价）；不传则返回平铺价（高峰标准价）。
 */
export function inferModelPricing(modelId: string, at?: Date | string | number): ModelPricing {
  return resolveModelPriceTier(modelId, at).pricing;
}

/** `providers.enc.json` 里单个模型的定价字段快照（存值） */
export interface StoredPricing {
  price_source?: string;
  price_in_usd?: number;
  price_out_usd?: number;
  price_cache_read_usd?: number;
  price_cache_write_usd?: number;
}

/**
 * 生效价的来源。**必须细分到能一眼看出"钱从哪来"**，不能合并：
 *   - `manual`  用户手填（可能是议价/合同价）—— 机器永不覆盖
 *   - `upstream` 上游探测（网关真实结算价）
 *   - `local`   本地/内网端点 → 恒 0（没有按 token 的账单）
 *   - `tier`    内置表的分时档（按请求时刻取档）
 *   - `table`   内置表平铺价（高峰标准价）
 *   - `stored`  兜底的历史残留值（表里查不到，且不是手填/上游）
 *   - `none`    **未定价** —— 表里没有已核实的价，成本会记成 0，需用户手填
 */
export type PriceOrigin = "manual" | "upstream" | "local" | "tier" | "table" | "stored" | "none";

/** 生效价解析结果（金额单位 USD / 1M tokens；`origin === "none"` 时两个金额无意义，UI 应按「未定价」呈现） */
export interface EffectivePricing {
  origin: PriceOrigin;
  priceIn: number;
  priceOut: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /** 命中内置表的供应商 key（排障用） */
  vendor?: string;
  /** 命中的分时档位 id（仅 `origin === "tier"`） */
  tierId?: string;
  tiered: boolean;
  /**
   * 存值被更高优先级来源取代时的原始存值（值不相同时才有）。
   *
   * 存在的理由：`providers.enc.json` 里躺着**机器自己写下的**历史错值（如 deepseek-v4-pro 的
   * 0.0193 = 美元刊例价又被按人民币除了一次汇率）。引擎按「分时档 > 表 > 存值」取值，
   * 那个 0.0193 实际不参与计费 —— 但面板如果只显示存值，用户会以为计费的就是它。
   * 把"被取代的存值"显式回传，UI 才能标出「这行存值引擎不采用」而不是让人自己去猜。
   */
  superseded?: { priceIn?: number; priceOut?: number };
}

/**
 * 解析「这个模型此刻**实际按什么价计费**」—— 全平台唯一的生效价入口。
 *
 * 优先级（**必须与引擎一致，否则面板与账目分裂**）：
 *   手填 / 上游结算价  >  本地端点 0  >  分时档  >  表平铺价  >  存值  >  未定价
 *
 * 为什么抽成共享函数：`recordUsage`（记钱）、供应商面板（显示）、历史回填（`makePriceResolver`）
 * 是三套独立实现，此前已经分裂出真实事故：
 *   - 面板看**存值**、引擎看**表** → 面板显示「未定价」而引擎按 0.3 计费（用户投诉"怎么还是没定价"）；
 *   - 本地端点（127.0.0.1）存值缺价时，引擎仍套官方刊例价 → 跑本地模型凭空产生账单。
 * 三处共用本函数即可根除这类分裂（本文件存在的全部理由）。
 *
 * ⚠️ `at` 与 `recordUsage` 的 `ts` 必须来自**同一个 Date**，否则会写出
 * "记录落在高峰、成本却按空闲价算"的自相矛盾数据。
 */
export function resolveEffectivePricing(
  modelId: string,
  baseUrl: string,
  stored?: StoredPricing,
  at?: Date | string | number,
): EffectivePricing {
  const storedIn = stored?.price_in_usd;
  const hasStored = typeof storedIn === "number";
  const src = stored?.price_source;

  // ① 手填 / 上游结算价：用户或网关说了算（单一价，**不参与分时**—— 用户填的可能是合同价）
  if ((src === "manual" || src === "upstream") && hasStored) {
    const out = typeof stored?.price_out_usd === "number" ? stored.price_out_usd : storedIn;
    return {
      origin: src, priceIn: storedIn, priceOut: out,
      priceCacheRead: stored?.price_cache_read_usd, priceCacheWrite: stored?.price_cache_write_usd,
      tiered: false,
    };
  }

  // ② 本地 / 内网端点：没有按 token 的账单 → 恒 0，**不得**套官方刊例价或分时价。
  //    本地端点常二次托管"有官方价"的模型 ID（llama.cpp 跑 deepseek-flash），官方价与它无关。
  //    若存值非 0 且不是权威来源（旧版本写下的机器值），标为被取代 —— 引擎不采用它。
  if (isLocalEndpoint(baseUrl)) {
    const stale = hasStored && storedIn !== 0;
    return {
      origin: "local", priceIn: 0, priceOut: 0, priceCacheRead: 0, tiered: false,
      superseded: stale ? { priceIn: storedIn, priceOut: stored?.price_out_usd } : undefined,
    };
  }

  // ③ 内置表：给了时刻 → 该时刻的档位价；没给 → 平铺价（高峰标准价，确定性结果）
  const r = resolveModelPriceTier(modelId, at);
  if (typeof r.pricing.priceIn === "number") {
    const priceIn = r.pricing.priceIn;
    const priceOut = r.pricing.priceOut ?? priceIn;
    // 存值与生效价不同 → 是历史残留值，回传给 UI 标出来
    const stale = hasStored && storedIn !== priceIn;
    return {
      origin: r.tiered ? "tier" : "table",
      priceIn, priceOut,
      priceCacheRead: r.pricing.priceCacheRead,
      priceCacheWrite: r.pricing.priceCacheWrite,
      vendor: r.pricing.vendor,
      tierId: r.tiered ? r.tierId : undefined,
      tiered: r.tiered,
      superseded: stale ? { priceIn: storedIn, priceOut: stored?.price_out_usd } : undefined,
    };
  }

  // ④ 表里查不到 → 退回存值（可能是用户环境的自定义价，也可能是没来源标记的历史值）
  if (hasStored) {
    return {
      origin: "stored", priceIn: storedIn,
      priceOut: typeof stored?.price_out_usd === "number" ? stored.price_out_usd : storedIn,
      priceCacheRead: stored?.price_cache_read_usd, priceCacheWrite: stored?.price_cache_write_usd,
      tiered: false,
    };
  }

  // ⑤ 未定价：宁可留空让用户填，也不编造 —— 错的低价比没有价格危害大得多
  return { origin: "none", priceIn: 0, priceOut: 0, tiered: false };
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 把星期集合写成「周一至周五」/「周三」（连续区间收敛成区间，否则逐个列） */
function describeDays(days: number[] | undefined): string {
  if (!days || days.length === 0 || days.length >= 7) { return "每天"; }
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length > 1) {
    return `${WEEKDAY_NAMES[sorted[0]]}至${WEEKDAY_NAMES[sorted[sorted.length - 1]]}`;
  }
  return sorted.map((d) => WEEKDAY_NAMES[d] ?? String(d)).join("、");
}

/** 分钟数 → HH:MM */
function fmtMinute(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * 把模型的分时规格描述成人话（UI 徽标 tooltip 用）；模型没有分时规格时返回 undefined。
 *
 * 为什么不把这段文案手写在 UI 里：**时段是数据**。手写文案在表改了之后不会跟着改，
 * 于是出现"表已改成新时段、界面还提示旧时段"的分裂（本文件存在的全部理由就是消灭这种分裂）。
 */
export function describePriceTiers(modelId: string): string | undefined {
  const entry = findPricingEntry(modelId);
  const spec = entry?.model.priceTiers ?? entry?.vendor.priceTiers;
  if (!spec || spec.tiers.length === 0) { return undefined; }
  const parts = spec.tiers.map((t) => `${
    t.label ?? t.id}：${describeWindows(t.windows)}`);
  return `${parts.join("；")}（${spec.timezone}）`;
}

/**
 * 把一个档位的多个时段窗写成紧凑文案：**同星期合并**，避免出现
 * 「周一至周五 09:00-12:00、周一至周五 14:00-18:00」这种把星期重复两遍的啰嗦提示。
 */
function describeWindows(windows: PriceTierWindow[] | undefined): string {
  if (!windows || windows.length === 0) { return "其余时段"; }
  const byDay = new Map<string, string[]>(); // 插入序保持（JS Map 保证），文案顺序与数据顺序一致
  for (const w of windows) {
    const dayKey = describeDays(w.days);
    const spans = byDay.get(dayKey) ?? [];
    spans.push(`${fmtMinute(w.startMin)}-${fmtMinute(w.endMin)}`);
    byDay.set(dayKey, spans);
  }
  return Array.from(byDay.entries()).map(([day, spans]) => `${day} ${spans.join("、")}`).join("，");
}

/** 按共识顺序稳定排序推理等级；未知等级排末尾，保证渲染稳定且以上游集合为准 */
export function sortEfforts(levels: string[]): string[] {
  const known = levels.filter((l) => l in EFFORT_RANK).sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
  const unknown = levels.filter((l) => !(l in EFFORT_RANK));
  return [...known, ...unknown];
}

/** 依据模型 ID 推断能力（大小写不敏感，首个命中即返回） */
export function inferModelCapabilities(modelId: string): {
  supported: boolean;
  efforts?: string[];
  vendor?: string;
  /** 开启思考所用的请求参数协议（缺省 "reasoning_effort"） */
  thinkingParam?: ThinkingParam;
  /** 模型家族原生端点（缺省 "openai"；仅官方原生端点生效，中转站统一 openai） */
  endpoint?: Endpoint;
  /** 兜底上下文窗口（token）：模型级 > 供应商级；上游 /models 未给元数据时使用 */
  context?: number;
  /** 兜底最大输出（token）：模型级 > 供应商级；上游 /models 未给元数据时使用 */
  maxOut?: number;
} {
  const id = (modelId ?? "").toLowerCase();
  if (!id) { return { supported: false }; }
  // 非对话模型（embedding/rerank/图像/音频/视频生成）→ 一律不支持思考，
  // 无论 ID 是否恰好命中某个家族（如 agnes-image / agnes-video）
  if (NON_CHAT_MODEL_RE.test(id)) { return { supported: false, vendor: "non_chat" }; }
  for (const v of MODEL_CAPABILITIES) {
    for (const m of v.models) {
      try {
        if (new RegExp(m.match, "i").test(id)) {
          return {
            supported: m.thinking,
            efforts: m.efforts ? [...m.efforts] : undefined,
            vendor: v.key,
            thinkingParam: m.thinkingParam ?? "reasoning_effort",
            endpoint: m.endpoint ?? "openai",
            context: m.context ?? v.context,
            maxOut: m.maxOut ?? v.maxOut,
          };
        }
      } catch {
        // 非法正则该条目跳过（数据维护错误不影响其他匹配）
        continue;
      }
    }
  }
  // 未命中已知家族 → 启发式兜底（「所有模型适配」，不再一律 supported:false）：
  //   其余未知新模型 → 默认支持思考 + reasoning_effort（OpenAI 兼容最大公约数，
  //   由 client 的 400 容错网兜底：不认就剥参重试，至少能回复，不会崩）。
  return { supported: true, thinkingParam: "reasoning_effort", vendor: "unknown", endpoint: "openai" };
}
