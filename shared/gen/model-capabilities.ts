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

import { PRICING_SNAPSHOT, PRICING_SNAPSHOT_META, type PricingSnapshotEntry } from "./pricing-snapshot.js";

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
   * A-1091：**上游每分钟请求数上限（RPM）** —— 官方公布的档位值，供 `rpmLimiter` 做安全兜底。
   *
   * 为什么必须做成数据：RPM 是**会变的官方参数**，而且变了之后**客户端完全无感** ——
   * 超限的表现只是「偶尔 429 / 生成到一半被中断」，用户根本不会想到是"我们把人家限流限额用超了"。
   * 2026-09-23 Agnes 把免费档 RPM 由 20 下调到 10（官方向全体用户发的公告），
   * 如果我们不把新档位落到代码里，用户就会持续踩限流而查不出原因。
   *
   * 取值优先级（`resolveRpm` 唯一实现）：**实测探测值 > 本表声明 > 不限（不发明值）**。
   * ⚠️ 留空 = 「未知」，**不等于无限**：`resolveRpm` 对未知返回 `null`，限流器直接放行
   * （不发明阈值），但探测到真实值后立刻起效。宁可先不限，也不要猜一个错的数字去卡用户。
   * ⚠️ 只填**官方公布**的值（注明档位与核实日期）。免费档与企业档不同值时，
   *    这里写**免费档**（默认用户群）——企业档按探测值覆盖。
   */
  rpm?: number;
  /**
   * 兜底定价（**USD / 1M tokens**，与 providers.enc.json 的 `price_in_usd` 同单位同语义）。
   * 上游 /models 或网关 /api/pricing 回传价格时**以上游为准**，本字段只是离线兜底。
   *
   * 维护铁律（A-970 定价事故的教训）：
   *   1. **只填已核实的官方刊例价**（注明核实日期与来源）。核实不了就留空 → UI 显示
   *      「未定价 · 可填写」，让用户自己填。**宁可留空，也不要填猜测值**：错的低价会让
   *      成本统计长期失真，而且因为"看起来有数字"而极难被发现。
   *   2. **原价按原币种存放，绝不写"换算后的浮点常量"**：美元计价厂商填 `priceIn/priceOut`，
   *      人民币计价厂商（智谱等）填 `priceInCny/priceOutCny`（官方原数字，如 `0.8` 而不是 `0.111`）。
   *      全表唯一的换算是 `flatPricing()` 按 `USD_CNY_RATE` 做的那一次，且结果带
   *      `usdDerivedFromCny` 标记，界面显示成 `≈$`。历史事故：deepseek 的美元价 0.14/0.28
   *      被当成人民币再 ÷7.25（成本缩水 7.25 倍）—— 根因正是"表里只有一个数字，看不出它原本是哪个币种"。
   *   3. 单价为 0 是**有意义的取值**（官方限时免费），与"未定价（undefined）"必须区分开。
   *   4. 上下架/调价频繁，改动时同步更新注释里的核实日期。
   */
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /**
   * 官方**原生人民币**刊例价（¥/1M tokens，语义与上面的 USD 字段并列，见 `PriceCurrency`）。
   *
   * 给官方定价页是人民币计价的厂商（智谱等）用：这里填**官方原数字**（如 `0.8`），
   * 而不是先手算成美元浮点常量（如 `0.111`）再写进来。
   * `priceIn` 与 `priceInCny` **同时**给值 = 官方两种币种都公布了 → 界面可并列展示两个官方数字；
   * 只给 `priceInCny` = 官方只有人民币价 → USD 由 `flatPricing` 按 `USD_CNY_RATE` **折算**
   * 并打上 `usdDerivedFromCny` 标记（**折算值不是官方美元价**，UI 必须显示成 `≈$`）。
   */
  priceInCny?: number;
  priceOutCny?: number;
  priceCacheReadCny?: number;
  priceCacheWriteCny?: number;
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

/**
 * **上游探针为什么没给出价** —— 用户可见的诊断分类（A-990-E）。
 *
 * 用户原话：「探针是探不到吗？为什么这些还是本地推断表？」
 * 这个疑问目前**界面上无法回答**：面板只说"内置表"，用户无从区分三种完全不同的情况 ——
 *   ① 探针坏了/没跑；② 上游根本不发布价目（多数官方 API）；③ 上游有价但探针字段没命中。
 * 三者对应的动作完全不同（修探针 / 接受内置表 / 补字段名），所以必须显式区分。
 *
 * 诚实性要求：本分类**只依据已经拿到的事实**（是否本地端点、生效价来源、是否命中内置表），
 * 不猜"上游有没有价目"。真正需要"上游回了模型但没带价格字段"这种信息时，
 * 必须先在 `enrichModels` 里把它记下来，而不是在这里编一个结论。
 */
export type ProbeOutcome =
  /** 本地/内网端点：没有按 token 的账单，**本来就不需要**价目 */
  | "local"
  /** 上游确实给了价（网关真实结算价），已采用 */
  | "upstream-hit"
  /** 上游没给价 → 用内置表（人工核对官方定价页）。**这是绝大多数官方 API 的正常结果** */
  | "builtin-table"
  /** 表里也没有 → 未定价，需要手填 */
  | "unpriced";

/**
 * 判定探针结果分类。**纯函数**，与面板文案共用同一个判据（避免"界面说的话"与"实际来源"漂移）。
 * `origin` 取 `resolveEffectivePricing` 的结果，不另外推断。
 */
export function classifyProbeOutcome(origin: PriceOrigin, baseUrl: string): ProbeOutcome {
  if (isLocalEndpoint(baseUrl)) { return "local"; }
  if (origin === "upstream") { return "upstream-hit"; }
  if (origin === "table" || origin === "tier" || origin === "snapshot") { return "builtin-table"; }
  return "unpriced";
}

/**
 * 各分类的用户可见解释（一句话说清"为什么"以及"要不要管"）。
 *
 * ⚠️ 这里必须说**准确**：不要写成"探针失败" —— 多数官方 API（DeepSeek / OpenAI / Anthropic …）
 * 只提供模型清单，**根本不发布价目**，探针"探不到价"是它们的正常形态而不是故障。
 * 把它说成故障，用户就会一直去重修探针（而这个项目里"反复修一个没坏的东西"本身是成本）。
 */
export const PROBE_OUTCOME_HINT: Record<ProbeOutcome, string> = {
  local: "本地 / 内网端点：没有按 token 计费的账单，价格恒按 0 记（探针与内置表都不参与）。",
  "upstream-hit": "上游探针命中：已采用该网关回传的真实结算价（比任何离线表都准）。",
  "builtin-table": "上游未回传价格：多数官方 API（DeepSeek / OpenAI / Anthropic 等）只提供模型清单，"
    + "**不发布价目**，能探到价的是 OpenRouter / new-api / one-api 这类网关。故此处使用内置价目表"
    + "（逐条核对官方定价页得来）。",
  unpriced: "上游与内置表都没有该模型的价：消耗会记成 $0，请在右侧手填单价（或确认模型 ID 是否拼写正确）。",
};

/* ═══════════════ 分时（峰谷）定价 ═══════════════ */

/**
 * 分时定价的**时段窗**（按 `ModelPriceTiers.timezone` 的**墙上时间**判定，与用户本机时区无关）。
 * 左闭右开：`[startMin, endMin)` —— 09:00 判在高峰、12:00 判在高峰之外，边界不重叠。
 *
 * **跨午夜**：`endMin < startMin` 表示窗口跨越零点（如 `startMin=1380, endMin=420` = 23:00→次日 07:00）。
 * 这是 DeepSeek 那种"白天高峰"用不到的形态，但**夜间空闲档**（国内多数厂商的优惠时段、
 * OpenRouter `overrides` 的 `utc_start > utc_end`）几乎全是跨午夜的，用户自定义分时一定会填到。
 * 跨午夜时 `days` 表示**窗口开始那天**：`days=[5], 23:00→07:00` 命中周五 23:30 与周六 06:00，
 * 但不命中周六 23:30 —— 与 OpenRouter 文档 "the override applies to the UTC day the window starts" 一致。
 *
 * ⚠️ 早期实现只写 `minute >= startMin && minute < endMin`，跨午夜窗口于是**永远不命中**
 * （数学上不可能同时满足），静默落到兜底档 —— 用户看到的症状是"设了夜间档却一直按高峰价计费"。
 */
export interface PriceTierWindow {
  /** 生效星期（0=周日 … 6=周六）；缺省 = 每天。跨午夜窗口指的是**窗口开始那天** */
  days?: number[];
  /** 当天起算分钟数（0..1439），含 */
  startMin: number;
  /** 当天起算分钟数（0..1439），不含；小于 `startMin` = 跨午夜到次日 */
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
  /**
   * 输出价。**可选**：缺省 = 与输入价相同（见 `resolveModelPriceTier` 的 `?? flat.priceOut`）。
   * 类型上是可选而不是"必填数字"，是因为用户自定义档位时常常只想改输入价
   * （很多网关的输出倍率直接由 completion_ratio 决定），UI 必须能表达"这项我不管，按规则继承"。
   */
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /**
   * 该档位的**官方原生人民币**价（¥/1M）。官方同时公布美元与人民币两列时**两列都填**——
   * DeepSeek 就是这种（英文页 $0.30/1.20、中文页 ¥2/8，美元列是官方价而非折算值）。
   * 只填其中一列时不要用汇率"补"另一列：官方明示两列非等比，补出来的数是错的。
   */
  priceInCny?: number;
  priceOutCny?: number;
  priceCacheReadCny?: number;
  priceCacheWriteCny?: number;
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

/* ═══════════════ 币种与折算（**$ 与 ¥ 分开存放**）═══════════════ */

/**
 * 官方报价的**原生计价币种**。
 *
 * 为什么要有这个类型：本表历史上只存 USD/1M 一个口径，于是"官方人民币价目"必须先被
 * 手算成美元浮点常量再写进来（如 `0.111`）。后果有二：
 *   ① 表里出现一个**看不出出处的数字** —— 没人能从 `0.111` 反推它其实是 ¥0.8 ÷ 7.2；
 *   ② 它会被误当成"官方美元价"。而智谱官方明示 z.ai 的美元价（$0.15）与国内站人民币价
 *      （¥0.8）**并非等比换算**，所以折算值 `0.111` **不是**官方美元价，只是国内站价的折算。
 * 把币种显式化后：**原价永远以原币种存放在表里**，折算只发生在一个地方（`flatPricing`），
 * 且折算结果被打上 `usdDerivedFromCny` 标记，UI 必须显示成 `≈$` 而不是官方价。
 */
export type PriceCurrency = "USD" | "CNY";

/**
 * 人民币 → 美元折算基准（**参考折算，不是任何厂商的官方报价**）。
 *
 * ⚠️ 只做两件事：① 把官方人民币刊例价折算成 USD 参与成本统计；
 * ② 把官方 USD 价折算成人民币供界面并列展示。
 * **绝不**用它去"校正"厂商同时公布的两种币种价 —— 那两种价各自独立，对不上不是错误。
 */
export const USD_CNY_RATE = 7.2;

/** 人民币金额 → 美元（按 `USD_CNY_RATE`；结果同样是**折算值**，不是官方美元价） */
export function cnyToUsd(cny: number): number {
  return cny / USD_CNY_RATE;
}

/**
 * 金额的**唯一**数字格式化出处（去掉尾随 0，极小值给 4 位小数）。
 *
 * 为什么必须收成一个函数：价目表里 0.044 / 0.006 / 0.0000002 这类小数到处都是，
 * 各处各写一套 `toFixed` 就会出现"同一个价在两张表里显示成 0.044 与 0.0440"，
 * 用户会当成两个不同的价去核对（这类"看起来不一致"的投诉已经出现过）。
 */
export function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(n < 0.1 ? 4 : 3).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * 把一份定价里的金额渲染成**带币种**的可读字符串（UI 共用，避免各处各写一套）。
 *
 * 规则（"$ 与 ¥ 分开"的展示落点）：
 *   - 有官方人民币价 → 以 `¥` 为主显示（原币种），USD 值仅在**是折算值**时以 `≈$` 附注；
 *     若 USD 也是官方价（两币种都公布），则两个数字都用官方标记并列。
 *   - 只有官方美元价 → 显示 `$`。
 * `undefined` 返回 `undefined`，交由调用方决定显示「未定价」还是留空。
 */
export function formatPricingAmounts(p: {
  priceIn?: number; priceOut?: number;
  priceInCny?: number; priceOutCny?: number;
  usdDerivedFromCny?: boolean;
}): string | undefined {
  const cny = p.priceInCny !== undefined || p.priceOutCny !== undefined;
  const usd = p.priceIn !== undefined || p.priceOut !== undefined;
  if (!cny && !usd) { return undefined; }
  const num = formatAmount;
  if (cny) {
    const c = `¥${num(p.priceInCny ?? 0)} / ¥${num(p.priceOutCny ?? p.priceInCny ?? 0)}`;
    if (!usd) { return `${c} /1M`; }
    // USD 是折算值 → 必须带 ≈，不能冒充官方美元价
    const sign = p.usdDerivedFromCny ? "≈$" : "$";
    const u = `${sign}${num(p.priceIn ?? 0)} / ${sign}${num(p.priceOut ?? p.priceIn ?? 0)}`;
    return `${c} /1M（${u}）`;
  }
  return `$${num(p.priceIn ?? 0)} / $${num(p.priceOut ?? p.priceIn ?? 0)} /1M`;
}

/**
 * 档位（分时档）的**双币种**展示串：`$0.3 / $1.2` ＋（若有官方人民币价）`¥2 / ¥8`。
 *
 * 与 `formatPricingAmounts` 的区别是**主次**：那张串以"原币种"为主（人民币计价时 ¥ 在前），
 * 而分时明细表整块以 USD 为单位（成本统计口径是 USD），所以美元在前、人民币并列在后。
 * 两个函数并存是有意的：把"谁是主币种"交给调用场景决定，而不是让一个函数兼顾两种排布。
 */
export function formatTierAmounts(t: {
  priceIn?: number; priceOut?: number;
  priceInCny?: number; priceOutCny?: number;
}): { usd?: string; cny?: string } {
  const usd = t.priceIn !== undefined
    ? `$${formatAmount(t.priceIn)}${typeof t.priceOut === "number" ? ` / $${formatAmount(t.priceOut)}` : ""}`
    : undefined;
  const cny = (t.priceInCny !== undefined || t.priceOutCny !== undefined)
    ? `¥${formatAmount(t.priceInCny ?? 0)} / ¥${formatAmount(t.priceOutCny ?? t.priceInCny ?? 0)}`
    : undefined;
  return { usd, cny };
}

/* ═══════════════ 币种归属（"以模型所属地决定"）═══════════════ */

/**
 * 模型/厂商的**计价归属地**：决定界面用哪种币种作为**主显示币种**。
 *
 * 用户指令（2026-09-18）原话：「这个以模型所属地决定，金额尽量靠近整数，
 * 转汇率的时候经常出现小数点，看着不舒服。」
 *
 * 为什么必须由归属地决定，而不是"统一折成美元再显示人民币"：
 *   ① 官方刊例价**本来就是整数或短小数**（¥2/¥8、¥8/¥28、$2.5/$10）。折算一次就变成
 *      `0.2777…`、`1.1111…`，用户看到的是**任何官方页面上都不存在**的数字，且无法反查；
 *   ② 各家两列币种**并非等比换算**（GLM-5 国内 ¥8/¥28 与 z.ai $1.4/$4.4 差 1.8 倍），
 *      折算值既不等于另一列官方价，也不等于账单 —— 三边都对不上；
 *   ③ 归属地和"账单币种"天然一致：国内厂商给你开人民币账单，海外厂商开美元账单。
 *      按归属地显示 = 显示的就是**你实际要付的那个数**。
 */
export type PriceRegion = "cn" | "us" | "other";

/**
 * 官方**以人民币刊例价**发布的厂商（唯一出处，新增一家只改这里）。
 *
 * 判据不是"公司注册地"，而是**官方定价页用哪种币种报价**（这才是与本功能相关的属性）：
 * 这些厂商的中文站/国内站给的是 ¥ 价，且通常与海外站的 $ 价**非等比**。
 * `Agnes` 是 slime 自研（SILAM），按人民币口径登记；`note`/`mimo`/`ling` 同理属国内站。
 *
 * ⚠️ 不是这里列出的厂商 = 美元计价。**不确定时不要猜着加**：加错的后果是
 * 把美元价按 ¥ 显示（金额直接差 7 倍），比"显示成美元"严重得多。
 */
const CN_VENDOR_KEYS: ReadonlySet<string> = new Set([
  "deepseek", "qwen", "glm", "kimi", "minimax", "doubao", "hunyuan", "ernie",
  "baichuan", "sensechat", "yi", "minicpm", "skywork", "step", "spark",
  "note", "mimo", "ling", "agnes",
]);

/** 厂商 key → 计价归属地（`VENDOR_CAPABILITIES` 的 key；未收录视为美元区） */
export function vendorRegion(vendorKey: string | undefined): PriceRegion {
  if (!vendorKey) { return "other"; }
  return CN_VENDOR_KEYS.has(vendorKey.toLowerCase()) ? "cn" : "other";
}

/** 归属地 → 主显示币种。**只有 cn 用人民币**，其余一律美元（宁可显示美元，也不要把美元当人民币）。 */
export function currencyOfRegion(region: PriceRegion): PriceCurrency {
  return region === "cn" ? "CNY" : "USD";
}

/**
 * 某模型的**主显示币种**（用户所说"模型所属地决定"）。
 *
 * 两级判据，**数据优先于归属表**：
 *   ① 表里登记了该模型的官方人民币价（`priceInCny`）→ 该厂商确实以 ¥ 报价 → CNY。
 *      这是硬证据（我们逐条核对官方定价页时才填得出这个字段），比按厂商名归类更可靠；
 *   ② 否则按 `vendorRegion(vendorKey)` 归类。
 * 之所以要两级：国内厂商的中文站价是逐条核对来的（①覆盖到的才有 ¥ 列），
 * 而归属表（②）能覆盖同一厂商尚未逐条登记 ¥ 价的模型 —— 单用任何一级都会漏。
 */
export function displayCurrencyForModel(modelId: string): PriceCurrency {
  const entry = findPricingEntry(modelId);
  if (!entry) { return "USD"; }
  // 四个 ¥ 字段**任一**存在即认定该厂商以人民币报价（与 `formatPricingAmounts` 的判据对齐：
  // 那个函数只要 `priceInCny`/`priceOutCny` 有一个就走 ¥ 分支）。判据不一致会出现
  // "价格行显示 ¥ 而总账按 $" 的分裂 —— 正是本文件存在的理由。
  const m = entry.model;
  const v = entry.vendor;
  const hasCny = m.priceInCny !== undefined || m.priceOutCny !== undefined
    || m.priceCacheReadCny !== undefined || m.priceCacheWriteCny !== undefined
    || v.priceInCny !== undefined || v.priceOutCny !== undefined
    || v.priceCacheReadCny !== undefined || v.priceCacheWriteCny !== undefined;
  if (hasCny) { return "CNY"; }
  return currencyOfRegion(vendorRegion(v.key));
}

/**
 * 把**美元金额**换算成目标币种（唯一折算点，`UsageStatsPanel` / 右栏总账都必须走这里）。
 *
 * ⚠️ 在此之前，`RightSidebar` 与 `UsageStatsPanel` **各自硬编码了 `7.25`** —— 既与
 * `USD_CNY_RATE`(7.2) 不一致（同一笔账两处显示不同数），又违反"折算率只有一个出处"。
 * 归拢到本函数后，改汇率只需改 `USD_CNY_RATE` 一处。
 */
export function convertFromUsd(usd: number, to: PriceCurrency): number {
  return to === "CNY" ? usd * USD_CNY_RATE : usd;
}

/**
 * **账目金额**的展示格式（区别于单价用的 `formatAmount`）。
 *
 * 用户诉求「金额尽量靠近整数…转汇率经常出现小数点，看着不舒服」→ 这里的舍入策略是
 * **按量级给足精度但绝不留长尾**：
 *   - ≥ 100   → 整数（¥1,234；账目上分位数没有意义）
 *   - ≥ 1     → 2 位小数（¥12.35）
 *   - ≥ 0.01  → 4 位小数并去尾零（¥0.0123 —— 单价极低时这是必要的分辨率）
 *   - 更小    → 6 位小数（¥0.000123），仍然去尾零
 * 关键点是**去尾零**：`toFixed(4)`（旧实现）会把 ¥12.30 印成 `¥12.3000`、
 * 把整数 ¥2 印成 `¥2.0000` —— 这正是"看着不舒服"的来源。
 */
export function formatMoney(amount: number, currency: PriceCurrency): string {
  const sign = currency === "CNY" ? "¥" : "$";
  if (!Number.isFinite(amount)) { return `${sign}0`; }
  const abs = Math.abs(amount);
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  const strip = (s: string): string => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const txt = strip(amount.toFixed(decimals));
  /*
   * 边界：极小**非零**金额在 6 位小数下会被抹成 "0"（如 $0.0000001）→ 界面显示 `$0`，
   * 把"花了钱"显示成"没花钱"。这与"0 = 免费"的语义直接冲突（免费与极小额是两件事），
   * 所以这里显式给出下限标记，而不是让它退化成一个假的 0。
   */
  if (Number(txt) === 0 && amount !== 0) { return `${sign}<0.000001`; }
  return `${sign}${txt}`;
}

/** `formatMoney` 的便捷版：美元账目 → 按目标币种折算并格式化（折算点仍只有 `convertFromUsd` 一处） */
export function formatUsdAs(usd: number, to: PriceCurrency): string {
  return formatMoney(convertFromUsd(usd, to), to);
}

/**
 * 该模型**官方刊例价**用的币种（= 表里那一列数字原本是哪种货币）。
 *
 * 与 `displayCurrencyForModel` 的关键区别：这里**不做归属地回退**。
 * 只有真的登记了 `price*Cny` 才算"官方人民币价"；否则一律 USD。
 *
 * 用途：判断"界面上的 ¥ 数字到底是官方原价，还是我们折算出来的近似值"。
 * 这个区分必须显式 —— 折算值加上 `≈` 才是诚实的（官方两列非等比，折算值对不上账单）。
 */
export function officialPriceCurrency(modelId: string): PriceCurrency {
  const entry = findPricingEntry(modelId);
  if (!entry) { return "USD"; }
  const m = entry.model;
  const v = entry.vendor;
  const hasCny = m.priceInCny !== undefined || m.priceOutCny !== undefined
    || m.priceCacheReadCny !== undefined || m.priceCacheWriteCny !== undefined
    || v.priceInCny !== undefined || v.priceOutCny !== undefined
    || v.priceCacheReadCny !== undefined || v.priceCacheWriteCny !== undefined;
  return hasCny ? "CNY" : "USD";
}

/** 单价的四个字段名（与 `EffectivePricing` 的四个金额字段一一对应） */
export type PriceFieldKey = "priceIn" | "priceOut" | "priceCacheRead" | "priceCacheWrite";

/**
 * 取**某一个字段**在指定币种下应该显示的数字，以及它是不是原生值。
 *
 * 为什么必须**按字段**判而不是按"一对价"判：官方可能只补了部分列 ——
 * 例如 DeepSeek 补了 ¥ 输入/输出/缓存命中，但**缓存写入**在官方口径里根本不单独收费
 * （显示为"推定不收费"）。若按"对"判原生性，就会出现"输入框是原生 ¥2、缓存写入也被迫
 * 当成原生 ¥0"这类把推定值冒充官方值的错误。
 *
 * 判据与 `formatAmountsInCurrency` / `isNativePriceCurrency` **完全同一份**：
 *   · 要 CNY 且该字段有原生 ¥ 列 → 用 ¥ 列（`native: true`）；
 *   · 要 USD 且美元值不是折算来的（`usdDerivedFromCny !== true`）→ 用美元值（`native: true`）；
 *   · 其余 → 折算（`native: false`，调用方**必须**加 `≈`）。
 *
 * ⚠️ 这是本文件里"界面显示的¥到底是官方原价还是折算值"的**唯一判定口**。
 * 曾经的实现让四个单价输入框自己写 `convertFromUsd(v, cur)`，于是官方 ¥2 被显示成
 * `0.3 × 7.2 = 2.16`（官方页面上不存在的数字，还带小数尾巴）—— 用户一眼就看出不对。
 */
export function amountInCurrency(
  p: {
    priceIn?: number; priceOut?: number; priceCacheRead?: number; priceCacheWrite?: number;
    priceInCny?: number; priceOutCny?: number; priceCacheReadCny?: number; priceCacheWriteCny?: number;
    usdDerivedFromCny?: boolean;
  },
  field: PriceFieldKey,
  currency: PriceCurrency,
): { value: number; native: boolean } | undefined {
  const usd = p[field];
  const cny = p[`${field}Cny` as keyof typeof p] as number | undefined;
  if (currency === "CNY" && typeof cny === "number") { return { value: cny, native: true }; }
  if (typeof usd !== "number") { return undefined; }
  if (currency === "USD" && p.usdDerivedFromCny !== true) { return { value: usd, native: true }; }
  return { value: convertFromUsd(usd, currency), native: false };
}

/**
 * **该币种下这对单价是不是原生值**（= 官方就是用它标价的，而不是我们折算出来的）。
 *
 * 成对版本，供"整行/整块"的文案使用（"官方以 ¥ 刊例"该不该出现）。
 * 实现直接复用按字段的 `amountInCurrency`（取输入字段为代表）—— **判据只有一份**，
 * 否则会出现"数字没带 ≈、文字却说这是折算值"（或反之）这类不一致。
 */
export function isNativePriceCurrency(
  p: {
    priceIn?: number; priceOut?: number; priceInCny?: number; priceOutCny?: number; usdDerivedFromCny?: boolean;
  },
  currency: PriceCurrency,
): boolean {
  return amountInCurrency(p, "priceIn", currency)?.native ?? false;
}

/**
 * 按**调用方指定的币种**渲染一对单价（输入 / 输出），供"用户手选币种"的展示使用。
 *
 * 与 `formatPricingAmounts` 的分工：
 *   · `formatPricingAmounts` —— 按"官方原币种"排布（¥ 主导时 ¥ 在前），用于"这条价官方怎么标"；
 *   · 本函数 —— 按调用方**指定**的币种排布，用于"用户想用哪种币看"。
 * 两者共存是刻意的：一个是事实陈述，一个是观看偏好，硬合一个函数必然在某一侧说谎。
 *
 * ⚠️ **必须按"要的那一列是不是原生列"决定，绝不能一律拿 USD 去乘汇率**：
 * DeepSeek 的官方两列是 `$0.30` 与 `¥2`（**非等比**）。若按 `0.30 × 7.2` 得到 `¥2.16` 并
 * 当作官方人民币价显示，就凭空造出了一个官方页面上不存在的数字 —— 这正是本项目
 * "用换算值冒充官方价"那类事故的形态。
 * 判据一律走 `isNativePriceCurrency`（与文案、`≈` 前缀共用同一份实现），
 * **非原生值一定带 `≈`**，且这个判定**不允许调用方自己传**。
 */
export function formatAmountsInCurrency(
  p: {
    priceIn?: number; priceOut?: number; priceInCny?: number; priceOutCny?: number; usdDerivedFromCny?: boolean;
  },
  currency: PriceCurrency,
): string | undefined {
  // 逐字段判原生性（实现只有 `amountInCurrency` 一份）
  const a = amountInCurrency(p, "priceIn", currency);
  const b = amountInCurrency(p, "priceOut", currency);
  // 输出价缺省 = 与输入价相同（与 `resolveModelPriceTier` 的 `?? flat.priceOut` 同一规则）
  const outAmt = b ?? a;
  if (!a || !outAmt) { return undefined; }
  const sign = currency === "CNY" ? "¥" : "$";
  // 原生值不带 ≈；折算值**必须**带（两侧各自判定，允许一原生一折算）
  const fmt = (x: { value: number; native: boolean }): string => `${x.native ? "" : "≈"}${sign}${formatAmount(x.value)}`;
  return `${fmt(a)} / ${fmt(outAmt)} /1M`;
}

/* ═══════════ 用户手选币种（A-990-B，"手动调整币种填入"）═══════════ */

/**
 * 该模型的**最终展示/录入币种**：**用户显式选择 > 归属地推断**。
 *
 * 为什么要留用户覆盖口：归属地是按"厂商官方定价页用哪种币种报价"推断的，它解决的是
 * "绝大多数情况该显示哪个币"，但用户可能拿到的是一张**转售价 / 合同价**账单
 * （例如海外厂商的模型、结算却是人民币），或者他就想用美元核对某个国内模型的账。
 * 这种"我知道我在看什么"的显式意图必须能压过机器推断 —— 与 `price_tiers` 压过内置表的道理一致。
 *
 * ⚠️ 但它**只影响显示与录入单位，不改变记账**：账目恒以 USD 记账（`usage.jsonl.cost_usd`），
 * 用户选 ¥ 只是让"输入的数字"和"显示的数字"用人民币表达（见 `toUsdAmount`）。
 * 把记账单位也改掉会让同一份账在两处对不上，那是本项目反复踩过的坑。
 */
export function pricingDisplayCurrency(modelId: string, userChoice?: PriceCurrency): PriceCurrency {
  // 用 `!== undefined` 而不是 `??`：两个值都是合法币种，没有"空值"语义，
  // 但 `undefined` 必须明确表示"用户没选过"（空串在旧数据里可能出现，也别当选择）。
  return userChoice === "USD" || userChoice === "CNY" ? userChoice : displayCurrencyForModel(modelId);
}

/**
 * 用户按 `from` 币种**输入**的金额 → 记账用的 USD。
 *
 * 与 `convertFromUsd` 是一对逆运算，共用同一个 `USD_CNY_RATE` —— 面板的输入框
 * **不允许**自己写 `/ 7.2` 或 `* 7.2`（源码守卫会拦，见 providers-pricing.spec.ts）。
 * `from === "USD"` 时原值返回，保证"用户没动币种"时数值与改造前**逐位一致**。
 */
export function toUsdAmount(amount: number, from: PriceCurrency): number {
  return from === "CNY" ? cnyToUsd(amount) : amount;
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
  /** 供应商级兜底 RPM（模型条目未单独声明时使用；语义见 `ModelCapability.rpm`） */
  rpm?: number;
  /** 供应商级兜底定价（USD/1M tokens）：模型条目未单独标价时使用（语义见 ModelCapability 同名字段） */
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /** 供应商级兜底定价（**原生人民币** ¥/1M tokens；语义见 ModelCapability 同名字段） */
  priceInCny?: number;
  priceOutCny?: number;
  priceCacheReadCny?: number;
  priceCacheWriteCny?: number;
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
 * 官方定价页的**核实日期**（一手来源，非社区镜像）。
 *
 * ⚠️ 这是"时效性底线"的工程落点：价格会变，而代码里一个浮点常量**看不出它是哪天的**。
 * 把日期显式写进数据，面板才能标出「价格核实于 YYYY-MM-DD」，
 * 人也能一眼看出哪些条目该重新核对了。
 *
 * ⚠️ **凡是在本表里写了价的厂商，这里必须有一条**（漏了 = 该厂商的价没有任何时效线索，
 *    等于"永远新鲜"的假象）。测试会强制这条对应关系。
 * ⚠️ 日期是**逐条核对官方定价页**的那天，不是"跑了一遍脚本"的那天。
 *    没有真去核对就别改日期 —— 那会让这张表本身变成假信息源。
 */
export const PRICING_VERIFIED_AT: Record<string, string> = {
  deepseek: "2026-09-18",
  openai: "2026-09-18",
  claude: "2026-09-18",
  gemini: "2026-09-18",
  glm: "2026-09-18",
  // A-990-F：昨日还是"内置表完全没有 qwen 的价"（全靠 OpenRouter 二手快照）。
  // 本次按**阿里云百炼官方价格页**补了 qwen3.8-max / 3.8-flash / 3.8-27b / 3.7-plus 四条 ¥ 价。
  // ⚠️ 仍有两条未核实：qwen3.7-max、qwen3.8-2.4t-a95b（官方表格抓取被截断）→ 见 ref-pricing.md 待办。
  qwen: "2026-09-18",
  // A-990-F：补上 Kimi 的官方人民币价（此前完全无价 → 走快照二手价，比官方低约 30%）。
  // 来源：platform.moonshot.cn 刊例 + kimi.com/resources/kimi-k3-pricing + platform.kimi.com/docs/pricing/batch 反算校验。
  kimi: "2026-09-18",
  // A-990-F：补 MiniMax 官方人民币价（含其独有的**缓存写入费** ¥2.625，此前完全没价 → 该部分成本记 0）。
  // 来源：platform.minimaxi.com/docs/guides/pricing-paygo 与 /subscribe/token-plan，两页一致。
  minimax: "2026-09-18",
  // A-990-F：补豆包官方人民币价（Seed-2.1 系，**三源一致**：产品页 + 计费标准 + TRAE 页）。
  // 来源：volcengine.com/product/ark + /docs/6492/1544808 + docs.volcengine.com/docs/86677/2387327。
  // ⚠️ seed-2.0-* / seed-1.8 按输入输出长度分档且官方文档页数字互相打架 → 刻意不写（见 doubao 段注释）。
  doubao: "2026-09-18",
  // A-990-F：补混元官方人民币价（turbos/t1/a13b/pro 四条，均多源一致；
  // standard/turbo 两页数字打架 → 刻意不写；Hy3 id 形态未确认 → 待办）。
  // 来源：cloud.tencent.com/document/product/1729/97731 + /document/api/1323/106152 + 智能体平台 PDF。
  hunyuan: "2026-09-18",
  // A-990-F：补文心官方人民币价（5.1/5.0/x1/4.5-Turbo-VL/4.5-Turbo/4.5-8K，取 ≤32k 短档）。
  // 来源：cloud.baidu.com/doc/qianfan/s/wmh4sv6ya + /doc/qianfan-docs/s/Jm8r1826a（两页一致）+ 千帆控制台。
  ernie: "2026-09-18",
  /*
   * 下面三家**有内置价、但没有可溯源的核实日期**。
   *
   * 这里写 `unknown` 而不是编一个日期：编日期会让"时效性"这条红线**看起来**合格，
   * 而实际上没人核对过 —— 那比缺日期更危险（缺日期至少诚实）。
   * `unknown` 在界面上会显示成「核实日期未知」，等于把"这三条需要一次复核"一直挂在屏幕上。
   */
  mistral: "unknown",
  cohere: "unknown",
  llama: "unknown",
  agnes: "2026-09-16",
  note: "2026-09-16",
};

/** 日期是否为「未知」（未登记或登记为 unknown）—— 面板据此渲染成醒目文案而不是一个假日期 */
export function pricingVerifiedAtUnknown(vendorKey: string | undefined): boolean {
  const d = vendorKey ? PRICING_VERIFIED_AT[vendorKey] : undefined;
  return d === undefined || d === "unknown";
}

/**
 * A-1091：**RPM 档位的核实日期**（与 `PRICING_VERIFIED_AT` 同一纪律）。
 *
 * ⚠️ RPM 比价格更容易"悄悄过期"：价格变了用户会看账单，限额变了用户只会看到零星 429。
 *    所以凡是本表里写了 `rpm` 的厂商，这里**必须**有一条核实日期；否则看着像"永远新鲜"。
 * ⚠️ 日期是**真去读了官方公告**的那天。厂商把档位一改（如 Agnes 2026-09-23 统一下调 50%），
 *    不更新这里就等于放任客户端拿旧限额去撞墙。
 */
export const RPM_VERIFIED_AT: Record<string, string> = {
  // Agnes 官方站内公告《Agnes 文本模型 RPM 限额调整公告》2026-09-23 16:48：
  // 免费/企业统一 ↓50% → 免费 10 / 企业 20。
  agnes: "2026-09-23",
};

/** 该厂商声明的 RPM 档位（未声明 → undefined；**不等于无限**） */
export function rpmDeclared(vendorKey: string | undefined): number | undefined {
  if (!vendorKey) { return undefined; }
  const v = MODEL_CAPABILITIES.find((x) => x.key === vendorKey);
  return v?.rpm;
}

/** DeepSeek **V4 Pro** 档（含峰谷分时）—— 官方英文定价页 2026-09-18 */
const DEEPSEEK_PRO_TIERS: ModelPriceTiers = {
  timezone: DEEPSEEK_TZ,
  tiers: [
    { id: "peak", label: "高峰时段", windows: DEEPSEEK_PEAK_WINDOWS, priceIn: 1.32, priceOut: 3.96, priceCacheRead: 0.044, priceInCny: 9, priceOutCny: 27, priceCacheReadCny: 0.3 },
    { id: "offpeak", label: "空闲时段", priceIn: 0.66, priceOut: 1.98, priceCacheRead: 0.022, priceInCny: 4.5, priceOutCny: 13.5, priceCacheReadCny: 0.15 },
  ],
};

/**
 * DeepSeek **Flash 档**（V4.1-Flash，含全部退休别名）—— 官方英文定价页 2026-09-18。
 * 与 `DEEPSEEK_PRO_TIERS` 同构，抽出常量是为了让 peak/offpeak 四条价**只写一遍**：
 * 散落的字面量一旦有一个写错（如 offpeak 忘了减半），就是"某些时段静默多收一倍"。
 *
 * ⚠️ 档位里**故意不写 `priceCacheWrite`** —— 这不是漏项，是正确结果：
 *    DeepSeek 的官方价目只有「输入(缓存命中) / 输入(缓存未命中) / 输出」三列，
 *    **没有**独立的"缓存写入/存储"计费项；未命中的那部分本来就按普通输入价计，
 *    并且已经算在 `prompt_tokens` 里（见 `client.ts::openAICacheTokens` 的注释：
 *    `prompt_cache_miss_tokens` 刻意不映射到 `cache_creation_tokens`，否则重复计会虚高）。
 *    所以这里补一个 cache-write 价反而会**凭空多收钱**。将来若官方新增该计费项，
 *    正确做法是同时改 `client.ts` 的字段映射 + 本档位，而不是只补一个数字。
 */
const DEEPSEEK_FLASH_TIERS: ModelPriceTiers = {
  timezone: DEEPSEEK_TZ,
  tiers: [
    { id: "peak", label: "高峰时段", windows: DEEPSEEK_PEAK_WINDOWS, priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006, priceInCny: 2, priceOutCny: 8, priceCacheReadCny: 0.04 },
    { id: "offpeak", label: "空闲时段", priceIn: 0.15, priceOut: 0.6, priceCacheRead: 0.003, priceInCny: 1, priceOutCny: 4, priceCacheReadCny: 0.02 },
  ],
};

/**
 * DeepSeek 两条产品线的**平铺价（= 高峰标准价）+ 档位表**，抽成常量供多条匹配条目共享。
 *
 * 为什么必须抽出来（A-990-H）：规范 id 要写**锚定**的精确条目，同一份价会被
 * `^deepseek-flash` / `^deepseek-chat` / `^deepseek-reasoner` / 家族兜底等多条复用。
 * 复制字面量的后果很具体：**改价时改了一条漏了几条**，而"同一个 Flash 在不同别名下价格不同"
 * 几乎不可能被用户发现（他会以为差别来自峰谷或缓存）。
 * 现在价格数字在**本文件里只出现一次**（就在这两个常量里）。
 */
const DEEPSEEK_PRO_FLAT = {
  priceIn: 1.32, priceOut: 3.96, priceCacheRead: 0.044,
  priceInCny: 9, priceOutCny: 27, priceCacheReadCny: 0.3,
  priceTiers: DEEPSEEK_PRO_TIERS,
};
const DEEPSEEK_FLASH_FLAT = {
  priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006,
  priceInCny: 2, priceOutCny: 8, priceCacheReadCny: 0.04,
  priceTiers: DEEPSEEK_FLASH_TIERS,
};
/** DeepSeek 思考能力（官方支持 low/high/max 三档 `reasoning_effort`） */
const DEEPSEEK_THINK: Pick<ModelCapability, "thinking" | "efforts"> = {
  thinking: true, efforts: ["low", "high", "max"],
};

/**
 * GPT-5 及更高家族的**能力**（思考等级 + 原生端点）。
 *
 * 抽成常量并在多条条目里 `...` 展开：`MODEL_CAPABILITIES` 是"能力 + 取价"共用的单表、
 * 首个命中即返回，所以**每一条带价的 gpt-5.x 条目都必须重复这套能力**。
 * 复制字面量迟早会漂移（改了一条漏一条 → "同一个家族里某个型号不能选 xhigh"），故用常量收口。
 */
const GPT5_CAPS: Pick<ModelCapability, "thinking" | "efforts" | "endpoint"> = {
  thinking: true,
  efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  endpoint: "responses",
};

/**
 * Qwen 家族支持的思考等级（DashScope 兼容模式的 `reasoning_effort`）。
 *
 * 抽成常量是因为它会在**多条 qwen 条目**里重复出现：本表"能力 + 价格"必须写在同一条目里
 * （见 qwen 段的说明），于是同一份等级列表会跟着价格一起复制。散落的字面量一旦有一处改了，
 * 就会出现"同一个家族里 A 型号能选 xhigh、B 型号不能"这种查不出原因的行为差异。
 */
const QWEN_EFFORTS = ["low", "medium", "xhigh"];

/** o 系列（o1/o3/o4-mini…）支持的思考等级（官方 `reasoning_effort`） */
const O_SERIES_EFFORTS = ["low", "medium", "high"];

/**
 * gpt-4o 世代的**能力 + 价格**（官方 `developers.openai.com/api/docs/pricing`，核实 2026-09-18）。
 *
 * 抽常量是因为每条要在表里出现**两次**（`^` 锚定的精确条目 + 不锚定的家族兜底，
 * 后者用来命中聚合网关的 `openai/gpt-4o` 形式）。数字只写一份 → 不会出现
 * "锚定条目改了、兜底条目没改"导致同型号两价。
 */
const GPT4O_MAY = { thinking: false, context: 128000, maxOut: 4096, priceIn: 5, priceOut: 15 };
const GPT4O_MINI = { thinking: false, context: 128000, maxOut: 16384, priceIn: 0.15, priceOut: 0.6, priceCacheRead: 0.075 };
const GPT4O_STD = { thinking: false, context: 128000, maxOut: 16384, priceIn: 2.5, priceOut: 10, priceCacheRead: 1.25 };
const GPT4_TURBO = { thinking: false, context: 128000, maxOut: 4096, priceIn: 10, priceOut: 30 };

/** Kimi（Moonshot）思考能力（官方支持 low/high/max 三档 `reasoning_effort`） */
const KIMI_THINK: Pick<ModelCapability, "thinking" | "efforts"> = {
  thinking: true, efforts: ["low", "high", "max"],
};

/** MiniMax 思考能力（官方支持 low/medium/high 三档） */
const MINIMAX_THINK: Pick<ModelCapability, "thinking" | "efforts"> = {
  thinking: true, efforts: ["low", "medium", "high"],
};

/**
 * 豆包思考能力（thinking:{type:...} 协议）。
 * ⚠️ `thinkingParam` **只在家族兜底条目上**：锚定的精确条目**漏了它会让这几个型号
 * 思考开关失效**——写这条注释时它就差点被漏掉（与 GLM/Qwen 同一个坑）。
 */
const DOUBAO_THINK: Pick<ModelCapability, "thinking" | "efforts" | "thinkingParam"> = {
  thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "thinking",
};

/** 混元思考能力（chat_template_kwargs 协议）—— 同豆包：锚定条目**必须**带上，否则思考开关失效 */
const HUNYUAN_THINK: Pick<ModelCapability, "thinking" | "efforts" | "thinkingParam"> = {
  thinking: true, efforts: ["low", "medium", "high"], thinkingParam: "chat_template_kwargs",
};

/** 文心（百度千帆）思考能力 */
const ERNIE_THINK: Pick<ModelCapability, "thinking" | "efforts"> = {
  thinking: true, efforts: ["low", "medium", "high"],
};

/**
 * 主流模型能力预制表（单一真相源；上游 /models 拉取失败时的离线兜底）。
 * 覆盖国际 + 国内主流家族；「思考协议」按官方文档标注，随官方文案更新。
 * 注意：数组顺序即匹配优先级（首个命中返回），有前缀包含关系的家族需靠前（如 muse 在 spark 前）。
 *
 * ⚠️ **同一个家族内，具体型号的"能力 + 价格"必须写在同一条目里**：
 *    本表被 `inferModelCapabilities`（能力）与 `findPricingEntry`（取价）**共用**，
 *    两者都是"首个命中即返回"。若把"只有价格"的条目排在"只有能力"的通用条目之前，
 *    价格那条会赢，同时把 `thinking` / `thinkingParam` 一并盖掉 ——
 *    症状是"这几个型号的思考开关失效"，而改动看起来只是在补价格，极难联想。
 */
export const MODEL_CAPABILITIES: VendorCapabilities[] = [
  // ────────── 国际 · 云厂商 API（OpenAI 兼容，reasoning_effort 为主）──────────
  {
    key: "openai",
    label: "OpenAI（GPT-5 / o 系列）",
    context: 1000000,
    maxOut: 128000,
    models: [
      /*
       * OpenAI 定价（USD / 1M tokens）——**一手来源：`developers.openai.com/api/docs/pricing`**，
       * 核实 2026-09-18（用户提供官方页原文，逐行抄录）。
       *
       * ── 本段的结构约定（A-990-H，用户指出的病根）─────────────────────────
       * **精确 id 条目（锚定 `^…$`）在前，家族正则只作兜底在后。**
       * 为什么必须这样：家族正则（`gpt[-_]4o`、`claude.*opus`…）会让**同家族跨代价差**的型号
       * 共用一个价 —— `claude.*opus` 曾把 Opus 4.5+（$5/$25）按 Opus 4.1（$15/$75）计，
       * **高估 3 倍**且因为"有数字"极难发现。精确 id 是唯一能表达"同名不同代/不同档"的键。
       *
       * ⚠️ 顺序仍是硬约束：本表被「能力推断」与「取价」**共用**且**首个命中即返回**，
       *    所以 ① 带价条目必须自带能力字段（`...GPT5_CAPS` 就是为此抽的常量）；
       *    ② 越具体的模式必须排越前（`-pro`/`-mini`/`-nano`/`-cyber` 都在基础型号之前）。
       *
       * ── 只记 **Standard / 短上下文（<272K）** 档 ────────────────────────
       * 官方对部分型号按上下文长度分两档（如 astra 短 $10/$50、长 $20/$75；5.5 短 $5/$30、长 $10/$45，
       * 长档普遍是输入 2×、输出 1.5×）。slime 的取价入口是「token 单价 × 时刻」，
       * **没有"按输入长度"这一维**（与上游上下文分档同一条理由），所以记短档价 ——
       * 短档覆盖绝大多数请求；长档若按短档记账是**低估**，但比"完全未定价记 $0"好得多，
       * 且快照的 `contextTiers` 会在面板上把长档价目显示出来供人工核对/手填。
       * ⚠️ 另有三档处理方式**刻意不记**：Batch（五折）、Fast mode（约 2.5×）、数据驻留（+10%）——
       *    它们按请求参数计费，而 slime 的账单模型里没有这些维度，混进来会让默认档价整体偏移。
       */
      // ── 精确 id：GPT-6 / GPT-5.6 / GPT-5.x 旗舰（现行在售）──
      // `cache writes` 是 OpenAI **新增的独立计费列**（= 1.25× 输入价）：astra/sol/terra/luna/cyber
      // 有值；其余型号官方标 `-` = 不单独收费 → 本表不填，由倍率逻辑判为"推定不收费"（与官方一致）。
      { ...GPT5_CAPS, match: "^gpt[-_]?6[-_.]?astra$", priceIn: 10, priceOut: 50, priceCacheRead: 1, priceCacheWrite: 12.5 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.6[-_.]?cyber$", priceIn: 12.5, priceOut: 75, priceCacheRead: 1.25, priceCacheWrite: 15.625 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.5[-_.]?cyber$", priceIn: 12.5, priceOut: 75, priceCacheRead: 1.25 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.6[-_.]?sol$", priceIn: 4, priceOut: 20, priceCacheRead: 0.4, priceCacheWrite: 5 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.6[-_.]?terra$", priceIn: 2, priceOut: 12, priceCacheRead: 0.2, priceCacheWrite: 2.5 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.6[-_.]?luna$", priceIn: 0.2, priceOut: 1.2, priceCacheRead: 0.02, priceCacheWrite: 0.25 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.5[-_.]?pro$", priceIn: 30, priceOut: 180 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.5$", priceIn: 5, priceOut: 30, priceCacheRead: 0.5 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.4[-_.]?pro$", priceIn: 30, priceOut: 180 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.4[-_.]?mini$", priceIn: 0.75, priceOut: 4.5, priceCacheRead: 0.075 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.4[-_.]?nano$", priceIn: 0.2, priceOut: 1.25, priceCacheRead: 0.02 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.4$", priceIn: 2.5, priceOut: 15, priceCacheRead: 0.25 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.3[-_.]?codex$", priceIn: 1.75, priceOut: 14, priceCacheRead: 0.175 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.2[-_.]?pro$", priceIn: 21, priceOut: 168 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.2$", priceIn: 1.75, priceOut: 14, priceCacheRead: 0.175 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5\\.1$", priceIn: 1.25, priceOut: 10, priceCacheRead: 0.125 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5[-_.]?mini$", priceIn: 0.25, priceOut: 2, priceCacheRead: 0.025 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5[-_.]?nano$", priceIn: 0.05, priceOut: 0.4, priceCacheRead: 0.005 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5[-_.]?pro$", priceIn: 15, priceOut: 120 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5[-_.]?search[-_.]?api$", priceIn: 1.25, priceOut: 10, priceCacheRead: 0.125 },
      { ...GPT5_CAPS, match: "^gpt[-_]?5$", priceIn: 1.25, priceOut: 10, priceCacheRead: 0.125 },
      // ChatGPT 应用侧对外接口（官方"Specialized models → ChatGPT"）
      { ...GPT5_CAPS, match: "^chat[-_]?latest$", priceIn: 5, priceOut: 30, priceCacheRead: 0.5 },
      // ── 精确 id：o 系列（推理模型）──
      { match: "^o1[-_.]?pro$", thinking: true, efforts: O_SERIES_EFFORTS, priceIn: 150, priceOut: 600 },
      { match: "^o1$", thinking: true, efforts: O_SERIES_EFFORTS, priceIn: 15, priceOut: 60, priceCacheRead: 7.5 },
      { match: "^o3[-_.]?pro$", thinking: true, efforts: O_SERIES_EFFORTS, priceIn: 20, priceOut: 80 },
      { match: "^o3[-_.]?mini$", thinking: true, efforts: O_SERIES_EFFORTS, priceIn: 1.1, priceOut: 4.4, priceCacheRead: 0.55 },
      { match: "^o3$", thinking: true, efforts: O_SERIES_EFFORTS, priceIn: 2, priceOut: 8, priceCacheRead: 0.5 },
      { match: "^o4[-_.]?mini$", thinking: true, efforts: O_SERIES_EFFORTS, priceIn: 1.1, priceOut: 4.4, priceCacheRead: 0.275 },
      // ── 精确 id：gpt-4.1 家族（$2/$8 一代，支持 1M 上下文）──
      { match: "^gpt[-_]?4\\.1[-_.]?nano$", thinking: false, context: 1000000, maxOut: 32768, priceIn: 0.1, priceOut: 0.4, priceCacheRead: 0.025 },
      { match: "^gpt[-_]?4\\.1[-_.]?mini$", thinking: false, context: 1000000, maxOut: 32768, priceIn: 0.4, priceOut: 1.6, priceCacheRead: 0.1 },
      { match: "^gpt[-_]?4\\.1$", thinking: false, context: 1000000, maxOut: 32768, priceIn: 2, priceOut: 8, priceCacheRead: 0.5 },
      /*
       * ── 家族兜底（正则，**排在所有精确条目之后**）──────────────────────
       * 作用只有两个：① 承接**未逐一登记**的新型号（能力字段不能丢）；
       * ② 提供 family 级别的能力/端点信息。
       * ⚠️ 兜底**不带任何价**：命中兜底 = 该型号没有已核实的手写价 → 继续走快照二手价，
       *    面板会标出「家族兜底/快照兜底」。**绝不在这里挂一个"大概的价"**：
       *    那会让"未核实"看起来像"已核实"，是本项目最贵的一类错。
       */
      { ...GPT5_CAPS, match: "gpt[-_]?[5-9]" },
      // o 系列（o1/o3/o4/o5/...）：边界锚定避免误匹配含 "o" 的其它 ID
      { match: "(^|[^a-z0-9])o[1-9]([^a-z0-9]|$)", thinking: true, efforts: O_SERIES_EFFORTS },
      // ── 旧模型（gpt-4o 世代）：仍活在大量历史 usage 记录与供应商预设里 ──
      // 必须补上**各自真实**的上下文，否则会落到供应商级兜底（context=1M）——
      // gpt-4o 实际只有 128K，被吹成 1M 会污染上下文计量与自动压缩阈值。
      // ⚠️ 4o 有**两个价期**，必须拆开：2024-05-13 首发 $5/$15（输出上限 4096）；
      //    2024-08-06 起（含当前 `gpt-4o`）$2.5/$10（输出上限 16384）。
      // ⚠️ 缓存命中价来自官方表（$1.25 / $0.075）——**不是**行业惯例的 0.1×（那是 $0.25/$0.015），
      //    不写就会**低估缓存读取**（4o 的官方缓存价是输入价的 50%，远比 0.1× 高）。
      // ⚠️ 每条都写**两遍**（`^` 锚定的精确条目 + 不锚定的家族兜底）：
      //    前者命中规范 id（`gpt-4o`），后者命中**聚合网关带目录前缀**的 id（`openai/gpt-4o`）。
      //    只写锚定版会让网关用户的价掉到快照；只写兜底版则永远标不出"家族兜底"。
      //    价格数字抽在下面四个常量里，两处引用同一份 → 不存在"改一条漏一条"。
      { match: "^gpt[-_]4o[-_]2024[-_]0?5[-_]13", ...GPT4O_MAY },
      { match: "^gpt[-_]4o[-_]?mini", ...GPT4O_MINI },
      { match: "^gpt[-_]4o", ...GPT4O_STD },
      { match: "^gpt[-_]4[-_]?turbo", ...GPT4_TURBO },
      { match: "gpt[-_]4o[-_]2024[-_]0?5[-_]13", ...GPT4O_MAY },
      { match: "gpt[-_]4o[-_]?mini", ...GPT4O_MINI },
      { match: "gpt[-_]4o", ...GPT4O_STD },
      { match: "gpt[-_]4[-_]?turbo", ...GPT4_TURBO },
      // gpt-3.5 / davinci / babbage：官方仍在表内，历史记录会用到
      { match: "^gpt[-_]?3\\.5[-_]?turbo[-_.]?0?125$", thinking: false, context: 16385, priceIn: 0.5, priceOut: 1.5 },
      { match: "^gpt[-_]?3\\.5[-_]?turbo[-_.]?1106$", thinking: false, context: 16385, priceIn: 1, priceOut: 2 },
      { match: "^gpt[-_]?3\\.5[-_]?turbo[-_.]?instruct$", thinking: false, context: 4096, priceIn: 1.5, priceOut: 2 },
      { match: "^gpt[-_]?3\\.5[-_]?turbo$", thinking: false, context: 16385, priceIn: 0.5, priceOut: 1.5 },
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
      //
      // ── 定价（USD/1M，核实 2026-09-18）──
      // 来源：官方定价页结构 + 三个独立转售/聚合方的价目表交叉印证
      // （DigitalOcean Inference、JetBrains LLM 价目、token 计算器站），三方数值完全一致。
      // ⚠️ 本站直连官方页受地区限制，故此为**多源交叉印证**而非一手抓取 —— 见下方 provenance 说明。
      // ⚠️ 历史严重错误（用户实测指出）：此前只有一条 `claude.*opus` = **$15/$75**，
      //    那是 **Opus 4 / 4.1** 的价；而当前在售的 Opus **4.5/4.6/4.7/4.8/5 是 $5/$25** ——
      //    同一条正则把两代一起匹配，导致**成本高估 3 倍**（15 vs 5），且因为"有数字"极难被发现。
      //    这是"一个正则键表达不了跨代价差"的第三次同类事故（前两次：Opus 当 Sonnet 计、GLM flash）。
      //    规则：**凡跨代改价的家族，必须按代拆成多条，且窄条目排前**。
      // 缓存写入 = 5 分钟档 1.25×输入、1 小时档 2×输入（官方 prompt caching 规则）。
      //   本表 priceCacheWrite 填 **5 分钟档**（最常用）；1 小时档由上游探针的 cacheWrite1h 槽位承载。
      //
      // 顺序 = 窄 → 宽，首个命中即返回。`([-_.]|$)` 收尾是**必需**的：否则
      // `claude-3-haiku-20240307` 会被 `[1-9]\d` 吃掉 "20" 而误判为 Haiku 4.5
      // （日期戳是 8 位数字，任何不加边界的大版本号正则都会被它骗到）。

      // Opus 4.5+（4.5 / 4.6 / 4.7 / 4.8 / 5）：$5/$25，缓存读 $0.50、写入 5m $6.25。
      // 4.5 = 200K 上下文 / 64K 输出；4.6 起升到 1M / 128K —— 取其中**至少成立**的值：
      // 上下文用 1M（4.6+ 的真实值），4.5 会略高估窗口，但比"把 4.6 锁成 200K"危害小得多。
      {
        match: "claude.*opus[-_.](4[-_.][5-9]|[5-9])([-_.]|$)", thinking: true,
        efforts: ["low", "medium", "high", "xhigh", "max"], endpoint: "anthropic",
        context: 1048576, maxOut: 128000,
        priceIn: 5, priceOut: 25, priceCacheRead: 0.5, priceCacheWrite: 6.25,
      },
      // Opus 4 / 4.1（旧代，仍在售）：$15/$75，200K / 32K
      {
        match: "claude.*opus", thinking: true,
        efforts: ["low", "medium", "high", "xhigh", "max"], endpoint: "anthropic",
        context: 200000, maxOut: 32000,
        priceIn: 15, priceOut: 75, priceCacheRead: 1.5, priceCacheWrite: 18.75,
      },
      // Sonnet 5：$2/$10，缓存读 $0.20、写入 $2.50，1M / 128K
      {
        match: "claude.*sonnet[-_.]([5-9]|[1-9]\\d)([-_.]|$)", thinking: true,
        efforts: ["low", "medium", "high", "xhigh", "max"], endpoint: "anthropic",
        context: 1048576, maxOut: 128000,
        priceIn: 2, priceOut: 10, priceCacheRead: 0.2, priceCacheWrite: 2.5,
      },
      // Sonnet 3.5 / 3.7 / 4 / 4.5 / 4.6：$3/$15，缓存读 $0.30、写入 $3.75。
      // ⚠️ Sonnet 4.5 起超过 200K 提示**涨价 2 倍**（$6 输入 / $22.50 输出）——
      //    平铺字段只表达单档，长上下文档一律低估 2 倍。上游探针的 contextTiers 会采集该分档，
      //    快照层也带 contextTiers 供 UI 提示；计费侧按基准档计（见 ref-pricing 待办）。
      {
        match: "claude.*sonnet", thinking: true,
        efforts: ["low", "medium", "high", "xhigh", "max"], endpoint: "anthropic",
        context: 1048576, maxOut: 64000,
        priceIn: 3, priceOut: 15, priceCacheRead: 0.3, priceCacheWrite: 3.75,
      },
      // Haiku 4.5+：$1/$5，缓存读 $0.10、写入 $1.25
      {
        match: "claude.*haiku[-_.]([4-9]|[1-9]\\d)([-_.]|$)", thinking: true,
        efforts: ["low", "medium", "high"], endpoint: "anthropic",
        context: 200000, maxOut: 64000,
        priceIn: 1, priceOut: 5, priceCacheRead: 0.1, priceCacheWrite: 1.25,
      },
      // Claude 3 Haiku（2024-03 首发代）：$0.25/$1.25，缓存读 $0.03、写入 $0.30。
      // ⚠️ 必须排在下一条 `claude.*haiku` 通配之前：那条写的是 **3.5 Haiku** 的价（$0.80/$4），
      //    两代差 3 倍。此前单条通配把 `claude-3-haiku-20240307` 按 $0.80/$4 计 ——
      //    LiteLLM 与 OpenRouter 均记 $0.25/$1.25，本次交叉印证后拆条。
      //    注意 id 里代次在 haiku **前面**（`claude-3-haiku-…`），故锚定 `claude[-_.]3[-_.]haiku`。
      {
        match: "claude[-_.]3[-_.]haiku", thinking: true,
        efforts: ["low", "medium", "high"], endpoint: "anthropic",
        context: 200000, maxOut: 4096,
        priceIn: 0.25, priceOut: 1.25, priceCacheRead: 0.03, priceCacheWrite: 0.3,
      },
      // Haiku 3.5（2024-10 起）：$0.80/$4，缓存读 $0.08、写入 $1
      {
        match: "claude.*haiku", thinking: true,
        efforts: ["low", "medium", "high"], endpoint: "anthropic",
        context: 200000, maxOut: 8192,
        priceIn: 0.8, priceOut: 4, priceCacheRead: 0.08, priceCacheWrite: 1,
      },
      // 未识别代次的 Claude（未来型号 / 网关自定义别名）：**只给协议不给价**。
      // 宁可让用户按实际档位手填，也不要拿某一代的价去套未知代次 —— 跨代价差最大 6 倍（$2 vs $15）。
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
      //
      // ── 定价（USD/1M，核实 2026-09-18）──
      // ⚠️ 此前 **Gemini 全系一条价都没有**（整族落入「未定价」）→ 用户只要用 Gemini 就必须手填，
      //    这正是用户投诉的"难道要用户全部自定义"的最典型样本。补齐，且按代拆条。
      // 来源：官方定价页结构 + 多源交叉印证（三方一致）。标准档（Standard）价；
      //  Batch / Flex ≈ 五折、Priority ≈ 1.75~2×，属**服务等级**而非模型价，不写进本表。
      //  ⚠️ 3.6/3.7/3.8 Flash 的 $0.75/$3.75 是**限时推广价，官方明示 2027-01-01 翻倍**
      //     → 届时必须回来改这两行（这是"时效性"要盯的硬日期）。
      // 顺序 = 窄 → 宽。`gemini-3.5-flash-lite` 必须排在 `gemini-3.5-flash` 前，
      //  `gemini-3.1-pro` 必须排在 `gemini-3` 系列前，否则会被宽条目吃掉。

      // 2.5 Flash-Lite：$0.10 / $0.40（现役最便宜档）
      { match: "gemini[-_.]?2[._]?5[-_.]?flash[-_.]?lite", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 0.1, priceOut: 0.4, priceCacheRead: 0.01 },
      // 2.5 Flash：$0.30 / $2.50
      { match: "gemini[-_.]?2[._]?5[-_.]?flash", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 0.3, priceOut: 2.5, priceCacheRead: 0.03 },
      // 2.5 Pro：$1.25 / $10
      { match: "gemini[-_.]?2[._]?5[-_.]?pro", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 1.25, priceOut: 10, priceCacheRead: 0.125 },
      // 3.5 Flash-Lite：$0.30 / $2.50
      { match: "gemini[-_.]?3[._]?5[-_.]?flash[-_.]?lite", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 0.3, priceOut: 2.5, priceCacheRead: 0.03 },
      // 3.1 Flash-Lite：$0.25 / $1.50
      { match: "gemini[-_.]?3[._]?1[-_.]?flash[-_.]?lite", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 0.25, priceOut: 1.5, priceCacheRead: 0.025 },
      // 3.5 Flash：$1.50 / $9.00（比 3.6+ 贵一倍）
      { match: "gemini[-_.]?3[._]?5[-_.]?flash", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 1.5, priceOut: 9, priceCacheRead: 0.15 },
      // 3.6 / 3.7 / 3.8 Flash：$0.75 / $3.75（限时推广价，2027-01-01 起翻倍）
      { match: "gemini[-_.]?3[._]?[6-9][-_.]?flash", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 0.75, priceOut: 3.75, priceCacheRead: 0.075 },
      // 3 Flash（初代）：$0.50 / $3.00
      { match: "gemini[-_.]?3[-_.]?flash", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 0.5, priceOut: 3, priceCacheRead: 0.05 },
      // 3 / 3.1 Pro：$2.00 / $12.00（**≤200K 输入**；>200K 涨到 $4 / $18 —— 长文档要留意）
      { match: "gemini[-_.]?3(\\.[0-9]+)?[-_.]?pro", thinking: true, efforts: ["minimal", "low", "medium", "high"], endpoint: "google", priceIn: 2, priceOut: 12, priceCacheRead: 0.2 },
      // 未识别代次：只给协议，不给价（跨代价差可达 20 倍，猜不得）
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
    label: "DeepSeek（V4.1 Flash / V4 Pro）",
    context: 1048576,
    // 官方英文定价页 CONTEXT LENGTH 1M、**MAX OUTPUT: 384K**（= 393216）。
    // ⚠️ 这里曾写 65536（64K）—— 那是"见到 deepseek 就猜 64K"的旧经验值，
    //    与官方公布的 384K 差 6 倍。maxOut 决定 UI 的"最大输出"提示与输出上限校验，
    //    偏低会让用户以为模型只能吐 64K。核实于 2026-09-18（英文定价页 + LiteLLM 首方条目双重印证）。
    maxOut: 393216,
    models: [
      // DeepSeek 全系识别为思考模型；medium 内部映射 high
      //
      // 定价：来源为官方定价页 https://api-docs.deepseek.com/quick_start/pricing，核实于 2026-09-18。
      //   ⚠️ 该站中英两版**计价货币不同**：中文页单位是人民币「元」，英文页才是美元 $。
      //      **两列都是官方价**（不是汇率换算），所以两列都存：美元进 `priceIn/priceOut`，
      //      人民币进 `priceInCny/priceOutCny`（见 `PriceCurrency`）。这样界面上并列展示的两个
      //      数字都有官方出处，不需要任何一处"用换算值冒充官方价"。
      //      历史事故是**只取一列还拿错页**：把英文页的美元价当成人民币再 ÷7.25，成本缩水 7.25 倍。
      // 官方为**峰谷分时**（空闲价 = 高峰价的一半；高峰时段 = 周一至周五
      // UTC 01:00-04:00 与 06:00-10:00 = 北京时间 09:00-12:00 与 14:00-18:00；
      // 其余（含午休、夜间、整个周末）为空闲）→ 见 priceTiers（DEEPSEEK_PEAK_WINDOWS）。
      //   官方 2026-08-23 起明确"周六、周日全天不再区分峰谷、统一按低谷价" —— 与上述窗口一致。
      //   deepseek-flash   : $0.003/0.006 · 未命中 $0.15/0.30 · 输出 $0.60/1.20（空闲/高峰）
      //                      ¥0.02/0.04   · 未命中 ¥1/2       · 输出 ¥4/8
      //   deepseek-v4-pro  : $0.022/0.044 · 未命中 $0.66/1.32 · 输出 $1.98/3.96
      //                      ¥0.15/0.3   · 未命中 ¥4.5/9     · 输出 ¥13.5/27
      //
      // ⚠️⚠️ **不要把 V4 Pro 改成 Flash 价**（本轮差点误改，已查官方现行文档拦下）：
      //   2026-09-10 的 V4.1-Flash 发布公告曾说"自 9-14 起 deepseek-v4-pro 的请求全部路由到
      //   V4.1-Flash 并按 Flash 单价计费"。**该公告随后被官方撤回**，现行 API 文档与定价页改为：
      //     "In response to user demand, we have decided to continue providing API services for
      //      DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged."
      //   即 V4 Pro 仍在售、仍按 **自成一档的 Pro 价**（高峰 $1.32/$3.96）计费。
      //   若照那条已作废的公告把 Pro 压成 Flash 价，会把 Pro 的账**低估 4.4 倍**（输入）。
      //   教训：撤回过/被覆盖过的公告不是来源；以**现行定价页**为准，并记下撤回这件事本身。
      // 平铺字段（priceIn/priceOut/priceCacheRead）填**高峰标准价** —— 真实存在的档位，
      // 只在"没有时刻信息"时兜底（面板展示 / 无法确定时刻的历史行）。
      // ⚠️ 这里**曾经**填峰谷均值（= 高峰 × 0.75）：均值在任何真实时段都不存在，
      //    单条记录最多偏 ±33%，且偏差方向随机。有了 priceTiers 后已不再需要这种妥协。
      // ⚠️ 顺序：`deepseek.*pro` 必须排在宽泛的 `deepseek` 之前（首个命中即返回）。
      // ⚠️ 历史事故：此处曾写成 `0.14 / 7.25`（把**美元**刊例价又当成人民币除了一次汇率），
      //    导致成本整体缩水 7.25 倍，而且浮点常量看不出换算来源、极难发现。
      //    要引入汇率换算前，先停下来确认单位到底是 USD 还是 CNY（中文页是 CNY，别拿错页）。
      //
      // ⚠️ **模型命名已在 2026-09 换代，本表曾按旧名组织（用户实测指出）**：
      //     官方现售模型名是 `deepseek-flash`（服务 **DeepSeek-V4.1-Flash**）与 `deepseek-v4-pro`
      //     （服务 DeepSeek-V4-Pro-0813）。`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`
      //     以及更早的 `deepseek-chat` / `deepseek-reasoner` 都是**已退休别名**，官方原文：
      //       "The legacy names … are still accepted, but the corresponding models have been
      //        retired, their requests are served by the DeepSeek-V4.1-Flash model and billed
      //        at the Flash price."
      //     即：所有 flash 系别名**同价**，历史记录按 Flash 价回填是正确的；
      //     但"表里只写 v4-flash"会让面板认不出 v4.1，用户无法确认新模型是否被正确计价 ——
      //     所以下面把当前名与别名**显式并列**（价格同档，仅匹配面不同）。
      // ── 精确 id（规范名，锚定 `^`）：A-990-H 起优先命中这些条目 ──
      // 价格全部来自上面两个常量（**本文件里数字只出现一次**）。
      // 锚定的理由：让界面能把"这个型号被逐条登记过"与"命中的是家族通配"分开标（`pricingMatch`）。
      { ...DEEPSEEK_THINK, match: "^deepseek[-_.]?v4[-_.]?pro", ...DEEPSEEK_PRO_FLAT },
      { ...DEEPSEEK_THINK, match: "^deepseek[-_.]?flash", ...DEEPSEEK_FLASH_FLAT },
      { ...DEEPSEEK_THINK, match: "^deepseek[-_.]?v4[-_.]?1[-_.]?flash", ...DEEPSEEK_FLASH_FLAT },
      { ...DEEPSEEK_THINK, match: "^deepseek[-_.]?chat", ...DEEPSEEK_FLASH_FLAT },
      { ...DEEPSEEK_THINK, match: "^deepseek[-_.]?reasoner", ...DEEPSEEK_FLASH_FLAT },
      // ── 家族兜底（不锚定）：承接**聚合网关带目录前缀**的 id（如 `deepseek/deepseek-chat`）
      //    与未登记的变体。⚠️ 这里**必须保留价格**：它们是"旧名/别名"的真实落点，
      //    删掉会让这批 id 掉到快照二手价（比一手核实价差）。但界面会标「家族兜底」。
      {
        match: "deepseek.*pro", ...DEEPSEEK_THINK, ...DEEPSEEK_PRO_FLAT,
      },
      // 当前 Flash 线：别名 / 历史名（`deepseek-v4-flash`、`deepseek-chat`…）的兜底落点
      {
        match: "deepseek[-_.]?v?4[-_.]?1|deepseek[-_.]?flash|deepseek[-_.]?chat|deepseek[-_.]?reasoner|deepseek[-_.]?v?[23]|deepseek[-_.]?r1",
        ...DEEPSEEK_THINK, ...DEEPSEEK_FLASH_FLAT,
      },
      // 终极兜底：任何未列出的 deepseek 变体（含未来型号）按 Flash 价计费 ——
      // 宁可沿用"最便宜的在售档"，也不要落到「未定价」让用户手填。
      {
        match: "deepseek", thinking: true, efforts: ["low", "high", "max"],
        priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006,
        priceInCny: 2, priceOutCny: 8, priceCacheReadCny: 0.04,
        priceTiers: DEEPSEEK_FLASH_TIERS,
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
      // ── 定价（**官方原生人民币** ¥/1M，核实 2026-09-18）──
      // 一手来源：**阿里云百炼官方价格页** bailian.console.aliyun.com/#/price（人民币计价）。
      //
      // ⚠️ 这块此前**完全空缺** —— qwen 只有能力条目、没有任何价，于是取价一路落到
      //    「权威镜像快照」（OpenRouter 口径的**二手美元价**，且没有 ¥ 列）。
      //    后果正是用户看到的那样：国内厂商的模型按人民币显示时只能拿美元价折算，
      //    于是出现 `¥10.62` 这种**官方页面上不存在、还带小数**的数字。
      //    补进官方 ¥ 价后：① 显示即官方原数字；② 不再依赖二手镜像。
      //
      // 列映射（百炼价格页的五列 → 本表四字段）：
      //   输入价格 → priceInCny；输出价格 → priceOutCny；**输入价格(隐式命中缓存)** → priceCacheReadCny。
      // ⚠️ `隐式命中` 取的是**自动缓存**（DashScope 默认开启）那一列：绝大多数请求走的是它。
      //    百炼另有「显式创建缓存 / 显式命中缓存」两列（需请求里显式声明缓存），
      //    本表**刻意不登记** —— 登记成缓存写入价会让"没用显式缓存"的用户被多计费。
      //    若你确实用显式缓存，请在面板手填。
      //
      // ⚠️ 长上下文阶梯只登记 **≤256K 档**：百炼对 qwen3.7-plus 有 `256K~1M` 的加价档
      //    （¥8.993/¥35.972），而 slime 的取价入口是「token 单价 × 时刻」，**没有"按输入长度"这一维**
      //    （与上游上下文分档同一条理由）。所以记短档价并在面板提示长上下文需手填 —— 记长档
      //    会让绝大多数短请求被高估，那比"长请求偏低"更糟。
      //
      // ⚠️ **每条都必须自带 `thinking` 三件套**（不能只写价）：
      //    `MODEL_CAPABILITIES` 是**单表**，「能力推断」与「取价」都取**首个命中**的条目。
      //    只写价的条目排在通用 `{ match: "qwen" }` 之前，就会把 `enable_thinking`
      //    这个请求协议一并盖掉 —— 症状是"这几个型号思考开关失效"，且极难联想到定价改动。
      //    所以能力与价格**必须写在同一条**里。
      { match: "^qwen3\\.8-max", thinking: true, efforts: QWEN_EFFORTS, thinkingParam: "enable_thinking", priceInCny: 14.988, priceOutCny: 44.965, priceCacheReadCny: 1.874 },
      { match: "^qwen3\\.8-flash", thinking: true, efforts: QWEN_EFFORTS, thinkingParam: "enable_thinking", priceInCny: 1.094, priceOutCny: 3.427, priceCacheReadCny: 0.117 },
      { match: "^qwen3\\.8-27b", thinking: true, efforts: QWEN_EFFORTS, thinkingParam: "enable_thinking", priceInCny: 3.646, priceOutCny: 21.875, priceCacheReadCny: 0.729 },
      { match: "^qwen3\\.7-plus", thinking: true, efforts: QWEN_EFFORTS, thinkingParam: "enable_thinking", priceInCny: 2.998, priceOutCny: 11.991, priceCacheReadCny: 0.6 },
      // ⚠️ 仍缺：qwen3.7-max / qwen3.8-2.4t-a95b 的官方 ¥ 价（本次抓到的官方表格被截断，
      //    不拿半个数字充数）。这些 id 目前仍走快照二手价 —— 见 ref-pricing.md 的待办清单。
      // ⚠️ **通用条目必须排在最后**：本表"首个命中即返回"，通用 `match: "qwen"` 若排前面，
      //    上面那些带价的具体条目就永远命不中（价格静默回落到快照）—— 这是实测踩到的坑。
      { match: "qwen", thinking: true, efforts: QWEN_EFFORTS, thinkingParam: "enable_thinking" },
    ],
  },
  {
    key: "glm",
    label: "智谱 GLM",
    context: 128000,
    maxOut: 16384,
    models: [
      // GLM OpenAI 兼容端点认 reasoning_effort（原生 API 用 thinking.type，但 OpenAI 兼容走 reasoning_effort）。
      //
      // ── 定价（**官方原生人民币** ¥/1M，核实 2026-09-18）──
      // 一手来源：智谱开放平台官方定价页 open.bigmodel.cn/pricing（**人民币计价**），
      // 并与阿里云百炼的智谱原厂直供价目页（更新于 2026-09-11）逐条交叉核对。
      //
      // ⚠️ 本块**直接书写官方人民币原数字**（`priceInCny: 0.8`），不再写 `0.111` 这种
      //    "¥0.8 ÷ 7.2" 的换算结果 —— 那种写法有两个致命问题：① 数字看不出出处，没人能反推
      //    它是人民币折算来的；② 它会被误当成官方美元价。USD 由 `flatPricing` 在**唯一折算点**
      //    按 `USD_CNY_RATE` 生成并置 `usdDerivedFromCny = true`，界面显示为 `≈$`。
      //
      // ⚠️ 官方明示：「海外站 z.ai 采用美元计价，同一模型的美元单价与国内站人民币报价
      //    **并非简单汇率换算**」。实例：GLM-5.3-Flash 海外站刊例 **$0.15 / $0.50**，
      //    国内站 ¥0.8 / ¥2.8 折算仅 ≈$0.111 / ≈$0.389 —— 两者差 35%，**都不是错**。
      //    本表以国内站人民币价为计费基准；因此权威镜像（LiteLLM/OpenRouter 收录 z.ai 口径）
      //    必然对不上，这是口径不同而非错误，已在 SNAPSHOT_VETO 里声明（kind = basis-differs）。
      //    海外站 z.ai 官方美元刊例（2026-09 记录，**仅作口径对照，不是本表基准**）：
      //      GLM-5.3 / 5.2 / 5.1 = $1.4 / $4.4；GLM-5 = $1 / $3.2；GLM-4.7 / 4.6 / 4.5 = $0.6 / $2.2；
      //      GLM-4.5-Air = $0.2 / $1.1；GLM-5.3-Flash = $0.15 / $0.50；GLM-4.7-FlashX = $0.07 / $0.40。
      //    差距明显不是汇率误差（GLM-5 国内 ¥4/¥18 ≈$0.556/$2.5 vs 海外 $1/$3.2，差 1.8 倍），
      //    所以**任何"用汇率把两个口径互相校正"的做法都会引入系统性偏差** —— 只记录，不换算。
      //
      // ⚠️ 历史严重错误（本次由"手写表 vs 快照"对拍发现，共 14 条）：
      //    ① `glm.*flash` 一条通配把 **所有** flash 归零 → GLM-4.7-FlashX / 5.3-Flash 这些
      //       **付费**型号被当免费计费（$0）—— 静默 100% 少计，且"框里是 0"极难被发现；
      //    ② `glm` 通配把 GLM-4 时代的 ¥0.6/¥1.7 套到 GLM-5.3 上 → 低估 **17 倍**。
      //    这是"一个正则表达跨代/跨档差价"的第 5 次同类事故（前四次：Opus 当 Sonnet、
      //    Opus 跨代、GLM flash、gpt-4o 与 Claude 3 Haiku）。规则照旧：**按代拆条，窄条目排前**。
      //
      // ⚠️ 第 6 次同类事故（本轮发现）：**免费档漏了 GLM-4.7-Flash**。官方明示它"完全免费"，
      //    但表里没有它的精确条目，`glm-4.7-flash` 于是落到下方 `glm[-_.]4[-_.]7` 命中，
      //    被按 ¥2/¥8 计费 —— 免费模型收钱，方向是**高估**。教训：**同代里"免费档"必须
      //    和"付费档"一起成对登记**，只写付费档 = 免费档静默落到付费档。现已在免费区补齐。
      //
      // 官方定价多为「输入长度分档」（≥32K 后涨价，GLM-4.7 是 [32K,200K) 档）—— 本表
      // 没有"按输入长度"这一维，取**短档（基础档）**价并在下面逐条标明长档价。
      // 长上下文为主的账号应按长档手填，否则会低估（最多 2 倍）。
      // 官方「缓存存储」当前标注**限时免费** → 显式写 0（0 = 官方免费，区别于 undefined = 未知）。

      // ── 免费档（官方定价页明示"免费"；显式 0 = 免费，区别于 undefined = 未定价）──
      // 必须是**精确**形式（`([-_.]|$)` 收尾）：否则 `glm-4-flash` 会吃掉 `glm-4-flashx`，
      // 把付费的 FlashX 也记成 0 —— 这正是上面 ① 的成因。
      { match: "glm[-_.]4[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low", "medium", "high"], context: 200000, maxOut: 128000, priceInCny: 0, priceOutCny: 0, priceCacheReadCny: 0, priceCacheWriteCny: 0 },
      { match: "glm[-_.]4[-_.]6v[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 0, priceOutCny: 0, priceCacheReadCny: 0, priceCacheWriteCny: 0 },
      // GLM-4.7-Flash：官方明示「完全免费」。必须在 `glm[-_.]4[-_.]7` 之前 —— 否则被它吃掉按 ¥2/¥8 计费
      { match: "glm[-_.]4[-_.]7[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low", "medium", "high"], context: 200000, maxOut: 128000, priceInCny: 0, priceOutCny: 0, priceCacheReadCny: 0, priceCacheWriteCny: 0 },
      // GLM-4.5-Flash：官方文档 free 目录页（/cn/guide/models/free/glm-4.5-flash）明示"完全免费开放使用"。
      // 官方公告其已于 2026-01-30 下线、存量请求自动路由到 GLM-4.7-Flash（同样免费）——
      // 保留这条免费档是为了别名仍能被**正确识别为免费**，而不是下线后就变成"未定价"或被按付费代计价。
      { match: "glm[-_.]4[-_.]5[-_.]?flash([-_.]|$)", thinking: true, efforts: ["low", "medium", "high"], context: 131072, maxOut: 98304, priceInCny: 0, priceOutCny: 0, priceCacheReadCny: 0, priceCacheWriteCny: 0 },

      // ── 视觉（多模态）── 窄条目：先 FlashX 再 Flash 已在上方，这里先 FlashX 再常规
      { match: "glm[-_.]4[-_.]6v[-_.]?flashx", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 0.15, priceOutCny: 1.5, priceCacheReadCny: 0.03, priceCacheWriteCny: 0 },
      { match: "glm[-_.]4[-_.]6v", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 1, priceOutCny: 3, priceCacheReadCny: 0.2, priceCacheWriteCny: 0 },
      { match: "glm[-_.]4[-_.]5v", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 2, priceOutCny: 6, priceCacheReadCny: 0.4, priceCacheWriteCny: 0 },
      { match: "glm[-_.]5v[-_.]?turbo", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 5, priceOutCny: 22, priceCacheReadCny: 1.2, priceCacheWriteCny: 0 },

      // ── GLM-4.7 系（先 FlashX 再常规；免费档已在上方）──
      { match: "glm[-_.]4[-_.]7[-_.]?flashx", thinking: true, efforts: ["low", "medium", "high"], context: 200000, maxOut: 128000, priceInCny: 0.5, priceOutCny: 3, priceCacheReadCny: 0.1, priceCacheWriteCny: 0 },
      // GLM-4.7：¥2 起，[32K,200K) 档 ¥4 输入 / ¥16 输出
      { match: "glm[-_.]4[-_.]7", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 2, priceOutCny: 8, priceCacheReadCny: 0.4, priceCacheWriteCny: 0 },

      // ── GLM-4.5 系 ──
      // 本代三个档位的关系必须记牢：**免费档 = GLM-4.5-Flash**（已在免费区登记）、
      // 付费档 = GLM-4.5-Air（下方）、以及已下线的 GLM-4.5 / GLM-4.5-X。
      // 只写付费档而漏掉免费档，是第 6 次同类事故的成因：`glm-4.5-flash` 会穿过所有精确条目，
      // 落到最下方宽泛的 `glm[-_.]4` 命中 GLM-4 时代的 ¥0.6/¥1.7 —— 免费模型被收钱。
      { match: "glm[-_.]4[-_.]5[-_.]?air", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 0.8, priceOutCny: 2, priceCacheReadCny: 0.16, priceCacheWriteCny: 0 },

      // ── GLM-5 系（先 flash / turbo / 小数点版本，最后才是裸 `glm-5`）──
      { match: "glm[-_.]5[-_.]3[-_.]?flash", thinking: true, efforts: ["low", "medium", "high"], context: 1048576, maxOut: 128000, priceInCny: 0.8, priceOutCny: 2.8, priceCacheReadCny: 0.23, priceCacheWriteCny: 0 },
      { match: "glm[-_.]5[-_.]3", thinking: true, efforts: ["low", "medium", "high"], context: 1048576, maxOut: 128000, priceInCny: 8, priceOutCny: 28, priceCacheReadCny: 2, priceCacheWriteCny: 0 },
      { match: "glm[-_.]5[-_.]2", thinking: true, efforts: ["low", "medium", "high"], context: 1048576, maxOut: 128000, priceInCny: 8, priceOutCny: 28, priceCacheReadCny: 2, priceCacheWriteCny: 0 },
      // GLM-5.1：¥6 输入 / ¥24 输出；≥32K 档 ¥8 / ¥28
      { match: "glm[-_.]5[-_.]1", thinking: true, efforts: ["low", "medium", "high"], context: 200000, maxOut: 128000, priceInCny: 6, priceOutCny: 24, priceCacheReadCny: 1.3, priceCacheWriteCny: 0 },
      // GLM-5-Turbo：¥5 / ¥22；≥32K 档 ¥7 / ¥26
      { match: "glm[-_.]5[-_.]?turbo", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 5, priceOutCny: 22, priceCacheReadCny: 1.2, priceCacheWriteCny: 0 },
      // GLM-5：¥4 输入 / ¥18 输出；≥32K 档 ¥6 / ¥22
      { match: "glm[-_.]5", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 4, priceOutCny: 18, priceCacheReadCny: 1, priceCacheWriteCny: 0 },

      // ── GLM-4 系（旧代）：¥0.6/M 输入、¥1.7/M 输出 ──
      // 缓存命中价在本轮核实来源中未出现 → **留空**（旧的 `priceCacheRead: 0.017` 是
      // 反推出来的 ~¥0.12，无来源支撑，按"宁可留空也不要填猜测值"移除）。
      { match: "glm[-_.]4", thinking: true, efforts: ["low", "medium", "high"], priceInCny: 0.6, priceOutCny: 1.7 },
      // 未识别代次的 GLM（未来型号 / 网关自定义别名）：**只给协议不给价**（同 claude/openai 的处理）
      { match: "glm", thinking: true, efforts: ["low", "medium", "high"] },
    ],
  },
  {
    key: "kimi",
    label: "Moonshot Kimi",
    context: 262144,
    maxOut: 65536,
    models: [
      /*
       * ── 定价（**官方原生人民币** ¥/1M，核实 2026-09-18）──
       * 一手来源：**Kimi 大模型开放平台** platform.moonshot.cn 首页刊例
       *   + www.kimi.com/resources/kimi-k3-pricing（K3）
       *   + platform.kimi.com/docs/pricing/batch（批量价 = 标准 60%，**反算回标准价交叉验证**：
       *     k2.6 批量 ¥3.90/¥16.20 → ¥6.50/¥27.00 ✓、k2.5 批量 ¥2.40/¥12.60 → ¥4.00/¥21.00 ✓
       *     —— 两条独立路径给出同一个数，可信度够高。）
       *
       *   kimi-k3       缓存命中 ¥2.00 / 输入 ¥20.00 / 输出 ¥100.00（1M 上下文）
       *   kimi-k2.7-code 缓存命中 ¥1.30 / 输入 ¥6.50 / 输出 ¥27.00
       *   kimi-k2.6     缓存命中 ¥1.10 / 输入 ¥6.50 / 输出 ¥27.00
       *   kimi-k2.5     缓存命中 ¥0.70 / 输入 ¥4.00 / 输出 ¥21.00
       *   moonshot-v1   输入 ¥10.00 / 输出 ¥30.00（官方未列缓存价 → 不填，不猜）
       *
       * ⚠️ 补这块的实际收益：此前 kimi **完全没价**，取价落到快照二手美元价
       *    （kimi-k3 快照 $2.1/$10.95 ≈ ¥15/¥79），比官方 ¥20/¥100 **低约 30%**，
       *    且按人民币显示时只能折算 → 必然出现小数。补官方 ¥ 价后两个问题一起消失。
       *
       * ⚠️ 顺序：具体型号（锚定 `^`）在前，家族兜底 `kimi` 在后；带价条目必须自带能力字段。
       */
      { match: "^kimi[-_.]?k3", ...KIMI_THINK, priceInCny: 20, priceOutCny: 100, priceCacheReadCny: 2 },
      { match: "^kimi[-_.]?k2\\.7[-_.]?code", ...KIMI_THINK, priceInCny: 6.5, priceOutCny: 27, priceCacheReadCny: 1.3 },
      { match: "^kimi[-_.]?k2\\.6", ...KIMI_THINK, priceInCny: 6.5, priceOutCny: 27, priceCacheReadCny: 1.1 },
      { match: "^kimi[-_.]?k2\\.5", ...KIMI_THINK, priceInCny: 4, priceOutCny: 21, priceCacheReadCny: 0.7 },
      { match: "^moonshot[-_.]?v1", ...KIMI_THINK, priceInCny: 10, priceOutCny: 30 },
      // 家族兜底：承接未登记变体（如 `moonshot-v1-128k` 之外的别名）与带目录前缀的 id
      { match: "kimi", ...KIMI_THINK },
    ],
  },
  {
    key: "minimax",
    label: "MiniMax（M 系 / abab）",
    context: 1000000,
    maxOut: 65536,
    models: [
      /*
       * ── 定价（**官方原生人民币** ¥/1M，核实 2026-09-18）──
       * 一手来源：**MiniMax 开放平台按量计费页** platform.minimaxi.com/docs/guides/pricing-paygo
       *   + platform.minimaxi.com/subscribe/token-plan（Token Plan），两页数值一致。
       *
       * 现行（M3 标注"永久五折"，下行为**折后执行价**）：
       *   MiniMax-M3（输入 ≤512K）  输入 ¥2.10 / 输出 ¥8.40 / 缓存读 ¥0.42
       *   MiniMax-M3（512K~1M）     输入 ¥4.20 / 输出 ¥16.80 / 缓存读 ¥0.84   ← 长档，本表不记（见下）
       *   MiniMax-M2.7              输入 ¥2.10 / 输出 ¥8.40 / 缓存读 ¥0.42 / **缓存写 ¥2.625**
       *   MiniMax-M2.7-highspeed    输入 ¥4.20 / 输出 ¥16.80 / 缓存读 ¥0.42 / 缓存写 ¥2.625
       * 历史（M2 / M2.1 / M2.5）：   输入 ¥2.10 / 输出 ¥8.40 / 缓存读 ¥0.21 / 缓存写 ¥2.625
       *                            （-highspeed 版：输入 ¥4.20 / 输出 ¥16.80 / 缓存读 ¥0.21）
       *
       * ⚠️ MiniMax 是**少数明确收"缓存写入"费**的国内厂商（¥2.625 = 输入价 1.25×），
       *    不填会让这部分的成本记成 0 —— 此前本表完全无价，正是这类漏项的重灾区。
       * ⚠️ M3 的长档（512K~1M）与 OpenAI 同理不记（slime 无"按输入长度"维度），取短档价。
       * ⚠️ 顺序：`-highspeed` 必须排在基础型号之前（否则被 `^minimax[-_.]?m2\.7` 前缀吃掉）。
       */
      { match: "^minimax[-_.]?m3", ...MINIMAX_THINK, priceInCny: 2.1, priceOutCny: 8.4, priceCacheReadCny: 0.42 },
      { match: "^minimax[-_.]?m2\\.7[-_.]?highspeed", ...MINIMAX_THINK, priceInCny: 4.2, priceOutCny: 16.8, priceCacheReadCny: 0.42, priceCacheWriteCny: 2.625 },
      { match: "^minimax[-_.]?m2\\.7", ...MINIMAX_THINK, priceInCny: 2.1, priceOutCny: 8.4, priceCacheReadCny: 0.42, priceCacheWriteCny: 2.625 },
      { match: "^minimax[-_.]?m2\\.5[-_.]?highspeed", ...MINIMAX_THINK, priceInCny: 4.2, priceOutCny: 16.8, priceCacheReadCny: 0.21, priceCacheWriteCny: 2.625 },
      { match: "^minimax[-_.]?m2\\.5", ...MINIMAX_THINK, priceInCny: 2.1, priceOutCny: 8.4, priceCacheReadCny: 0.21, priceCacheWriteCny: 2.625 },
      { match: "^minimax[-_.]?m2(\\.1)?", ...MINIMAX_THINK, priceInCny: 2.1, priceOutCny: 8.4, priceCacheReadCny: 0.21, priceCacheWriteCny: 2.625 },
      // 家族兜底：`abab` 老系列无官方现价 → 不带价，避免编造
      { match: "minimax|abab", ...MINIMAX_THINK },
    ],
  },
  {
    key: "doubao",
    label: "字节豆包 Doubao",
    context: 262144,
    maxOut: 65536,
    models: [
      /*
       * ── 定价（**官方原生人民币** ¥/1M，核实 2026-09-18）──
       * 一手来源（**三源一致**）：volcengine.com/product/ark（产品页刊例）
       *   + volcengine.com/docs/6492/1544808（模型计费标准）
       *   + docs.volcengine.com/docs/86677/2387327（TRAE 内置模型单价）。
       *   Doubao-Seed-2.1-Pro   输入 ¥6 / 输出 ¥30 / 缓存命中 ¥1.2
       *   Doubao-Seed-2.1-Turbo 输入 ¥3 / 输出 ¥15 / 缓存命中 ¥0.6
       *   Doubao-Seed-Evolving  输入 ¥6 / 输出 ¥30 / 缓存命中 ¥1.2（与 2.1-Pro 同价）
       * ⚠️ **刻意不写** `seed-2.0-*` 与 `seed-1.8`：它们按**输入/输出长度**分三档，
       *    且不同官方文档页对 2.0-pro 的数字**互相打架**（一处 ¥3.2/¥16、另一处 ¥6.4/¥32）。
       *    打架的数按纪律不进真相源 —— 宁可让这几条走快照兜底（界面会标「家族兜底」）。
       * ⚠️ 豆包还单独收**缓存存储费**（¥0.017/百万·小时）—— 按小时计费，slime 账单模型
       *    没有"时长"维度，无法折成 token 价 → 不填（不猜），并在上游 hints 里展示。
       */
      { match: "^doubao[-_.]?seed[-_.]?2\\.1[-_.]?pro", ...DOUBAO_THINK, priceInCny: 6, priceOutCny: 30, priceCacheReadCny: 1.2 },
      { match: "^doubao[-_.]?seed[-_.]?2\\.1[-_.]?turbo", ...DOUBAO_THINK, priceInCny: 3, priceOutCny: 15, priceCacheReadCny: 0.6 },
      { match: "^doubao[-_.]?seed[-_.]?evolving", ...DOUBAO_THINK, priceInCny: 6, priceOutCny: 30, priceCacheReadCny: 1.2 },
      // 家族兜底：承接 `doubao-*`（老模型）与网关带前缀的 id
      // 火山引擎官方：thinking:{type:"enabled"|"disabled"|"auto"} 控制思考（无 budget_tokens）
      { match: "doubao", ...DOUBAO_THINK, thinkingParam: "thinking" },
    ],
  },
  {
    key: "hunyuan",
    label: "腾讯混元 Hunyuan",
    context: 131072,
    maxOut: 65536,
    models: [
      /*
       * ── 定价（**官方原生人民币** ¥/1M，核实 2026-09-18）──
       * 一手来源：cloud.tencent.com/document/product/1729/97731（混元生文计费概述）
       *   + /document/api/1323/106152（计费概述，元/千 tokens × 1000 换算）
       *   + 腾讯云智能体开发平台购买指南 PDF（PU→现金折算价）。
       * 只写**多源一致**的条目：
       *   hunyuan-turbos  ¥0.8 / ¥2      （计费概述 0.0008/0.002 元每千 + PDF 一致）
       *   hunyuan-t1      ¥1 / ¥4        （计费概述 + PDF 一致）
       *   hunyuan-a13b    ¥0.5 / ¥2      （生文计费概述）
       *   hunyuan-pro     ¥30 / ¥100     （计费概述 0.03/0.1 元每千 + PDF 一致）
       * ⚠️ **刻意不写**：`hunyuan-standard`（一处 ¥4.5/¥5、另一处 ¥0.8/¥2 —— 打架）
       *    与 `hunyuan-turbo`（一处 ¥15/¥50、另一处 ¥2.4/¥9.6 —— 打架）。
       *    打架的数按纪律不进真相源；`Hy3`（正式版 ¥1/¥4 vs preview ¥2/¥8，且 id 形态未确认）同样待办。
       * ⚠️ 腾讯云上**代售**的 DeepSeek（V4-Pro ¥12/¥24）是**转售价**，与官方 ¥9/¥27 不同
       *    → 绝不能拿来覆盖 deepseek 官方价（本表 deepseek 走官方条目，不受影响）。
       */
      { match: "^hunyuan[-_.]?turbos", ...HUNYUAN_THINK, priceInCny: 0.8, priceOutCny: 2 },
      { match: "^hunyuan[-_.]?t1", ...HUNYUAN_THINK, priceInCny: 1, priceOutCny: 4 },
      { match: "^hunyuan[-_.]?a13b", ...HUNYUAN_THINK, priceInCny: 0.5, priceOutCny: 2 },
      { match: "^hunyuan[-_.]?pro", ...HUNYUAN_THINK, priceInCny: 30, priceOutCny: 100 },
      // 混元 chat template：apply_chat_template(enable_thinking=True) → chat_template_kwargs 族
      { match: "hunyuan", ...HUNYUAN_THINK, thinkingParam: "chat_template_kwargs" },
    ],
  },
  {
    key: "ernie",
    label: "百度文心 Ernie",
    context: 131072,
    maxOut: 65536,
    models: [
      /*
       * ── 定价（**官方原生人民币** ¥/1M，核实 2026-09-18）──
       * 一手来源：**百度千帆模型服务计费** cloud.baidu.com/doc/qianfan/s/wmh4sv6ya
       *   + cloud.baidu.com/doc/qianfan-docs/s/Jm8r1826a（两页一致）
       *   + 千帆控制台（qianfan.cloud.baidu.com，ernie-x1.1-preview ¥1/¥4）。
       * 官方按**输入长度**分两档（≤32k / 32k~128k），本表取 **≤32k 短档**（同 OpenAI/MiniMax 的处理）：
       *   ERNIE-5.1            ¥4 / ¥18          （长档 ¥6/¥22）
       *   ERNIE-5.0（含 Thinking 系）¥6 / ¥24   （长档 ¥10/¥40）
       *   ERNIE-X1.1-preview   ¥1 / ¥4
       *   ERNIE-4.5-Turbo-VL   ¥3 / ¥9 / 缓存 ¥0.75
       *   ERNIE-4.5-Turbo      ¥0.8 / ¥3.2 / 缓存 ¥0.2
       *   ERNIE-4.5-8K         ¥4 / ¥16
       */
      { match: "^ernie[-_.]?5\\.1", ...ERNIE_THINK, priceInCny: 4, priceOutCny: 18 },
      { match: "^ernie[-_.]?5\\.0", ...ERNIE_THINK, priceInCny: 6, priceOutCny: 24 },
      { match: "^ernie[-_.]?x1", ...ERNIE_THINK, priceInCny: 1, priceOutCny: 4 },
      { match: "^ernie[-_.]?4\\.5[-_.]?turbo[-_.]?vl", ...ERNIE_THINK, priceInCny: 3, priceOutCny: 9, priceCacheReadCny: 0.75 },
      { match: "^ernie[-_.]?4\\.5[-_.]?turbo", ...ERNIE_THINK, priceInCny: 0.8, priceOutCny: 3.2, priceCacheReadCny: 0.2 },
      // ⚠️ 只锚定 `-8k`：写成 `^ernie[-_.]?4\.5` 会把**开源版** `ernie-4.5-vl-424b-a47b`
      //    （千帆上另一档价，快照 $0.42/$1.25）也吃进 ERNIE-4.5-8K 的 ¥4/¥16（高估 3 倍）——
      //    实测被冲突守卫抓住。开源变体留给家族兜底 → 快照。
      { match: "^ernie[-_.]?4\\.5[-_.]?8k", ...ERNIE_THINK, priceInCny: 4, priceOutCny: 16 },
      { match: "ernie", ...ERNIE_THINK },
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
    // ── 上下文口径（A-1054 修正；A-1087 重述理由）──
    // 官方文档「限制与价格」表：上下文窗口 **512K** / 最大输出 **65.5K**
    //   （agnes-ai.com/zh-Hans/docs/agnes-25-flash）。
    //
    // ⚠️ A-1087：A-1054 当初把 524288 改成 512000，理由是「全项目显示层 ÷1000，写 524288
    //    会读成 524K」—— **这条理由已经作废**：显示层现改为**按上限自适进制**
    //    （`gui/src/renderer/pages/contextMath.ts` 的 `pickTokenBase`：哪个进制能把上限写成
    //    整数 K 就用哪个，平局取十进制）。于是 `524288` 与 `512000` **都**读作「512K」，
    //    界面上完全同形 —— 用户原点（原话「没有 524K 容量的上下文，只有 512K」）的根因是
    //    *旧的* 全局 ÷1000，不是这两个数里的某一个。
    //    保留 512000 只是"不改数值"：512K 在两种进制下都成立，写十进制与同表其余头条模型
    //    （gpt-4o 128000 / claude 200000 / deepseek 64000）同形。**别据这条注释去反推数值。**
    //
    // ⚠️ 另一条路径也早就按 512000 写了（`providers.ts` 正则兜底分支，理由同已作废），
    //    但那条分支**只在家族表未命中时才跑** → 对 agnes 文本模型是死代码，
    //    于是出现「改了却没生效」（用户观感：修了一个坏一个）。**真值只应有一个产地：本表。**
    //
    // ⚠️ 为什么不像 Kimi / Doubao 那样保留 2^n：那两家的官方文档**自己就把 K 定义成 ×1024**
    //    （Moonshot 帮助中心原文「最大输出长度是 256*1024 - prompt_tokens」），故 262144 是忠实值；
    //    Agnes 官方只给「512K」这个写法（两种进制都成立）。**判据是「厂商怎么定义 K」，
    //    不是「我们偏好哪种数制」。**
    //
    // 副作用检查：本表同家族无其他条目覆盖 context，故一处改完全部 agnes 文本模型同步生效。
    context: 512000,
    // 官方「65.5K」→ ÷1000 显示 66K（`ProvidersPanel` 取整）。65536 也是 66K，两者界面一致，
    // 故保持 2^16 不动（它同时是真实的 token 上限），避免无意义的数值churn。
    maxOut: 65536,
    // ── A-1091：RPM 档位（核实日期 2026-09-23）──
    // 来源：Agnes 官方站内公告《Agnes 文本模型 RPM 限额调整公告》（2026-09-23 16:48，向全体用户推送）：
    //   「免费用户及企业用户的 RPM 限额将统一下调 50%」→ 免费 20→**10** / 企业 40→**20**。
    //   （公告另注："请您根据新的限额合理调整 API 请求频率，避免触发限流。"）
    // 这里写**免费档 10**（默认用户群就是免费档）。企业档由实测响应头覆盖（见 probe-live 的 rateLimit）。
    // ⚠️ 下调 50% 意味着**旧值 20 已经会踩限**——这正是"官方参数变了而客户端无感"的典型形态：
    //    用户只会看到零星的 429 与中途中断，不会想到是自己把限额用超了。
    rpm: 10,
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
    // A-1054：`524288` → `512000`。⚠️ A-1087：当时给的理由（显示层 ÷1000，写 2^19 会读成
    // 「524K」）已作废 —— 显示层改为按上限自适进制后 524288 也读作「512K」；保留 512000
    // 仅为不改数值。注释自称「官方公布窗口 512K」与值 512000 现在**两种进制下都自洽**。
    context: 512000,
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
  // ── 计费口径：USD / 1M tokens。成本统计**只读**这几个字段 ──
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  // ── 官方**原生币种**报价（只用于展示与核对，不参与推导）──
  /**
   * 官方原生人民币价（¥/1M tokens）。有值 = 该厂商官方定价页是人民币计价。
   * UI 应**优先**展示这一口径（原币种原数字），而不是展示被折算过的美元近似值。
   */
  priceInCny?: number;
  priceOutCny?: number;
  priceCacheReadCny?: number;
  priceCacheWriteCny?: number;
  /**
   * `priceIn` / `priceOut` / `priceCache*` 是否由人民币价按 `USD_CNY_RATE` **折算**而来。
   * `true` → UI 必须显示成 `≈$x`（近似折算）；`false`/缺省 → 官方公布的美元价，可直接显示 `$x`。
   * 这条区分是"$ 与 ¥ 分开"的要害：折算值一旦冒充官方美元价，两边就永远对不上账。
   */
  usdDerivedFromCny?: boolean;
  /** 命中的供应商 key（排障与 UI「价格来自内置价目表」提示用） */
  vendor?: string;
}

/** 命中的模型条目（家族 + 模型级），供定价相关函数共用同一套匹配逻辑 */
interface PricingEntry {
  vendor: VendorCapabilities;
  model: ModelCapability;
  /** 命中的正则源串（排障与"精确/兜底"判定都要） */
  pattern: string;
  /**
   * 命中方式（A-990-H，用户指出的病根）：
   *   · `exact`  —— 命中**锚定 `^…$`** 的条目 = 该型号被逐一登记过（价格可追到官方页）
   *   · `family` —— 命中家族正则 = 该型号**没有**已核实的手写价，价可能来自快照或缺失
   *
   * 判据：**模式以 `^` 开头**（前缀锚定到具体型号名）即算 `exact`；否则算 `family`。
   * 为什么是"前缀锚定"而不是"`^…$` 双锚定"：官方会给同一型号加日期后缀
   * （`qwen3.8-max-0902`、`gpt-5.5-2026-04-23`），双锚定会把它们全部漏掉。
   * ⚠️ 而**不能**拿"是否以 `^` 开头"去要求所有历史条目：聚合网关会加目录前缀
   * （OpenRouter 的 `deepseek/deepseek-chat`），那些条目必须保持不锚定才能命中。
   * 所以约定只对**规范 id 条目**生效：现行在售型号应为 `^` 开头的精确条目，家族正则作兜底。
   */
  matchKind: "exact" | "family";
}

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
        if (new RegExp(m.match, "i").test(id)) {
          // `^` 前缀锚定 = 精确条目（判据详见 PricingEntry.matchKind 注释）
          const kind = m.match.startsWith("^") ? "exact" : "family";
          return { vendor: v, model: m, pattern: m.match, matchKind: kind };
        }
      } catch {
        // 非法正则该条目跳过（数据维护错误不影响其它匹配）
        continue;
      }
    }
  }
  return undefined;
}

/**
 * 该模型的价目命中方式（供界面标注"这条价可不可信"）。
 *
 * 为什么必须暴露给 UI：家族兜底意味着**这条价可能偏离**（家族里跨代改价时，兜底键只能取其一），
 * 而用户面对一个数字时**无法分辨**它来自"逐一核对的官方价"还是"家族通配"。
 * 不标出来，`claude.*opus` 把 Opus 4.5+ 按 4.1 的价算那类事故就**永远只能靠人偶然发现**。
 */
export function pricingMatchKind(modelId: string): "exact" | "family" | "none" {
  return findPricingEntry(modelId)?.matchKind ?? "none";
}

/**
 * A-1091：该模型**声明的** RPM 档位（模型级 > 供应商级；都没声明 → undefined）。
 *
 * ⚠️ 复用 `findPricingEntry` 的家族匹配循环，**不另写一套** —— 「哪个家族管这个模型」
 *    必须只有一个答案，两份匹配循环迟早漂移出"定价认 agnes、限流不认"的经典缺陷
 *    （本文件就是为消除双份真相源而存在的）。
 * ⚠️ 返回 `undefined` = **未知**，绝不等于"无限"：调用方（`rpmLimiter.resolveRpm`）据此
 *    选择"放行且不发明阈值"，等实测值到了再收紧。返回 `0` 则表示"真的不能发请求"。
 */
export function resolveDeclaredRpm(modelId: string): { rpm: number; vendor: string } | undefined {
  const hit = findPricingEntry(modelId);
  if (!hit) { return undefined; }
  const rpm = hit.model.rpm ?? hit.vendor.rpm;
  return rpm === undefined ? undefined : { rpm, vendor: hit.vendor.key };
}

/**
 * 把条目的平铺价（模型级 > 供应商级）整理成 ModelPricing；全 undefined 时返回 `{}`。
 *
 * **这是整个文件里唯一发生币种折算的地方**（`$ 与 ¥ 分开` 的工程落点）：
 *   - 官方给了美元价 → 直接用，`usdDerivedFromCny` 不置位（是官方价）；
 *   - 官方只给人民币价 → 按 `USD_CNY_RATE` 折算成 USD 供成本统计，并把 `usdDerivedFromCny`
 *     置为 true，同时把**人民币原价**一并带出去（UI 展示原币种，不被折算值顶掉）。
 * 其余任何地方都**不得**再写 `/ 7.2` 这类常量 —— 历史事故（deepseek 美元价被当人民币再 ÷7.25，
 * 成本整体缩水 7.25 倍）就是因为换算散落在各条目里、看不出数字的出处。
 */
function flatPricing(entry: PricingEntry): ModelPricing {
  const { vendor: v, model: m } = entry;

  // 官方原生人民币价（模型级 > 供应商级）
  const inCny = m.priceInCny ?? v.priceInCny;
  const outCny = m.priceOutCny ?? v.priceOutCny;
  const cacheReadCny = m.priceCacheReadCny ?? v.priceCacheReadCny;
  const cacheWriteCny = m.priceCacheWriteCny ?? v.priceCacheWriteCny;

  // 官方美元价（模型级 > 供应商级）
  const inUsd = m.priceIn ?? v.priceIn;
  const outUsd = m.priceOut ?? v.priceOut;
  const cacheReadUsd = m.priceCacheRead ?? v.priceCacheRead;
  const cacheWriteUsd = m.priceCacheWrite ?? v.priceCacheWrite;

  // 逐字段"官方美元价优先，否则由人民币价折算"
  const priceIn = inUsd ?? (inCny === undefined ? undefined : cnyToUsd(inCny));
  const priceOut = outUsd ?? (outCny === undefined ? undefined : cnyToUsd(outCny));
  const priceCacheRead = cacheReadUsd ?? (cacheReadCny === undefined ? undefined : cnyToUsd(cacheReadCny));
  const priceCacheWrite = cacheWriteUsd ?? (cacheWriteCny === undefined ? undefined : cnyToUsd(cacheWriteCny));

  // 命中家族但该家族未定价 → 仍然是「未定价」，不能返回 {priceIn: undefined} 让上层误当已解析
  if (priceIn === undefined && priceOut === undefined
    && priceCacheRead === undefined && priceCacheWrite === undefined) {
    return {};
  }
  const out: ModelPricing = { priceIn, priceOut, priceCacheRead, priceCacheWrite, vendor: v.key };
  // 人民币原价随行带出（只在有值时挂字段，保持 `toEqual({})` 之类的既有断言不受影响）
  if (inCny !== undefined) { out.priceInCny = inCny; }
  if (outCny !== undefined) { out.priceOutCny = outCny; }
  if (cacheReadCny !== undefined) { out.priceCacheReadCny = cacheReadCny; }
  if (cacheWriteCny !== undefined) { out.priceCacheWriteCny = cacheWriteCny; }
  // 只要有任一 USD 金额是折算来的，就整体标记"部分含折算值"（UI 显示 ≈$）
  if ((inUsd === undefined && inCny !== undefined)
    || (outUsd === undefined && outCny !== undefined)
    || (cacheReadUsd === undefined && cacheReadCny !== undefined)
    || (cacheWriteUsd === undefined && cacheWriteCny !== undefined)) {
    out.usdDerivedFromCny = true;
  }
  return out;
}

/* ═══════════════ 权威价格快照（A-989）═══════════════ */

/**
 * 快照 id 与真实模型 id 的**归一化**（与 scripts/sync-model-pricing.mjs 的 normalizeId 保持同一语义）。
 * 快照 id 已是归一形态，这里只需把查询方（供应商配置里的原始 id）也对齐：
 * 大小写、前导 `~`（OpenRouter 的 "latest" 别名前缀）、`vendor/` 前缀。
 */
function normalizeModelIdForSnapshot(raw: string): string {
  let id = (raw ?? "").trim().toLowerCase();
  id = id.startsWith("~") ? id.slice(1) : id;
  if (id.includes("/")) { id = id.slice(id.lastIndexOf("/") + 1); }
  return id;
}

/** 快照查找结果 */
export interface SnapshotPricingHit {
  entry: PricingSnapshotEntry;
  /**
   * 是否**具体命中**：快照 id 恰好等于模型 id，或**是它的前缀**（`claude-opus-4-6` ← `claude-opus-4-6-20260205`）。
   *
   * 这个布尔量是整个快照层的判断核心：
   *   - `specific = true`  → 快照知道**这一个**模型（比任何家族正则都准）→ 可以压在家族价之上；
   *   - `specific = false` → 只匹配到家族/近邻（不可靠）→ 只能在内置表**完全没价**时补位。
   */
  specific: boolean;
}

/**
 * 在权威快照里找该模型的价格。**最长前缀匹配**（不是首个前缀匹配）——
 * 快照里同时存在 `claude-opus-4-5` 与 `claude-opus-4-6`，取短的那个会把 4.6 按 4.5 计价；
 * 同时存在 `gpt-5` 与 `gpt-5.5`，取短的会把 5.5 按 5 计价（$1.25 vs $5，低 4 倍）。
 */
export function findSnapshotPricing(modelId: string): SnapshotPricingHit | undefined {
  const id = normalizeModelIdForSnapshot(modelId);
  if (!id) { return undefined; }
  let best: PricingSnapshotEntry | undefined;
  for (const e of PRICING_SNAPSHOT) {
    if (id === e.id) { return { entry: e, specific: true }; }
    if (id.startsWith(e.id) && (!best || e.id.length > best.id.length)) { best = e; }
  }
  if (!best) { return undefined; }
  // 前缀命中后必须**在同一 token 边界**上（`gpt-5` 不该命中 `gpt-50x`，`glm-4` 不该命中 `glm-45`）
  const rest = id.slice(best.id.length);
  if (!/^[-_.:]/.test(rest)) { return undefined; }
  return { entry: best, specific: true };
}

/**
 * 快照价 → `ModelPricing`。单位已是 USD/1M（生成器换算过），**此处严禁再乘 1e6**。
 */
function snapshotPricing(hit: SnapshotPricingHit): ModelPricing {
  const e = hit.entry;
  return {
    priceIn: e.priceIn,
    priceOut: e.priceOut,
    priceCacheRead: e.priceCacheRead,
    priceCacheWrite: e.priceCacheWrite,
    vendor: e.vendor,
  };
}

/** 快照的新鲜度信息（面板/诊断用）—— 时效性是定价的底线，所以它必须能被看到，而不只是存在于源码里 */
export function pricingSnapshotMeta(): {
  generatedAt: string; count: number; litellmUrl: string; openrouterUrl: string;
} {
  return {
    generatedAt: PRICING_SNAPSHOT_META.generatedAt,
    count: PRICING_SNAPSHOT_META.count,
    litellmUrl: PRICING_SNAPSHOT_META.litellmUrl,
    openrouterUrl: PRICING_SNAPSHOT_META.openrouterUrl,
  };
}

/** 某模型的快照命中详情（面板展示「价从哪个镜像来 / 长上下文是否另计价 / 为什么被抑制」） */
export interface SnapshotPricingInfo {
  /** 快照里命中的 id（可能与查询 id 不同：靠 token 边界前缀命中） */
  snapshotId: string;
  vendor: string;
  source: string;
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  context?: number;
  maxOut?: number;
  /** 长上下文分档价（存在即说明该模型长上下文另行计价） */
  contextTiers?: Array<{ fromInputTokens: number; prompt?: number; completion?: number }>;
  /** 该模型被抑制表拦下的原因（有值即"本轮不会采用快照价"） */
  vetoReason?: string;
  /** 抑制性质：镜像错 / 口径不同（界面据此决定是否标警告） */
  vetoKind?: SnapshotVetoKind;
}

export function snapshotPricingInfo(modelId: string): SnapshotPricingInfo | undefined {
  const hit = findSnapshotPricing(modelId);
  if (!hit) { return undefined; }
  const e = hit.entry;
  return {
    snapshotId: e.id,
    vendor: e.vendor,
    source: e.source,
    priceIn: e.priceIn,
    priceOut: e.priceOut,
    priceCacheRead: e.priceCacheRead,
    priceCacheWrite: e.priceCacheWrite,
    context: e.context,
    maxOut: e.maxOut,
    contextTiers: e.contextTiers,
    vetoReason: snapshotVetoReason(modelId),
    vetoKind: snapshotVetoKind(modelId),
  };
}

/**
 * **快照抑制表**：这些模型 id 一律不看快照，由内置表决定。
 *
 * 为什么必须有：快照是**社区镜像**，它记录的是"这个 id 曾经/当前的刊例价"，
 * 而内置表有时编码的是**厂商的换代计费决策**——两者会正面冲突，且冲突时快照"看起来更具体"，
 * 会以"更权威"的姿态把正确规则覆盖掉（典型的"修一个坏一个"）。
 *
 *   - `deepseek-chat` / `deepseek-reasoner`：官方已**退休**，其请求由 DeepSeek-V4.1-Flash 承接
 *     并按 Flash 价计费（$0.30/$1.20 高峰）。快照里仍留着退休前的旧价 $0.28/$0.42，
 *     输出价低 3 倍 —— 用它就是把官方的迁移规则换成一张过期价目表。
 *   - `chatgpt-4o-latest`：官方定义它是"当前 gpt-4o 的别名"，而 gpt-4o 自 2024-08-06 起是
 *     $2.5/$10。快照（LiteLLM）里仍记着首发期的 $5/$15 —— 两个数字与 `gpt-4o-2024-05-13`
 *     那条完全相同，是典型的"首发价抄下来再没人改"。别名必须跟随本体，不能跟随过期快照。
 *   - `glm` 全族（kind = `basis-differs`，**不是镜像错**）：智谱官方定价页明示海外站 z.ai 的
 *     美元价与国内站人民币价"并非简单汇率换算"，而快照收录的是 z.ai 口径、本表按官方人民币
 *     价目换算 —— 两侧必然对不上。选人民币口径是因为它是官方定价页的**正文**，
 *     而 z.ai 的美元数只能通过镜像二手获得。两种口径都合法，故只声明、不判谁错。
 *
 * 维护规则：新增一条必须写清**为什么快照在这里不采用**，否则半年后没人敢删。
 */
export type SnapshotVetoKind = "mirror-wrong" | "basis-differs";

const SNAPSHOT_VETO: Array<{ re: RegExp; reason: string; kind: SnapshotVetoKind }> = [
  {
    re: /deepseek[-_.]?(chat|reasoner)/i,
    kind: "mirror-wrong",
    reason: "官方已退休，请求由 DeepSeek-V4.1-Flash 按 Flash 价承接；快照里的退休前旧价会低估输出 3 倍",
  },
  {
    re: /^chatgpt[-_.]4o[-_.]?latest$/i,
    kind: "mirror-wrong",
    reason: "该 id 是「当前 gpt-4o 的别名」（现 $2.5/$10），快照仍记首发期 $5/$15，会高估输入 2 倍、输出 1.5 倍",
  },
  {
    // 只匹配 glm 家族自己（`glm-4.5-flash` 之类仍属本族），不波及任何其它厂商
    re: /^glm([-_.]|$)/i,
    kind: "basis-differs",
    reason: "官方定价页明示 z.ai 美元价与国内站人民币价非等比换算；本表按官方人民币价目（@7.2）换算，故不采用快照的 z.ai 口径值",
  },
  {
    /*
     * Qwen（阿里百炼）：**同一条 basis-differs 逻辑**，2026-09-18 补官方 ¥ 价时实测命中。
     *
     * 现象：补价后 `qwen3.8-flash` 手写表折算值 0.1519/0.476 vs 快照 0.15/0.47 —— 很接近但不相等；
     * 而 `qwen3.8-27b` 差得更远（0.506 vs 0.214）。这不是谁记错了，而是**两边取的是不同币种列**：
     *   本表 = 阿里云百炼官方**人民币**价 ÷ USD_CNY_RATE（口径：国内站账单）；
     *   快照 = OpenRouter / LiteLLM 收录的**官方美元**价。
     * 阿里的美元列与人民币列同样**非等比**，所以折算值必然对不上官方美元列。
     *
     * 若不声明：那条"手写表与快照不得冲突"的守卫会一直报冲突，而"修掉"它的唯一办法
     * 就是把官方 ¥ 价换成快照的美元值 —— 等于用二手镜像覆盖一手核实价，方向完全反了。
     *
     * ⚠️ **正则必须只覆盖"已经手写了价"的型号**（这里就是补了价的 4 个家族）。
     *    抑制表的作用是**完全关掉**这些 id 的快照价，不是"让手写价优先"。
     *    写成 `/^qwen/i` 会把**没手写价**的长尾型号（如 `qwen3.7-max`）的快照也一起关掉
     *    → 那些模型直接变成「未定价」、消耗记 $0。实测踩到：`qwen3.7-max` 从"快照补价"
     *    变成 undefined，被既有守卫 `内置表未定价的长尾家族由快照补价` 抓个正着。
     */
    re: /^qwen3\.(8-max|8-flash|8-27b|7-plus)/i,
    kind: "basis-differs",
    reason: "本表采用阿里云百炼官方人民币价（@7.2 折算）；快照收录的是官方美元价。两列非等比，故不采用快照口径值",
  },
  {
    /*
     * Kimi（Moonshot）：同型 basis-differs，2026-09-18 补官方 ¥ 价时命中。
     * 实测偏差：kimi-k3 手写 ¥20/¥100 → $2.78/$13.9，快照 $2.1/$10.95（**低约 30%**）；
     *           k2.5/k2.6/k2.7-code 偏差 20%~32%。两边都不是"错"，只是取的列不同：
     *   本表 = 官方**人民币**刊例；快照 = OpenRouter/LiteLLM 收录的**美元**价。
     * ⚠️ 正则只覆盖**已手写价**的型号（k3 / k2.5 / k2.6 / k2.7 / moonshot-v1）——
     *    抑制表是"完全关掉该 id 的快照价"，覆盖到没写价的变体会让它们变未定价。
     */
    re: /^(kimi[-_.]?k3|kimi[-_.]?k2\.[567]|moonshot[-_.]?v1)/i,
    kind: "basis-differs",
    reason: "本表采用 Moonshot 官方人民币价（@7.2 折算）；快照收录的是美元价，两列非等比，故不采用快照口径值",
  },
  {
    /*
     * MiniMax：同型 basis-differs。偏差比 Kimi 小（3%~14%，官方 ¥2.1/¥8.4 → $0.29/$1.17，
     * 快照 $0.255~0.30/$1.02~1.20），但同样是"取了不同币种列"。
     * ⚠️ 正则**只覆盖 M 系**（`^minimax[-_.]?m(3|2)`）：`abab` 老系列我没有官方价，
     *    把它也关掉会让这批 id 直接变未定价（抑制表是"完全关掉"，不是"让手写价优先"）。
     */
    re: /^minimax[-_.]?m(3|2)/i,
    kind: "basis-differs",
    reason: "本表采用 MiniMax 官方人民币价（@7.2 折算）；快照收录的是美元价，两列非等比，故不采用快照口径值",
  },
  {
    /*
     * 混元（腾讯云）：同型 basis-differs。实测 hunyuan-a13b-instruct 快照 $0.14/$0.57
     * 是官方 ¥0.5/¥2（→$0.069/$0.278）的 **2 倍** —— 腾讯云官方人民币刊例 vs 镜像美元价。
     * ⚠️ 只覆盖已写价的四条（turbos/t1/a13b/pro）；standard/turbo/Hy3 官方页数字打架未写，
     *    不能关它们的快照（否则变未定价）。
     */
    re: /^hunyuan[-_.]?(turbos|t1|a13b|pro)/i,
    kind: "basis-differs",
    reason: "本表采用腾讯云官方人民币价；快照收录的是美元价，两列非等比，故不采用快照口径值",
  },
];

/** 该模型是否允许采用快照价（命中抑制表则不允许） */
function snapshotAllowed(modelId: string): boolean {
  const id = (modelId ?? "").toLowerCase();
  return !SNAPSHOT_VETO.some((v) => v.re.test(id));
}

/** 抑制表只读视图（供测试与排障确认"这条为什么不用快照"） */
export function snapshotVetoReason(modelId: string): string | undefined {
  const id = (modelId ?? "").toLowerCase();
  return SNAPSHOT_VETO.find((v) => v.re.test(id))?.reason;
}

/**
 * 抑制的**性质**：`mirror-wrong` = 镜像确实记错了；`basis-differs` = 口径不同、两边都没错。
 * 分开是为了界面不撒谎：把"口径不同"也标成 ⚠️ 警告，会让用户以为快照坏了，
 * 从而对整块快照层失去信任（而它正是长尾模型唯一的价源）。
 */
export function snapshotVetoKind(modelId: string): SnapshotVetoKind | undefined {
  const id = (modelId ?? "").toLowerCase();
  return SNAPSHOT_VETO.find((v) => v.re.test(id))?.kind;
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

/**
 * 判断墙上时钟是否落在任一窗口内（左闭右开；`days` 缺省 = 每天）。
 *
 * 跨午夜（`endMin < startMin`）必须拆成**当天段 + 次日段**两段判定，且两段对 `days` 的校验不同：
 *   - 当天段 `[startMin, 1440)`：`days` 必须含**今天**；
 *   - 次日段 `[0, endMin)`：`days` 必须含**昨天**（窗口是昨天开始的）。
 * 漏掉后者就会出现"周五 23:00→07:00 只在周五 23:00-24:00 生效、周六凌晨不生效"的诡异行为
 * —— 而夜间优惠档的价值恰恰在凌晨那半段。
 *
 * `endMin === startMin` 视为**空窗口（永不命中）**而不是 24 小时：用户把两个时间填成一样
 * 几乎一定是笔误，当成全天高峰会凭空多收一笔；而兜底档本来就已经覆盖"其余所有时段"，
 * 所以跳过它不会让任何时刻无价可用。
 */
function inAnyWindow(windows: PriceTierWindow[], clock: { weekday: number; minute: number }): boolean {
  for (const w of windows) {
    const anyDay = !w.days || w.days.length === 0;
    // 取模归一化：次日段要拿"昨天"去比，clock.weekday - 1 在周日会变成 -1
    const dayHit = (d: number): boolean => anyDay || w.days!.includes(((d % 7) + 7) % 7);
    if (w.endMin === w.startMin) { continue; } // 空窗口：见上方注释
    if (w.endMin > w.startMin) {
      if (dayHit(clock.weekday) && clock.minute >= w.startMin && clock.minute < w.endMin) { return true; }
    } else {
      if (dayHit(clock.weekday) && clock.minute >= w.startMin) { return true; }
      if (dayHit(clock.weekday - 1) && clock.minute < w.endMin) { return true; }
    }
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
  const flat = entry ? flatPricing(entry) : {};
  const spec = entry?.model.priceTiers ?? entry?.vendor.priceTiers;
  const snap = snapshotAllowed(modelId) ? findSnapshotPricing(modelId) : undefined;

  // ③-1 内置分时规格存在且给了时刻 → 内置档位说了算。
  //     分时表比任何单一价都更具体（它描述了"什么时候什么价"），快照只有单一价，
  //     所以这里**绝不能**被快照抢走 —— 否则 DeepSeek 的峰谷分时会被一个平铺数抹平。
  if (spec && spec.tiers.length > 0 && at !== undefined) {
    const tier = resolveTierId(spec.tiers, at, spec.timezone);
    if (tier) {
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
          // 「$ 与 ¥ 分开」：官方同时公布两列时（DeepSeek 就是）两列都带出去，
          // 界面才能并列展示，而不是拿折算值冒充另一个口径。
          priceInCny: tier.priceInCny ?? flat.priceInCny,
          priceOutCny: tier.priceOutCny ?? flat.priceOutCny,
          priceCacheReadCny: tier.priceCacheReadCny ?? flat.priceCacheReadCny,
          priceCacheWriteCny: tier.priceCacheWriteCny ?? flat.priceCacheWriteCny,
          vendor: entry!.vendor.key,
        },
      };
    }
  }

  // ③-2 无时刻信息 / 无分时规格 → 平铺价
  if (typeof flat.priceIn === "number") {
    // 快照是**厂商刊例价**（litellm）且**具体命中这一个模型**时，才可能压过内置的家族价：
    // 内置按正则分家族，天然表达不了"同族跨代/跨版本改价"（Opus 4 = $15 而 Opus 4.6 = $5；
    // gpt-4o 首发 $5/$15 而 4o-2024-08-06 起 $2.5/$10）；快照按精确 id，能。
    //
    // ⚠️ 前提是**内置没有分时规格**：有分时规格时，内置的"平铺价 = 高峰标准价"与档位表
    //    是一套自洽的语义；让快照插进来会造出"同一模型有两条互不知情的价格基准"，
    //    日后档位表改价而快照没改，就会出现"面板说平坦价 X、档位算 Y"的分裂。
    const builtinHasTiers = !!spec && spec.tiers.length > 0;
    if (!builtinHasTiers && snap && snap.entry.source === "litellm" && snap.specific) {
      const sp = snapshotPricing(snap);
      // A-989：**数值一致时用内置表**。两家说同一个数，就没有理由把行标成「快照兜底」——
      // 那会把"一手核实过的刊例价"降级显示成"二手镜像价"，用户看到一片「快照兜底」会以为
      // 整个价目表都来自社区镜像（实测 33 条覆盖里 30 条数值完全相同，全被误标）。
      // 只有**数值不一致**时才让快照赢：此时它是精确 id 命中，而手写表那条是家族正则，
      // 覆盖过宽 —— 上面列的 gpt-4o / Haiku 两例就是这么被纠正的。
      const agrees = sp.priceIn === flat.priceIn
        && (sp.priceOut ?? sp.priceIn) === (flat.priceOut ?? flat.priceIn);
      if (!agrees) { return { tierId: "snapshot", pricing: sp, tiered: false }; }
    }
    return { tierId: "flat", pricing: flat, tiered: false };
  }

  // ③-3 内置表完全没有价 → 快照补位（含 OpenRouter 路由市场价）。
  //     这是"消灭长尾模型必须用户手填"的关键一步：qwen / kimi / glm / minimax / grok /
  //     mistral / cohere 等内置表未定价的家族，从此都有可用价。
  if (snap) {
    return { tierId: "snapshot", pricing: snapshotPricing(snap), tiered: false };
  }

  // ③-4 都没有 → 平铺价（可能为 `{}` = 未定价）
  return { tierId: "flat", pricing: flat, tiered: false };
}

/**
 * 依据模型 ID 查内置兜底价（首个命中的家族条目；家族未定价则返回空对象）。
 * 传了 `at` 时返回**该时刻**的档位价（分时定价）；不传则返回平铺价（高峰标准价）。
 */
export function inferModelPricing(modelId: string, at?: Date | string | number): ModelPricing {
  return resolveModelPriceTier(modelId, at).pricing;
}

/**
 * **只看内置手写表**的平铺价（不含分时档、不含快照补位）。查不到该模型时返回 `{}`。
 *
 * 为什么需要这个"少一层"的入口：`inferModelPricing` 现在会把快照也算进去，于是"这块钱到底
 * 是手写表说的还是镜像说的"就没法在外部对拍了。判"手写表 vs 快照"的一致性、以及日后与厂商
 * 官方页逐条比价，都需要一个只读手写表的基准值 —— 这就是它。**生产取价路径不使用它。**
 */
export function builtInFlatPricing(modelId: string): ModelPricing {
  const entry = findPricingEntry(modelId);
  return entry ? flatPricing(entry) : {};
}

/**
 * 该 IANA 时区在本运行时是否可解析。
 *
 * 为什么必须单独暴露：`resolveTierId` 在时区不可用时**故意**落到兜底档（计费上"宁可退回
 * 高峰标准价，也不要凭空把成本清零"）—— 那是对的行为。但**展示层不能据此说"此刻命中兜底档"**：
 * 用户把时区打错一个字，面板就会高亮「空闲时段 · 当前」，而真实原因只是"这个时区名解析不了"。
 * 计费结论正确、界面结论撒谎，正是本文件要根除的那类分裂。
 */
export function isTimezoneResolvable(timezone: string): boolean {
  // ⚠️ 必须与 `undefined` 比：`zonedWallClock` 失败时返回的是 **undefined**（不是 null），
  // 写成 `!== null` 会对任何非法时区都返回 true —— 护栏看似存在、实则恒不生效。
  return zonedWallClock(new Date(), timezone) !== undefined;
}

/** `providers.enc.json` 里单个模型的定价字段快照（存值） */
export interface StoredPricing {
  price_source?: string;
  price_in_usd?: number;
  price_out_usd?: number;
  price_cache_read_usd?: number;
  price_cache_write_usd?: number;
  /**
   * A-988c：**用户自定义的分时（峰谷）档位**。存在这里（而不是内置能力表）是因为它属于
   * 「用户环境的事实」，必须能跨重启保留、且不能与内置表混在一处被后续维护覆盖。
   *
   * 优先级：**自定义分时 > 手填/上游平铺价 > 内置分时 > 内置平铺价 > 存值兜底**（见 resolveEffectivePricing）。
   * 自定义分时排在平铺价之前，是因为"填了档位表"是比"填了一个数"更强的意图表达：
   * 用户特意描述了时段，就不该再被一个静态数字压住。
   */
  price_tiers?: ModelPriceTiers;
}

/**
 * A-988：缓存命中价 / 写入价的**来源**。必须能细分，因为几者可信度完全不同：
 *   - `stored` 用户在面板手填 / 上游探测给的缓存价 → 最权威
 *   - `tier`   来自**当前生效的分时档**（档位自带缓存价，比家族基价更具体）
 *   - `table`  从内置家族价目表**继承**（LiteLLM 的文档化取舍，见 resolveCacheRates）
 *   - `ratio`  表里也没有 → 按行业倍率推导（**估算**，UI 要标明）
 *   - `none`   连基准价都是 0/未知 → 缓存部分如实计 0
 */
export type CacheRateSource = "stored" | "tier" | "table" | "ratio" | "none";

/**
 * 缓存价倍率约定（用于「内置表也查不到」时的推导）。
 *
 * 依据（A-988 调研，均为厂商**已公开文档化**的规则）：
 *   - **命中价 ≈ 未命中价的 1/10**：OpenAI prompt caching 与 Anthropic caching 文档
 *     都写 `cache read = 0.1 × base input`。DeepSeek 更狠（flash 档 0.006/0.3 = 1/50），
 *     但 DeepSeek 家族在内置表里**有**已核实的真实值，走 `table` 分支，不会用到这个倍率。
 *   - **写入价 = 1.25 × 基准输入价**：OpenAI（GPT-5.6+）与 Anthropic 的 5 分钟缓存写入
 *     都是 1.25×；Anthropic 的 1 小时档是 2×（本推导取保守的 1.25×）。
 *
 * ⚠️ 为什么宁可"估算"也不留空：留空会让 `computeRecordCost` 退回
 * `priceCacheReadUsd ?? priceInUsd`，即**按全价输入计缓存** —— 实测 deepseek-flash
 * （缓存 0.006 / 输入 0.3）虚高 50 倍。用一个有文献支撑的 0.1× 估算，
 * 误差从 50 倍收敛到个位数百分比；并且 `cacheRateSource: "ratio"` 会让 UI 明确标出这是推导值。
 */
export const CACHE_READ_RATIO = 0.1;
export const CACHE_WRITE_RATIO = 1.25;

/**
 * 会**额外收取「缓存写入 / cache creation」费**的家族（正则）。
 *
 * A-988c 全网调研（各家官方定价页，核实 2026-09-18）：
 *   - **Anthropic Claude**：唯一明确按 write token 计费的家族 —— 5 分钟 TTL 收 1.25× 输入价，
 *     1 小时 TTL 收 2×（`cache_creation_input_tokens` 单独回传用量）。
 *   - **OpenAI**：prompt caching 的**写入免费**，只对 `cached_tokens` 收 0.1×；
 *     响应里根本没有 creation token 计数器。
 *   - **DeepSeek**：只有「缓存命中 / 未命中」两档（命中 1/50 甚至 1/10），写入不单独计费。
 *   - **Google Gemini**：隐式缓存免费；显式 context caching 按**存储时长**（token-hour）计费，
 *     不是按 write token —— 这个口径 token 单价表表达不了，故不在这里编造数字。
 *   - **new-api / one-api**：`create_cache_ratio` / `cache_write_*_ratio` 允许为 0。
 * ⇒ **"写入不收费"是多数的默认**。把 1.25× 当普适规则，会在面板上给 DeepSeek/OpenAI/Gemini
 *    的用户凭空显示一笔并不存在的写入费（与 A-970「错的低价比没有价格危害更大」是同一类错误，
 *    方向相反）。只有命中本正则的家族才按 1.25× 推导。
 */
const CACHE_WRITE_CHARGING_RE = /(claude|anthropic)/i;

/**
 * 缓存写入价的推导倍率：仅明确计费写入的家族用 1.25×，其余推定为 0（不收费）。
 *
 * ⚠️ 实际账单影响是二阶的 —— OpenAI 系供应商不会回传 creation token，乘 0 与乘 1.25 都得 0。
 * 真正被这条改掉的是**面板展示**：此前 deepseek-flash 的「缓存写入」会显示一个 2.5 倍的
 * 编造价，用户据此手填就会把假价写进配置（这才是会真的影响后续所有记账的入口）。
 */
export function cacheWriteRatio(modelId: string): number {
  return CACHE_WRITE_CHARGING_RE.test(modelId ?? "") ? CACHE_WRITE_RATIO : 0;
}

/**
 * 缓存价解析结果（金额单位 USD / 1M tokens）。
 *
 * A-988b：**来源必须按字段分开**（`readSource` / `writeSource`），不能再共用一个 `source`。
 * 反例就是这次用户看到的自相矛盾：只手填了「缓存命中」而没填「缓存写入」时，
 * 旧实现返回 `{read: 手填值, write: undefined, source: "stored"}`，
 * 于是面板上「缓存写入」格子写「未定价」、旁边徽标却写「手填/上游」——
 * 同一行里两个字段互相打脸。分开之后每个字段各自回答"我是哪来的"，
 * 而且未手填的那个会自动落到 `table` / `ratio`，**不会**再留 undefined 让下游按全价输入兜底。
 */
export interface CacheRateResolution {
  read?: number;
  write?: number;
  readSource: CacheRateSource;
  writeSource: CacheRateSource;
}

/** 保留 6 位小数，避免 0.1×0.3 这类浮点尾巴写进配置/账目 */
function round6(n: number): number {
  return Number(n.toFixed(6));
}

/**
 * A-988：解析缓存命中价 / 写入价。**核心规则是它们绝不允许留空后落回输入价。**
 *
 * 这条规则的出处是 LiteLLM 的一个**刻意例外**（docs/proxy/custom_model_cost_map）：
 *   > When you override the base input rate, missing cache fields … are inherited from the
 *   > backend model's default entry **so cache reads are not silently billed at zero**.
 * LiteLLM 担心的方向是"静默按 0 计"。slime 这里的失败方向**相反但更贵**：
 * `computeRecordCost` 的兜底是 `priceCacheReadUsd ?? priceInUsd` —— 静默按**全价**计。
 * 而用户最容易做的操作恰恰是"手填输入/输出两个框"（截图里 deepseek-flash 就是 0.3/1.2），
 * 一旦如此，`price_cache_read_usd` 就是 undefined → 缓存命中部分按 0.3 记账，
 * 而真实价是内置表里的 0.006。**同一批 token 被多记 50 倍**，且因为"看着有数字"而极难发现
 * （与 A-970「错的低价比没有价格危害大得多」是同一条教训的镜像）。
 *
 * 优先级（**逐字段独立判定**）：手填/上游存值 > 内置表继承 > 行业倍率推导 > 如实置零（基准价为 0 时）。
 */
export function resolveCacheRates(
  modelId: string,
  priceIn: number,
  stored?: StoredPricing,
): CacheRateResolution {
  const table = inferModelPricing(modelId);

  /**
   * 单字段解析。命中/写入两条链**完全同构**，所以抽成一个闭包而不是复制两遍
   * —— 复制两遍正是"一条改了另一条没改"的温床（A-988 的 `? :` 不对称过滤就是这么来的）。
   */
  function one(storedValue: number | undefined, tableValue: number | undefined, ratio: number) {
    if (typeof storedValue === "number") { return { value: storedValue, source: "stored" as CacheRateSource }; }
    if (typeof tableValue === "number") { return { value: tableValue, source: "table" as CacheRateSource }; }
    // 基准价为 0（官方免费 / 本地端点）时缓存自然也是 0 —— 这是**正确结果**，不是"未定价"，
    // 所以如实返回 0 而不是 undefined（0 会让下游成本算成 0，undefined 会落回全价输入）。
    if (priceIn === 0) { return { value: 0, source: "none" as CacheRateSource }; }
    return { value: round6(priceIn * ratio), source: "ratio" as CacheRateSource };
  }

  const read = one(stored?.price_cache_read_usd, table.priceCacheRead, CACHE_READ_RATIO);
  const write = one(stored?.price_cache_write_usd, table.priceCacheWrite, cacheWriteRatio(modelId));
  return { read: read.value, write: write.value, readSource: read.source, writeSource: write.source };
}

/** 缓存价来源的展示文案（**单一真相源**：面板徽标、悬停说明、日志都用这一份，避免同一来源两种说法） */
export interface CacheSourceMeta {
  /** 中文短语，如「内置表继承」 */
  text: string;
  /** 是否是**估算/推定**值（UI 应标黄），false = 已核实的取值 */
  estimated: boolean;
  /** 悬停说明：这个数到底是怎么来的 */
  hint: string;
}

/**
 * A-988c：把缓存价来源翻译成人话。
 *
 * 特别处理 `ratio + 值 0`：那不是"按 1.25 倍推出来的 0"，而是"推定该家族不收缓存写入费"——
 * 两者若共用一句「按倍率推导」，用户会以为我们算错了（1.25 × 2 = 0？），
 * 所以单独给一句文案。这个判断放在共享层而不是面板里，理由与本文件其它函数一致：
 * **同一来源在任何地方都必须给出同一种说法**。
 */
export function describeCacheRateSource(source: CacheRateSource, value?: number): CacheSourceMeta {
  switch (source) {
    case "stored":
      return { text: "手填/上游", estimated: false, hint: "用户在面板手填，或上游探测回传的缓存价 —— 最权威。" };
    case "tier":
      return { text: "分时档自带", estimated: false, hint: "来自当前生效的分时档位（档位级别比家族基价更具体）。" };
    case "table":
      return { text: "内置表继承", estimated: false, hint: "内置家族价目表里已核实的刊例值，直接继承。" };
    case "none":
      return { text: "基准价为 0", estimated: false, hint: "基准输入价本身是 0（官方免费 / 本地端点），缓存价如实也是 0。" };
    case "ratio":
    default:
      if (value === 0) {
        return {
          text: "推定不收费",
          estimated: true,
          hint: "主流厂商（OpenAI / DeepSeek / Gemini）都不单独收缓存写入费，故推定为 0。"
            + "若你的网关确实按 write token 计费，请手填覆盖。",
        };
      }
      return {
        text: "按倍率推导",
        estimated: true,
        hint: "内置表没有该模型的缓存价，按行业倍率换算而来（命中 ≈ 0.1× 输入价 / 写入 ≈ 1.25× 输入价），是**估算值**。",
      };
  }
}

/**
 * 生效价的来源。**必须细分到能一眼看出"钱从哪来"**，不能合并：
 *   - `customTier` 用户**自定义的**分时档（面板里配的峰谷规则）—— 用户显式授权，优先级最高
 *   - `manual`  用户手填（可能是议价/合同价）—— 机器永不覆盖
 *   - `upstream` 上游探测（网关真实结算价）
 *   - `local`   本地/内网端点 → 恒 0（没有按 token 的账单）
 *   - `tier`    内置表的分时档（按请求时刻取档）
 *   - `table`   内置表平铺价（高峰标准价）
 *   - `snapshot` 权威镜像快照兜底价（LiteLLM `model_prices_and_context_window` / OpenRouter 快照）
 *               —— **机器同步来的二手价**，不是亲手核实的刊例价，仅在 ③-2/③-3 补位时出现；
 *               区别于 `table` 是为了**界面不许撒谎**：把快照价标成「内置表」会让用户以为
 *               那是 slime 维护者核过的价，从而在调价后不去核对。
 *   - `stored`  兜底的历史残留值（表里查不到，且不是手填/上游）
 *   - `none`    **未定价** —— 表里没有已核实的价，成本会记成 0，需用户手填
 */
export type PriceOrigin =
  | "customTier" | "manual" | "upstream" | "local" | "tier" | "table" | "snapshot" | "stored" | "none";

/** 生效价解析结果（金额单位 USD / 1M tokens；`origin === "none"` 时两个金额无意义，UI 应按「未定价」呈现） */
export interface EffectivePricing {
  origin: PriceOrigin;
  priceIn: number;
  priceOut: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /**
   * A-988b：缓存价的来源**按字段分开**（`stored` / `table` / `ratio` / `none`）。
   *
   * 为什么不能合成一个：命中价与写入价的来源天然会不同 —— 用户很可能只手填了命中价
   * （手上只有那张报价单），写入价则由内置表继承或按倍率推导。合并成一个来源，
   * UI 就必然要在其中一个字段上说谎（实测症状：「缓存写入」显示"未定价"，
   * 旁边徽标却写「内置表继承」，同一个格子里两句互相矛盾的话）。
   * UI 要能把 `ratio` 标出来 —— 那是按行业倍率**推导**的值，不是核实的刊例价。
   */
  cacheRateReadSource?: CacheRateSource;
  cacheRateWriteSource?: CacheRateSource;
  /** 命中内置表的供应商 key（排障用） */
  vendor?: string;
  /**
   * 官方**原生人民币**刊例价（¥/1M）。有值 = 该厂商官方定价页是人民币计价（智谱等）。
   * UI 应**优先**显示这一口径 —— 它才是官方原数字；下面的 USD 值只是折算。
   */
  priceInCny?: number;
  priceOutCny?: number;
  priceCacheReadCny?: number;
  priceCacheWriteCny?: number;
  /**
   * `priceIn`/`priceOut` 是否由人民币价折算而来（true → UI 必须显示 `≈$`）。
   * **不能省**：折算值一旦按官方美元价显示，用户拿去和 z.ai 官网一比就发现对不上，
   * 而真实原因是"官方两种币种价本来就不等比"（GLM 实测差 1.8 倍）。
   */
  usdDerivedFromCny?: boolean;
  /** 命中的分时档位 id（仅 `origin === "tier"` / `"customTier"`） */
  tierId?: string;
  /** 档位展示名（如「高峰时段」） */
  label?: string;
  /** 判定该档位所用的 IANA 时区（自定义分时档尤其要显示，否则用户不知道按谁的钟算） */
  timezone?: string;
  tiered: boolean;
  /**
   * A-990-H：这条价是**精确命中**（`^…$` 锚定条目）还是**家族兜底**（正则通配）。
   *
   * 存在的理由（用户指出的病根）：家族兜底意味着**这个数字可能偏离** ——
   * 家族里跨代改价时兜底键只能取其一（`claude.*opus` 曾把 Opus 4.5+ 的 $5/$25
   * 按 Opus 4.1 的 $15/$75 计，**高估 3 倍**）。用户面对一个数字时无法分辨它的出处，
   * 所以必须由界面显式标注：精确 = 逐条核对过官方价；家族兜底 = 可能偏离，建议核对。
   */
  pricingMatch?: "exact" | "family";
  /**
   * A-993：**手填价与官方档位价严重偏离**（≥5× 或 ≤1/5）时的偏离详情。
   *
   * 存在的理由：手填按设计压过内置表（保护议价/合同价），所以"配置里的历史错值"
   * 会静默地成为生效价 —— 用户看到 0.139 这种数字却无从知道它来自哪、表明明是对的。
   * 这是"显示如实、数据有毒"的组合，唯一解法是把偏离算出来亮到界面上，
   * 并给一键「清空手填恢复内置表」。**不改取价结果**（机器覆盖手填违反纪律）。
   */
  suspiciousStored?: { storedIn: number; tableIn: number; ratio: number };
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
 * 优先级（**必须与引擎一致，否则面板与账目分裂**），自高到低分**两组**：
 *   ① 用户/网关的**显式意图**：自定义分时档 > 手填价 = 上游结算价
 *   ② 机器**推导**：本地端点恒 0 > 内置分时档 > 内置手写表平铺价 > 权威镜像快照兜底 > 存值残留 > 未定价
 * 分组的理由：显式意图可以覆盖本地端点（自己写下的价，自己负责），
 * 而推导值绝不可以 —— 本地跑一个同名模型凭空产生账单是已经出过的事故。
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

  // 用户自定义分时规格是否"已启用"。① 与 ①b 都属"显式意图"，但**档位表 > 单一数字**，
  // 所以手填 / 上游分支必须让位（否则用户填了档位表却仍按那个平铺数字计费，
  // 而面板顶部状态条会显示手填来源 —— 界面与账目再次分裂，正是本文件要根除的那类问题）。
  const userTiers = stored?.price_tiers;
  const hasUserTiers = !!userTiers && Array.isArray(userTiers.tiers) && userTiers.tiers.length > 0;

  // ① 手填 / 上游结算价：用户或网关说了算（单一价，**不参与分时**—— 用户填的可能是合同价）
  //    唯一例外：已启用自定义分时档（见下）—— 那才是更具体的显式意图。
  if (!hasUserTiers && (src === "manual" || src === "upstream") && hasStored) {
    const out = typeof stored?.price_out_usd === "number" ? stored.price_out_usd : storedIn;
    // A-988：**必须同时把缓存价定下来**。此前这里只透传 `stored.price_cache_read_usd`，
    // 用户只手填输入/输出时它就是 undefined → recordUsage 落回 `?? priceInUsd`
    // → 缓存命中按全价输入记账（deepseek-flash 实测虚高 50 倍）。详见 resolveCacheRates。
    const cache = resolveCacheRates(modelId, storedIn, stored);
    /*
     * A-993：**手填价与官方档位价严重偏离 → 必须亮红灯**（用户实测踩到）。
     *
     * 实例：配置里躺着历史错值 `$0.0193/$0.0386/$0.00417`（美元刊例被按人民币又除了一次
     * 汇率），带着 `manual` 来源。手填按设计压过内置峰谷表（保护议价/合同价，机器永不覆盖
     * —— 这个优先级本身不能动），于是面板显示 `0.0193×7.2 = ¥0.139`，用户看到的就是
     * "官方明明 ¥9/¥27，你给我 0.139"，而界面上**没有任何东西解释这个差异来自哪**。
     *
     * 为什么只 Warn 不改值：手填可能是真实的议价价（偏离 10 倍也可能是真的），
     * 机器自动覆盖手填违反本表最高纪律。所以只把偏离**算出来、亮出来**，
     * 并在面板给「清空手填恢复内置表」的一键操作 —— 决定权留给用户。
     *
     * 阈值 5×：手填价与官方价差 5 倍以上基本不可能是"议价浮动"；
     * 另一界 (≤1/5) 同理（错值方向是除过汇率 → 偏小）。
     */
    let suspiciousStored: EffectivePricing["suspiciousStored"];
    if (src === "manual") {
      const tableIn = resolveModelPriceTier(modelId, at).pricing.priceIn;
      if (typeof tableIn === "number" && tableIn > 0 && storedIn > 0) {
        const ratio = storedIn / tableIn;
        if (ratio >= 5 || ratio <= 0.2) {
          suspiciousStored = { storedIn, tableIn, ratio };
        }
      }
    }
    return {
      origin: src, priceIn: storedIn, priceOut: out,
      priceCacheRead: cache.read, priceCacheWrite: cache.write,
      cacheRateReadSource: cache.readSource, cacheRateWriteSource: cache.writeSource,
      tiered: false,
      suspiciousStored,
    };
  }

  // ①b 用户自定义分时（A-988c）：**优先级高于手填平铺价与内置表**。
  //     理由：填一张档位表是比填一个数字更强的意图表达 —— 用户特意描述了时段，
  //     就不该再被一个静态数字压住。
  //
  //     与 ① 同处的这一档（即"用户显式意图"）整体排在 ② 本地端点之前，与 `price_source === "manual"`
  //     的既有设计一致（面板的本地提示就写着"若这其实是要计费的托管端点，手填即覆盖"）。
  //     自动推导出来的价（内置分时 / 内置表 / 残留值）则一律排在本地端点之后 ——
  //     本地跑一个同名模型不该凭空产生账单，那是已经出过的事故。
  //
  //     ⚠️ 无时刻信息（`at === undefined`，如面板列表、enrichModels）时不猜时刻，
  //     取**无窗口的兜底档**；这是与内置表同一条规则：需要确定性结果的场景不能随时间跳动
  //     （否则 UI 每秒都在变、测试必炸）。
  if (hasUserTiers) {
    // 用 `?.` 而不是 `!`：`hasUserTiers` 是独立布尔量，TS 不会据此收窄 `userTiers`，
    // 而这里的判空意图本来就与 hasUserTiers 完全一致，写成可选链更诚实。
    const spec: ModelPriceTiers = {
      timezone: userTiers?.timezone || "Asia/Shanghai",
      tiers: userTiers?.tiers ?? [],
    };
    const fallbackTier = spec.tiers.find((t) => !t.windows || t.windows.length === 0) ?? spec.tiers[0];
    const picked = at === undefined ? fallbackTier : resolveTierId(spec.tiers, at, spec.timezone);
    if (picked && typeof picked.priceIn === "number") {
      const priceIn = picked.priceIn;
      const priceOut = typeof picked.priceOut === "number" ? picked.priceOut : priceIn;
      // 档位缺缓存价时逐字段走 stored→内置表→倍率链，绝不留 undefined 让下游按输入价兜底
      const fallback = resolveCacheRates(modelId, priceIn, stored);
      const read = typeof picked.priceCacheRead === "number"
        ? { value: picked.priceCacheRead, source: "tier" as CacheRateSource } : fallback.read !== undefined
          ? { value: fallback.read, source: fallback.readSource } : undefined;
      const write = typeof picked.priceCacheWrite === "number"
        ? { value: picked.priceCacheWrite, source: "tier" as CacheRateSource } : fallback.write !== undefined
          ? { value: fallback.write, source: fallback.writeSource } : undefined;
      return {
        origin: "customTier",
        priceIn, priceOut,
        priceCacheRead: read?.value,
        priceCacheWrite: write?.value,
        cacheRateReadSource: read?.source ?? "none",
        cacheRateWriteSource: write?.source ?? "none",
        tierId: picked.id,
        label: picked.label,
        timezone: spec.timezone,
        // 无时刻 → 用的是兜底档，此时**不能**报 tiered=true：调用方（UI）会据此显示
        // "此刻命中某档"，而"此刻"根本没被判定过，等于撒谎。
        tiered: at !== undefined,
        // 平铺存值被自定义分时取代时如实回传，UI 才知道该提示而不是让用户猜
        superseded: hasStored && storedIn !== priceIn
          ? { priceIn: storedIn, priceOut: stored?.price_out_usd } : undefined,
      };
    }
  }

  // ② 本地 / 内网端点：没有按 token 的账单 → 恒 0，**不得**套官方刊例价或分时价。
  //    本地端点常二次托管"有官方价"的模型 ID（llama.cpp 跑 deepseek-flash），官方价与它无关。
  //    若存值非 0 且不是权威来源（旧版本写下的机器值），标为被取代 —— 引擎不采用它。
  if (isLocalEndpoint(baseUrl)) {
    const stale = hasStored && storedIn !== 0;
    return {
      origin: "local", priceIn: 0, priceOut: 0, priceCacheRead: 0, priceCacheWrite: 0,
      cacheRateReadSource: "none", cacheRateWriteSource: "none", tiered: false,
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
    // A-988：表里单价的档位可能没配缓存价（如自定义档 + 平铺档只配了 in/out）
    // → 用同一套优先级补齐，绝不留 undefined 让下游按输入价兜底。
    //
    // A-988b：档位自带的缓存价**逐字段**判定优先级 —— 档位是"此刻生效的价"，
    // 比家族基价更具体，所以命中/写入各自独立地优先取档位值，缺了才走 stored→table→ratio 链。
    // 不能写成"档位有命中价就把写入价也当成 undefined"，那正是下一个自相矛盾的来源。
    const tierRead = r.pricing.priceCacheRead;
    const tierWrite = r.pricing.priceCacheWrite;
    const fallback = resolveCacheRates(modelId, priceIn, stored);
    const cache = {
      read: typeof tierRead === "number" ? tierRead : fallback.read,
      write: typeof tierWrite === "number" ? tierWrite : fallback.write,
      readSource: (typeof tierRead === "number" ? "tier" : fallback.readSource) as CacheRateSource,
      writeSource: (typeof tierWrite === "number" ? "tier" : fallback.writeSource) as CacheRateSource,
    };
    // 官方原生人民币价随行带出（只在有值时挂字段，避免给既有 `toEqual` 断言塞进 undefined 键）
    const cnyFields: Partial<Pick<EffectivePricing,
      "priceInCny" | "priceOutCny" | "priceCacheReadCny" | "priceCacheWriteCny" | "usdDerivedFromCny">> = {};
    if (r.pricing.priceInCny !== undefined) { cnyFields.priceInCny = r.pricing.priceInCny; }
    if (r.pricing.priceOutCny !== undefined) { cnyFields.priceOutCny = r.pricing.priceOutCny; }
    if (r.pricing.priceCacheReadCny !== undefined) { cnyFields.priceCacheReadCny = r.pricing.priceCacheReadCny; }
    if (r.pricing.priceCacheWriteCny !== undefined) { cnyFields.priceCacheWriteCny = r.pricing.priceCacheWriteCny; }
    if (r.pricing.usdDerivedFromCny) { cnyFields.usdDerivedFromCny = true; }
    return {
      // A-989：快照兜底价必须自报家门。标成 `table` 会让界面显示「内置表」——
      // 那暗示"slime 维护者核实过"，而快照是机器同步来的**二手镜像价**，
      // 官方调价后它会滞后。来源标错 → 用户不会去核对 → 账目静默失真。
      origin: r.tiered ? "tier" : (r.tierId === "snapshot" ? "snapshot" : "table"),
      priceIn, priceOut,
      priceCacheRead: cache.read,
      priceCacheWrite: cache.write,
      cacheRateReadSource: cache.readSource,
      cacheRateWriteSource: cache.writeSource,
      vendor: r.pricing.vendor,
      tierId: r.tiered ? r.tierId : undefined,
      label: r.tiered ? r.label : undefined,
      timezone: r.tiered ? r.timezone : undefined,
      tiered: r.tiered,
      // A-990-H：这条价是精确命中还是家族兜底（界面据此标注"可能偏离"）。
      // 只在**内置表**分支有意义：上游/手填/本地端点都不是"表查到的"，故不设。
      pricingMatch: findPricingEntry(modelId)?.matchKind,
      superseded: stale ? { priceIn: storedIn, priceOut: stored?.price_out_usd } : undefined,
      ...cnyFields,
    };
  }

  // ④ 表里查不到 → 退回存值（可能是用户环境的自定义价，也可能是没来源标记的历史值）
  if (hasStored) {
    const out = typeof stored?.price_out_usd === "number" ? stored.price_out_usd : storedIn;
    const cache = resolveCacheRates(modelId, storedIn, stored);
    return {
      origin: "stored", priceIn: storedIn, priceOut: out,
      priceCacheRead: cache.read, priceCacheWrite: cache.write,
      cacheRateReadSource: cache.readSource, cacheRateWriteSource: cache.writeSource,
      tiered: false,
    };
  }

  // ⑤ 未定价：宁可留空让用户填，也不编造 —— 错的低价比没有价格危害大得多
  //    ⚠️ 这里**不能**套用 resolveCacheRates 的倍率推导：基准价本身都未知，
  //    由它推出的缓存价同样是编造（0.1 × 0 = 0 会把"未定价"伪装成"免费"）。
  return {
    origin: "none", priceIn: 0, priceOut: 0,
    priceCacheRead: undefined, priceCacheWrite: undefined,
    cacheRateReadSource: "none", cacheRateWriteSource: "none",
    tiered: false,
  };
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
  return spec ? describeTierSpec(spec) : undefined;
}

/** 把**任意**一份分时规格描述成人话（内置规格与用户自定义规格共用同一份文案逻辑） */
export function describeTierSpec(spec: ModelPriceTiers): string {
  const parts = spec.tiers.map((t) => `${t.label ?? t.id}：${describeWindows(t.windows)}`);
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
    // 跨午夜显式标出「次日」：`23:00-07:00` 光看数字会被读成"从早到晚"，实际是到第二天早上
    const crossMidnight = w.endMin < w.startMin;
    spans.push(`${fmtMinute(w.startMin)}-${fmtMinute(w.endMin)}${crossMidnight ? "（次日）" : ""}`);
    byDay.set(dayKey, spans);
  }
  return Array.from(byDay.entries()).map(([day, spans]) => `${day} ${spans.join("、")}`).join("，");
}

/* ═══════════════ 分时的「谷」时段推导 + 全时段展示（A-989）═══════════════ */

/** 一周的总分钟数 */
const WEEK_MINUTES = 7 * 1440;

/** 一段连续空闲（补集）区间；`endMinExclusive` 可等于 1440 表示"到当日 24:00" */
interface FreeSpan {
  /** 起始星期（0=周日…6=周六） */
  startDay: number;
  startMin: number;
  /** 结束星期 */
  endDay: number;
  endMinExclusive: number;
  /** 跨过的天数（0 = 当天内结束；1 = 次日；≥2 = 跨多日） */
  daysCrossed: number;
}

/** 把一组窗口铺到整周（7×1440）的覆盖位图上；`1` = 被该组窗口覆盖 */
function weekCoverage(windows: PriceTierWindow[]): Uint8Array {
  const cov = new Uint8Array(WEEK_MINUTES);
  for (const w of windows) {
    if (w.endMin === w.startMin) { continue; } // 空窗口：与 inAnyWindow 同一规则
    const days = !w.days || w.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : w.days;
    for (const d of days) {
      const base = (((d % 7) + 7) % 7) * 1440;
      if (w.endMin > w.startMin) {
        for (let m = w.startMin; m < w.endMin; m++) { cov[base + m] = 1; }
      } else {
        for (let m = w.startMin; m < 1440; m++) { cov[base + m] = 1; }
        const nb = (base + 1440) % WEEK_MINUTES;
        for (let m = 0; m < w.endMin; m++) { cov[nb + m] = 1; }
      }
    }
  }
  return cov;
}

function spanOf(startIdx: number, endIdx: number): FreeSpan {
  const startDay = Math.floor(startIdx / 1440);
  const startMin = startIdx % 1440;
  const endDay = Math.floor(endIdx / 1440) % 7;
  const endMinExclusive = (endIdx % 1440) + 1; // 位图是闭区间 → 转成右开
  return { startDay, startMin, endDay, endMinExclusive, daysCrossed: endDay - startDay < 0 ? endDay - startDay + 7 : endDay - startDay };
}

/**
 * 求一组时段窗在**整周**上的补集（即"谷"时段）。
 *
 * 为什么需要它：分时规格里「空闲档」刻意不写 `windows`（缺省 = 其余所有时段，语义最精确、
 * 不会漏时段），但这让**界面上看不到谷时段** —— 用户只看到"高峰 09:00-12:00、14:00-18:00"，
 * 无法确认夜间与周末到底算不算空闲。用户明确要求"把峰、谷时间端全部显示出来"，
 * 于是这里把补集**推导出来仅供展示**（不改计费语义，`windows: []` 仍是兜底档）。
 *
 * 算法：把窗口铺到 7×1440 位图上，从**任一覆盖点**起沿线性周环扫一遍找连续 0 段。
 *   - 从覆盖点起扫是为了让"跨周末的长空闲"不被切成两段（Fri 18:00 → Mon 09:00 是一段）；
 *   - 全周无覆盖（没有任何高峰窗）→ 整周都是谷，返回单段。
 */
export function complementSpans(windows: PriceTierWindow[]): FreeSpan[] {
  const cov = weekCoverage(windows);
  let pivot = -1;
  for (let i = 0; i < WEEK_MINUTES; i++) { if (cov[i] === 1) { pivot = i; break; } }
  if (pivot === -1) {
    return [{ startDay: 0, startMin: 0, endDay: 6, endMinExclusive: 1440, daysCrossed: 6 }];
  }
  const spans: FreeSpan[] = [];
  let runStart = -1;
  for (let k = 1; k <= WEEK_MINUTES; k++) {
    const idx = (pivot + k) % WEEK_MINUTES;
    const free = cov[idx] === 0;
    if (free && runStart === -1) { runStart = idx; continue; }
    if (!free && runStart !== -1) {
      spans.push(spanOf(runStart, (idx - 1 + WEEK_MINUTES) % WEEK_MINUTES));
      runStart = -1;
    }
  }
  if (runStart !== -1) { spans.push(spanOf(runStart, pivot)); }
  return spans;
}

/**
 * 把补集（谷）时段写成人类可读的**多行**文案，同形状的段按起始星期合并。
 *
 * 例（DeepSeek 高峰 = 工作日 09:00-12:00 与 14:00-18:00）：
 *   ["周一至周五 00:00-09:00","周一至周五 12:00-14:00","周一至周五 18:00-24:00","周六、周日 全天"]
 * 注意跨周末会被合并为「周五 18:00 至 周一 09:00」这种更长的一段 —— 那是事实，如实显示。
 */
export function describeComplementSpans(windows: PriceTierWindow[]): string[] {
  const spans = complementSpans(windows);
  if (spans.length === 0) { return ["无（该组窗口已占满整周）"]; }
  if (spans.length === 1 && spans[0].daysCrossed === 6 && spans[0].startMin === 0) {
    return ["全周（7×24 小时）"];
  }
  const groups = new Map<string, number[]>();
  for (const s of spans) {
    // 跨多日（≥2 天）的段无法用"星期 + 时间区间"表达，单独成组，避免被错误合并
    const key = s.daysCrossed >= 2
      ? `!${s.startDay}-${s.startMin}-${s.endDay}-${s.endMinExclusive}`
      : `${s.startMin}-${s.endMinExclusive}-${s.daysCrossed}`;
    const arr = groups.get(key) ?? [];
    arr.push(s.startDay);
    groups.set(key, arr);
  }
  const lines: string[] = [];
  for (const [key, days] of groups) {
    const sample = spans.find((s) => (s.daysCrossed >= 2
      ? `!${s.startDay}-${s.startMin}-${s.endDay}-${s.endMinExclusive}` : `${s.startMin}-${s.endMinExclusive}-${s.daysCrossed}`) === key)!;
    const uniqDays = [...new Set(days)].sort((a, b) => a - b);
    if (sample.daysCrossed >= 2) {
      lines.push(`${WEEKDAY_NAMES[sample.startDay]} ${fmtMinute(sample.startMin)} 至 ${WEEKDAY_NAMES[sample.endDay]} ${fmtMinute(sample.endMinExclusive)}（跨 ${sample.daysCrossed} 天）`);
      continue;
    }
    const timeText = sample.endMinExclusive === 1440 && sample.startMin === 0
      ? "全天"
      : `${fmtMinute(sample.startMin)}-${fmtMinute(sample.endMinExclusive)}`;
    const cross = sample.daysCrossed === 1 ? "（次日）" : "";
    lines.push(`${describeDays(uniqDays)} ${timeText}${cross}`);
  }
  return lines;
}

/**
 * 分时档位的**展示模型**（UI 只需渲染，不再自己判时段/拼文案）。
 *
 * 每个档位带上 `windowLines`（该档的**全部**时段，谷时段由补集推导）与 `active`
 * （给定时刻是否命中）。让 UI 拿数据而不是自己算，是为了消灭"界面按一套逻辑高亮、
 * 计费按另一套逻辑取值"的分裂（本文件存在的全部理由）。
 */
export interface TierDisplay {
  id: string;
  label: string;
  /** 该档的全部时段（多行，已按同形状合并）；兜底档为推导出的补集 */
  windowLines: string[];
  /** 是否"其余时段"兜底档（未显式声明 windows） */
  isFallback: boolean;
  priceIn: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /**
   * 档位的**官方原生人民币**价（¥/1M），原样透传、**不折算**。
   * 为什么明细表也要带：分时档是"同一个模型在不同时刻的两个价"，用户核对账单时
   * 拿到的往往是人民币账单；若明细表只给美元，用户只能自己乘汇率 —— 而官方两列
   * 非等比，乘出来的数对不上账单，会被当成又一处错价。
   */
  priceInCny?: number;
  priceOutCny?: number;
  priceCacheReadCny?: number;
  priceCacheWriteCny?: number;
  /** 给定 `at` 时是否命中该档；未传 `at` 时为 undefined（**不猜时刻**） */
  active?: boolean;
}

/**
 * 把一份分时规格整理成**含全部峰谷时段**的展示数据。
 * 兜底档（无 windows）的时段由其余档位的窗口**求补集**得出 —— 这样"谷"也能被逐条列出。
 */
export function describeTiersForDisplay(
  spec: ModelPriceTiers, at?: Date | string | number,
): TierDisplay[] {
  const explicit = spec.tiers.filter((t) => t.windows && t.windows.length > 0);
  const explicitWindows = explicit.flatMap((t) => t.windows!);
  // 时区不可解析 → resolveTierId 会返回兜底档，但那是"解析失败的退路"，不是"此刻命中"。
  // 标成 active=true 会让面板高亮一个它根本没判定过的档位（见 isTimezoneResolvable 注释）。
  const activeTier = at === undefined || !isTimezoneResolvable(spec.timezone)
    ? undefined
    : resolveTierId(spec.tiers, at, spec.timezone);
  return spec.tiers.map((t) => {
    const isFallback = !t.windows || t.windows.length === 0;
    return {
      id: t.id,
      label: t.label ?? t.id,
      windowLines: isFallback
        ? (explicitWindows.length > 0 ? describeComplementSpans(explicitWindows) : ["全周（7×24 小时）"])
        : describeWindows(t.windows).split("，"),
      isFallback,
      priceIn: t.priceIn,
      priceOut: t.priceOut,
      priceCacheRead: t.priceCacheRead,
      priceCacheWrite: t.priceCacheWrite,
      priceInCny: t.priceInCny,
      priceOutCny: t.priceOutCny,
      priceCacheReadCny: t.priceCacheReadCny,
      priceCacheWriteCny: t.priceCacheWriteCny,
      active: activeTier ? activeTier.id === t.id : undefined,
    };
  });
}

/** 模型内置（或供应商级）分时规格的展示数据；无分时规格时返回 undefined */
export function describePriceTiersForDisplay(
  modelId: string, at?: Date | string | number,
): { timezone: string; tiers: TierDisplay[] } | undefined {
  const entry = findPricingEntry(modelId);
  const spec = entry?.model.priceTiers ?? entry?.vendor.priceTiers;
  if (!spec || spec.tiers.length === 0) { return undefined; }
  return { timezone: spec.timezone, tiers: describeTiersForDisplay(spec, at) };
}


/* ═══════════════ 用户自定义分时档（A-988c）═══════════════ */

/**
 * 取**内置**分时规格的深拷贝（模型级 > 供应商级），供 UI 当编辑模板 / 「恢复内置默认」。
 * 返回拷贝而不是引用：UI 直接改表格里的对象会让内置真相源被就地污染，
 * 而这类污染不会在本次会话暴露，只会在下次启动时表现为"内置价莫名其妙变了"。
 */
export function builtInPriceTiers(modelId: string): ModelPriceTiers | undefined {
  const entry = findPricingEntry(modelId);
  const spec = entry?.model.priceTiers ?? entry?.vendor.priceTiers;
  if (!spec || spec.tiers.length === 0) { return undefined; }
  return {
    timezone: spec.timezone,
    tiers: spec.tiers.map((t) => ({
      ...t,
      days: undefined, // 档位级没有 days（只有窗口有），显式清掉避免脏字段被拷进配置
      windows: t.windows?.map((w) => ({ ...w, days: w.days ? [...w.days] : undefined })),
    })),
  };
}

/**
 * 生成一份**通用**的峰谷分时模板（内置表里没有该模型的分时规格时用）。
 *
 * 时段取 DeepSeek 那套"工作日双高峰"的形状 —— 它是国内公开定价里最广为人知的分时形态，
 * 用户按它改比从空白开始快得多。价格按传入的基准价填：高峰 = 基准价，空闲 = 半价
 * （"空闲半价"是分时定价里最常见的一档折扣，DeepSeek / Gemini 的 off-peak 都是这个比例）。
 *
 * ⚠️ 这是**用户自己确认过的模板**，不是 slime 对上游的断言 —— 所以它只会出现在
 * "用户点了『改为自定义』并且看到了这些数字"之后，绝不会被自动写进任何模型配置。
 */
export function createDefaultPriceTiers(priceIn = 0, priceOut = 0, timezone = "Asia/Shanghai"): ModelPriceTiers {
  const half = (n: number): number => Number((n / 2).toFixed(6));
  return {
    timezone,
    tiers: [
      { id: "peak", label: "高峰时段", windows: DEEPSEEK_PEAK_WINDOWS.map((w) => ({ ...w, days: w.days ? [...w.days] : undefined })), priceIn, priceOut },
      { id: "offpeak", label: "空闲时段", windows: [], priceIn: half(priceIn), priceOut: half(priceOut) },
    ],
  };
}

/**
 * 校验并规整一份（可能来自磁盘 JSON 的）分时规格。非法即返回 undefined —— 调用方据此
 * 视为"没有自定义分时"，而不是带着半个坏档位去计费。
 *
 * 为什么必须校验：这份数据来自 `providers.enc.json`，是**用户可编辑、也可能被旧版本写坏**的
 * 外部输入。缺了校验，一个 `startMin: NaN` 会让 `inAnyWindow` 全部返回 false（静默按兜底档
 * 计费，用户永远查不出为什么），一个非数字 `priceIn` 会让成本记成 NaN 并污染整张账目表。
 */
export function normalizePriceTiers(raw: unknown): ModelPriceTiers | undefined {
  if (!raw || typeof raw !== "object") { return undefined; }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.tiers)) { return undefined; }
  const isMin = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1439;
  const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const tiers: ModelPriceTier[] = [];
  for (const t of r.tiers) {
    if (!t || typeof t !== "object") { continue; }
    const o = t as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 32) : undefined;
    if (!id || !isMoney(o.priceIn)) { continue; } // 档位没有价就没有意义
    const windows: PriceTierWindow[] = [];
    if (Array.isArray(o.windows)) {
      for (const w of o.windows) {
        if (!w || typeof w !== "object") { continue; }
        const wo = w as Record<string, unknown>;
        if (!isMin(wo.startMin) || !isMin(wo.endMin)) { continue; }
        const days = Array.isArray(wo.days)
          ? [...new Set(wo.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))]
          : undefined;
        windows.push({ ...(days && days.length > 0 ? { days: days.sort((a, b) => a - b) } : {}), startMin: wo.startMin, endMin: wo.endMin });
      }
      // ⚠️ 写明了时段、但**一个都没通过校验** → 整档丢弃，绝不让它"退化成兜底档"。
      // 反例（本可以静默发生）：用户的「高峰档」时段被写坏 → windows 变空数组 →
      // `resolveModelPriceTier` 按「缺省 windows = 兜底档」处理 → 且它排在档位表第一位，
      // 于是 find() 先命中它 → **全天按高峰价计费**。用户唯一的症状是账单变贵，查不出原因。
      // 区分手法：`Array.isArray(o.windows) && o.windows.length > 0` = "用户本来写了时段"，
      // 与"用户主动不写 windows（= 兜底档）"是两件事，不能合并处理。
      if (o.windows.length > 0 && windows.length === 0) { continue; }
    }
    tiers.push({
      id,
      ...(typeof o.label === "string" && o.label ? { label: o.label.slice(0, 40) } : {}),
      windows,
      priceIn: o.priceIn,
      priceOut: isMoney(o.priceOut) ? o.priceOut : o.priceIn,
      ...(isMoney(o.priceCacheRead) ? { priceCacheRead: o.priceCacheRead } : {}),
      ...(isMoney(o.priceCacheWrite) ? { priceCacheWrite: o.priceCacheWrite } : {}),
    });
  }
  if (tiers.length === 0) { return undefined; }
  const timezone = typeof r.timezone === "string" && r.timezone.trim() ? r.timezone.trim().slice(0, 64) : "Asia/Shanghai";
  return { timezone, tiers };
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
