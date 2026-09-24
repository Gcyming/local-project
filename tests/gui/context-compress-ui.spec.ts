/**
 * 守卫：上下文压缩闭环的**接线**（A-1082）—— 锁住「压缩并非真压缩」（用户原话）的根因。
 *
 * ## 本文件锁的真实缺陷（逐条都有代码证据）
 *
 * | # | 缺陷 | 判据 |
 * | --- | --- | --- |
 * | ① | `estimateHistoryTokens` 用 `字符/4` ⇒ CJK 4 倍低估 ⇒ 阈值形同虚设 | `context-compress.spec.ts` 的数值判据 |
 * | ② | 摘要轮输入超 9000 就 `return null` **放弃摘要** | 本文件锁 engine 不再有 `inputTokens >= cap` 早退 |
 * | ③ | 摘要不可用时 `setSessionSummary(sid, null, K)` **连 summaryCount 一起删** ⇒ `loadSessionHistory` 判假 ⇒ **返回完整未裁剪历史**：界面报「已压缩 N 轮」，请求一字未减 | 本文件锁 sessions 不再 `delete meta.summaryCount`、且 `loadSessionHistory` 有 `summaryCount !== undefined` 的只裁分支 |
 * | ④ | 渲染层 `ctxAnchorRef = cap × 0.5` —— 与真实体积**无关的构造值**（假报，且污染后续判定） | 本文件锁 ChatPanel 里不存在 `cap * 0.5`、且用 `res.tokensAfter` |
 * | ⑤ | `force` 只越过**渲染层**阈值，主进程再判一次 `needsCompress` ⇒ **一次也没压** | 本文件锁主进程 `if (!force && !needsCompress(` |
 *
 * ## ⚠️ 断言一律用 `has / hasNot` 包装
 *
 * 这些源文件动辄数千行，直接 `expect(SRC).toContain(x)` 在失败时会把**整个文件**灌进报告
 * （实测单条失败 300KB，日志无法阅读）。包装成布尔断言后失败只打一行。
 *
 * 变异：把任一条判据改回去，本文件必须变红（2026-09-23 已逐条手工验证）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** 读源码并剥掉注释 —— 判据只认**代码**，不认注释里提到的旧写法（否则守卫会被自己的说明文字满足） */
const strip = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const PANEL = strip("gui/src/renderer/pages/ChatPanel.tsx");
const MAIN = strip("gui/src/main/index.ts");
const SESSIONS = strip("core-ts/src/services/sessions.ts");
const ENGINE = strip("core-ts/src/services/engine.ts");
const IPC = strip("gui/src/shared/ipc.ts");

/** 必须**出现**（失败只打一行，不灌整个源文件） */
const has = (src: string, needle: string, why: string): void =>
  expect(src.includes(needle), `${why}｜缺少：${needle}`).toBe(true);
/** 必须**不出现** */
const hasNot = (src: string, needle: string, why: string): void =>
  expect(src.includes(needle), `${why}｜不该出现：${needle}`).toBe(false);
/** 正则判据 */
const matches = (src: string, re: RegExp, why: string): void =>
  expect(re.test(src), `${why}｜不匹配：${re}`).toBe(true);

describe("④ 去掉 `cap × 0.5` 假报，改实测回填（P1-7）", () => {
  it("🐛 ChatPanel 里**不许**再出现 `cap * 0.5` 这类构造值", () => {
    hasNot(PANEL, "cap * 0.5", "压缩后占用又被写成了「上限的一半」——与真实体积无关的假报");
    expect(/Math\.round\(res\.cap/.test(PANEL), "仍用 cap 构造占用值").toBe(false);
  });

  it("占用回落必须来自主进程实测回填的 `res.tokensAfter`", () => {
    has(PANEL, "res.tokensAfter", "没用实测值 ⇒ 占用数字又变成构造值");
    has(PANEL, "ctxAnchorRef.current = next;", "真值锚没有回落 ⇒ 圆环不会跟着降");
  });

  it("CompressResult 必须带 tokensAfter / stillOverflow / realShrink", () => {
    has(IPC, "tokensAfter?: number;", "契约缺 tokensAfter");
    has(IPC, "stillOverflow?: boolean;", "契约缺 stillOverflow");
    has(IPC, "realShrink?: boolean;", "契约缺 realShrink");
  });

  it("主进程必须**重新加载后实测**（不是拿压缩前的数字改一改）", () => {
    /* A-1085 迁移（**保留原意**：必须重新加载压缩后的历史，而不是拿压缩前的数字改一改）：
       那之后所有压缩路径的历史加载都带 `{ full: true }`（摘要必须覆盖**全部**历史），
       原锚点 `loadSessionHistory(sessionId)` 因此消失 —— 锚点演进而意图不变，故改判新形态。
       ⚠️ 变量名 `after` 必须一起带上：`{ full: true }` 在压缩前那次加载里也出现，
          只匹配它会让这条守卫退化成「只要有一处 full 就算过」（同族假绿）。 */
    has(MAIN, "const after = await loadSessionHistory(sessionId, { full: true });", "没有重新加载压缩后历史（且必须读全量，与压缩前同口径）⇒ tokensAfter 不可信");
    has(MAIN, "const tokensAfter = estimateHistoryTokens(after) + fixedOverhead;", "tokensAfter 没按「历史 + 固定开销」同口径算");
    has(MAIN, "const stillOverflow = cap > 0 && tokensAfter >= cap;", "没有「压完仍超限」判据");
  });
});

describe("③ 降级路径必须**真的裁**（「压缩并非真压缩」的直接形态）", () => {
  it("🐛 sessions 里 `summary` 为 null **不许**连带删掉 `summaryCount`", () => {
    hasNot(SESSIONS, "delete meta.summaryCount;", "summaryCount 被一起删了 ⇒ trim 档失效 ⇒ 返回完整历史");
    has(SESSIONS, "meta.summaryCount = Math.max(1, Math.floor(keep));", "任何一次压缩都必须落 K（与摘要是否成功无关）");
    // 反例自检：证明「删 contextSummary」这条**确实**在，否则上面那条断言可能是空转
    has(SESSIONS, "delete meta.contextSummary;", "summary 为 null 时仍应清掉过期摘要文本");
  });

  it("🐛 loadSessionHistory 的注入条件**不许**绑死在 `contextSummary` 上", () => {
    has(MAIN, "if (meta.summaryCount !== undefined && lines.length > keep * 2) {", "条件仍是 `meta.contextSummary && …` ⇒ 摘要不可用时判假、返回完整历史");
    has(MAIN, "return truncateTurnAligned(lines, keep);", "没有「只裁不摘要」的 trim 分支");
  });

  it("摘要档走纯函数拼装（含「理解总结」环的续接认知）", () => {
    has(MAIN, "buildCompactedHistory(meta.contextSummary, lines, keep, { comprehend: meta.contextComprehend })", "摘要档没走纯函数拼装");
  });

  it("切口不许再按条数硬切（`lines.slice(-(meta.summaryCount …))` 会落在半轮上）", () => {
    hasNot(MAIN, "lines.slice(-(meta.summaryCount", "又用 slice 按条数硬切了 ⇒ user,user 连续同角色（Anthropic 系 400）");
  });
});

describe("② 摘要轮**不许**再无条件放弃（P1-7 的前提）", () => {
  it("🐛 engine 里不许有 `inputTokens >= cap` 就 return null 的早退", () => {
    hasNot(ENGINE, "inputTokens >= cap", "摘要轮仍在超限时放弃 ⇒ 调用方只能降级（用户症状的起点）");
  });

  it("超预算必须走「预算内摘录」（头 30% + 尾 70%）而不是放弃", () => {
    has(ENGINE, "buildSummaryInput(messages, budget)", "没走预算内摘录");
  });

  it("摘要轮预算按**该模型窗口**解析，不再写死 9000", () => {
    has(MAIN, "Math.min(SUMMARIZE_INPUT_CAP, Math.floor(cap * 0.5))", "预算没按窗口解析 ⇒ 大窗口模型也被 9000 卡住");
    has(MAIN, "maxInputTokens: budget", "没把预算传下去 ⇒ engine 用默认值");
  });

  it("递进式摘要：必须把既有摘要作为 priorSummary 传下去（否则信息逐轮衰减）", () => {
    has(MAIN, "priorSummary: meta.contextSummary", "没传既有摘要 ⇒ 摘要逐轮衰减（I5 违反）");
  });
});

describe("⑤ force 必须透传到主进程（P0「少的那一环」真正接上）", () => {
  it("🐛 主进程的压缩判定必须把 force 当**反应式触发**（否则压缩一次也不会发生）", () => {
    /* A-1083 **迁移**：判定已收口到唯一出处 `planSend`（此前是两条散落的内联 `!force &&` 判定，
       而"`force` 要在每一处都记得越过"正是 A-1082 踩过的坑）。原意逐字不变 ——
       「上游说了太长，就必须真的压一次」；判据搬到新家：
       ① `force` 以 `afterOverflow` 入参进入 planSend；
       ② 空转护栏以 `canShrink` 入参进入（而不是在调用点外再判一次）；
       ③ planSend 内部让 overflow 档**优先于**预算档与用户阈值档（见 context-loop.spec.ts 的 A-1083 用例）。 */
    has(MAIN, "afterOverflow: force,", "主进程没把 force 当反应式触发 ⇒ 上游说了太长也不压，force 形同虚设");
    has(MAIN, "planSend({", "判定没收口到唯一出处 planSend ⇒ 散落判定会让「force 忘了越过」复发");
    has(MAIN, "canShrink: !noRoomToCut,", "空转护栏没进 planSend ⇒ 上游说太长时仍可能什么都不做");
  });

  it("force 必须来自 IPC 参数，且渲染层真的传了", () => {
    has(MAIN, "const force = p?.force === true;", "主进程没读 force 参数");
    matches(PANEL, /api\.chat\.compress\(sid,\s*cfg\.ratio,\s*used,\s*force\)/, "渲染层没把 force 传下去");
  });

  it("force 下「一点也没压下去」的 skipped 必须回带 stillOverflow（否则会白等一次注定失败的请求）", () => {
    // 两条 force 路径的 skipped：历史过短、已熔断
    matches(MAIN, /reason: "历史过短[^}]*\.\.\.\(force \? \{ stillOverflow: true \}/, "历史过短的 skipped 没回带 stillOverflow");
    matches(MAIN, /breakerOpen: true,\s*\.\.\.\(force \? \{ stillOverflow: true \}/, "熔断的 skipped 没回带 stillOverflow");
  });
});

describe("⑤b 「理解总结」环（用户点名）—— 有界、恰好一次、失败不阻塞", () => {
  it("摘要成功后必须跑一次只读回读，且产出随摘要一并落库", () => {
    has(MAIN, "await engine.comprehendContext(agent, s.summary)", "没有理解环调用 ⇒ 用户点名的这一环缺失");
    has(MAIN, "await setSessionSummary(sessionId, summaryText, keep, { comprehend });", "续接认知没有落库");
  });

  it("engine 的理解环必须有界：固定 schema 校验 + 收紧 max_tokens + 无历史", () => {
    has(ENGINE, "async comprehendContext(", "engine 没有理解环方法");
    has(ENGINE, "parseComprehend(raw)", "没做 5 字段/注入校验 ⇒ 摘要污染无法被发现");
    has(ENGINE, "max_tokens: 800", "理解环没限输出长度 ⇒ 无界自省（ReSum 的教训）");
  });

  it("理解环失败必须**非阻塞**降级（不许卡住用户的对话）", () => {
    has(MAIN, "comprehend = c?.comprehend ?? null;", "理解失败没有兜底 ⇒ 压缩整体失败");
  });
});

describe("⑥ 跳过 / 熔断 / 压完仍超限都必须**如实告知**（不许静默）", () => {
  it("skipped 必须带 reason（旧实现静默 ⇒ 用户看到「逼近阈值却毫无动作」）", () => {
    matches(MAIN, /skipped: true[^}]*reason:/, "skipped 没带 reason");
    has(IPC, "reason?: string;", "契约缺 reason");
  });

  it("渲染层必须把 skip 原因显示出来", () => {
    has(PANEL, 'stage: "skip"', "没有 skip 阶段");
    has(PANEL, "未执行压缩：", "skip 原因没有显示给用户");
  });

  it("🐛 压完仍超限要明说「换大窗口模型 / 开新会话」（§8.8 一等状态）", () => {
    has(PANEL, 'stage: "overflow"', "没有 overflow 阶段");
    matches(PANEL, /窗口上限|换窗口更大的模型/, "overflow 文案不可操作");
  });

  it("反应式路径压完仍超限 ⇒ **不再**发一次注定失败的请求", () => {
    has(PANEL, "if (stillOverflow) {", "缺少 stillOverflow 早退 ⇒ 会拿同一个超限请求再撞一次");
    const guardAt = PANEL.indexOf("if (stillOverflow) {");
    const retryAt = PANEL.indexOf("void api.chat.stream(", guardAt);
    expect(retryAt, "重试排在早退之前 ⇒ 早退形同虚设").toBeGreaterThan(guardAt);
  });

  it("熔断必须真的接进压缩编排（同一段历史连续失败 ≥3 停）", () => {
    has(MAIN, "nextBreakerState(compressBreaker,", "熔断状态没有推进");
    has(MAIN, "if (compressBreaker.open && compressBreaker.lastKey === key)", "熔断状态没有在编排里被查询 ⇒ 死代码");
  });

  it("skip-stale 必须接进编排（异步压缩不许覆盖更新的摘要）", () => {
    has(MAIN, "acceptSummary(startGen, fresh.summaryGeneration ?? 0)", "没有 generation 守卫");
    has(SESSIONS, "meta.summaryGeneration = (meta.summaryGeneration ?? 0) + 1;", "generation 没有单调 +1");
  });

  it("⑥ 校验环：压缩产物必须过 validateHistory（I1/I3 防线）", () => {
    has(MAIN, "const validation = validateHistory(after);", "没有结构校验 ⇒ 非法序列会被发给上游");
  });
});
