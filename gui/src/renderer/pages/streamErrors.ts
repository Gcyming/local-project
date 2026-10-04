














































export const PERMANENT_STATUSES: readonly number[] = [401, 403, 404];








export function upstreamStatusOf(msg: string): number | null {
  const m = /上游错误\s*(\d{3})|HTTP\s*(\d{3})/i.exec(msg ?? "");
  if (!m) { return null; }
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) ? n : null;
}





































export const CONTEXT_OVERFLOW_STATUSES: readonly number[] = [413, 414];


















import { LOCAL_PREFLIGHT_MARKER } from "../../../../core-ts/src/services/context_loop.js";

export { LOCAL_PREFLIGHT_MARKER };

export function isContextOverflowError(msg: string): boolean {
  const raw = msg ?? "";
  const m = raw.toLowerCase();

  
  
  if (raw.includes(LOCAL_PREFLIGHT_MARKER)) { return true; }

  
  if (/maximum context length/i.test(m)) { return true; }          
  if (/prompt is too long/i.test(m)) { return true; }             
  if (/exceeded model token limit/i.test(m)) { return true; }     
  if (/range of input length should be/i.test(m)) { return true; } 

  
  if (/context_length_exceeded|model_context_window_exceeded|input_too_long/.test(m)) { return true; }

  
  if (/context[^.]{0,24}(exceed|too (long|large))|too (many|large)[^.]{0,16}tokens/i.test(m)) { return true; }

  
  const status = upstreamStatusOf(raw);
  if (status !== null && CONTEXT_OVERFLOW_STATUSES.includes(status)) { return true; }

  return false;
}







export function contextOverflowHint(rescue?: string): string {
  const base =
    "本次请求超过了该模型的上下文上限（上游已明确报「上下文/输入过长」）。\n" +
    "原样重发必然同样失败，因此没有做自动重连。可操作项：\n" +
    "· 压缩上下文后重发（已自动尝试过一次；失败说明固定开销——系统提示/记忆/技能/工具定义——本身就接近上限）；\n" +
    "· 换成窗口更大的模型；\n" +
    "· 或开一个新会话。";
  return rescue ? `${base}\n\n${rescue}` : base;
}


















export function rescueSwitchLabel(model: { id: string; label?: string; cap?: number }): string {
  const name = model.label && model.label !== model.id ? model.label : model.id;
  const cap = typeof model.cap === "number" && model.cap > 0 ? `（${model.cap} tokens）` : "";
  return `切到 ${name}${cap} 并继续本轮`;
}


export const RESCUE_SWITCH_TITLE =
  "切换模型后接着本轮继续 —— 你已经发出的消息不会重复发送；输入框里正在写的内容也不会被动。";







export function isPermanentStreamError(msg: string): boolean {
  const raw = msg ?? "";
  const m = raw.toLowerCase();

  
  const status = upstreamStatusOf(raw);
  if (status !== null && PERMANENT_STATUSES.includes(status)) { return true; }

  
  if (/regionerror|not available in your (country|region)/i.test(m)) { return true; }

  
  
  if (/unauthorized|认证失败|authentication fail/i.test(m)) { return true; }
  if (/invalid[^.]{0,24}(api.?key|key)|(api.?key)[^.]{0,24}invalid/i.test(m)) { return true; }

  
  if (/no such model|model[^.]{0,40}(not found|no such)/i.test(m)) { return true; }

  
  if (/model (is )?unavailable/i.test(m)) { return true; }

  
  
  if (/freeusagelimit|free usage|免费额度|免费模型限流/i.test(m)) { return true; }

  return false;
}



export function explainStreamError(msg: string, attemptCount?: number): string {
  const causes: string[] = [];
  const m = msg ?? "";
  const low = m.toLowerCase();
  const status = upstreamStatusOf(m);

  if (status === 401 || /unauthorized|认证失败|api.?key|authentication|auth/i.test(low)) {
    causes.push("API Key 无效或已过期 → 请到「模型供应商」重新填写密钥并保存");
  }
  if (status === 403 || /forbidden|permission|regionerror|not available in your (country|region)/i.test(low)) {
    
    if (/regionerror|not available in your (country|region)/i.test(low)) {
      causes.push("上游区域限制（RegionError）→ 该模型在你所在地区不可用，请切换其他地区可用的模型 / 供应商");
    } else {
      causes.push("上游拒绝访问（403）→ 检查密钥权限 / 账号额度是否耗尽");
    }
  }
  if (status === 404 || /no such|not found|model[^.]{0,40}not|invalid[^.]{0,24}model/i.test(low)) {
    causes.push("模型 ID 不存在 / 已被下架 / 大小写不匹配 → 请切换到其他已启用模型");
  }
  
  if (/model (is )?unavailable/i.test(low)) {
    causes.push("上游报告该模型当前不可用（Model is unavailable）→ 请切换到其他已启用模型，或稍后重试");
  }
  
  
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
