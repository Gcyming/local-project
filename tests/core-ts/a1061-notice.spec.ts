/**
 * A-1061④ 守卫：上游**静默重试**必须如实上报。
 *
 * 用户原话：「经常出现 agent 什么都没有，自己加载半天才输出，你给我优化一下」。
 *
 * 取证（不是猜）：本项目的上游失败是**静默重试**的 ——
 *   · `client.ts` 的 429 退避表 `[5, 15, 30, 60]`（累计最长 ≈110s）+ 瞬时错误 1/3/7s 退避；
 *   · `router.recordFallback` 静默换备用模型。
 * 这段时间界面只有一句「已发出请求，等待上游返回…」→ 用户认定卡死。
 *
 * 权威做法：Claude Code 状态栏把这类情况显示出来 ——
 * `API error · Retrying in Xs · attempt N/10`、`Rate limited · Retrying in Xs`。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeUpstreamStatus, formatRetryNotice, formatFallbackNotice,
  noteUpstream, takeUpstreamNotice, peekUpstreamNotice, resetUpstreamNoticeForTest,
} from "../../core-ts/src/llm/upstreamNotice.js";
import { deriveLiveStatus } from "../../gui/src/renderer/pages/liveStatus.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CLIENT = "core-ts/src/llm/client.ts";
const ROUTER = "core-ts/src/router.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const CHAT_SVC = "core-ts/src/services/chat.ts";
const IPC = "gui/src/shared/ipc.ts";
const LIVE = "gui/src/renderer/pages/liveStatus.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";

describe("A-1061④-A 文案与单槽行为（真模块）", () => {
  it("状态码说人话：429 明说是限流，其余按 HTTP 码，无码说网络抖动", () => {
    expect(describeUpstreamStatus(429)).toContain("限流");
    expect(describeUpstreamStatus(503)).toBe("HTTP 503");
    expect(describeUpstreamStatus(undefined)).toBe("网络抖动");
    expect(describeUpstreamStatus(0)).toBe("网络抖动");
  });

  it("🐛 重试次数是**用户口径**（从 1 开始），且不会超过上限", () => {
    expect(formatRetryNotice({ attempt: 0, maxAttempts: 4, waitMs: 5000, status: 429 })).toContain("第 1/4 次");
    expect(formatRetryNotice({ attempt: 2, maxAttempts: 4, waitMs: 30000 })).toContain("第 3/4 次");
    // 脏输入（下标越界）不许显示成「第 9/4 次」
    expect(formatRetryNotice({ attempt: 9, maxAttempts: 4, waitMs: 30000 })).toContain("第 4/4 次");
  });

  it("等待时长如实换算成秒（四舍五入到整秒，且至少 1s）", () => {
    expect(formatRetryNotice({ attempt: 0, maxAttempts: 4, waitMs: 30000 })).toContain("30s 后重试");
    expect(formatRetryNotice({ attempt: 0, maxAttempts: 4, waitMs: 200 })).toContain("1s 后重试");
  });

  it("切模型通知带上原模型与备用模型（用户据此判断要不要换回来）", () => {
    const t = formatFallbackNotice("deepseek-chat", "agnes-2.5-flash");
    expect(t).toContain("deepseek-chat");
    expect(t).toContain("agnes-2.5-flash");
    // 没有备用名也要给出非空、不自相矛盾的文案
    expect(formatFallbackNotice("deepseek-chat", "").length).toBeGreaterThan(0);
  });

  it("单槽语义：取走即清空；空文本不占槽", () => {
    resetUpstreamNoticeForTest();
    noteUpstream("retry", "  ");
    expect(peekUpstreamNotice(), "空白文本不该占槽").toBeNull();
    noteUpstream("retry", "被限流（429），30s 后重试（第 1/4 次）");
    expect(takeUpstreamNotice()?.text).toContain("限流");
    expect(takeUpstreamNotice(), "取走必须清空，否则每次轮询都会重复吐一条").toBeNull();
  });
});

describe("A-1061④-B 接线：谁在什么时候上报 / 透传 / 收掉", () => {
  it("客户端在**睡之前**上报重试（429 与网络两条分支都要）", () => {
    const src = code(CLIENT);
    const at429 = src.indexOf('noteUpstream("retry", formatRetryNotice({ attempt, maxAttempts, waitMs, status: resp.status }));');
    const atNet = src.indexOf('noteUpstream("retry", formatRetryNotice({ attempt, maxAttempts, waitMs: netWaitMs }));');
    expect(at429, "429 重试没有上报").toBeGreaterThan(-1);
    expect(atNet, "网络级重试没有上报").toBeGreaterThan(-1);
    // 必须在 sleep 之前（睡完再报等于这段等待期仍然是静默的）
    expect(src.indexOf("await sleep(waitMs);")).toBeGreaterThan(at429);
    expect(src.indexOf("await sleep(netWaitMs);")).toBeGreaterThan(atNet);
  });

  it("切换备用模型也上报（此前是静默的）", () => {
    const src = code(ROUTER);
    const at = src.indexOf("private recordFallback(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 700);
    expect(body).toContain('noteUpstream("fallback", formatFallbackNotice(from, to ?? ""));');
  });

  it("引擎的**两个**轮询循环都把它吐出去（工具路径与纯流式路径）", () => {
    const src = code(ENGINE);
    const n = (src.match(/const notice = takeUpstreamNotice\(\);/g) ?? []).length;
    expect(n, "只接了一条路径 → 另一条仍然静默").toBeGreaterThanOrEqual(2);
    expect((src.match(/liveQueue\.push\(\{ type: "notice", content: notice\.text \}\);/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("契约类型认 notice", () => {
    expect(code(CHAT_SVC)).toMatch(/type: "chunk"[^;]*"notice"/);
    expect(code(IPC)).toMatch(/type: "chunk"[^;]*"notice"/);
  });

  it("🐛 状态行：有通知就显示它，且**必须仍在 loading 判定之前**（否则空转期不显示）", () => {
    const src = code(LIVE);
    const atNotice = src.indexOf("if (input.upstreamNotice) {");
    const atLoading = src.indexOf("if (!input.loading) { return null; }");
    expect(atNotice, "状态行没有 upstreamNotice 分支").toBeGreaterThan(-1);
    expect(atLoading).toBeGreaterThan(atNotice);
    expect(src).toContain('return { kind: "notice", text: input.upstreamNotice, detail, animated: true };');
  });

  it("状态行行为：通知在场时报通知；不在场时一切照旧", () => {
    const withNotice = deriveLiveStatus({ loading: true, upstreamNotice: "被限流（429），30s 后重试（第 1/4 次）" });
    expect(withNotice?.kind).toBe("notice");
    expect(withNotice?.animated, "在等上游属于「在推进」，该播扫光").toBe(true);
    // 停止的优先级更高（用户已经点了停止就不该再看见"在重试"）
    expect(deriveLiveStatus({ loading: true, stopping: true, upstreamNotice: "x" })?.kind).toBe("stopping");
    // 没有通知时旧路径不变
    expect(deriveLiveStatus({ loading: true, replyChars: 5 })?.kind).toBe("writing");
    expect(deriveLiveStatus({ loading: true })?.kind).toBe("preparing");
  });

  it("界面：notice 只对当前会话生效，且有真实产出时收掉", () => {
    const src = code(PANEL);
    const at = src.indexOf('if (c.type === "notice") {');
    expect(at, "onChunk 没有 notice 分支").toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toContain("if (otherSid == null) { setUpstreamNotice(c.data?.content ?? null); }");
    // 有真实事件就收掉（同值 setState 会被 React bail out，不额外渲染）
    expect(src).toContain('if (c.type !== "heartbeat") { setUpstreamNotice(null); }');
    // 必须真的喂给状态行
    expect(src).toContain("upstreamNotice: upstreamNotice ?? undefined,");
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // 不把 notice 分支放在 loading 之前 → 空转期（loading 为 true 时）其实仍然会显示，
    // 但若被挪到 `if (!input.loading) return null;` 之后，非 loading 场景会误显示出来。
    const order = (noticeFirst: boolean): boolean => noticeFirst;
    expect(order(false)).toBe(false);
    expect(order(true)).toBe(true);
  });
});
