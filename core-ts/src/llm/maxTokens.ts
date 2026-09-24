/**
 * core-ts/src/llm/maxTokens.ts — `max_tokens` 必须按**实际发出的那个模型**封顶（A-1071）。
 *
 * ## 它修的是什么（#229「主 Agent 400 / 子代理正常」的结构性根因）
 *
 * 上游对「要得比它给得起的还多」的请求**不降级、不截断，直接 400**。2026-09-23 实测
 * （`POST https://api.agnes-ai.cn/v1/chat/completions`，模型 `agnes-3.0-flash`）:
 *
 * | 请求 max_tokens | 结果 |
 * | --- | --- |
 * | 不传 | 200（上游自取默认） |
 * | 65000 / 65536 | 200（等于官方 max_output 也接受） |
 * | 1000000 | **400** `{"error":{"message":"max_tokens 不能超过 65536","type":"AgnesAI_error","code":"invalid_request"}}` |
 *
 * 而 `max_tokens` 在本项目里是**由渲染层按"用户选中的那个模型"的 `max_output` 算出来的**
 * （`ChatPanel` → `maxTokens` → 引擎 → 路由）。问题在于**发出去的模型未必是用户选中的那个**：
 * A-158 有跨供应商降级池，首选失败后会换到别的模型，而 `max_tokens` 仍钉在首选模型的口径上
 * —— 于是「按 A 的额度要，让 B 来满足」，B 给不起就 400。
 *
 * **为什么子代理从来不撞这个坑**：子代理路径（`executor` → `toolLoop.run`）**根本不传
 * `maxTokens`**（`max_tokens: undefined` → 请求里没有这个字段）→ 上游自取默认 → 永远不会
 * 超限。这正是用户观察到的「主 Agent 400、子代理正常」的不对称来源 —— 不是模型不可用，
 * 是**主链路多带了一个按错误模型算出来的数字**。
 *
 * ## 与既有修法的关系（同一类 bug 的第二次出现）
 *
 * 这个仓里已经修过一次同族缺陷：思考参数（`reasoning_effort` / `chat_template_kwargs` …）
 * 曾经也按"请求里的模型"取，降级换模型后把 A 的协议参数发给 B → 上游 400。修法是
 * `ModelRouter.withModel()` 里**按本条路由的实际模型重算**（见 `router.ts` 的
 * `applyReasoningParams` 注释）。`max_tokens` 是同一条原则漏掉的第二个字段，所以修法也放在
 * 同一处收口：**凡是"随模型而变的请求字段"，都必须在路由收口处按实际模型重算**。
 *
 * ## 边界（保守）
 *
 *   · **只在超过已知上限时下压**，绝不因为"表里有值"就替调用方发明一个 `max_tokens`；
 *   · 请求方没给（`undefined`）→ 原样返回 `undefined`（保持"不传 = 上游默认"的既有语义）；
 *   · 能力表没有该模型的上限（未收录/未知家族）→ **原样返回**，不猜、不封；
 *   · 请求值 ≤ 上限 → 原样返回（含等号：实测 65536 是被接受的）。
 *
 * 守卫：`tests/core-ts/a1071-maxtokens.spec.ts`；变异：`gui/scripts/mut-a1071.mjs`。
 */
import { inferModelCapabilities } from "shared/model-capabilities";

/** 该模型的上游输出上限（token）。未收录/无上限 → undefined（不封顶）。 */
export function maxOutputCeilingOf(modelId: string): number | undefined {
  const cap = inferModelCapabilities(modelId ?? "").maxOut;
  return typeof cap === "number" && cap > 0 ? cap : undefined;
}

/**
 * 按**实际模型**封顶 `max_tokens`。
 *
 * @param modelId   真正要发往上游的模型 id（路由条目上的那个，不是用户选中的那个）
 * @param requested 调用方原本要的额度；`undefined` 表示"不传"（保持不传）
 */
export function capMaxTokensForModel(modelId: string, requested: number | undefined | null): number | undefined {
  // 不发明值：调用方没要，就不给（"不传 max_tokens = 上游默认"是安全的，加一个数字反而不安全）
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return undefined;
  }
  const ceiling = maxOutputCeilingOf(modelId);
  if (ceiling === undefined) { return requested; }
  return requested > ceiling ? ceiling : requested;
}

/**
 * 给请求体套上「按实际模型封顶」的 `max_tokens`（路由收口处调用）。
 *
 * 返回**新对象**：与 `applyReasoningParams` 一样不改入参 —— payload 可能在降级链里被
 * 逐条路由复用，就地改写会让上一条路由的参数泄漏给下一条。
 * 请求体里**没有** `max_tokens` 字段时原样返回（不新增、不发明）。
 */
export function applyMaxTokensCap<T extends object>(payload: T, modelId: string): T {
  const p = payload as Record<string, unknown>;
  if (!("max_tokens" in p)) { return payload; }
  const requested = typeof p.max_tokens === "number" ? p.max_tokens : undefined;
  const capped = capMaxTokensForModel(modelId, requested);
  if (capped === p.max_tokens) { return payload; }
  return { ...payload, max_tokens: capped };
}
