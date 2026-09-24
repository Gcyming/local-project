/**
 * 守卫：流式失败的两件纯逻辑 —— ①"该不该跳过自动重连" ②"给用户什么诱因文案"。
 *
 * ## 本文件锁住的那个真实缺陷（用户原话）
 *
 * 「我**以前定下的十次请求失败的重连阈值**呢？」
 *
 * 阈值一直在（`ChatPanel` 的 `MAX_RETRY = 9` → 共 10 次尝试）。被吃掉的是**重连本身**：
 * 旧 `isPermanentStreamError` 第一段是 `/401|403|404/i.test(msg)` —— **裸三位数字子串匹配**，
 * 而递给它的 `msg` 形如 `上游错误 400: {……完整响应体……}`。响应体里出现 `404` / `401`
 * 这类数字极其常见（request id、token 计数、分页、数组下标、base64 片段），
 * 于是**任意**一个 400/500 都可能被判成"不可恢复"→ `failReconnect(msg, 0)` → **零次重连**。
 *
 * ⇒ 判据必须只认**我们/上游给出的状态码形态**（`上游错误 NNN` / `HTTP NNN`），
 * 不许对整串做裸数字扫描。下面第 1 组用例就是"响应体里带数字"的回归。
 *
 * 变异见 `gui/scripts/mut-a1063-streamerrors.mjs`。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERMANENT_STATUSES, explainStreamError, isPermanentStreamError, upstreamStatusOf,
  isContextOverflowError, contextOverflowHint, CONTEXT_OVERFLOW_STATUSES,
  LOCAL_PREFLIGHT_MARKER,
} from "../../gui/src/renderer/pages/streamErrors.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PANEL_C = readFileSync(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** 真实形态：client.ts 的 UpstreamError 把完整响应体拼进 message */
const upstream = (status: number, body: string): string => `上游错误 ${status}: ${body}`;

describe("streamErrors · upstreamStatusOf：只认状态码形态，不扫裸数字", () => {
  it("`上游错误 NNN: {…}` → 取状态码", () => {
    expect(upstreamStatusOf(upstream(400, "{}"))).toBe(400);
    expect(upstreamStatusOf("上游错误 429: rate limited")).toBe(429);
  });

  it("`HTTP NNN` → 取状态码（备用模型 / 网关自己的拼法）", () => {
    expect(upstreamStatusOf("HTTP 503 Service Unavailable")).toBe(503);
  });

  it("🐛 裸三位数字**不许**被当成状态码（这正是那次回归的根）", () => {
    expect(upstreamStatusOf("404")).toBeNull();
    expect(upstreamStatusOf('{"request_id":"req_2e4041a","n":4032}')).toBeNull();
    expect(upstreamStatusOf("token 计数 4010 已超出")).toBeNull();
  });

  it("空串 / null-ish → null（不抛）", () => {
    expect(upstreamStatusOf("")).toBeNull();
    expect(upstreamStatusOf(undefined as unknown as string)).toBeNull();
  });
});

describe("streamErrors · isPermanentStreamError：不可恢复才跳过重连", () => {
  it("401 / 403 / 404 判为不可恢复（换路重发同一个模型也一样失败）", () => {
    for (const s of PERMANENT_STATUSES) {
      expect(isPermanentStreamError(upstream(s, "nope")), `${s} 应当不可恢复`).toBe(true);
    }
  });

  it("🐛 400 **不在**不可恢复之列（归进去正是「重连阈值看起来消失」的那类修法）", () => {
    expect(PERMANENT_STATUSES).not.toContain(400);
    expect(isPermanentStreamError(upstream(400, "bad request shape"))).toBe(false);
  });

  it("🐛 回归：400/502 的响应体里出现 401/403/404 数字 → **仍然可重连**", () => {
    // 旧实现（/401|403|404/ 裸匹配）在这两条上都会误判为"不可恢复"，从而零次重连
    expect(isPermanentStreamError(upstream(400, '{"request_id":"req_2e4041a","usage":{"max_tokens":4096}}'))).toBe(false);
    expect(isPermanentStreamError(upstream(502, '{"n":4011,"msg":"bad gateway"}'))).toBe(false);
    // [反例] 守卫自检：证明这段文字**确实**能被旧的裸匹配抓住，否则这组用例就是空转
    expect(/401|403|404/.test(upstream(400, '{"request_id":"req_2e4041a"}'))).toBe(true);
  });

  it("5xx / 网络错误 / 超时 → 可重连（别把可恢复的挡在门外）", () => {
    expect(isPermanentStreamError(upstream(500, "internal"))).toBe(false);
    expect(isPermanentStreamError("fetch failed")).toBe(false);
    expect(isPermanentStreamError("ETIMEDOUT")).toBe(false);
  });

  it("区域限制（RegionError 常以 400/5xx 返回，所以不能只靠状态码）", () => {
    expect(isPermanentStreamError("RegionError: not available in your country")).toBe(true);
    expect(isPermanentStreamError(upstream(400, "RegionError"))).toBe(true);
  });

  it("认证失败 / 模型不存在 / 模型不可用 / 免费池限流 → 不可恢复", () => {
    expect(isPermanentStreamError("unauthorized")).toBe(true);
    expect(isPermanentStreamError("invalid api key")).toBe(true);
    expect(isPermanentStreamError(upstream(400, "no such model: gpt-x"))).toBe(true);
    expect(isPermanentStreamError("Model is unavailable")).toBe(true);
    expect(isPermanentStreamError("FreeUsageLimitError: rate limit exceeded")).toBe(true);
  });

  it("空错误串 → false（别把「不知道」当「不可恢复」）", () => {
    expect(isPermanentStreamError("")).toBe(false);
    expect(isPermanentStreamError(undefined as unknown as string)).toBe(false);
  });
});

describe("streamErrors · explainStreamError：重连耗尽时的可操作文案", () => {
  it("带重连次数 → 标题如实报出次数；带原错误信息", () => {
    const s = explainStreamError(upstream(401, "bad key"), 10);
    expect(s).toContain("已自动重连 10 次仍无法恢复");
    expect(s).toContain("上游错误 401: bad key");
    expect(s).toContain("可能诱因：");
    expect(s).toContain("API Key 无效或已过期");
  });

  it("attemptCount 为 0/缺省 → 说「无法自动恢复」，不说「重连 0 次」", () => {
    const s = explainStreamError(upstream(404, "no such model"), 0);
    expect(s).toContain("错误无法自动恢复");
    expect(s).not.toContain("已自动重连 0 次");
    expect(s).toContain("模型 ID 不存在");
  });

  it("5xx → 提示上游服务暂时不可用", () => {
    expect(explainStreamError(upstream(503, "maintenance"), 3)).toContain("5xx");
  });

  it("认不出的错误 → 给兜底诱因（不许返回空「可能诱因」）", () => {
    const s = explainStreamError("莫名其妙的一次失败", 2);
    expect(s).toContain("未知错误");
    expect(s).toMatch(/可能诱因：\n· /);
  });

  it("空错误串 → 用兜底描述，不抛", () => {
    expect(explainStreamError("", 1)).toContain("连接意外中断");
  });
});

describe("A-1081 · isContextOverflowError：上下文超限是**第三类**（终态·可压缩）", () => {
  it("① 各家**真实**错误散文都命中 —— 含被 200 字符截断的 OpenAI 形态", () => {
    /* ⚠️ 这条最关键：`client.ts` 对响应体做了 `slice(0, 200)`，而 OpenAI 把
       `"code":"context_length_exceeded"` 放在**末尾** ⇒ 被截掉。
       所以判据必须以**散文句**为主判据（它总在 message 开头），只靠 code 必然漏判。 */
    expect(isContextOverflowError(upstream(400, `{"error":{"message":"This model's maximum context length is 131072 tokens. However, you req`))).toBe(true);
    expect(isContextOverflowError(upstream(400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213482 tokens > 200000 maximum"}}'))).toBe(true);
    expect(isContextOverflowError(upstream(400, '{"error":{"message":"exceeded model token limit: 131072 (requested: 140000)"}}'))).toBe(true);
    expect(isContextOverflowError(upstream(400, '{"code":"InvalidParameter","message":"Range of input length should be [1, 131072]"}}'))).toBe(true);
    expect(isContextOverflowError(upstream(400, '{"error":{"code":"context_length_exceeded"}}'))).toBe(true);
    expect(isContextOverflowError(upstream(413, "Payload Too Large"))).toBe(true);
    expect(isContextOverflowError(upstream(414, "URI Too Long"))).toBe(true);
  });

  it("🐛 **裸 400 不许**被判成超限（超限 = 400 + 特定散文，缺一不可）", () => {
    expect(isContextOverflowError(upstream(400, '{"error":{"message":"unknown parameter: foo"}}'))).toBe(false);
    expect(isContextOverflowError(upstream(400, '{"error":{"message":"invalid api key"}}'))).toBe(false);
    // "token" 单独出现不算：必须是"上下文/输入**过长**"的语义
    expect(isContextOverflowError(upstream(400, "invalid token count field"))).toBe(false);
    expect(CONTEXT_OVERFLOW_STATUSES.includes(400), "400 混进超限状态码 → 任何 400 都会被压缩+重试，掩盖真因").toBe(false);
  });

  it("其它类别不许被误判（误判会白白压一次并丢掉本该有的重连）", () => {
    expect(isContextOverflowError(upstream(401, "unauthorized"))).toBe(false);
    expect(isContextOverflowError(upstream(429, "rate limit reached"))).toBe(false);
    expect(isContextOverflowError(upstream(500, "internal error"))).toBe(false);
    expect(isContextOverflowError("流式空闲超时（300000ms 无数据）")).toBe(false);
  });

  it("提示必须**可操作**（重发同一请求必然同样失败，不许只说「请重试」）", () => {
    const h = contextOverflowHint();
    expect(h).toContain("没有做自动重连");
    expect(h).toMatch(/压缩|新会话|窗口更大/);
  });
});

describe("A-1081 接线：反应式压缩必须排在 **9 次重连之前**，且只做一次", () => {
  it("onError 里有超限分支，且位置在重连判定**之前**", () => {
    const at = PANEL_C.indexOf("if (isContextOverflowError(msg)) {");
    const retry = PANEL_C.indexOf("if (retryCountRef.current < MAX_RETRY) {");
    expect(at, "渲染层没接上下文超限分类 → 超限仍会走 9 次重连").toBeGreaterThan(-1);
    expect(retry, "找不到重连分支").toBeGreaterThan(-1);
    expect(at, "超限分支排在重连**之后** → 等于没接（会先空转 9 次）").toBeLessThan(retry);
  });

  it("只压一次：用**独立** ref 而不是复用 didCompressTurnRef（后者在早退分支不置位 → 死循环）", () => {
    expect(PANEL_C, "没有独立的一次性闸门 → 超限重试会无限循环").toContain("ctxOverflowRetriedRef");
    expect(PANEL_C, "闸门没有在每轮开始复位").toMatch(/retryCountRef\.current = 0;\s*ctxOverflowRetriedRef\.current = false;/);
  });

  it("反应式触发带 force（越过阈值判定），但仍尊重用户的自动压缩开关", () => {
    expect(PANEL_C, "maybeAutoCompress 没有 force 形参 → 反应式触发会被阈值挡掉（超限时占用口径可能还没到阈值）")
      .toContain("force = false");
    expect(PANEL_C, "force 绕过了用户的 cfg.enabled 开关（设置即权威，不许偷偷压）")
      .toContain("if (!force && used < cap * cfg.ratio)");
    // 顺序铁律：`cfg.enabled`（用户开关）必须在 force 那条**之前**判定 —— 否则 force 会把开关一起绕过
    const enabledAt = PANEL_C.indexOf("if (!cfg.enabled)");
    const forceAt = PANEL_C.indexOf("if (!force && used < cap * cfg.ratio)");
    expect(enabledAt, "找不到用户开关判定").toBeGreaterThan(-1);
    expect(enabledAt, "cfg.enabled 排在 force 之后 → force 会连用户开关一起绕过").toBeLessThan(forceAt);
  });

  it("A-1082：force 必须**透传到主进程**（只越过渲染层判据 = 主进程再判一次 needsCompress ⇒ 一次也没压）", () => {
    expect(PANEL_C, "compress 调用没带 force → 主进程仍会判 needsCompress=false ⇒ 压缩空转")
      .toMatch(/api\.chat\.compress\(sid,\s*cfg\.ratio,\s*used,\s*force\)/);
  });

  it("A-1082：压完仍超限 ⇒ **不许**再发一次注定失败的请求（把「重连半天」从根上掐掉）", () => {
    expect(PANEL_C, "缺少 stillOverflow 早退 → 会拿同一个超限请求再撞一次").toContain("if (stillOverflow) {");
    const guardAt = PANEL_C.indexOf("if (stillOverflow) {");
    const retryAt = PANEL_C.indexOf("void api.chat.stream({ ...(streamReqRef.current ?? {}), resumeHint: buildResumeHint() });", guardAt);
    expect(guardAt, "找不到 stillOverflow 早退").toBeGreaterThan(-1);
    expect(retryAt, "重试排在 stillOverflow 判定之前 → 早退形同虚设").toBeGreaterThan(guardAt);
  });
});

describe("A-1084 · 本地判定必须走「超限」这条处置（否则落进 9 次重连、且每次都被拦回）", () => {
  it("🐛 引擎保险门的拒发错误**必须**被判成超限类", () => {
    /* 场景：引擎算出来装不下 ⇒ **请求根本没发出去** ⇒ 上游一个字都不会说。
       若判据只认上游散文，这条错误会被当成瞬时故障 ⇒ 走 9 次重连，
       而每一次都会被保险门原样拦回 —— 比不做这道门还糟（用户看到"重连了 9 次还是不行"）。 */
    expect(
      isContextOverflowError(`${LOCAL_PREFLIGHT_MARKER}\n⚠️ 本次请求**未发送** —— 上下文装不下该模型的窗口。`),
      "本地拒发没被判成超限 → 会去重连 9 次",
    ).toBe(true);
    // 只带标记（文案改了）也认：判据认的是**身份**，不是某一句措辞
    expect(isContextOverflowError(LOCAL_PREFLIGHT_MARKER)).toBe(true);
  });

  it("标记**不许**把真实错误误判成超限（形态必须足够特异）", () => {
    expect(isContextOverflowError("上游错误 500: internal error")).toBe(false);
    expect(isContextOverflowError('{"request_id":"req_2e4041a"}')).toBe(false);
  });

  it("A-1086：rescue 提示附加在超限文案末尾；不传时原样（旧调用点零回归）", () => {
    const plain = contextOverflowHint();
    expect(plain).toContain("没有做自动重连");
    expect(plain, "旧调用点拿到了多余的出路文案 → 说明签名改了但默认行为也变了").not.toContain("切到它");
    const withRescue = contextOverflowHint("检测到可用的更大窗口模型：**X**（512000 tokens）—— 切到它即可继续本次会话。");
    expect(withRescue).toContain("没有做自动重连");
    expect(withRescue, "出路没被附加 → 用户仍只看到「请换更大窗口的模型」这句原则").toContain("切到它");
  });

  it("接线：两条路径都把主进程算出的出路真的用上了", () => {
    expect(PANEL_C, "反应式路径没把 rescueHint 交给 failReconnect → 红字里只有原则、没有出路")
      .toContain("contextOverflowHint(rescueHint)");
    expect(PANEL_C, "压完仍超限的横幅没用 rescueHint → 又变回自己拼「请换窗口更大的模型」")
      .toContain("res.rescueHint");
  });
});
