/**
 * gui/src/renderer/pages/streamTyping.ts — 流式内容的**显示层逐字缓冲**（纯逻辑，A-1128）。
 *
 * ## 用户需求（2026-09-26）
 *
 * 原话：「那种吐字有浅到深的渐入效果我依旧没看见啊，而且现在正文更是基本秒出，这就算了，
 * **思考历程里面的吐字也是一整个一整个的吐**。给我找出原因，明明之前有一段时间是符合我要求的，
 * 怎么现在直接没了？」
 *
 * ## 根因（不是"动画被删了"，是**内容到得太整**）
 *
 * 渐入动画（`.stream-fade-unit`）只挂在 `splitStreamFade()` 切出来的**尾巴 ≤48 字**上
 * （正是"刚吐出来"的那一小段）。所以它能不能被看见，取决于**显示文本的推进粒度**：
 *
 *   · **正文**：有一条显示层打字机缓冲（`displayPartialRef`，28ms/字）——
 *     每帧只多 1 个字，于是每帧都只有 1~2 个新单元进尾巴 ⇒ 逐字渐入看得见。
 *   · **思考**：**没有**缓冲 —— `timelineStepsRef` 直接吃 SSE 的 reasoning chunk。
 *     一个 chunk 动辄几十上百字，尾巴一次多出几十个单元（甚至整行跨过换行直接落进
 *     `settled` 交给 Markdown 立即成块）⇒ 「一整个一整个的吐」。
 *
 * ⇒ 修法：给思考（以及思考历程里穿插的正文片段）也加一条**同一族的显示层缓冲**。
 *   ⚠️ 只缓冲**显示层**：`timelineStepsRef`（真源：持久化 / 恢复 / 快照都读它）一个字都不动。
 *
 * ## 为什么"逐字"要与"追赶"同时存在
 *
 * 28ms/字 ≈ 36 字/秒；思考的输出速率经常是它的十倍以上。纯 28ms/字会让显示位置**无限滞后**
 * （用户读完结论了，屏幕上还在吐前面的推理）。所以沿用正文那套双模：
 *   积压小 → 逐字（有渐入观感）；积压大 → 每帧推进积压的 1/N（几何收敛，几十帧内追平）。
 *
 * ⚠️ 思考的 N 比正文**大得多**（40 vs 12）：正文只在收尾时一次性播（用户裁决：
 *   「正文维持收尾统一输出」），而思考是**边想边看**的实时区 —— 追得太猛（每帧几十字）
 *   就又变回"整块蹦"。40 是在"看得见逐字"与"不落后太久"之间取的折中：
 *   输出速率 r 字/秒时稳定积压 ≈ r·N/60，即 500 字/秒 ≈ 330 字（约 8 字/帧）；
 *   模型慢下来就自然回到一字一帧。
 *
 * 本模块**不得**出现 React / JSX / DOM（对齐 streamFade.ts / floatDock.ts / subAgentPanel.ts 的分家约定）。
 */

/** 打字机节拍（ms/字）—— 正文与思考共用同一个来源（正文那处直接读它，别再写字面量 28） */
export const TYPING_STEP_MS = 28;

/** 一套打字机参数：常态节拍 + 追赶阈值 + 追赶分母（每帧推进积压的 1/divisor） */
export interface TypingTuning {
  stepMs: number;
  catchupChars: number;
  divisor: number;
}

/**
 * 正文（`displayPartialRef`）的参数。
 *
 * ⚠️ `catchupChars = 240` 是**被 OOM 事故逼出来的值**，不要凭手感调大：
 *   显示落后越多，每帧就要对一个越长的字符串重跑一次 Markdown 解析。
 *   模型可以吐 700+ 字符/秒，而 28ms/字只有约 36 字符/秒 —— 不设追赶阈值，
 *   `partialRef` 会以十几倍速度堆积，渲染进程被钉在 60fps 处理一个只增不减的大字符串，
 *   内存与 CPU 双爆（`data/logs/renderer-crash.log` 里有 `oom` 记录；
 *   用户侧表现是"用着用着 slime 直接崩了、任务中断"）。
 */
export const BODY_TYPING: TypingTuning = { stepMs: TYPING_STEP_MS, catchupChars: 240, divisor: 12 };

/** 思考内容（思考历程里的 think / body 节点）的参数 —— 追赶分母见文件头说明 */
export const THINK_TYPING: TypingTuning = { stepMs: TYPING_STEP_MS, catchupChars: 320, divisor: 40 };

export interface TypingAdvance {
  /** 推进后的显示前缀（**永远是 `full` 的前缀**） */
  shown: string;
  /** 下一次可推进的墙钟门限 */
  lastAt: number;
  /** 这一帧是否真的多显示了字符（吐字光标的证据） */
  emitted: boolean;
}

/**
 * 推进一步显示缓冲。纯函数（`now` 由调用方传入）。
 *
 * · `full` 不再以 `shown` 为前缀（换轮 / 文本被回溯改写）→ 从零重来（否则会显示错位的切片）；
 * · 积压 > `catchupChars` → 每帧推进积压的 `1/divisor`（至少 4 字，保证能收敛）；
 * · 否则每 `stepMs` 推进 1 字。
 */
export function advanceTypingShown(
  shown: string,
  full: string,
  lastAt: number,
  now: number,
  t: TypingTuning = BODY_TYPING,
): TypingAdvance {
  let s = typeof shown === "string" ? shown : "";
  let at = Number.isFinite(lastAt) ? lastAt : 0;
  if (!full || !full.startsWith(s)) { s = ""; at = 0; }
  if (s.length >= full.length) { return { shown: s, lastAt: at, emitted: false }; }
  const backlog = full.length - s.length;
  if (backlog > t.catchupChars) {
    s = full.slice(0, s.length + Math.max(4, Math.ceil(backlog / t.divisor)));
    at = now;
  } else if (now - at >= t.stepMs) {
    s = full.slice(0, s.length + 1);
    at = now;
  }
  return { shown: s, lastAt: at, emitted: s.length > shown.length };
}

/** 需要被"打字机"控制的最小节点形状（TimelineStep 的子集；本模块不 import 组件类型） */
export interface TypingTailStep { kind: string; text?: string }

/**
 * 找出当前**正在流的那一段尾巴**：时间线的最后一个节点，且它必须是文本节点
 * （`think` / `body`）。末尾是工具卡 / 规划卡时返回 `null` —— 那些不是"逐字吐"的内容。
 *
 * `key` 用**位置 + 类型**而不是对象身份：`appendTimelineStep` 每来一个 chunk 都会新建
 * 末位对象（`[...slice(0,-1), newStep]`），拿对象当 key 会导致每帧都"换了个节点"。
 */
export function tailTypingTarget(steps: readonly TypingTailStep[]): { key: string; text: string } | null {
  if (!Array.isArray(steps) || steps.length === 0) { return null; }
  const i = steps.length - 1;
  const last = steps[i];
  if (!last || (last.kind !== "think" && last.kind !== "body")) { return null; }
  return { key: `${i}:${last.kind}`, text: last.text ?? "" };
}

/** 尾巴打字机的状态：正在吐哪一段（`key`）+ 已经吐到哪里（`shown`，是 `text` 的前缀） */
export interface TailTypingState { key: string; shown: string; lastAt: number }

/** 空闲态（没有尾巴在吐）。**必须复用同一个对象**，这样"没变化"能靠引用相等被认出来。 */
export const IDLE_TAIL_TYPING: TailTypingState = { key: "", shown: "", lastAt: 0 };

/**
 * 推进一步。`target` 变化（换节点）或文本不再以 `shown` 为前缀 → 从头开始吐。
 *
 * 换节点就从头吐是**要的效果**：新出现的思考段/正文段正是"刚开始吐的东西"。
 * 而**旧节点**不会被少显示 —— 渲染侧只截断最后一个节点（见 `trimTailToShown`），
 * 所以"还欠着字就被工具卡顶掉"的那段仍会整段显示出来（宁可整段出现，不能丢内容）。
 */
export function advanceTailTyping(
  state: TailTypingState,
  target: { key: string; text: string } | null,
  now: number,
  t: TypingTuning = THINK_TYPING,
): TailTypingState {
  if (!target) { return IDLE_TAIL_TYPING; }
  const base = (state.key === target.key && target.text.startsWith(state.shown))
    ? state
    : { key: target.key, shown: "", lastAt: 0 };
  const next = advanceTypingShown(base.shown, target.text, base.lastAt, now, t);
  return { key: target.key, shown: next.shown, lastAt: next.lastAt };
}

/**
 * 尾巴那条缓冲**还有字没吐完吗** —— 调用方据此决定要不要再排一帧（rAF 自续）。
 *
 * ⚠️ 这条自续**必须独立于正文那条**（正文那条带 `!gated`：关闸期故意不推进）。
 *   若只靠正文的自续条件，症状是：正文已追平（或正在关闸）⇒ rAF 停 ⇒ 思考那条缓冲**冻住**
 *   ⇒ 因为渲染侧仍在 `trimTailToShown` 截断，用户看到的是"思考尾巴停在一半、少了一截"
 *   （要等下一个 reasoning chunk 才继续）。那是**内容看起来丢了**，比"吐得慢"严重得多。
 *
 * `key` 不同也算有积压 —— 换了节点就意味着要从头吐这一段。
 */
export function tailTypingHasBacklog(state: TailTypingState, steps: readonly TypingTailStep[]): boolean {
  const t = tailTypingTarget(steps);
  if (!t) { return false; }
  if (state.key !== t.key) { return t.text.length > 0; }
  return state.shown.length < t.text.length;
}

/**
 * 按显示缓冲**截断**最后一节点 —— 这是把"打字机"接到渲染上的唯一接口。
 *
 * 三种情况**原样返回**（保持数组引用，React 据此 bail out）：
 *   · 没有节点 / 末位不是文本节点（工具卡之类，不参与逐字）；
 *   · `shown` 已经等于全文（没什么可截的）；
 *   · `text` **不是**以 `shown` 开头（形态对不上：恢复/重建过后内容变了）
 *     —— 这时**整段显示**。宁可多显示，也不能显示一段错位的切片。
 *
 * ⚠️ 只动**最后一个**节点：前面的节点一律按真源全量渲染。这条保证了"内容不丢"
 *   （见 `advanceTailTyping` 的说明）。
 */
export function trimTailToShown<T extends TypingTailStep>(steps: readonly T[], shown: string): readonly T[] {
  if (!Array.isArray(steps) || steps.length === 0) { return steps; }
  const i = steps.length - 1;
  const last = steps[i];
  if (!last || (last.kind !== "think" && last.kind !== "body")) { return steps; }
  const text = last.text ?? "";
  if (typeof shown !== "string" || text === shown || !text.startsWith(shown)) { return steps; }
  return [...steps.slice(0, i), { ...last, text: shown }];
}
