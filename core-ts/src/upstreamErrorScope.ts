/**
 * core-ts/src/upstreamErrorScope.ts — 上游错误正文「特征表」的唯一实现（A-157 收敛）。
 *
 * 为什么这个文件必须存在（真实事故）：
 *   用户报「群聊里 GLM 成员每轮发言都失败」。根因链：智谱 provider 的模型列表探测
 *   返回 `glm-4.5-air:free`（上游真实返回的 id，非我们生成）；该 id 打到 chat/completions
 *   返回 400，正文 `{"error":{"code":"1211","message":"模型不存在，请检查模型代码。"}}`，
 *   而同供应商的 `glm-4.5-air` 同端点 200（可用）。本该由降级链自动切到 `glm-4.5-air`，
 *   但**没有** —— 因为「上游错误正文特征表」在三个地方各写了一份、互不同步：
 *     1. client.ts 的 `modelScopeFromUpstreamText`（降级链 isFallbackError 据此判 modelScope）
 *     2. probe-live.ts 的 `isModelDeadError`
 *     3. probe-live.ts 的 `nextAuthOnFailure` 的 404 支
 *   三份都只认英文 RegionError / Model is unavailable 等传统形态，**都没认智谱 1211 / 中文
 *   「模型不存在」** → 第 1 份返回 undefined → isFallbackError 对「400 且 modelScope===undefined」
 *   返回 false → 整条降级链中止 → 用户只看到失败（该降级的没降级、该标死的没标死）。
 *
 * 本次收敛的边界（诚实表述，不要夸大）：
 *   - 收敛的是**「上游错误正文特征表 + 厂商错误码」这一份数据**，把它从三处搬到这里，
 *     三处都改为调用 `isModelLevelErrorText` / `modelScopeFromUpstreamText` 的唯一实现。
 *   - **不合并 `isModelDeadError` / `nextAuthOnFailure` 的整体函数语义**：它们各自还带状态码
 *     语义（404 模型不存在、401/403 鉴权、429 限流、5xx），这些是「函数级」契约，继续留在
 *     probe-live.ts；本模块只负责「正文/错误码里这段文字算不算模型级失效」这一份纯判定。
 *
 * 设计约束：
 *   - 纯逻辑、零项目内依赖（不 import 任何项目内模块），便于三处共享且可被守卫测试直接读源码断言。
 *   - 反向要求：正则**不得**吞掉无关 400（上下文超限 / 参数错误 / 系统错误等），见下方 RE 与单测。
 */

/**
 * 模型级错误正文特征表（单条 RegExp，带 `i` 标志）。
 * 原始 8 条英文形态**一条都不删**（`regionerror` / `not available in your (country|region)` /
 * `model (is |not )?unavailable` / `model_not_found` / `model not found` / `freeusagelimit` /
 * `endpoint is unavailable` / `invalid model`），并新增：
 *   - 英文：`no such model` / `unknown model` / `unsupported model` / `does not exist`
 *   - 中文：`模型不存在` / `模型不可用` / `不存在(的)?模型` / `无效(的)?模型` /
 *           `模型已下线` / `模型下线` / `请检查模型代码`
 * 全部合成一个带 `i` 标志的 RegExp，便于守卫测试引用（导出）。
 *
 * ⚠️ 反向约束（已单测钉死）：不得吞掉无关 400，例如
 *   `{"error":{"message":"上下文长度超过模型上限"}}`、
 *   `{"error":{"code":"1210","message":"请求参数错误"}}`、
 *   `{"error":{"code":"1301","message":"系统错误"}}` 均不匹配。
 */
export const MODEL_LEVEL_ERROR_RE =
  /regionerror|not available in your (country|region)|model (is |not )?unavailable|model_not_found|model not found|freeusagelimit|endpoint is unavailable|invalid model|no such model|unknown model|unsupported model|does not exist|模型不存在|模型不可用|不存在(的)?模型|无效(的)?模型|模型已下线|模型下线|请检查模型代码/i;

/**
 * 厂商错误码判据：智谱用数字码而非文案表达「模型不存在」。
 * 真实正文：`{"error":{"code":"1211","message":"模型不存在，请检查模型代码。"}}`。
 * 注意仅识别 1211，避免误伤 1210（参数错误）/ 1301（系统错误）等。
 */
const ZHIPU_MODEL_NOT_FOUND_CODE_RE = /"code"\s*:\s*"?1211"?\b/;

/**
 * 从上游错误正文识别「模型级错误」（换模型可恢复）。
 * 命中正文特征表（`MODEL_LEVEL_ERROR_RE`）**或**智谱 1211 错误码 → true。
 * 空 / undefined / null 正文 → false（调用方据此回退到状态码语义）。
 */
export function isModelLevelErrorText(text: string | undefined | null): boolean {
  if (!text) { return false; }
  const t = String(text);
  return MODEL_LEVEL_ERROR_RE.test(t) || ZHIPU_MODEL_NOT_FOUND_CODE_RE.test(t);
}

/**
 * 从上游错误正文 + 状态码识别「错误作用域」：
 *   - "model"   ：模型级（换模型可恢复）→ 降级链可换同供应商另一模型
 *   - "provider"：供应商级（401 认证 / 403 非区域权限）→ 换模型无意义，不降级
 *   - undefined ：无法判定 → 调用方按默认状态码语义处理
 *
 * 判定顺序与旧 `client.ts` 的 `modelScopeFromUpstreamText` **逐字一致**（不改判据）：
 *   1) 空正文 → undefined；2) 401 → provider；3) 正文模型级 → model；4) 403 → provider；5) undefined。
 * 含义：401 永远视为认证问题（即便正文凑巧含模型级词）；含模型级正文的 403 仍判 model（区域限制
 * 属模型级）；纯 403（无正文特征）→ provider。
 */
export function modelScopeFromUpstreamText(text: string, status: number): "model" | "provider" | undefined {
  if (!text) { return undefined; }
  if (status === 401) { return "provider"; }
  if (isModelLevelErrorText(text)) { return "model"; }
  if (status === 403) { return "provider"; }
  return undefined;
}
