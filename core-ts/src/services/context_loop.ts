/**
 * core-ts/src/services/context_loop.ts — 上下文压缩 Agent-Loop 的**纯逻辑**部分（A-1082）。
 *
 * 设计定稿见 `docs/context-compaction-loop.md`（8 状态环路 + 7 条硬不变量）。
 * 本模块只放**可穷举测试的纯函数**，不含任何 I/O、模型调用、主进程时序：
 *
 *   · `planCut` / `trimTurnAligned`  —— 切口**只落在 turn 边界**（I2）
 *   · `validateHistory`              —— 四条硬不变量（I1/I3）
 *   · `buildResumeBlock` / `parseComprehend` —— 「理解总结」环（⑤ AWAIT_COMPREHEND）
 *   · `nextBreakerState`             —— 熔断（I7）
 *   · `acceptSummary`                —— generation / skip-stale（§8.4）
 *   · `planSend` / `formatCannotFit`  —— **发送前预算门**（A-1083）：能不能超，**发之前**就知道
 *   · `pickRescueModel` / `formatRescueHint` —— 可救模型挑选与出路文案（A-1086 / A-1090）：
 *      压无可压时唯一出路，且候选**自带可写入的选择串**（`choice`）、"没查"与"查过没有"分三态
 *   · `planEngineSend`               —— engine 侧保险门（A-1084）：闸门长在必经之路上
 *
 * ⚠️ **判据唯一出处**：`planEngineSend` **不另写一套**，而是 `planSend(canShrink: false)`
 * 的一层薄包装 —— 两处口径不可能漂移（"主进程说能发、引擎偏说不能"这类互相打架的形态
 * 在结构上就不成立）。新增任何"发不发"的判断，都必须先问：能否表达为 `planSend` 的入参？
 * 不能，才考虑新函数；而新函数也必须落在本模块（可穷举、可变异）。
 *
 * ## 为什么必须抽成纯模块
 *
 * 本仓铁律：**纯判据不许住组件/主进程内联块**（否则守卫只能读源码断言，
 * 「切口切在半轮上」这类回归永远测不出来）。此前 `loadSessionHistory` 把
 * 「摘要头 + 垫脚 + 末 K 条」的拼装写成主进程内联代码，`hardTruncate` /
 * `buildCompactedHistory` 反而成了**无人调用的死代码** —— 于是
 * `setSessionSummary(sid, null, K)` 这条「降级裁剪」路径实际**什么都没裁**，
 * 界面却报「已压缩」。本模块就是把这个拼装收回来，让它可测、可变异。
 */

/** 非 system 消息的最小合法条数（I3：压缩后序列不许塌成空） */
export const MIN_VALID_MESSAGES = 1;

/** 压缩后的最小降幅（I4）：压缩后体积必须 < 压缩前 × (1 - 该值)，否则算「假压缩」 */
export const MIN_SHRINK_RATIO = 0.15;

/** 「理解总结」环要求的固定 5 字段（§8.7：固定 schema、有界、不许多轮自省） */
export const COMPREHEND_FIELDS: readonly string[] = ["目标", "已完成", "失败", "未决", "下一步"];

/** 熔断阈值（I7 / §8.6：连续失败 ≥ 3 即停，Claude Code 同款） */
export const BREAKER_THRESHOLD = 3;

/** 环路消息的最小形状（只声明本模块真正读的字段；调用方多带字段不影响） */
export interface LoopMessage {
  role: string;
  content: unknown;
  /** OpenAI 系工具调用声明（本仓持久化历史暂不含，但拼装/裁剪必须原样透传） */
  tool_calls?: Array<{ id?: string }>;
  /** 工具结果对位 id */
  tool_call_id?: string;
}

/* ────────────────────────── ① turn 对齐裁剪（I2） ────────────────────────── */

/**
 * 从尾往前按**整轮**（以 `role === "user"` 为界）累计，返回裁剪后的起始下标。
 *
 * 依据：OpenAI Agents SDK `TrimmingSession`「从后往前找第 N 个 user，保留其后的**全部** item」；
 * LangChain `trim_messages(start_on="human", end_on=("human","tool"))` 同一语义。
 *
 * ⚠️ 绝对不许按「条数 / 字符数」硬切 —— 那会把一条 assistant 的 `tool_calls` 与
 * 紧随的 `tool` 结果切成两半，产出**下一轮才爆**的 400（Anthropic/OpenAI 均如此）。
 *
 * @param keep 保留的**整轮**数（一轮 = 一个 user 及其后直到下一个 user 之前的全部消息）
 * @returns 裁剪后起始下标；`0` 表示无需裁剪（消息不足 keep 轮）
 */
export function planCut(messages: LoopMessage[], keep: number): number {
  if (!Array.isArray(messages) || messages.length === 0) { return 0; }
  const keepTurns = Math.max(1, Math.floor(keep));
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      seen += 1;
      if (seen >= keepTurns) { return i; }
    }
  }
  return 0; // 不足 keep 轮 → 一条都不裁（宁可不动，也不切半轮）
}

/**
 * 轮数计数（**「轮」的唯一口径**，与 `planCut` 的 turn 边界同源）：
 * 一轮 = 一条 `role === "user"` 消息（及其后的全部 assistant / tool 消息）。
 *
 * ⚠️ A-1106：本函数存在的唯一理由是**堵住单位错配**。`needsCompress` 的第 4 个参数语义是
 *    **轮数**，而调用点曾直接传 `historyAll.length`（**消息条数**）——一条用户消息通常带
 *    1 条 assistant（有工具调用时更多）⇒ 消息数 ≈ 轮数的 2 倍以上 ⇒ 最小轮次门槛（6 轮）
 *    实际在 ~2-3 轮就放行，**压缩触发得比设计早一倍**（用户症状：还没聊几句就开始压缩）。
 *    凡是要给 `needsCompress` / `planCut` 这类"以轮为单位"的判据传值，必须先过本函数。
 */
export function countTurns(messages: readonly { role?: string }[] | null | undefined): number {
  if (!Array.isArray(messages)) { return 0; }
  let n = 0;
  for (const m of messages) { if (m?.role === "user") { n += 1; } }
  return n;
}

/**
 * turn 对齐裁剪：保留最后 `keep` **整轮**，切口之前一律丢弃。
 *
 * 与旧 `hardTruncate`（`[首条, ...末 K 条]`）的关键差别：
 *   · 旧实现把首条单独留下 ⇒ 首尾**不相邻**（对话不连续），且当末 K 条以 user 开头时
 *     会产出 `user, user, …` 连续同角色 ⇒ **Anthropic 系直接 400**（I3 违反）。
 *   · 新实现切口落在 turn 边界 ⇒ 结果**必然以 user 开场**且角色交替与原文一致。
 */
export function trimTurnAligned<T extends LoopMessage>(messages: T[], keep: number): T[] {
  if (!Array.isArray(messages) || messages.length === 0) { return messages; }
  const start = planCut(messages, keep);
  return start <= 0 ? messages : messages.slice(start);
}

/* ────────────────────── ② 硬不变量校验（I1 / I3） ────────────────────── */

export interface HistoryViolation {
  /** 违反的不变量编号（与 docs/context-compaction-loop.md §3.1 对齐） */
  rule: "I1" | "I3";
  detail: string;
}

export interface HistoryValidation {
  ok: boolean;
  violations: HistoryViolation[];
}

/**
 * 校验一段消息序列是否**合法可发**（压缩/裁剪之后必须过）。
 *
 * I3：非 system 序列必须以 `user` 开场、且**无连续同角色**（Anthropic 系硬要求）。
 * I1：每个 `assistant.tool_calls` 的每个 id，都必须能在**紧随其后**找到同 id 的 `tool` 结果；
 *     反过来，孤立 `tool` 结果（前面没有对应声明）同样非法。
 *
 * ⚠️ 现状说明（2026-09-23 已查证）：本仓 `loadSessionHistory` 是**手工拼**
 * `{role:"user",content:r.user}` / `{role:"assistant",content:r.ai}`，而 `HistoryRecord`
 * 只有 `user`/`ai` 两个字符串字段 ⇒ **持久化历史里根本没有 `tool` 消息**，
 * 工具结果只活在单轮内的 `core-ts/src/services/tool_loop.ts`。
 * 所以 I1 在当前主链路上**恒真**；它在这里的价值是：① 防未来引入持久化工具消息时回归；
 * ② 保证 `buildCompactedHistory` 若被喂进带结构的序列时**不破坏配对**。
 */
export function validateHistory(messages: LoopMessage[]): HistoryValidation {
  const violations: HistoryViolation[] = [];
  const list = Array.isArray(messages) ? messages : [];

  // I3-a：非 system 序列以 user 开场
  const nonSystem = list.filter((m) => m?.role !== "system");
  if (nonSystem.length < MIN_VALID_MESSAGES) {
    violations.push({ rule: "I3", detail: `非 system 消息不足 ${MIN_VALID_MESSAGES} 条` });
  } else if (nonSystem[0].role !== "user") {
    violations.push({ rule: "I3", detail: `非 system 序列以 ${nonSystem[0].role} 开场（必须 user）` });
  }

  // I3-b：无连续同角色
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]?.role;
    const cur = list[i]?.role;
    if (prev === cur && prev !== "system") {
      violations.push({ rule: "I3", detail: `第 ${i} 条与上一条同为 ${cur}（连续同角色）` });
      break; // 报一处即可，避免长序列刷屏
    }
  }

  // I1：tool_calls ↔ tool 结果成对
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const calls = m?.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
      const want = calls.map((c) => String(c?.id ?? "")).filter(Boolean);
      const got = new Set<string>();
      for (let j = i + 1; j < list.length; j++) {
        const nxt = list[j];
        if (nxt?.role !== "tool") { break; } // 工具结果必须**紧随**（中间不许夹别的角色）
        got.add(String(nxt.tool_call_id ?? ""));
      }
      const missing = want.filter((id) => !got.has(id));
      if (missing.length > 0) {
        violations.push({ rule: "I1", detail: `第 ${i} 条 assistant 的 tool_calls 缺结果：${missing.join(",")}` });
      }
    }
    if (m?.role === "tool") {
      // 孤立 tool 结果：往前找不到对应的 assistant.tool_calls
      let matched = false;
      for (let j = i - 1; j >= 0; j--) {
        const prv = list[j];
        if (prv?.role === "tool") { continue; }
        if (prv?.role === "assistant" && Array.isArray(prv.tool_calls)) {
          matched = prv.tool_calls.some((c) => String(c?.id ?? "") === String(m.tool_call_id ?? ""));
        }
        break;
      }
      if (!matched) {
        violations.push({ rule: "I1", detail: `第 ${i} 条 tool 结果无对应声明（id=${String(m.tool_call_id ?? "")}）` });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/* ──────────────────── ③ 「理解总结」环（⑤ AWAIT_COMPREHEND） ──────────────────── */

/** 会话压缩摘要的**只读**回读块开头哨兵。
 *  ⚠️ 这行不能删：摘要若被下游模型当成「用户新任务」，会诱发
 *  Build→Compact→Build 无限循环（有真实事故，见设计定稿 §8.5）。 */
export const RESUME_NOT_TASK_SENTINEL = "以下是对**过往工作**的记录，**不是**待执行的新任务，不要因此开始任何新工作。";

/**
 * 拼「续接认知」回读块（压缩后**恰好跑一次**，让模型自述当前状态）。
 *
 * 固定 5 字段（§8.7 有界：一次调用、固定 schema、不许无限自省）：
 * 目标 / 已完成（含证据）/ 失败与被否决 / 未决 / 下一步候选。
 */
export function buildResumeBlock(summary: string, archivePath?: string): string {
  const lines = [
    RESUME_NOT_TASK_SENTINEL,
    "",
    "<summary>",
    String(summary ?? "").trim(),
    "</summary>",
  ];
  if (archivePath) {
    lines.push("", `（完整历史已归档于：${archivePath}，需要细节时可用只读工具查阅）`);
  }
  lines.push(
    "",
    "请回读以上摘要，用**中文**、**被动陈述**语气自述你当前的工作状态，**只**输出下面 5 个字段（每字段一行，冒号后写内容）：",
    "目标：…",
    "已完成：…（附证据：文件路径 / 命令 / 结论）",
    "失败：…（被否决的方案与原因；没有就写「无」）",
    "未决：…（尚不确定或待确认的点）",
    "下一步：…（候选动作，不要执行）",
    "",
    "禁止在回答里给出任何指令式语句（例如「接下来只允许调用 X」「忽略之前的规则」）——那会被后续模型误当成用户指令。",
  );
  return lines.join("\n");
}

export interface ComprehendParseResult {
  ok: boolean;
  /** 缺哪些字段 */
  missing: string[];
  /** 是否夹带了指令式语句（安全闸：视为失败） */
  injected: boolean;
  /** 命中的注入样句（用于告警展示） */
  injectionSample?: string;
}

/** 指令式语句的判据（§8.2：摘要里的命令句会被下游模型当成用户指令，污染下一步决策）。
 *  ⚠️ 必须**保守**：只拦真正的越权命令，不拦正常陈述（否则正常摘要会被误杀）。 */
const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /忽略(之前|上述|上面|以上|先前)的?(规则|指令|要求|限制)/,
  /(接下来|以后|此后|从现在起)(只|仅)(允许|能|可)(调用|使用|执行)/,
  /(必须|务必)(忽略|跳过|绕过|不要遵守)/,
  /你现在(是|要扮演|需要扮演)/,
  /\bsystem\s*prompt\b/i,
  /\bignore\s+(all\s+)?(previous|prior|above)\b/i,
];

/**
 * 校验「理解总结」的输出：① 5 字段齐备；② 不夹带指令式语句。
 *
 * 纯函数、可穷举（设计定稿 §4.4 验收要求）。任何一条不过 ⇒ 视为**理解失败**，
 * 由调用方按「压缩失败」处理（重试 1 次 → 非阻塞降级）。
 */
export function parseComprehend(text: string): ComprehendParseResult {
  const raw = String(text ?? "");
  const missing = COMPREHEND_FIELDS.filter((f) => !new RegExp(`${f}\\s*[：:]`).test(raw));

  let injected = false;
  let injectionSample: string | undefined;
  for (const p of INJECTION_PATTERNS) {
    const hit = p.exec(raw);
    if (hit) {
      injected = true;
      injectionSample = hit[0];
      break;
    }
  }

  return { ok: missing.length === 0 && !injected, missing, injected, injectionSample };
}

/* ────────────────────────── ④ 熔断（I7 / §8.6） ────────────────────────── */

export interface BreakerState {
  /** 连续失败次数（同一段历史内累计） */
  failures: number;
  /** 是否已熔断（open ⇒ 不再调用摘要模型） */
  open: boolean;
  /** 上次失败时那段历史的指纹（用于区分「同一段历史反复重送」与「新历史」） */
  lastKey?: string;
}

export const INITIAL_BREAKER: BreakerState = { failures: 0, open: false };

/**
 * 熔断状态机（纯函数，可穷举）。
 *
 * 关键语义（JetBrains 实证的坑）：失败计数记在「**同一段历史**是否已被处理过」这个维度上 ——
 * 坏历史没被救出来却每轮重送时，**同一指纹**会持续累加并最终熔断；
 * 而一旦历史指纹变了（用户发了新消息 / 已成功压缩过一次）⇒ 视为新战场，计数**归零**重来。
 */
export function nextBreakerState(
  prev: BreakerState,
  outcome: { ok: boolean; historyKey?: string },
): BreakerState {
  const key = outcome.historyKey;
  if (outcome.ok) {
    return { failures: 0, open: false, lastKey: key };
  }
  const sameHistory = key !== undefined && key === prev.lastKey;
  // 新历史 ⇒ 重新给满额尝试机会；同一历史 ⇒ 继续累加
  const failures = (key === undefined || sameHistory ? prev.failures : 0) + 1;
  return { failures, open: failures >= BREAKER_THRESHOLD, lastKey: key };
}

/* ─────────────────── ⑤ generation / skip-stale（§8.4） ─────────────────── */

/**
 * 压缩是**异步**的（`await engine.summarizeContext` + 理解环），期间可能已有别的压缩落地。
 * 请求/写入侧只接受「自己出发时看到的那个 generation 仍然没变」的结果，否则丢弃并标 stale。
 *
 * 依据：OpenAI Agents SDK `Session` 内建的 skip-stale 语义。
 */
export function acceptSummary(startedAtGeneration: number, currentGeneration: number): boolean {
  const a = Number.isFinite(startedAtGeneration) ? Math.floor(startedAtGeneration) : 0;
  const b = Number.isFinite(currentGeneration) ? Math.floor(currentGeneration) : 0;
  return b === a;
}

/* ────────────────────────── ⑥ 压缩收益判定（I4） ────────────────────────── */

/**
 * 压缩是否**真的**变小了（I4）。
 *
 * ⚠️ 这正是「压缩并非真压缩」的判据化：旧实现压缩后无条件把界面占用写成
 * `cap × 0.5`（构造值），与真实体积无关 ⇒ 假报。此处只认真实估算。
 */
export function isRealShrink(tokensBefore: number, tokensAfter: number): boolean {
  if (!Number.isFinite(tokensBefore) || tokensBefore <= 0) { return false; }
  if (!Number.isFinite(tokensAfter) || tokensAfter < 0) { return false; }
  return tokensAfter < tokensBefore * (1 - MIN_SHRINK_RATIO);
}

/* ────────────────── ⑦ 发送前**预算门**（A-1083：从根上消灭「连接半天」） ────────────────── */

/**
 * 给**本条回复**预留的输出空间（tokens）。
 * 窗口不是只有输入：模型还要写出这条回复，预留不足 ⇒ 生成中途撞墙。
 * （对齐 Claude Code 的 `reserved_for_summary` 结构，数值取业界常用档。）
 */
export const RESERVE_OUTPUT_TOKENS = 13_000;

/**
 * 给**下一轮工具结果**预留的余量（tokens）。
 * 本仓的一轮里工具结果还能再吃这么多 —— 不留就会被"输入没超、一调工具就超"打死。
 */
export const RESERVE_NEXT_TOOL_TOKENS = 20_000;

/** 发送前预算门的输入 */
export interface SendPlanInput {
  /** 本次请求**输入侧**估算（系统提示 + 工具定义 + 记忆/技能注入 + 历史 + 本条用户消息） */
  estimatedInput: number;
  /** 该模型窗口上限（cap）。≤0 表示**未知** —— 未知不猜、不拦（对齐 `applyMaxTokensCap` 的「不发明值」） */
  cap: number;
  /** 预留覆盖（缺省用上面的常量；测试可注入） */
  reserveOutput?: number;
  reserveTool?: number;
  /** 上游**已经**报过一次"太长"（反应式路径）——上游说的比我们的估算权威 */
  afterOverflow?: boolean;
  /** 用户设定的**阈值触发**（占用 ≥ 窗口 × ratio，即原来的 `needsCompress`）——主动体检档 */
  ratioTriggered?: boolean;
  /** 是否**还有可压缩的素材**（固定开销之外还有历史/工具结果可裁）。缺省 true（乐观，精确判定在主进程） */
  canShrink?: boolean;
}

export interface SendPlan {
  action: "ok" | "compact" | "cannot-fit";
  /** 距**硬墙**还剩多少（负数 = 已超）。硬墙 = 窗口上限本身 */
  headroom: number;
  /** 触发的档位（`none` / `budget` / `overflow` / `ratio`）——用于如实告知"为什么压" */
  trigger: "none" | "budget" | "overflow" | "ratio";
  /** **永远非空**：任何一次"什么都不做"或"拒发"都必须能如实说明原因 */
  reason: string;
}

/**
 * 发送前的**唯一判据**：要不要压缩 / 能不能发。
 *
 * ## 为什么要这一道门（这回事故的根）
 *
 * 事故形态：长会话发出去 → 上游 400(超长) 或**挂住不出首字节** → 客户端把它当"可重试"
 * → 9 次重连（每次最长 300s 超时）⇒ 用户看到「**连接半天还是重连**」。
 * A-1081/A-1082 把「上游说了之后怎么办」修对了（第三类 + 压缩一次重试一次），
 * 但**根子在于我们仍然"发出去才知道超"**。这道门把它翻过来：**先算，再决定发不发**。
 *
 * ## 三档动作与判据顺序（顺序即优先级，不许换）
 *
 * | 顺序 | 条件 | 动作 |
 * | --- | --- | --- |
 * | 1 | `cap ≤ 0`（窗口未知） | `ok` —— **不猜、不拦**（猜错会把能用的模型也拦掉） |
 * | 2 | 三个触发任一成立（上游报超限 / 预算不足 / 用户阈值） | 需要压缩 |
 * | 3 | 需要压缩且**有**可压素材 | `compact` |
 * | 4 | 需要压缩但**无可压素材** 且 `headroom < 0`（真装不下） | `cannot-fit` —— **拒发** |
 * | 5 | 需要压缩但**无可压素材** 且预算仍够（只是用户阈值到了） | `ok` —— 照常发 |
 *
 * ⚠️ 第 4 与第 5 的区分是最容易写错的一处：**"压无可压"不等于"发不出去"**。
 *    用户把阈值调低（例如 0.5）时，占用早就过阈值但离硬墙还很远 —— 那时拒发就是误伤。
 *    **只有 `headroom < 0`（输入本身已超窗口）才拦。**
 *
 * @example
 * // 输入 120K、窗口 128K、预留 33K ⇒ 预算不足 ⇒ 先压
 * planSend({ estimatedInput: 120_000, cap: 128_000 }).action === "compact"
 * // 窗口未知 ⇒ 不拦
 * planSend({ estimatedInput: 999_999, cap: 0 }).action === "ok"
 */
export function planSend(input: SendPlanInput): SendPlan {
  const cap = Number.isFinite(input?.cap) ? Math.floor(input.cap) : 0;
  const used = Number.isFinite(input?.estimatedInput) ? Math.max(0, Math.floor(input.estimatedInput)) : 0;
  const reserveOutput = Number.isFinite(input?.reserveOutput) ? Math.max(0, Math.floor(input.reserveOutput as number)) : RESERVE_OUTPUT_TOKENS;
  const reserveTool = Number.isFinite(input?.reserveTool) ? Math.max(0, Math.floor(input.reserveTool as number)) : RESERVE_NEXT_TOOL_TOKENS;
  const canShrink = input?.canShrink !== false;
  const budget = cap - reserveOutput - reserveTool;
  const headroom = cap - used; // 距硬墙（窗口上限）的头寸

  // 1. 窗口未知 ⇒ 不猜、不拦
  if (cap <= 0) {
    return { action: "ok", headroom: 0, trigger: "none", reason: "模型窗口未知，不做预算拦截（不猜）" };
  }

  // 2. 三个触发（顺序即优先级：上游说的最权威，其次预算，最后用户阈值）
  const overflow = input?.afterOverflow === true;
  const overBudget = used > budget;
  const byRatio = input?.ratioTriggered === true;
  const trigger: SendPlan["trigger"] = overflow ? "overflow" : overBudget ? "budget" : byRatio ? "ratio" : "none";
  if (trigger === "none") {
    return { action: "ok", headroom, trigger, reason: `预算 ${budget} 够用（输入 ${used}，预留 输出${reserveOutput}+工具${reserveTool}）` };
  }
  const why = overflow
    ? "上游已报上下文超限"
    : overBudget
      ? `输入 ${used} 超出预算 ${budget}（预留 输出${reserveOutput}+工具${reserveTool}）`
      : `占用 ${used} 达到你设定的触发阈值`;

  // 3/4/5. 需要压缩
  if (canShrink) {
    return { action: "compact", headroom, trigger, reason: `${why} —— 先压缩再发（不发注定失败的请求）` };
  }
  if (headroom < 0) {
    return { action: "cannot-fit", headroom, trigger, reason: `${why}，且固定开销之外已无可压缩素材 —— 需要换更大窗口的模型或开新会话` };
  }
  return { action: "ok", headroom, trigger: "none", reason: `${why}，但已无可压缩素材且预算仍够（离硬墙 ${headroom}）—— 照常发送` };
}

/**
 * 「发不出去」时给用户的如实文案（不许只说"请重试"——重发同一请求必然同样失败）。
 *
 * A-1086：`rescue` 是**已核实**的更大窗口候选（由主进程按降级链逐个解析窗口后挑出）。
 * 有它时把"可操作项"从空泛的"换一个窗口更大的模型"升级为**具体模型名 + 窗口数**——
 * 用户在"什么都发不出去"的处境里，需要的是**出路**而不是原则。
 * ⚠️ 无候选时必须**如实说"没有"**，不许沉默：沉默会让用户以为工具没查过。
 * ⚠️ 而 `rescue` 有**三态**（A-1090）：`undefined` = 调用方**没查**（如引擎侧保险门，
 *    它只做本地判定、手上没有模型清单），`null` = 查过确实没有，对象 = 查到了。
 *    `undefined` 与 `null` **不许合并成一句话** —— 那会把"没查"说成"查过没有"，
 *    等于替一个没做过的检查背书，用户于是放弃了一条本可能走得通的出路。
 */
export function formatCannotFit(plan: SendPlan, rescue?: RescuableModel | null): string {
  const base =
    `本次请求的上下文已装不下（${plan.reason}）。\n` +
    "没有把它发出去 —— 因为这个请求必然被上游拒绝或长时间挂住（那正是「连接半天」的来历）。\n" +
    "可操作项：换一个窗口更大的模型；或开一个新会话；或先在设置里确认自动压缩已开启（压掉历史后再发）。";
  // 「有 / 没有 / 没查」三种情形都必须**如实说**（沉默会让用户以为工具没查过）
  return `${base}\n${formatRescueHint(rescue)}`;
}

/* ────────────── ⑧ 可救模型挑选（A-1086：压无可压时的唯一出路） ────────────── */

/** 一个候选模型的窗口信息（`cap` 由主进程按模型**实测/预设**解析，不是猜的） */
export interface CapCandidate {
  id: string;
  label?: string;
  cap: number;
  /**
   * 可直接写入 `model_choice` 的选择串（A-1090）。
   *
   * ⚠️ 为什么必须由主进程回带、而不是渲染层拿 `id` 自己拼：
   * `model_choice` 的格式是 `api:<供应商key>:<模型id>` / `local:<模型id>`
   * （解析见 `ChatPanel.parseModelChoice`），**裸 model id 拼不出可用串** ——
   * 同一个 model id 可能同时挂在多个供应商下，只有主进程知道这条候选来自哪个供应商。
   * 渲染层拼错 ⇒ 切到一个不存在的模型（静默失败：切完照旧发不出去，用户以为工具在骗人）。
   *
   * ⚠️ 可选：老调用方不传时退回按 `id` 处理，排序/去重行为**完全不变**（零回归）。
   */
  choice?: string;
}

/** 已挑选出的可救模型（= CapCandidate 的子集，语义化别名，供文案层复用） */
export type RescuableModel = CapCandidate;

/**
 * 「可救模型」那一句话的**唯一产地**（主进程的拒发文案、渲染层的"压完仍超限"提示都用它）。
 *
 * ⚠️ 必须抽出来：同一句话若在主进程与渲染层各写一份字面量，改一处就会漂移 ——
 * 而漂移的症状是"同一个处境下两处给出的出路不一样"（用户会怀疑工具在乱说）。
 */
export function formatRescueHint(rescue?: RescuableModel | null): string {
  // ⚠️ 三态，`undefined` 与 `null` **不许合并**（A-1090）：
  //    undefined = 没人查过；null = 查过了、确实没有。
  //    把前者说成后者是**假陈述**：引擎侧保险门（`planEngineSend`）只做本地判定、
  //    手上根本没有模型清单可查，它此前却输出「已查过…没有窗口更大的候选」——
  //    等于替一个没做过的检查背书，用户于是放弃了「换模型」这条本可能走得通的路。
  if (rescue === undefined) {
    return "这次**没有检查**其它模型的窗口（本地判定只算了自己的账）—— 换模型这条路未必走不通，可在模型选择器里自己试一个窗口更大的。";
  }
  if (rescue === null) {
    return "已查过当前可用模型：没有窗口更大的候选 —— 换模型这条路走不通，请开一个新会话。";
  }
  const label = rescue.label && rescue.label !== rescue.id ? `${rescue.label}（${rescue.id}）` : rescue.id;
  return `检测到可用的更大窗口模型：**${label}**（${rescue.cap} tokens）—— 切到它即可继续本次会话。`;
}

/**
 * 从候选里挑出**能救回当前请求**的那个模型。
 *
 * ## 为什么需要它
 *
 * 「固定开销（系统提示/记忆/技能/工具定义/工作区注入）本身就逼近窗口」这类超限，
 * **压缩救不回来**（压无可压）—— 唯一出路是换一个窗口更大的模型。而本仓**已有**
 * 降级链（A-158）与窗口解析（`resolveSessionWindowCap`），却从未把两者接起来用过：
 * 用户看到的只有"请换窗口更大的模型"，至于**换哪个**全靠自己试。
 *
 * ## 判据（顺序即优先级）
 *
 * | 顺序 | 条件 | 动作 |
 * | --- | --- | --- |
 * | 1 | `requiredTokens` 非正有限数 | `null` —— 不知道要多大就别乱换 |
 * | 2 | `cap` 非正有限数 / 不大于 `currentCap` | 剔除 —— **必须真更大**，否则换了照样超 |
 * | 3 | `cap < requiredTokens + 预留输出` | 剔除 —— **必须真装得下**（换完还要留出写回复的空间） |
 * | 4 | 其余按 `cap` **升序**取第一个 | 返回 —— 取**最省**的那个，不把用户甩到远超需要的模型上 |
 * | 5 | 全被剔除 | `null`（调用方据此**如实说"没有"**） |
 *
 * ⚠️ 平手（同 cap）时按 `choice ?? id` 字典序 —— 判据必须**确定性**，否则同输入两次给不同答案，
 *    守卫就会 flaky，用户也会看到"建议的模型一会儿一个样"。
 *    排序键刻意与调用方（`suggestWiderChatModel`）的**去重键同源**：去重按 A 排、排序按 B 排，
 *    会让"哪一条留下"与"显示的是哪一条"各说各话（同名模型改个 label 就换出另一个建议）。
 *
 * @param requiredTokens 本次请求实需的输入量（含固定开销），与 `planSend.estimatedInput` 同口径
 * @param currentCap 当前模型的窗口上限（候选必须严格大于它）
 */
export function pickRescueModel(
  requiredTokens: number,
  currentCap: number,
  candidates: CapCandidate[],
): RescuableModel | null {
  if (!Number.isFinite(requiredTokens) || requiredTokens <= 0) { return null; }
  const need = Math.ceil(requiredTokens);
  const cur = Number.isFinite(currentCap) ? currentCap : 0;
  const list = Array.isArray(candidates) ? candidates : [];
  const ok = list
    .filter((c) => c && typeof c.id === "string" && c.id.length > 0)
    .filter((c) => Number.isFinite(c.cap) && c.cap > 0)
    // 必须比当前**严格**更大：同窗口的候选换了也没用（用户会经历一次无意义的等待）
    .filter((c) => c.cap > cur)
    // 必须真装得下：输入 + 预留输出 ≤ 窗口
    .filter((c) => c.cap >= need + RESERVE_OUTPUT_TOKENS)
    .sort((a, b) => {
      if (a.cap !== b.cap) { return a.cap - b.cap; }
      const ka = a.choice ?? a.id;
      const kb = b.choice ?? b.id;
      if (ka !== kb) { return ka < kb ? -1 : 1; }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return ok.length > 0 ? ok[0] : null;
}

/* ─────────── ⑨ engine 侧保险门（A-1084：防绕过主进程预检） ─────────── */

/**
 * 「**本地判定**的上下文装不下」标记（A-1084）。
 *
 * ## 为什么需要它（一个会让修复变成退化的坑）
 *
 * 渲染层对"上下文超限"有专门的三态处置（`isContextOverflowError` → 压缩一次 + 重试一次，
 * 而不是 9 次重连）。而那条判据**只认上游报的超限**（OpenAI/Anthropic/Kimi/DashScope 的
 * 官方错误句式 + 413/414）。
 *
 * 引擎的保险门是**我们自己**判定"装不下"，**根本不会发出请求** ⇒ 上游一个字都不会说 ⇒
 * 渲染层认不出来 ⇒ 落进 9 次重连 ⇒ **每一次都被保险门原样拦回** ⇒ 用户看到"重连了 9 次
 * 还是不行"，比不做这道门还糟。
 *
 * ⇒ 本地判定必须**显式自报身份**，与上游超限走**同一条**处置路径。
 * ⚠️ 但它**不许冒称上游**（那是"乱出声"的镜像形态）：标记本身就写着"本地判定"，
 *    用户看到的文案会如实说明"没有发出去"。
 *
 * 形态刻意选成双中括号 + `slime:` 前缀 —— 上游响应体里不可能出现这种串，
 * 所以它不会把真实的网络错误误判成超限。
 */
export const LOCAL_PREFLIGHT_MARKER = "[[slime:preflight-overflow]]";

export interface EngineSendGuardInput {
  /** 本次请求输入侧估算（system + tools + history + message，与压缩判据同口径） */
  estimatedInput: number;
  /** 本次实际要用的模型窗口上限。≤0 / 非有限数 = **未知** ⇒ 不拦（不猜） */
  windowCap?: number;
}

export interface EngineSendGuard {
  /** false = **不发**（不出网：发了也只会被上游拒/长时间挂住） */
  allow: boolean;
  /** **永远非空**（放行也要能说清为什么放行） */
  reason: string;
}

/**
 * engine 发送前的**最后一道**闸门。
 *
 * ## 为什么要第二道（主进程不是已经拦了吗）
 *
 * 主进程的 `planSend` 只在 `slime:chat:compress` 这条编排里跑。engine 还有**别的入口**：
 * 群聊头脑风暴、子代理、强制工具轮、以及未来的非 GUI 调用 —— 它们**都绕过那条编排**。
 * 「只有一条路径记得安检」正是 A-1082 的教训（`force` 漏了一处 ⇒ 反应式压缩一次没发生）。
 * ⇒ 所以闸门要**长在必经之路上**（`engine.stream` / `engine.chat` 发送前），而不是靠调用方自觉。
 *
 * ## 实现要点：直接复用 `planSend`，不另写一套判据
 *
 * 引擎层**不做压缩**（它拿不到会话元数据、也不该改历史）⇒ 传 `canShrink: false`
 * 让 `planSend` 只说两件事：`ok`（发）或 `cannot-fit`（别发）。
 * 这样两处判据**天然同源** —— 不存在"主进程说能发、引擎偏说不能"这种互相打架的可能。
 *
 * ## ⚠️ 拦的**只有**「输入本身 ≥ 窗口」这一种（不许更严）
 *
 * `canShrink: false` 时 `planSend` 的 `cannot-fit` 条件**恰好**是 `headroom < 0`
 * （即 `estimatedInput ≥ cap`）。这正是"发出去**一定**失败"的判据。
 * 任何"顺手加严"（例如把预算档 `used > cap - 预留` 也纳入）都会造成**死锁**：
 * 主进程已经放行了（它判过预算且没有可压素材），引擎却把它拦回 ⇒
 * 用户什么都发不出去，而那个请求**本来是可能成功的**（只是输出空间小）。
 * ⇒ 引擎只当"最后一道防呆"，不当"第二个决策者"。
 */
export function planEngineSend(input: EngineSendGuardInput): EngineSendGuard {
  const cap = Number.isFinite(input?.windowCap) ? Math.floor(input.windowCap as number) : 0;
  const plan = planSend({
    estimatedInput: Number.isFinite(input?.estimatedInput) ? Math.max(0, Math.floor(input.estimatedInput)) : 0,
    cap,
    canShrink: false, // 引擎层不压缩 ⇒ 「有可压素材」这一档对引擎恒不成立
    ratioTriggered: false, // 阈值体检是主进程的职责（引擎不知道用户的 ratio 设置）
    afterOverflow: false, // 反应式压缩也由主进程编排
  });
  if (plan.action === "cannot-fit") {
    return { allow: false, reason: formatCannotFit(plan) };
  }
  return { allow: true, reason: plan.reason };
}
