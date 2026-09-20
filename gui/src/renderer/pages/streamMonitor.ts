/**
 * streamMonitor.ts — 「本轮输出监测计数器」的纯函数集（无 React 依赖，vitest 可直测）。
 *
 * 为什么独立成模块（A-974-R9）：
 *   底部监测栏的 tokens / 耗时 / tokens·s⁻¹ / model 此前**只活在组件内 ref**，切会话时
 *   随实例销毁、被 resetStreamUI 清零，`perSessionStreamCache` 快照只存了 partial/reasoning/tools
 *   → 切回来数值清零重新计（用户实测）。这里把「增量累计 / 绝对起点折算耗时」两件事抽成纯函数，
 *   快照保存与恢复共用同一套语义，并有单测兜住。
 *
 * `startedAt` 用**绝对时间戳**而非"已用毫秒"：流在切走期间仍在后台跑，
 * 切回后用 `now - startedAt` 折算，耗时自然包含离开的时段（语义正确，不会少算）。
 */

export interface StreamMonitor {
  /** 本轮总输出（正文 + 思考）token 估算（≈4 字符/token） */
  tokens: number;
  /** 本轮起始绝对时间戳（epoch ms；0 = 尚未开始输出） */
  startedAt: number;
  /** 实际流式模型标签（首个 chunk 或 done 回填） */
  model: string;
  /** 正文字符累计 */
  replyChars: number;
  /** 思考字符累计 */
  reasonChars: number;
}

/** 每 4 字符 ≈ 1 token（与 ChatPanel 其它估算口径一致） */
export const CHARS_PER_TOKEN = 4;

/** 新建计数器（发送／首次镜像时用；startedAt 传发送时刻，保证"发完立刻切走"也能正确计时） */
export function createMonitor(startedAt: number, model = ""): StreamMonitor {
  return { tokens: 0, startedAt, model, replyChars: 0, reasonChars: 0 };
}

/** 由已累计字符数推算总输出 token（正文 + 思考） */
export function tokensFromChars(replyChars: number, reasonChars: number): number {
  const total = Math.max(0, replyChars) + Math.max(0, reasonChars);
  return Math.round(total / CHARS_PER_TOKEN);
}

/** 累计增量并回算 tokens（原地更新并返回同一对象；调用方持有快照引用时无需重新赋值）。
 *  @param replyDelta 正文新增字符数
 *  @param reasonDelta 思考新增字符数
 *  @param model 若传入非空且当前为空，则回填模型标签 */
export function bumpMonitor(
  m: StreamMonitor,
  replyDelta: number,
  reasonDelta: number,
  model?: string,
): StreamMonitor {
  if (replyDelta > 0) { m.replyChars += replyDelta; }
  if (reasonDelta > 0) { m.reasonChars += reasonDelta; }
  m.tokens = tokensFromChars(m.replyChars, m.reasonChars);
  if (model && !m.model) { m.model = model; }
  return m;
}

/** 由绝对起点折算已用耗时（ms）。startedAt 非法/未开始 → 0；时钟回拨 → 夹到 0，不出现负数。 */
export function monitorElapsed(m: Pick<StreamMonitor, "startedAt"> | null | undefined, now: number): number {
  const start = m?.startedAt ?? 0;
  if (!start) { return 0; }
  return Math.max(0, now - start);
}
