/**
 * gui/src/renderer/pages/streamErrors.ts — 流式失败后的**两件事**的纯逻辑：
 *   ① `isPermanentStreamError` —— 该不该**跳过自动重连**（判定错误是否不可恢复）；
 *   ② `explainStreamError`    —— 重连耗尽/不可恢复时给用户的**可能诱因**文案。
 *
 * ## 为什么从 ChatPanel.tsx 搬到独立模块
 *
 * 两条都是**纯字符串逻辑**，却住在 5000 行的组件里 —— 于是守卫只能读源码断言，
 * 而"用户设的 10 次重连为什么一次都没跑"这类回归**永远测不出来**（本项目铁律：
 * 纯逻辑不许住 `.tsx`）。搬出来之后可以直接喂错误串断言行为，配变异。
 *
 * ## 修掉的真实缺陷：**裸数字子串匹配**
 *
 * 原实现（2026-09 之前）第一段是：
 *
 * ```ts
 * if (/403|regionerror|forbidden|…/i.test(m)) { return true; }   // 401 / 404 同理
 * ```
 *
 * `/\d{3}/` 没有边界 —— 它匹配的是**整条错误串里任何位置**的这三个数字。
 * 而我们递给它的 `msg` 是 `上游错误 400: {……完整响应体……}`（见 `client.ts` 的 `UpstreamError`），
 * 响应体里出现 `404`/`401`/`403` 这些数字**极其常见**：request id、token 计数、
 * 分页大小、数组下标、版本号、甚至 base64 片段。
 *
 * ⇒ 后果不是"提示不准"，而是**整段自动重连被跳过**：`isPermanentStreamError` 一旦为真，
 *   `onError` 直接 `failReconnect(msg, 0)`（用户原话："我以前定下的十次请求失败的重连阈值呢？"
 *   —— `MAX_RETRY = 9` 其实一直在代码里，是被这个判定**提前短路**掉了）。
 *
 * 修法：**只按上游状态码判**（`上游错误 NNN` / `HTTP NNN` 两种我们自己/上游给出的形态），
 * 文本信号一律退到"单词/短语"级，不再出现裸三位数字。
 *
 * ⚠️ 判据顺序即优先级不变（先精准后笼统），只是把"数字匹配"换成了"状态码解析"。
 *
 * 回归守卫见 `tests/gui/stream-errors.spec.ts`；变异见 `gui/scripts/mut-a1063-streamerrors.mjs`。
 */

/**
 * 判定"不可恢复"的上游状态码。
 *
 * 语义：换路重发**同一个模型**也一样失败，所以自动重连没有意义，直接终止并给可操作提示。
 *   · 401 认证失败（key 无效/过期）；
 *   · 403 区域限制 / 权限拒绝（RegionError 等）；
 *   · 404 模型 ID 不存在 / 已被下架 / 大小写不匹配。
 *
 * ⚠️ **400 不在其中**（历史上也不在）：400 的诱因五花八门，很多是上游对请求形态的临时挑剔
 *    或网关差异，重连 + 换路仍有成功的可能 —— 而把它列进来正是"重连阈值看起来消失"的那类修法。
 */
export const PERMANENT_STATUSES: readonly number[] = [401, 403, 404];

/**
 * 从错误串里解析上游 HTTP 状态码。
 *
 * 只认两种形态（其余一律 `null`，**不做裸数字扫描**）：
 *   · `上游错误 400: {…}` —— 本项目 `client.ts` 抛 `UpstreamError` 的统一格式；
 *   · `HTTP 400`           —— 备用模型/网关自己拼的格式。
 */
export function upstreamStatusOf(msg: string): number | null {
  const m = /上游错误\s*(\d{3})|HTTP\s*(\d{3})/i.exec(msg ?? "");
  if (!m) { return null; }
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) ? n : null;
}

/**
 * A-1081：**上下文超限**类错误 —— 与"终态错误"（401/403/404）并列的**第三类**。
 *
 * ## 三态模型（这是本轮修复的核心）
 *
 * | 类别 | 例子 | 正确处置 |
 * | --- | --- | --- |
 * | 瞬时 | 429 / 5xx / 网络抖动 | **重连**（现有 9 次退避） |
 * | 终态·不可恢复 | 401 / 403 / 404 | **立即终止** + 可操作提示 |
 * | **终态·可压缩** | 上下文超限 | **压缩一次 → 重试一次**；已压过则终止 |
 *
 * 上下文超限**不是**瞬时故障：把同一个请求原样重发必然**同样失败** ——
 * 所以它既不该进 9 次重连（用户实测症状：「连接半天还是重连」「直接超时报错」），
 * 也不该直接终止（压缩一下就可能成功）。它是"**少的那一环**"。
 *
 * ## ⚠️ 判据为什么必须以**散文**为主，而不是 `code` 字段
 *
 * 本仓 `client.ts` 抛错误时对响应体做了 `slice(0, 200)`（9 处，见 `UpstreamError` 构造点）。
 * 而 OpenAI 系的错误体把 `"code":"context_length_exceeded"` 放在**末尾**：
 *
 * ```json
 * {"error":{"message":"This model's maximum context length is 131072 tokens. …","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}
 * ```
 *
 * ⇒ 200 字符时 `code` 已被**截掉**，任何"靠结构化 code 精确分类"的实现都会在这条真实错误上失效。
 * 所以：**散文句式为第一判据**（它总在 message 开头），`code` 只作补充；
 * 且所有匹配都限定在**单句内**（`[^.]{0,N}`），避免把响应体里无关的词配成一对。
 *
 * 来源（形态逐字取自各家官方错误文档 / 实测响应体，见 `docs/context-compaction-loop.md` §7）：
 *   · OpenAI / DeepSeek：`This model's maximum context length is N tokens`
 *   · Anthropic：`prompt is too long: N tokens > M maximum`
 *   · Moonshot / Kimi：`exceeded model token limit`
 *   · 阿里云百炼 / DashScope：`Range of input length should be [1, N]`
 *   · Cloudflare 等网关：`Request is too large: maximum context length …`（曾被翻成 413）
 *   · HTTP 语义：**413** Content Too Large / **414** URI Too Long
 */
export const CONTEXT_OVERFLOW_STATUSES: readonly number[] = [413, 414];

/**
 * A-1084：**本地判定**的「上下文装不下」标记。
 *
 * 引擎的保险门（`core-ts/services/context_loop.ts` 的 `planEngineSend`）在"装不下"时
 * **根本不会发出请求** ⇒ 上游一个字都不会说 ⇒ 上面那些"上游超限"的判据**一个都不命中** ⇒
 * 渲染层会把这条错误当成"瞬时故障"，落进 9 次重连 —— 而每一次都被保险门原样拦回，
 * 用户看到"重连了 9 次还是不行"，比不做这道门还糟。
 *
 * ⇒ 本地判定必须**自报身份**，与上游超限走**同一条**处置（压缩一次 + 重试一次）。
 *
 * ⚠️ 常量**只有一份正本**（在 `context_loop.ts`，判定与文案同源），这里 import 后原样
 * re-export，而不是重写一份字面量 —— 两份字面量就是两个产地，改名时会静默漂移（本仓铁律）。
 * 该模块**零 import 的纯函数**，所以渲染层引用它不会把 node 内置模块拖进打包。
 *
 * ⚠️ 必须是 `import` + `export {}`（不能只写 `export … from`）：后者**不建立本地绑定**，
 * 下面 ⓪ 那行判据会编译不过 —— 这正是"看起来接线了、实际没接上"的经典形态。
 */
import { LOCAL_PREFLIGHT_MARKER } from "../../../../core-ts/src/services/context_loop.js";

export { LOCAL_PREFLIGHT_MARKER };

export function isContextOverflowError(msg: string): boolean {
  const raw = msg ?? "";
  const m = raw.toLowerCase();

  // ⓪ 本地判定（引擎保险门自报身份）—— **最精准的一档，必须排第一**：
  //    它是我们自己的字符串，不存在被响应体污染的可能。
  if (raw.includes(LOCAL_PREFLIGHT_MARKER)) { return true; }

  // ① 散文句式（第一判据 —— 总在 message 开头，不会被 200 字符截掉）
  if (/maximum context length/i.test(m)) { return true; }          // OpenAI / DeepSeek 系
  if (/prompt is too long/i.test(m)) { return true; }             // Anthropic
  if (/exceeded model token limit/i.test(m)) { return true; }     // Moonshot / Kimi
  if (/range of input length should be/i.test(m)) { return true; } // 阿里云百炼 / DashScope

  // ② 结构化 code（补充：不依赖它，因为可能被截断）
  if (/context_length_exceeded|model_context_window_exceeded|input_too_long/.test(m)) { return true; }

  // ③ 广谱（最松一档，放最后）—— 必须"上下文/输入"与"超"在**同一句内**相邻
  if (/context[^.]{0,24}(exceed|too (long|large))|too (many|large)[^.]{0,16}tokens/i.test(m)) { return true; }

  // ④ 状态码（HTTP 语义：413/414 就是"载荷太大"）
  const status = upstreamStatusOf(raw);
  if (status !== null && CONTEXT_OVERFLOW_STATUSES.includes(status)) { return true; }

  return false;
}

/** 上下文超限时给用户的**可操作**提示（不是"请重试"——重试同一个请求必然同样失败）。
 *
 *  A-1086：`rescue` 是主进程算好的**出路**（"切到哪个模型"，唯一产地
 *  `core-ts/services/context_loop.formatRescueHint`）。有它就附在末尾 ——
 *  用户在这个处境里需要的是**具体动作**，不是"请换一个窗口更大的模型"这种原则。
 *  ⚠️ 不传时（旧调用点/非 GUI 场景）保持原样输出，零回归。 */
export function contextOverflowHint(rescue?: string): string {
  const base =
    "本次请求超过了该模型的上下文上限（上游已明确报「上下文/输入过长」）。\n" +
    "原样重发必然同样失败，因此没有做自动重连。可操作项：\n" +
    "· 压缩上下文后重发（已自动尝试过一次；失败说明固定开销——系统提示/记忆/技能/工具定义——本身就接近上限）；\n" +
    "· 换成窗口更大的模型；\n" +
    "· 或开一个新会话。";
  return rescue ? `${base}\n\n${rescue}` : base;
}

/**
 * A-1090：「压无可压」时那个「一键切换」按钮的**文案唯一产地**。
 *
 * ## 为什么必须是纯函数（而不是组件里的字面量）
 *
 * 文案描述的是"点了会发生什么"。行为一改（例如从"切换并继续本轮"改成"只切换不回填"），
 * 组件里拼死的字面量就会**说反话** —— 用户按一种心智点下去，得到另一种结果。
 * 这正是 A-1062 的形态（placeholder 说"Enter 发送"、实际走的是注入本轮，用户反复报"插入会打断"）。
 * ⇒ 文案与判据必须同源：按钮显示什么由这里给，点击做什么由 `ChatPanel.handleRescueSwitch` 做，
 *    两者的语义**逐字对齐**（本函数刻意用「继续」而不是「重发」，见下）。
 *
 * ## ⚠️ 不许说"重发"
 *
 * `formatRescueHint` 承诺的是「切到它即可**继续本次会话**」。用户那条消息在发送时**已经落库**，
 * 再发一次就重复了；真实动作是接着**被打断的那一轮**继续。按钮若自称"重发"，
 * 用户会以为消息要再发一遍 —— 两句话必须指同一件事。
 */
export function rescueSwitchLabel(model: { id: string; label?: string; cap?: number }): string {
  const name = model.label && model.label !== model.id ? model.label : model.id;
  const cap = typeof model.cap === "number" && model.cap > 0 ? `（${model.cap} tokens）` : "";
  return `切到 ${name}${cap} 并继续本轮`;
}

/** 按钮的悬停说明（同样在描述行为，故与 `rescueSwitchLabel` 同处同源，不许在组件里另写一份）。 */
export const RESCUE_SWITCH_TITLE =
  "切换模型后接着本轮继续 —— 你已经发出的消息不会重复发送；输入框里正在写的内容也不会被动。";

/**
 * 不可恢复错误：403 区域限制 / 401 认证失败 / 404 模型不存在 / 400 模型不可用 /
 * 免费模型限流（FreeUsageLimitError）等**短期不可自动恢复**的错误。
 *
 * 对这些错误自动重连（上限见 `ChatPanel` 的 `MAX_RETRY`）多半无效，直接终止并给出可操作提示。
 */
export function isPermanentStreamError(msg: string): boolean {
  const raw = msg ?? "";
  const m = raw.toLowerCase();

  // ① 状态码优先（唯一权威）—— 见文件头"裸数字子串匹配"的说明
  const status = upstreamStatusOf(raw);
  if (status !== null && PERMANENT_STATUSES.includes(status)) { return true; }

  // ② 区域限制（RegionError 常常以 400 或 5xx 返回，所以不能只靠状态码）
  if (/regionerror|not available in your (country|region)/i.test(m)) { return true; }

  // ③ 认证失败：单词级信号（`invalid … key` 允许中间夹少量词，但不跨句——避免把
  //    响应体里无关的 "invalid" 与后面的 "key" 配成一对）
  if (/unauthorized|认证失败|authentication fail/i.test(m)) { return true; }
  if (/invalid[^.]{0,24}(api.?key|key)|(api.?key)[^.]{0,24}invalid/i.test(m)) { return true; }

  // ④ 模型不存在（404 的文字形态；上游有时用 400 携带这句话）
  if (/no such model|model[^.]{0,40}(not found|no such)/i.test(m)) { return true; }

  // ⑤ 上游明确报告模型当前不可用（如 opencode zen 的 Model is unavailable）
  if (/model (is )?unavailable/i.test(m)) { return true; }

  // ⑥ 免费模型限流（FreeUsageLimitError）：免费池有独立速率/并发限制，与个人累计用量无关；
  //    短时间自动重连不会恢复，提示用户稍后手动重发
  if (/freeusagelimit|free usage|免费额度|免费模型限流/i.test(m)) { return true; }

  return false;
}

/** 重连均失败后 / 不可恢复错误：按错误内容归纳「可能诱因」，供红字强调展示。
 *  attemptCount 有值时标题注明重连 N 次仍失败；留空（0）表示错误不可自动恢复 */
export function explainStreamError(msg: string, attemptCount?: number): string {
  const causes: string[] = [];
  const m = msg ?? "";
  const low = m.toLowerCase();
  const status = upstreamStatusOf(m);

  if (status === 401 || /unauthorized|认证失败|api.?key|authentication|auth/i.test(low)) {
    causes.push("API Key 无效或已过期 → 请到「模型供应商」重新填写密钥并保存");
  }
  if (status === 403 || /forbidden|permission|regionerror|not available in your (country|region)/i.test(low)) {
    // RegionError（区域限制）优先给出精准提示，避免笼统误报为"检查权限"
    if (/regionerror|not available in your (country|region)/i.test(low)) {
      causes.push("上游区域限制（RegionError）→ 该模型在你所在地区不可用，请切换其他地区可用的模型 / 供应商");
    } else {
      causes.push("上游拒绝访问（403）→ 检查密钥权限 / 账号额度是否耗尽");
    }
  }
  if (status === 404 || /no such|not found|model[^.]{0,40}not|invalid[^.]{0,24}model/i.test(low)) {
    causes.push("模型 ID 不存在 / 已被下架 / 大小写不匹配 → 请切换到其他已启用模型");
  }
  // 400 上游明确报告模型不可用（放在 404 判断后、429 判断前，命中优先展示精准诱因）
  if (/model (is )?unavailable/i.test(low)) {
    causes.push("上游报告该模型当前不可用（Model is unavailable）→ 请切换到其他已启用模型，或稍后重试");
  }
  // 免费模型限流：FreeUsageLimitError 含 "Rate limit exceeded" 字样，
  // 必须在通用 429 分支之前判断，避免误报成"普通限流稍等片刻"或"额度用完"
  if (/freeusagelimit|free usage|免费额度|免费模型限流/i.test(low)) {
    causes.push("免费模型触发上游限流（FreeUsageLimit，免费池独立的速率/并发限制，与你今天用没用过无关）→ 请稍等片刻后手动重新发送，或切换到其他模型");
  }
  if (status === 429 || /rate.?limit|quota|insufficient|too many|限流|额度/i.test(low)) {
    causes.push("触发上游限流（429）或额度不足 → 稍等片刻再发，或降低推理强度 / 输出长度");
  }
  if (/timeout|timed ?out|etimedout|econnreset|socket|network|fetch failed|unexpected token|aborted/i.test(low)) {
    causes.push("网络波动或上游连接中断 → 检查网络 / 代理 / VPN 后重试");
  }
  if ((status !== null && status >= 500) || /overloaded|maintenance|服务暂时不可用/i.test(low)) {
    causes.push("上游服务暂时不可用（5xx）→ 服务恢复后重试");
  }
  if (/context|token[^.]{0,20}(limit|length|max)|too (long|large)/i.test(low)) {
    causes.push("请求超出模型上下文上限 → 点击「新对话」清理上下文后重试");
  }
  if (/local|model.?server|llama|19100|load/i.test(low)) {
    causes.push("本地模型服务未就绪或已崩溃 → 到「状态面板」确认模型服务状态后重试启动");
  }
  if (causes.length === 0) {
    causes.push("未知错误 → 参考上方完整错误信息；检查模型是否已启用、网络是否正常");
  }
  return [
    `❌ 模型调用失败${attemptCount ? `（已自动重连 ${attemptCount} 次仍无法恢复）` : "（错误无法自动恢复，请按下方提示处理）"}`,
    ``,
    `错误信息：${msg || "连接意外中断"}`,
    ``,
    `可能诱因：`,
    ...causes.map((c) => `· ${c}`),
  ].join("\n");
}
