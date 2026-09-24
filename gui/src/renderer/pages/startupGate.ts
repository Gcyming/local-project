/**
 * gui/src/renderer/pages/startupGate.ts — 启动门「会话内容」判据（A-1059②）。
 *
 * 纯模块：不含 JSX、不碰 DOM、不知道自己被谁调用 —— 便于单测与变异（项目铁律）。
 *
 * ## 它解决的是什么
 *
 * A-1058① 把「会话内容」并进了启动门的等待清单，但**门仍然会提前放行**：
 * `loadSessions()` 一回来就 `markFirstLoad("sessions")`，而那一刻
 * `selectedSessionId` 还是 `null`（默认选中第一个会话是在**另一趟** `conversations.list()`
 * 之后才 set 的）→ 自我收尾分支把 `chatHistory` 直接标成已加载 → 门打开。
 * 随后才发生：选中会话 → ChatPanel 挂载 → `conversations.load` → 历史到齐。
 * 用户看到的正是「加载界面消失了，中间那栏还要空一会儿才出内容」。
 *
 * ## 判据（顺序即优先级）
 *
 * 1. 会话列表还没加载 → **等**（此刻"有几个会话"根本不可知，任何结论都是猜的）
 * 2. 列表已加载且**确实为空** → 收尾（欢迎页，本来就没有会话内容可等）
 * 3. 「默认选中哪个会话」的决定还没落定 → **等**（用户在等的是内容，不是空态）
 * 4. 已选中一个存在的会话、且拿得到 agentId → **等**（由 ChatPanel 加载完历史后回执）
 * 5. 其余（选中了但拿不到 agentId → 落到那句占位文案）→ 收尾
 *
 * ⚠️ 第 5 条必须留在最后：它的判据是"**已经**确定了选中对象"，
 *    与第 3 条（还没确定）是两件事。把两者并成一支就是 A-1058① 的那个洞。
 */

/** 判据输入：全部来自渲染层已有状态，不引入新数据源 */
export interface HistoryGateInput {
  /** 会话列表是否已加载完成（`firstLoad.sessions`） */
  sessionsReady: boolean;
  /** 列表里的会话数量 */
  sessionCount: number;
  /**
   * 「默认选中哪个会话」的决定是否已落定。
   *
   * 注意语义是「**已经决定过了**」（哪怕决定的结果是"没有可选的会话"），
   * 不是「已经选中了」 —— 后者在没有任何会话时永远为假，会把门挂死到总超时。
   */
  selectionSettled: boolean;
  /** 当前是否已选中一个**在列表里真实存在**的会话 */
  hasSelectedSession: boolean;
  /** 选中的会话是否拿得到 agentId（拿不到 → ChatPanel 不挂载 → 占位文案） */
  hasAgentId: boolean;
}

export type HistoryGateDecision = "wait" | "self-finish";

/** 门该怎么判（见文件头注释的五条顺序） */
export function decideHistoryGate(input: HistoryGateInput): HistoryGateDecision {
  if (!input.sessionsReady) { return "wait"; }
  if (input.sessionCount === 0) { return "self-finish"; }
  if (!input.selectionSettled) { return "wait"; }
  if (input.hasSelectedSession && input.hasAgentId) { return "wait"; }
  return "self-finish";
}

/**
 * 历史加载「落定」后延迟若干帧再回执（带时间兜底，实现见下方 settleAfterFrames）。
 *
 * 为什么不能拿到数据就回执：`setMessages()` 只是**排了一次渲染**，
 * 消息要等 React 提交进 DOM、再等一帧布局稳定才真的出现在屏幕上。
 * 门如果在提交之前就打开，用户仍然会看到"加载界面消失了、中间还是空的"。
 *
 * 帧数默认 2：第 1 帧完成提交，第 2 帧布局/滚动稳定。
 */

/** 门内「会话内容」这一步默认等几帧（唯一出处，守卫按此断言） */
export const HISTORY_SETTLE_FRAMES = 2;

/** 帧等待的兜底上限（ms）：见 settleAfterFrames 的说明 */
export const SETTLE_FALLBACK_MS = 120;

/**
 * 等「若干帧」再回执，**但配一个时间兜底**。
 *
 * ⚠️ 为什么不能只等帧（A-1061 实测到的真实缺陷）：`requestAnimationFrame` 在
 * **窗口被遮挡 / 最小化 / 页面不可见**时会被浏览器暂停 —— 此时等帧的链条**永远不往下走**，
 * 回执永远不来，启动门只能枯等到总超时兜底，于是"加载界面在会话内容还没就绪时就结束了"。
 * （用户重启 slime 时窗口常不在前台，这不是罕见路径。）
 *
 * 语义：**两个条件哪个先到用哪个** —— 帧数够了（正常情况，≈2 帧 ≈33ms）或兜底时间到了。
 * `done` 保证只被调用一次。
 */
export function settleAfterFrames(
  frames: number,
  done: () => void,
  raf: (cb: () => void) => unknown = (cb) => window.requestAnimationFrame(cb),
  // 用 globalThis.setTimeout（浏览器与 node 都有）—— 测试环境可能没有 window
  schedule: (cb: () => void, ms: number) => unknown = (cb, ms) => globalThis.setTimeout(cb, ms),
): void {
  let finished = false;
  const finish = (): void => { if (!finished) { finished = true; done(); } };
  if (frames <= 0) { finish(); return; }
  // 时间兜底先挂上：帧回调不来时它负责收口
  schedule(finish, SETTLE_FALLBACK_MS);
  const step = (left: number): void => {
    if (left <= 0) { finish(); return; }
    raf(() => step(left - 1));
  };
  step(frames);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 「首屏是否就绪」的判据（A-1061 修正）。
 *
 * ## 原判据的结构性缺陷（用户原话："加载界面的会话内容还没有加载完，加载界面就结束了，
 * 你的检测是不是有问题啊"）
 *
 * 原式是 `uiReady = firstLoadGuard || 全部键到齐`。那个 `||` 让**总超时可以直接绕过内容这一步**
 * —— 8 秒一到，哪怕会话内容一个字都还没到，门也照开。它本意是防"某个数据源挂了把用户
 * 永久关在加载页"（这个诉求是正当的），但代价是：
 *   ① 内容没就绪也放行 → 用户看到"加载界面结束了、中间那栏还在转"；
 *   ② 放行**不留痕** → 事后无法判断当时到底在等什么，只能靠猜。
 *
 * ## 现在的判据：两组分开，各自有各自的兜底
 *
 * - **元数据组**（agents / sessions / providers / localModels）：8s 兜底。
 *   它们慢/失败的代价是"界面能用但某些面板不全"，不值得把用户耗在加载页。
 * - **内容组**（chatHistory）：**独立且更长的兜底**（用户明确说过"加载时间稍微长一点也没什么"）。
 *   它是用户一进来就要看的东西，必须真的就绪。
 *
 * 两组都满足才收门；哪一组是被兜底"强行放行"的，由 `forcedBy` **如实报出来**（不静默）。
 * ──────────────────────────────────────────────────────────────────────────── */

export interface UiReadyInput {
  /** 各项数据的登记表（键 → 是否已到齐） */
  firstLoad: Record<string, boolean>;
  /** 元数据组是否已被兜底放行 */
  metadataGuard: boolean;
  /** 内容组是否已被兜底放行 */
  contentGuard: boolean;
  /** 元数据组的键（唯一出处由调用方给，避免这里再抄一份） */
  metadataKeys: readonly string[];
  /** 内容组的键（同上） */
  contentKey: string;
}

export type UiReadyForcedBy = "none" | "metadata-timeout" | "content-timeout" | "both-timeout";

export interface UiReadyDecision {
  ready: boolean;
  /** 谁被兜底放行了（`none` = 正常到齐）。用于日志，不许静默 */
  forcedBy: UiReadyForcedBy;
  /** 收门时**仍未到齐**的键（正常到齐则为空）—— 这就是"当时在等什么"的直接证据 */
  missing: string[];
}

/** 首屏就绪判据（见上方注释） */
export function decideUiReady(i: UiReadyInput): UiReadyDecision {
  const metadataMissing = i.metadataKeys.filter((k) => !i.firstLoad[k]);
  const contentMissing = !i.firstLoad[i.contentKey];
  const metadataOk = metadataMissing.length === 0 || i.metadataGuard;
  const contentOk = !contentMissing || i.contentGuard;
  const missing = [...metadataMissing, ...(contentMissing ? [i.contentKey] : [])];
  let forcedBy: UiReadyForcedBy = "none";
  if (metadataOk && contentOk && missing.length > 0) {
    const mdForced = metadataMissing.length > 0;
    const ctForced = contentMissing;
    forcedBy = mdForced && ctForced ? "both-timeout" : mdForced ? "metadata-timeout" : "content-timeout";
  }
  return { ready: metadataOk && contentOk, forcedBy, missing };
}

