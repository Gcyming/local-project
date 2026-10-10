



















export const LOCAL_MODELS_KEY = "_local_models";








/**
 * **思考模式**（A-1201）。混合推理模型（qwen3 / deepseek-r1 / qwq 等）的对话模板里有一个
 * `enable_thinking` 开关：开着时模型先吐一大段思维链，关掉时直接给正文。
 *
 * ## 为什么本地模型默认必须是 `auto`（且 auto 的实际行为是"关"）
 * 缺陷现场（2026-10-10 实测，RTX 4070 + qwen3-1.7b）：
 * 旧实现里 `engine.reasoningParamsForModel` 对 `kind === "local"` **硬编码下发
 * `chat_template_kwargs.enable_thinking = true`** ⇒ 每个本地模型都被强制开思考。
 * 小参数模型（1.7B）的思维链又长又发散，`max_tokens` 一被吃光 ⇒
 * **`content` 是空字符串、`finish_reason` 是 `length`** —— 用户看到的就是"模型不说话"。
 * 实测对照（max_tokens=64）：开思考 ⇒ `content=""`；关思考 ⇒ `content="你好呀"`。
 *
 * 所以三档语义是：
 *   · `auto`（缺省）—— **不下发 `enable_thinking: true`**；属于已知混合推理家族时下发
 *     `false`（因为它们的模板默认就是开）。目标：**保证有正文**。
 *   · `on`  —— 强制下发 `true`（用户明确要大模型的思考过程）。
 *   · `off` —— 强制下发 `false`。
 * 判据一句话：**"能出正文"优先于"能出思维链"** —— 出不了正文时思维链毫无价值。
 */
export type LocalThinkingMode = "auto" | "on" | "off";

export const LOCAL_THINKING_MODES: readonly LocalThinkingMode[] = ["auto", "on", "off"] as const;

/** 归一到合法取值：脏值（含 undefined / 老数据）⇒ `auto`（**不把未知值当 on/off 用**）。 */
export function normalizeThinkingMode(v: unknown): LocalThinkingMode {
  return v === "on" || v === "off" ? v : "auto";
}

/**
 * 已知的「混合推理家族」——这些模型的对话模板带 `enable_thinking`，
 * 且**模板默认是开**，所以 `auto` 要对它们显式下发 `false`。
 *
 * ⚠️ 判据是**模型 id 里的家族词**，不是"猜"：不在表里 ⇒ 不下发该 kwarg
 * （非推理模型收到未知 kwarg 会被 jinja 静默忽略，实测无害；但不下发更干净）。
 */
const HYBRID_REASONING_HINTS = [
  "qwen3", "qwen-3", "qwq",
  "deepseek-r1", "deepseek_r1", "-r1-", "reasoner",
  "glm-z1", "glm-4.5", "magistral",
] as const;

/** 该模型 id 是否属于已知混合推理家族（大小写不敏感）。 */
export function isHybridReasoningModel(id: string): boolean {
  const s = String(id ?? "").toLowerCase();
  if (!s) { return false; }
  return HYBRID_REASONING_HINTS.some((h) => s.includes(h));
}

/**
 * **本地模型思考参数的唯一产地**（A-1201）。
 *
 * 为什么抽成纯函数：这组参数有**两个消费者** ——
 *   ① 引擎发聊天请求时（`SlimeEngine.localReasoningParams`）；
 *   ② 「服务自检」按钮发探测请求时（主进程）。
 * 两处若各写一份，迟早漂移（自检验的参数与真跑的参数不一致 ⇒ 自检通过但真聊失败，
 * 那是比没有自检更坏的形态）。**判据同源**在这里是硬要求。
 *
 * 决策表（`auto` 是缺省，也是"保证能出正文"的那一档）：
 * | mode   | 模型属于混合推理家族 | 返回 |
 * |--------|--------------------|------|
 * | `off`  | 任意               | `{ chat_template_kwargs: { enable_thinking: false } }` |
 * | `on`   | 任意               | `{ chat_template_kwargs: { enable_thinking: true } }` |
 * | `auto` | 是                 | `{ chat_template_kwargs: { enable_thinking: false } }`（它们模板默认开 ⇒ 必须显式关） |
 * | `auto` | 否                 | `{}`（不下发；非推理模型收到未知 kwarg 虽无害，但不下发更干净） |
 */
export function localThinkingParams(modeRaw: unknown, modelId: string): Record<string, unknown> {
  const mode = normalizeThinkingMode(modeRaw);
  if (mode === "off") { return { chat_template_kwargs: { enable_thinking: false } }; }
  if (mode === "on") { return { chat_template_kwargs: { enable_thinking: true } }; }
  return isHybridReasoningModel(modelId) ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

export interface LocalModelSpec {
  id: string;
  
  path: string;
  label?: string;
  
  ctx_len?: number;
  
  gpu_layers?: number;
  max_output?: number;
  vision?: boolean;
  /** A-1201：思考模式（缺省 = auto ⇒ 保证出正文）。见 `LocalThinkingMode` 的长注释。 */
  thinking?: LocalThinkingMode;
}









export function findLocalModelSpec(
  table: Record<string, unknown> | undefined | null,
  id: string,
): LocalModelSpec | undefined {
  const raw = table?.[LOCAL_MODELS_KEY];
  if (!Array.isArray(raw)) { return undefined; }
  return (raw as LocalModelSpec[]).find(
    (m) => m && typeof m === "object" && m.id === id,
  );
}







export function localModelSpecs(
  table: Record<string, unknown> | undefined | null,
): LocalModelSpec[] {
  const raw = table?.[LOCAL_MODELS_KEY];
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((m): m is LocalModelSpec =>
    typeof m === "object" && m !== null &&
    typeof (m as LocalModelSpec).id === "string" &&
    typeof (m as LocalModelSpec).path === "string");
}
