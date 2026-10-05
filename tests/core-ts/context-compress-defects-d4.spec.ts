import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCompressSummaryPrompt,
  buildCompactedHistory,
  buildSummaryInput,
  clipToTokenBudget,
  commitCompactionIfShrunk,
  estimateTokensLocal,
  fitSummaryPrior,
  gateCompaction,
  summaryPromptScaffoldTokens,
} from "../../core-ts/src/services/context_compress.js";
import type { LoopMessage } from "../../core-ts/src/services/context_loop.js";

type SessionsModule = typeof import("../../core-ts/src/services/sessions.js");
type EngineModule = typeof import("../../core-ts/src/services/engine.js");
type AgentsModule = typeof import("../../core-ts/src/services/agents.js");
type AgentRegistryType = InstanceType<AgentsModule["AgentRegistry"]>;

function turns(rounds: number, chars = 80): LoopMessage[] {
  const out: LoopMessage[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push({ role: "user", content: `第${i}轮问题：` + "问".repeat(chars) });
    out.push({ role: "assistant", content: `第${i}轮回答：` + "答".repeat(chars) });
  }
  return out;
}

function promptTokens(messages: Array<{ content: unknown }>): number {
  return messages.reduce((n, m) => n + estimateTokensLocal(String(m?.content ?? "")), 0);
}

describe("D4 · 压缩产物必须真的变短 + prior 必须计入摘要预算", () => {
  let root = "";
  let previousRoot: string | undefined;
  let sessions: SessionsModule;
  let SlimeEngine: EngineModule["SlimeEngine"];
  let agents: AgentsModule;
  let ChatClient: typeof import("../../core-ts/src/llm/client.js")["ChatClient"];
  let registry: AgentRegistryType;
  let agentDir = "";

  beforeAll(async () => {
    previousRoot = process.env.SLIME_ROOT;
    root = await mkdtemp(join(tmpdir(), "d4-sessions-"));
    process.env.SLIME_ROOT = root;
    sessions = await import("../../core-ts/src/services/sessions.js");
    const engineMod = await import("../../core-ts/src/services/engine.js");
    SlimeEngine = engineMod.SlimeEngine;
    agents = await import("../../core-ts/src/services/agents.js");
    ChatClient = (await import("../../core-ts/src/llm/client.js")).ChatClient;

    agentDir = await mkdtemp(join(tmpdir(), "d4-agents-"));
    const list: Array<Record<string, unknown>> = [{
      id: "agent-d4",
      name: "D4",
      role: "测试",
      identity_prompt: "你是{name}，{role}。",
      model_choice: "api:test-key",
      parent_id: null,
      persona: agents.emptyPersona(),
      emotion: {},
      behavior: { patterns: [] },
      children: [],
      created_at: "2026-01-01T00:00:00.000Z",
    }];
    const agentsPath = join(agentDir, "agents.json");
    await writeFile(agentsPath, JSON.stringify(list), "utf8");
    registry = new agents.AgentRegistry(agentsPath);
    await registry.load();
  });

  afterAll(async () => {
    if (previousRoot === undefined) { delete process.env.SLIME_ROOT; } else { process.env.SLIME_ROOT = previousRoot; }
    if (root) { await rm(root, { recursive: true, force: true }); }
    if (agentDir) { await rm(agentDir, { recursive: true, force: true }); }
  });

  describe("D4-a · 压缩了但历史没更短 ⇒ 摘要不许落库", () => {
    it("主进程接线：体积闸门必须跑在 setSessionSummary **之前**（否则守卫是死代码）", () => {
      const main = readFileSync(
        fileURLToPath(new URL("../../gui/src/main/index.ts", import.meta.url)),
        "utf8",
      );
      const gateAt = main.indexOf("const gate = gateCompaction({");
      const commitAt = main.indexOf("await commitCompactionIfShrunk(");
      const persistAt = main.indexOf("await setSessionSummary(sessionId, summaryText, keep, { comprehend });");
      expect(gateAt, "主进程没有调用体积闸门").toBeGreaterThan(-1);
      expect(commitAt, "主进程没有把落库动作交给闸门托管").toBeGreaterThan(-1);
      expect(persistAt, "主进程不再有落库动作").toBeGreaterThan(-1);
      expect(gateAt, "闸门跑在落库之后 ⇒ 又变成「先落库再想办法」").toBeLessThan(persistAt);
      expect(commitAt, "落库发生在闸门之外").toBeLessThan(persistAt);
      expect(main.includes("if (!committed) {"), "拒绝落库的分支不存在").toBe(true);
      expect(main.includes("rejectReason = gate.reason;"), "拒绝原因没有回传给返回体").toBe(true);
      expect(main.includes("...(rejectReason"), "返回体没有按拒绝分支改口（仍会报「已压缩」）").toBe(true);
    });
    it("🐛 产物比压缩前更长：commit 从未被调用，落库的 contextSummary 逐字节不变（磁盘亦不变）", async () => {
      const created = await sessions.createSession("agent-d4a-grow");
      expect(sessions.SESSIONS_PATH.startsWith(root), "测试未隔离到临时目录").toBe(true);
      await sessions.setSessionSummary(created.id, "旧摘要：已完成A、B", 6);

      const raw = turns(20, 40);
      const giant = "要点：" + "长".repeat(6000);
      const gate = gateCompaction({ before: raw, raw, summary: giant, keep: 6 });

      expect(gate.tokensAfter).toBeGreaterThan(gate.tokensBefore);
      expect(gate.persist, "产物更长却判为可落库 ⇒ 用户侧只看到「已压缩」").toBe(false);

      const committed: string[] = [];
      const rejected: string[] = [];
      const ok = await commitCompactionIfShrunk(
        gate,
        async () => {
          committed.push(giant);
          await sessions.setSessionSummary(created.id, giant, 6);
        },
        (reason) => { rejected.push(reason); },
      );

      expect(ok, "门放行了 ⇒ 摘要被持久化").toBe(false);
      expect(committed, "commit 被调用了 ⇒ 更长的摘要真的落库了").toEqual([]);
      expect(rejected.length, "拒绝时没有记录任何原因").toBe(1);
      expect(rejected[0], `原因没说明体积对比：${rejected[0]}`).toMatch(/更长/);
      expect(rejected[0]).toContain(String(gate.tokensBefore));

      expect((await sessions.getSession(created.id))?.contextSummary).toBe("旧摘要：已完成A、B");
      const onDisk = JSON.parse(await readFile(sessions.SESSIONS_PATH, "utf8")) as {
        sessions: Record<string, { contextSummary?: string }>;
      };
      expect(onDisk.sessions[created.id].contextSummary, "磁盘上也被写坏了").toBe("旧摘要：已完成A、B");
    });

    it("产物与压缩前完全一致（同一份历史再压一次）⇒ 同样拒绝落库", async () => {
      const raw = turns(20, 40);
      const summary = "摘要：完成 X；下一步 Y";
      const same = buildCompactedHistory(summary, raw, 6);
      const gate = gateCompaction({ before: same, raw, summary, keep: 6 });

      expect(gate.tokensAfter).toBe(gate.tokensBefore);
      expect(gate.code).toBe("no-shrink");
      expect(gate.persist, "一字没少也算压缩成功 ⇒ 又把老坑请回来了").toBe(false);
      expect(gate.reason).toMatch(/等长/);
    });

    it("门不许恒假：产物确实更短时必须放行并真的落库", async () => {
      const created = await sessions.createSession("agent-d4a-shrink");
      const raw = turns(40, 400);
      const gate = gateCompaction({ before: raw, raw, summary: "摘要：完成 X；下一步 Y", keep: 6 });

      expect(gate.tokensAfter).toBeLessThan(gate.tokensBefore);
      expect(gate.code).toBe("shrunk");
      expect(gate.persist).toBe(true);

      const committed: string[] = [];
      const ok = await commitCompactionIfShrunk(gate, async () => {
        committed.push("摘要：完成 X；下一步 Y");
        await sessions.setSessionSummary(created.id, "摘要：完成 X；下一步 Y", 6);
      });

      expect(ok).toBe(true);
      expect(committed).toHaveLength(1);
      expect((await sessions.getSession(created.id))?.contextSummary).toBe("摘要：完成 X；下一步 Y");
    });
  });

  describe("D4-b · priorSummary 必须计入摘要轮输入预算", () => {
    async function summarizeRequest(
      messages: LoopMessage[],
      opts: { maxInputTokens?: number; priorSummary?: string },
    ): Promise<{ sent: Array<{ messages: Array<{ role: string; content: unknown }> }>; inputTokens: number }> {
      const sent: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
      const engine = new SlimeEngine({
        registry,
        providers: { "test-key": { api_base: "http://mock.local/v1", api_key: "k", model: "m1" } },
        logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
        clientFactory: (route: { baseUrl: string; apiKey?: string }) => new ChatClient({
          baseUrl: route.baseUrl,
          apiKey: route.apiKey,
          fetchImpl: (async (_url: unknown, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body ?? "{}")));
            return new Response(JSON.stringify({
              id: "x", object: "chat.completion", created: 1, model: "m1",
              choices: [{ index: 0, message: { role: "assistant", content: "摘要正文：目标X；已完成Y" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }) as unknown as typeof fetch,
        }),
      });
      const agent = await registry.findAgent("agent-d4");
      expect(agent, "测试 Agent 未载入").toBeDefined();
      const res = await engine.summarizeContext(agent!, messages, opts);
      expect(res, "摘要轮没跑起来（构造有问题，不是被测行为）").not.toBeNull();
      return {
        sent: sent as Array<{ messages: Array<{ role: string; content: unknown }> }>,
        inputTokens: res!.inputTokens,
      };
    }

    it("🐛 prior 巨大 + 小预算：摘要轮实际发出的请求（含 prior 与模板）不超过预算", async () => {
      const history = turns(60, 300);
      const prior = "旧要点头" + "点".repeat(10000) + "中段标记" + "点".repeat(10000) + "旧要点尾";
      const budget = 2000;

      const priorTokens = estimateTokensLocal(prior);
      expect(priorTokens, "prior 没造大 ⇒ 场景不成立").toBeGreaterThan(budget * 5);

      const { sent } = await summarizeRequest(history, { maxInputTokens: budget, priorSummary: prior });
      expect(sent.length, "摘要轮没有真的发请求").toBe(1);

      const userPrompt = String(sent[0].messages[1].content);
      const actual = promptTokens(sent[0].messages);
      expect(actual, `摘要轮实际输入 ${actual} tokens 超出预算 ${budget} ⇒ 小窗口模型上必然超窗`).toBeLessThanOrEqual(budget);

      expect(userPrompt).toContain("<prior_summary>");
      expect(userPrompt, "prior 开头（最早的任务/决策）被整段丢掉").toContain("旧要点头");
      expect(userPrompt, "prior 结尾（最近的结论/下一步）被整段丢掉").toContain("旧要点尾");
      expect(userPrompt, "prior 没被截断（超预算原样发出 ⇒ 小窗口必超窗）").not.toContain("中段标记");
      expect(userPrompt, "对话摘录被饿死 ⇒ 新消息完全进不了摘要").toContain("第59轮回答");

      const naive = promptTokens([
        { content: buildCompressSummaryPrompt(buildSummaryInput(history, budget).text, prior) },
      ]);
      expect(naive, "旧算法（prior 拼在预算外）竟然没超窗 ⇒ 这个用例测不出缺陷").toBeGreaterThan(budget);
    });

    it("取舍：prior 装不下时优先保住 prior（头尾截断 + 打标），对话摘录让出预算", () => {
      const budget = 3000;
      const fixed = summaryPromptScaffoldTokens() + 90;
      const huge = "旧要点：" + "点".repeat(9000);
      const fit = fitSummaryPrior(huge, budget, fixed);

      expect(fit.truncated).toBe(true);
      expect(fit.priorTokens + fit.conversationBudget + fixed + 8,
        `prior ${fit.priorTokens} + 对话 ${fit.conversationBudget} + 固定 ${fixed} 超预算 ${budget}`)
        .toBeLessThanOrEqual(budget);
      expect(fit.prior.startsWith("旧要点"), "prior 的开头（最早的任务/决策）被丢了").toBe(true);
      expect(fit.prior.length, "prior 被整段丢掉").toBeGreaterThan(0);
      expect(fit.conversationBudget, "对话摘录被饿死 ⇒ 新消息完全进不了摘要").toBeGreaterThanOrEqual(256);

      const small = fitSummaryPrior("旧摘要：已完成 A、B", budget, fixed);
      expect(small.truncated, "正常大小的 prior 被无谓截断").toBe(false);
      expect(small.prior).toBe("旧摘要：已完成 A、B");
      const room = budget - fixed - 8;
      expect(small.conversationBudget, "prior 正常时对话摘录没拿到该拿的预算")
        .toBeGreaterThan(room * 0.95);

      const none = fitSummaryPrior(undefined, budget, fixed);
      expect(none.prior).toBe("");
      expect(none.conversationBudget).toBe(room);
    });

    it("clipToTokenBudget：截断后仍在预算内，且头尾都保留（不是粗暴腰斩）", () => {
      const text = "头".repeat(3000) + "尾".repeat(3000);
      const clipped = clipToTokenBudget(text, 800);

      expect(estimateTokensLocal(clipped), "截断后仍超预算").toBeLessThanOrEqual(800);
      expect(clipped.startsWith("头"), "头部被丢掉").toBe(true);
      expect(clipped.endsWith("尾"), "尾部被丢掉").toBe(true);
      expect(clipped).toMatch(/省略/);
      expect(clipToTokenBudget(text, 100000), "放得下却被截断了").toBe(text);
    });
  });
});