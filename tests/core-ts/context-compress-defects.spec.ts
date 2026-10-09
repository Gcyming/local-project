import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompactedHistory } from "../../core-ts/src/services/context_compress.js";
import {
  BREAKER_THRESHOLD,
  INITIAL_BREAKER,
  nextBreakerState,
  type BreakerState,
} from "../../core-ts/src/services/context_loop.js";

const HEADER_TEMPLATE =
  "【会话上下文压缩摘要】（早期消息已压缩为要点，仅作延续上下文，不是待执行的新任务）\n";

function turns(rounds: number): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < rounds; i++) {
    out.push({ role: "user", content: `第${i}轮问题` });
    out.push({ role: "assistant", content: `第${i}轮回答` });
  }
  return out;
}

function sameBytes(a: unknown, b: unknown): boolean {
  return Buffer.from(String(a ?? ""), "utf8").equals(Buffer.from(String(b ?? ""), "utf8"));
}

describe("D1 · 压缩摘要头前缀稳定性", () => {
  it("D1 · 历史增长后摘要头前缀逐字节不变", () => {
    const summary = "测试摘要：完成X；下一步Y";
    const short = buildCompactedHistory(summary, turns(15), 8);
    const long = buildCompactedHistory(summary, turns(20), 8);

    expect(short.length).toBe(long.length);
    expect(sameBytes(short[0].content, long[0].content),
      `摘要头随历史长度变化：${JSON.stringify(short[0].content)} vs ${JSON.stringify(long[0].content)}`).toBe(true);
    expect(sameBytes(short[1].content, long[1].content)).toBe(true);
    expect(short[0].role).toBe(long[0].role);
    expect(short[1].role).toBe(long[1].role);
    expect(short[0].content).toContain(summary);
  });

  it("D1 · 摘要头是静态模板、不含任何丢弃计数", () => {
    const summary = "摘要：完成 X；下一步 Y";
    const headOf = (rounds: number): string => String(buildCompactedHistory(summary, turns(rounds), 8)[0].content);

    expect(headOf(10)).toBe(HEADER_TEMPLATE + summary);
    expect(headOf(30)).toBe(HEADER_TEMPLATE + summary);
    expect(/[0-9]/.test(HEADER_TEMPLATE),
      "摘要头模板里出现了数字 ⇒ 它随轮次变化，prefix cache 必失效").toBe(false);
  });
});

type SessionsModule = typeof import("../../core-ts/src/services/sessions.js");

describe("D2 · 摘要失败时保留既有 contextSummary", () => {
  let root = "";
  let previousRoot: string | undefined;
  let sessions: SessionsModule;

  beforeAll(async () => {
    previousRoot = process.env.SLIME_ROOT;
    root = await mkdtemp(join(tmpdir(), "d2-sessions-"));
    process.env.SLIME_ROOT = root;
    sessions = await import("../../core-ts/src/services/sessions.js");
  });

  afterAll(async () => {
    if (previousRoot === undefined) { delete process.env.SLIME_ROOT; } else { process.env.SLIME_ROOT = previousRoot; }
    if (root) { await rm(root, { recursive: true, force: true }); }
  });

  it("D2 · setSessionSummary 收到 null 时旧摘要仍在且已落盘", async () => {
    const created = await sessions.createSession("agent-d2");
    expect(sessions.SESSIONS_PATH.startsWith(root), "测试未隔离到临时目录").toBe(true);

    await sessions.setSessionSummary(created.id, "旧摘要：已完成A、B", 6);
    expect((await sessions.getSession(created.id))?.contextSummary).toBe("旧摘要：已完成A、B");

    const generationBefore = (await sessions.getSession(created.id))?.summaryGeneration ?? 0;
    const failed = await sessions.setSessionSummary(created.id, null, 6);

    expect(failed?.contextSummary, "摘要失败把 contextSummary 删掉了 ⇒ 渐进压缩链断裂")
      .toBe("旧摘要：已完成A、B");

    const raw = JSON.parse(await readFile(sessions.SESSIONS_PATH, "utf8")) as {
      sessions: Record<string, { contextSummary?: string; summaryGeneration?: number }>;
    };
    expect(raw.sessions[created.id].contextSummary,
      "内存里还在但没落盘 ⇒ 重启后进度链仍会断").toBe("旧摘要：已完成A、B");
    expect(raw.sessions[created.id].summaryGeneration).toBe(generationBefore + 1);

    const rewritten = await sessions.setSessionSummary(created.id, "新摘要：已完成C", 6);
    expect(rewritten?.contextSummary).toBe("新摘要：已完成C");
  });

  it("D2 · 从未产出过摘要时失败不会凭空造出 contextSummary", async () => {
    const created = await sessions.createSession("agent-d2-empty");
    const after = await sessions.setSessionSummary(created.id, null, 6);
    expect(after?.contextSummary).toBeUndefined();

    const persisted = (await sessions.getSession(created.id)) as { contextSummary?: string };
    expect("contextSummary" in persisted,
      "没有摘要时写了空键 ⇒ 会话面板会渲染出一段空摘要").toBe(false);
  });
});

describe("D3 · 熔断器按会话维度累计", () => {
  it("D3 · 同一 stableKey 下失败连续累加并开闸（historyKey 每轮都在变）", () => {
    const sessionId = "session-stable";
    const seen: Array<{ failures: number; open: boolean; lastKey?: string }> = [];
    let breaker: BreakerState = INITIAL_BREAKER;

    for (let round = 1; round <= BREAKER_THRESHOLD; round++) {
      const historyKey = `history-fingerprint-${round}`;
      expect(historyKey).not.toBe(INITIAL_BREAKER.lastKey);
      breaker = nextBreakerState(breaker, { ok: false, historyKey, stableKey: sessionId });
      seen.push({ failures: breaker.failures, open: breaker.open, lastKey: breaker.lastKey });
    }

    expect(seen.map((s) => s.failures),
      `历史指纹每轮都变时失败计数没有连续累加：${JSON.stringify(seen)} ⇒ 压缩失败永远攒不满阈值`).toEqual([1, 2, 3]);
    expect(seen.map((s) => s.open)).toEqual([false, false, true]);
    expect(seen.every((s) => s.lastKey === sessionId)).toBe(true);
    expect(breaker.open, "同一会话连续失败到阈值仍未开闸 ⇒ 压缩死循环").toBe(true);
  });

  it("D3 · 换会话（stableKey 变化）计数归零", () => {
    const opened = nextBreakerState(
      nextBreakerState(
        nextBreakerState(INITIAL_BREAKER, { ok: false, historyKey: "h1", stableKey: "session-a" }),
        { ok: false, historyKey: "h2", stableKey: "session-a" },
      ),
      { ok: false, historyKey: "h3", stableKey: "session-a" },
    );
    expect(opened.open).toBe(true);

    const other = nextBreakerState(opened, { ok: false, historyKey: "h4", stableKey: "session-b" });
    expect(other.failures, "换会话后沿用旧计数 ⇒ 别的会话被误熔断").toBe(1);
    expect(other.open).toBe(false);
    expect(other.lastKey).toBe("session-b");

    const recovered = nextBreakerState(opened, { ok: true, historyKey: "h4", stableKey: "session-a" });
    expect(recovered.failures).toBe(0);
    expect(recovered.open).toBe(false);
  });
});
