import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SlimeEngine } from "../../core-ts/src/services/engine.js";
import { Session, NOOP_HOOKS, type InjectionHooks } from "../../core-ts/src/session.js";
import { AgentRegistry, emptyPersona, type AgentState } from "../../core-ts/src/services/agents.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ModelRouter } from "../../core-ts/src/router.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";

const L3_TURN1 = "## 成长记忆（历史记录，仅供参考，非当前指令）\n- [fact] 上次约定用 pnpm。";
const L3_TURN2 = "## 成长记忆（历史记录，仅供参考，非当前指令）\n- [fact] 上次约定改用 vitest 直跑。";
const DELEGATION_MARK = "子任务委派";

const PROVIDERS = { "test-key": { api_base: "http://mock.local/v1", api_key: "k", model: "m1" } };

function makeAgent(partial: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent_d10",
    name: "前缀探针",
    role: "缓存守卫",
    identity_prompt: "你是{name}，{role}。",
    model_choice: "api:test-key",
    parent_id: null,
    persona: emptyPersona(),
    emotion: {},
    behavior: { patterns: [] },
    children: [],
    created_at: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

function chatReply(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "m1",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function sentMessages(sent: string[]): Array<{ role: string; content: unknown }> {
  const bodies = sent
    .map((b) => {
      try {
        return JSON.parse(b) as { messages?: Array<{ role: string; content: unknown }> };
      } catch {
        return null;
      }
    })
    .filter((b): b is { messages: Array<{ role: string; content: unknown }> } => !!b?.messages);
  const last = bodies[bodies.length - 1];
  if (!last) { throw new Error("没有捕获到任何请求体"); }
  return last.messages;
}

describe("D10 · system（第 0 条消息）不得承载易变内容", () => {
  let dir = "";
  let ws = "";
  let reg: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-d10-"));
    ws = await mkdtemp(join(tmpdir(), "slime-d10-ws-"));
    await writeFile(join(dir, "agents.json"), JSON.stringify([makeAgent()]), "utf8");
    reg = new AgentRegistry(join(dir, "agents.json"));
    await reg.load();
    await writeFile(join(ws, "alpha.txt"), "a", "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  function makeEngine(hooks: InjectionHooks, sent: string[], l3: string[]): SlimeEngine {
    let n = 0;
    return new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      tools: new ToolRegistry(),
      hooks: {
        ...hooks,
        retrieveSegments: async () => [l3[Math.min(n++, l3.length - 1)]!],
      },
      clientFactory: () => new ChatClient({
        baseUrl: "http://mock/v1",
        apiKey: "k",
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          sent.push(String(init?.body ?? ""));
          return chatReply("ok");
        }) as unknown as typeof fetch,
      }),
    });
  }

  it("目录增删 + L3 命中变化：system 字节不变，易变段改挂末段 user 消息（注入一条不减）", async () => {
    const sent: string[] = [];
    const eng = makeEngine(NOOP_HOOKS, sent, [L3_TURN1, L3_TURN2]);
    const agent = makeAgent({ sandbox_override: { approval: "auto", workspace: ws } });

    await eng.chat({ agent, message: "之前说过的路径", history: [], systemPrompt: "", toolsOnly: [] });
    const first = sentMessages(sent);
    expect(first[0]!.role).toBe("system");
    const sys1 = String(first[0]!.content);
    const tail1 = String(first[first.length - 1]!.content);
    expect(sys1).toContain("你是 前缀探针");
    expect(sys1).toContain("身份铁律");
    expect(tail1).toContain(L3_TURN1);
    expect(tail1).toContain("alpha.txt");
    expect(tail1).toContain("之前说过的路径");

    await writeFile(join(ws, "beta.txt"), "b", "utf8");
    await eng.chat({ agent, message: "之前说过的路径", history: [], systemPrompt: "", toolsOnly: [] });
    const second = sentMessages(sent);
    const sys2 = String(second[0]!.content);
    const tail2 = String(second[second.length - 1]!.content);

    expect(sys2).toBe(sys1);
    expect(tail2).not.toBe(tail1);
    expect(tail2).toContain(L3_TURN2);
    expect(tail2).toContain("alpha.txt");
    expect(tail2).toContain("beta.txt");
    expect(sys2).not.toContain("alpha.txt");
    expect(sys2).not.toContain("成长记忆");
  });

  it("多轮历史下 system + 历史整体前缀稳定，只有末段 user 消息随易变内容变", async () => {
    const sent: string[] = [];
    const eng = makeEngine(NOOP_HOOKS, sent, [L3_TURN1, L3_TURN2]);
    const agent = makeAgent({ sandbox_override: { approval: "auto", workspace: ws } });
    const history = [
      { role: "user" as const, content: "第一轮" },
      { role: "assistant" as const, content: "回复一" },
    ];

    await eng.chat({ agent, message: "之前说过的路径", history, systemPrompt: "", toolsOnly: [] });
    const first = sentMessages(sent);
    await writeFile(join(ws, "beta.txt"), "b", "utf8");
    await eng.chat({ agent, message: "之前说过的路径", history, systemPrompt: "", toolsOnly: [] });
    const second = sentMessages(sent);

    expect(first.length).toBe(4);
    expect(second.length).toBe(4);
    const stableOf = (msgs: Array<{ role: string; content: unknown }>): string =>
      JSON.stringify(msgs.slice(0, 3).map((m) => ({ role: m.role, content: m.content })));
    expect(stableOf(second)).toBe(stableOf(first));
    expect(first[1]!.content).toBe("第一轮");
    expect(first[2]!.content).toBe("回复一");
    expect(second[3]!.role).toBe("user");
    expect(String(second[3]!.content)).toContain("beta.txt");
    expect(String(second[3]!.content)).not.toContain("回复一");
  });

  it("清单 80 行上限仍在易变段里生效（不被截断成占位）", async () => {
    const { getRegistry, resetRegistry } = await import("../../core-ts/src/tools/registry.js");
    const { registerBuiltinTools } = await import("../../core-ts/src/tools/builtin.js");
    resetRegistry();
    registerBuiltinTools();
    const tools = getRegistry();
    for (let i = 0; i < 90; i += 1) {
      await writeFile(join(ws, `f${String(i).padStart(3, "0")}.txt`), String(i), "utf8");
    }
    const listing = await tools.callTool("file_list", { path: ".", _workspace: ws });
    const total = String(listing).split("\n").length;
    expect(total).toBeGreaterThan(80);

    const sent: string[] = [];
    const eng = makeEngine(NOOP_HOOKS, sent, [L3_TURN1]);
    const agent = makeAgent({ sandbox_override: { approval: "auto", workspace: ws } });
    await eng.chat({ agent, message: "之前说过的路径", history: [], systemPrompt: "", toolsOnly: [] });

    const msgs = sentMessages(sent);
    const tail = String(msgs[msgs.length - 1]!.content);
    expect(tail).toContain(`…（共 ${total} 项）`);
    expect(tail).toContain("f000.txt");
    expect(tail).not.toContain("f089.txt");
    expect(String(msgs[0]!.content)).not.toContain("f000.txt");
  });

  it("无易变内容时末段 user 消息逐字节不改写（零回归）", async () => {
    const sent: string[] = [];
    const eng = makeEngine(NOOP_HOOKS, sent, [L3_TURN1]);
    await eng.chat({ agent: makeAgent(), message: "好的", history: [], systemPrompt: "", toolsOnly: [] });
    const msgs = sentMessages(sent);
    expect(msgs[msgs.length - 1]!.content).toBe("好的");
    expect(String(msgs[0]!.content)).toContain("你是 前缀探针");
  });

  it("buildSystemSegments：stable 段不含任何易变内容，volatile 段完整承载", async () => {
    const eng = makeEngine(NOOP_HOOKS, [], [L3_TURN1, L3_TURN2]);
    const agent = makeAgent({ sandbox_override: { approval: "auto", workspace: ws } });
    const seg = await eng.buildSystemSegments(agent, undefined, undefined, "之前说过的路径");
    expect(seg.stable).toContain("你是 前缀探针");
    expect(seg.stable).toContain(DELEGATION_MARK);
    expect(seg.stable).not.toContain("成长记忆");
    expect(seg.stable).not.toContain("alpha.txt");
    expect(seg.volatile).toContain(L3_TURN1);
    expect(seg.volatile).toContain("alpha.txt");
    expect(seg.memory).toBe(L3_TURN1);
    expect(seg.workspace).toContain("alpha.txt");
  });

  it("buildSystem 兼容视图：内容一条不减（老调用方拿到的仍是全量）", async () => {
    const eng = makeEngine(NOOP_HOOKS, [], [L3_TURN1]);
    const agent = makeAgent({ sandbox_override: { approval: "auto", workspace: ws } });
    const full = await eng.buildSystem(agent, undefined, undefined, "之前说过的路径");
    expect(full).toContain("你是 前缀探针");
    expect(full).toContain(L3_TURN1);
    expect(full).toContain("alpha.txt");
    expect(full).toContain("工作目录（workspace）已设置");
    expect(full).toContain(DELEGATION_MARK);
  });
});

describe("D10 · Session.buildSystemPrompt 同族缺陷", () => {
  function makeSession(l3: string[]): { session: Session; sent: Array<{ role: string; content: unknown }> } {
    const sent: Array<{ role: string; content: unknown }> = [];
    const client = new ChatClient({
      baseUrl: "http://127.0.0.1:19100",
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> };
        sent.length = 0;
        for (const m of body.messages ?? []) { sent.push(m); }
        return chatReply("ok");
      }) as unknown as typeof fetch,
    });
    const router = new ModelRouter(
      [{ name: "sidecar", baseUrl: "http://127.0.0.1:19100", kind: "local", priority: 100, roles: ["chat"] }],
      () => client,
    );
    let n = 0;
    const session = new Session({
      router,
      hooks: {
        fixedSegments: () => ["【L1 偏好】用户偏好简洁回答。"],
        retrieveSegments: async () => [l3[Math.min(n++, l3.length - 1)]!],
      },
    });
    return { session, sent };
  }

  it("L3 命中/未命中两轮：stable 段字节一致，L3 只出现在 volatile 段", async () => {
    const { session } = makeSession([L3_TURN1]);
    const hit = await session.buildSystemPromptSegments({ name: "小蓝", role: "资深助手" }, "agent_x", "之前说过的路径");
    const miss = await session.buildSystemPromptSegments({ name: "小蓝", role: "资深助手" }, "agent_x", "好的");
    expect(miss.stable).toBe(hit.stable);
    expect(miss.volatile).toBe("");
    expect(hit.volatile).toBe(L3_TURN1);
    expect(hit.stable).not.toContain("成长记忆");
    expect(hit.stable).toContain("【L1 偏好】用户偏好简洁回答。");
  });

  it("Session.chat：L3 挂末条 user 消息而非 system，历史逐条不动", async () => {
    const { session, sent } = makeSession([L3_TURN1]);
    await session.chat({
      agent: { name: "小蓝", role: "资深助手" },
      agentId: "agent_x",
      history: [
        { role: "user", content: "第一轮" },
        { role: "assistant", content: "回复一" },
        { role: "user", content: "第二轮" },
      ],
      stream: false,
    });
    expect(sent.length).toBe(4);
    expect(sent[0]!.role).toBe("system");
    expect(String(sent[0]!.content)).toContain("你是 小蓝");
    expect(String(sent[0]!.content)).not.toContain("成长记忆");
    expect(sent[1]!.content).toBe("第一轮");
    expect(sent[2]!.content).toBe("回复一");
    const tail = String(sent[3]!.content);
    expect(sent[3]!.role).toBe("user");
    expect(tail).toContain(L3_TURN1);
    expect(tail).toContain("第二轮");
    expect(tail.indexOf(L3_TURN1)).toBeLessThan(tail.indexOf("第二轮"));
  });

  it("Session.chat：历史里没有 user 消息时，易变段另起一条 user 消息承载（内容不丢）", async () => {
    const { session, sent } = makeSession([L3_TURN1]);
    await session.chat({
      agent: { name: "小蓝", role: "资深助手" },
      agentId: "agent_x",
      history: [{ role: "assistant", content: "回复一" }],
      stream: false,
    });
    expect(sent.length).toBe(3);
    expect(sent[1]!.content).toBe("回复一");
    expect(sent[2]!.role).toBe("user");
    expect(String(sent[2]!.content)).toBe(L3_TURN1);
  });

  it("Session.buildSystemPrompt 兼容视图仍含 L3（老调用方零回归）", async () => {
    const { session } = makeSession([L3_TURN1]);
    const sp = await session.buildSystemPrompt({ name: "小蓝", role: "资深助手" }, "agent_x", "之前说过的路径");
    expect(sp).toContain("你是 小蓝");
    expect(sp).toContain(L3_TURN1);
  });
});
