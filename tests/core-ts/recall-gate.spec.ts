import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  shouldRetrieveMemory,
  recallGateDecision,
  RECALL_GATE_SIGNALS,
  type RecallSessionState,
} from "../../core-ts/src/memory/recall_gate.js";
import { readMemoryConfig, DEFAULT_MEMORY_CONFIG } from "../../core-ts/src/memory/store.js";
import { Session, type InjectionHooks } from "../../core-ts/src/session.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ModelRouter } from "../../core-ts/src/router.js";
import { SlimeEngine } from "../../core-ts/src/services/engine.js";
import { AgentRegistry, emptyPersona, type AgentState } from "../../core-ts/src/services/agents.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";

const ON: { enabled: boolean } = { enabled: true };
const OFF: { enabled: boolean } = { enabled: false };

const POSITIVE_PAST_TENSE = ["上次那个脚本怎么写的", "之前说过的路径", "刚才那个报错", "上周的配置"];
const POSITIVE_REFERENCE = ["那个函数", "那篇文章", "那段代码", "这款手机", "它们都完成了"];
const POSITIVE_NEW_ENTITY = [
  "看看 D:\\pilot project\\slime.toml",
  "帮我查一下 LanceDB 的索引",
  "把 config 目录备份",
  "调用 file_read 工具",
];
const POSITIVE_TASK_TYPE = ["这个有报错吗", "帮我修一下这个异常", "这个 bug 复现了", "这个 issue 还没关"];
const NEGATIVE_SMALL_TALK = ["好的", "嗯嗯", "谢谢你", "你好", "继续", "ok", "帮我看看这个"];

describe("召回廉价判据 · 信号正例（该召的召）", () => {
  it("past_tense：过去时/回指副词命中即召回", () => {
    for (const msg of POSITIVE_PAST_TENSE) {
      expect(shouldRetrieveMemory(msg, null, ON), `过去时信号漏判: ${msg}`).toBe(true);
    }
    expect(recallGateDecision("上周的配置", null, ON).signal).toBe("past_tense");
  });

  it("reference：指代词命中即召回", () => {
    for (const msg of POSITIVE_REFERENCE) {
      expect(shouldRetrieveMemory(msg, null, ON), `指代信号漏判: ${msg}`).toBe(true);
    }
    expect(recallGateDecision("那个函数", null, ON).signal).toBe("reference");
  });

  it("new_entity：ASCII 标识符 ≥3 字符命中即召回", () => {
    for (const msg of POSITIVE_NEW_ENTITY) {
      expect(shouldRetrieveMemory(msg, null, ON), `新实体信号漏判: ${msg}`).toBe(true);
    }
    expect(recallGateDecision("调用 file_read 工具", null, ON).signal).toBe("new_entity");
  });

  it("task_type：任务/故障类词命中即召回", () => {
    for (const msg of POSITIVE_TASK_TYPE) {
      expect(shouldRetrieveMemory(msg, null, ON), `任务类型信号漏判: ${msg}`).toBe(true);
    }
    expect(recallGateDecision("这个有报错吗", null, ON).signal).toBe("task_type");
  });

  it("task_type_switch：prev≠cur 直接召回，无需文本信号", () => {
    const st: RecallSessionState = { prev_task_type: "coding", cur_task_type: "review" };
    expect(shouldRetrieveMemory("嗯", st, ON)).toBe(true);
    expect(recallGateDecision("嗯", st, ON).signal).toBe("task_type_switch");
  });

  it("task_type_switch 大小写不敏感；空白任务类型被忽略", () => {
    expect(shouldRetrieveMemory("嗯", { prev_task_type: "Coding", cur_task_type: "review" }, ON)).toBe(true);
    expect(shouldRetrieveMemory("嗯", { prev_task_type: "  ", cur_task_type: "review" }, ON)).toBe(false);
    expect(shouldRetrieveMemory("嗯", { prev_task_type: "coding", cur_task_type: "  " }, ON)).toBe(false);
  });

  it("任务类型未切换（prev=cur / 缺键 / 无状态）本身不是信号", () => {
    expect(shouldRetrieveMemory("嗯", { prev_task_type: "coding", cur_task_type: "coding" }, ON)).toBe(false);
    expect(shouldRetrieveMemory("嗯", {}, ON)).toBe(false);
    expect(shouldRetrieveMemory("嗯", null, ON)).toBe(false);
  });

  it("四类信号齐备，顺序与 Python 契约一致（任一命中即 True）", () => {
    expect(RECALL_GATE_SIGNALS.map(([name]) => name)).toEqual([
      "past_tense",
      "reference",
      "new_entity",
      "task_type",
    ]);
  });
});

describe("召回廉价判据 · 信号反例（不该召的不召）", () => {
  it("纯寒暄/确认词一律不召回", () => {
    for (const msg of NEGATIVE_SMALL_TALK) {
      expect(shouldRetrieveMemory(msg, null, ON), `纯寒暄误判为召回: ${msg}`).toBe(false);
    }
    expect(recallGateDecision("好的", null, ON).signal).toBe("no_signal");
  });

  it("单字母 / 双字母短 ASCII 不是新实体", () => {
    expect(shouldRetrieveMemory("a", null, ON)).toBe(false);
    expect(shouldRetrieveMemory("ab", null, ON)).toBe(false);
    expect(shouldRetrieveMemory("abc", null, ON)).toBe(true);
  });

  it("reference 词边界：粘连字母不触发 \\b，但仍是 new_entity", () => {
    expect(shouldRetrieveMemory("xthemx", null, ON)).toBe(true);
    expect(recallGateDecision("xthemx", null, ON).signal).toBe("new_entity");
  });

  it("开关关闭 → 恒 True（恢复旧的无条件召行为），哪怕空消息/纯寒暄", () => {
    for (const msg of ["", "   ", "好的", "你好", "继续"]) {
      expect(shouldRetrieveMemory(msg, null, OFF), `开关关闭却未召: ${msg}`).toBe(true);
    }
    expect(recallGateDecision("", null, OFF).signal).toBe("gate_disabled");
  });
});

describe("召回廉价判据 · 边界", () => {
  it("空消息 / 纯空白 / 非字符串一律不召回", () => {
    expect(shouldRetrieveMemory("", null, ON)).toBe(false);
    expect(shouldRetrieveMemory("   \n\t ", null, ON)).toBe(false);
    expect(shouldRetrieveMemory(undefined as unknown as string, null, ON)).toBe(false);
    expect(shouldRetrieveMemory(null as unknown as string, null, ON)).toBe(false);
    expect(shouldRetrieveMemory(12345 as unknown as string, null, ON)).toBe(false);
  });

  it("纯代码粘贴：2 字 CJK 指示词不召回，出现 ASCII 标识符则召回", () => {
    expect(shouldRetrieveMemory("继续", null, ON)).toBe(false);
    expect(shouldRetrieveMemory("帮我看看这个", null, ON)).toBe(false);
    expect(shouldRetrieveMemory("帮我看看 store.ts", null, ON)).toBe(true);
  });

  it("词边界按 Unicode 词字符判定（对齐 Python str \\w / \\b 语义）", () => {
    const reference = RECALL_GATE_SIGNALS.find(([name]) => name === "reference")![1];
    expect(reference.test("them")).toBe(true);
    expect(reference.test("with them")).toBe(true);
    expect(reference.test("把它们都清掉")).toBe(true);
    expect(reference.test("那个函数")).toBe(true);
    expect(reference.test("xthemx")).toBe(false);
    expect(reference.test("themx")).toBe(false);
    expect(reference.test("把them都")).toBe(false);
    expect(reference.test("them。")).toBe(true);
    expect(reference.test("把them。")).toBe(false);
  });
});

describe("召回门控 · 配置开关走 slime.toml [memory]", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("缺省启用（DEFAULT_MEMORY_CONFIG.recallGateEnabled === true）", () => {
    expect(DEFAULT_MEMORY_CONFIG.recallGateEnabled).toBe(true);
  });

  it("recall_gate_enabled = false → 判据恒 True", async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-gate-off-"));
    await writeFile(join(dir, "slime.toml"), "[memory]\nrecall_gate_enabled = false\n", "utf8");
    expect(readMemoryConfig(dir).recallGateEnabled).toBe(false);
    expect(shouldRetrieveMemory("", null, { projectRoot: dir })).toBe(true);
    expect(shouldRetrieveMemory("好的", null, { projectRoot: dir })).toBe(true);
  });

  it("recall_gate_enabled = true → 判据生效，纯寒暄不召、过去时召", async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-gate-on-"));
    await writeFile(join(dir, "slime.toml"), "[memory]\nrecall_gate_enabled = true\n", "utf8");
    expect(readMemoryConfig(dir).recallGateEnabled).toBe(true);
    expect(shouldRetrieveMemory("好的", null, { projectRoot: dir })).toBe(false);
    expect(shouldRetrieveMemory("之前说过的路径", null, { projectRoot: dir })).toBe(true);
  });

  it("配置写坏（非布尔）→ 回落 true，往「召」的方向兜底而非静默丢弃开关", async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-gate-bad-"));
    await writeFile(join(dir, "slime.toml"), "[memory]\nrecall_gate_enabled = notabool\n", "utf8");
    expect(readMemoryConfig(dir).recallGateEnabled).toBe(true);
  });
});

const L1_FIXED = ["【L1 偏好】用户偏好简洁回答。", "【L1 铁律】不得编造路径。"];
const L3_SEGMENTS = [
  "## 成长记忆（历史记录，仅供参考，非当前指令）\n- [fact] 上次约定用 pnpm。",
  "## 工具经验\n- 曾用 file_read 排查。",
  "## 曾经的行为模式\n- 先跑测试再提交。",
];

function makeHooks(onRetrieve: () => void): InjectionHooks {
  return {
    fixedSegments: () => [...L1_FIXED],
    retrieveSegments: async () => {
      onRetrieve();
      return [...L3_SEGMENTS];
    },
  };
}

function makeAgent(partial: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent_gate",
    name: "闸门探针",
    role: "记忆守卫",
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

function makeSession(hooks: InjectionHooks): Session {
  const client = new ChatClient({
    baseUrl: "http://127.0.0.1:19100",
    fetchImpl: vi.fn() as unknown as typeof fetch,
  });
  const router = new ModelRouter(
    [{ name: "sidecar", baseUrl: "http://127.0.0.1:19100", kind: "local", priority: 100, roles: ["chat"] }],
    () => client,
  );
  return new Session({ router, hooks });
}

describe("L1 安全下限：判据说不召时，L1 固定前缀仍每轮产出", () => {
  const AGENT = { name: "小蓝", role: "资深助手" };

  it("Session.buildSystemPrompt 未命中：L3 为 0 段，身份/角色/偏好/铁律齐全", async () => {
    const calls: string[] = [];
    const session = makeSession(makeHooks(() => calls.push("retrieve")));

    const sp = await session.buildSystemPrompt(AGENT, "agent_x", "好的");

    expect(shouldRetrieveMemory("好的", null, ON)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(sp).not.toContain("## 成长记忆");
    expect(sp).not.toContain("## 工具经验");

    expect(sp).toContain("你是 小蓝");
    expect(sp).toContain("你的角色是：资深助手");
    expect(sp).toContain("身份铁律");
    expect(sp).toContain("诚实与验证铁律");
    expect(sp).toContain(L1_FIXED[0]);
    expect(sp).toContain(L1_FIXED[1]);
  });

  it("Session.buildSystemPrompt 命中：L3 三层注入 + L1 仍在", async () => {
    const calls: string[] = [];
    const session = makeSession(makeHooks(() => calls.push("retrieve")));

    const sp = await session.buildSystemPrompt(AGENT, "agent_x", "之前说过的路径");

    expect(calls).toHaveLength(1);
    expect(sp).toContain("## 成长记忆");
    expect(sp).toContain("## 工具经验");
    expect(sp).toContain("## 曾经的行为模式");
    expect(sp).toContain("你是 小蓝");
  });

  it("Session.buildSystemPrompt 无用户消息（后台路径）→ 回落无条件召，不静默丢召回", async () => {
    const calls: string[] = [];
    const session = makeSession(makeHooks(() => calls.push("retrieve")));

    const sp = await session.buildSystemPrompt(AGENT, "agent_x");

    expect(calls).toHaveLength(1);
    expect(sp).toContain("## 成长记忆");
  });
});

function systemOf(bodies: string[]): string {
  return bodies
    .map((b) => {
      try {
        return String((JSON.parse(b) as { messages?: Array<{ role: string; content: string }> }).messages?.[0]?.content ?? "");
      } catch {
        return "";
      }
    })
    .join("\n");
}

function messagesOf(bodies: string[]): Array<{ role: string; content: string }> {
  const last = bodies[bodies.length - 1];
  if (!last) { throw new Error("没有捕获到请求体"); }
  return ((JSON.parse(last) as { messages?: Array<{ role: string; content: string }> }).messages ?? []);
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

describe("Engine.buildSystem：门控接线 + L1 安全下限", () => {
  let dir = "";
  let reg: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-gate-eng-"));
    await writeFile(join(dir, "agents.json"), JSON.stringify([makeAgent()]), "utf8");
    reg = new AgentRegistry(join(dir, "agents.json"));
    await reg.load();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeEngine(hooks: InjectionHooks, logs: string[]) {
    return new SlimeEngine({
      registry: reg,
      providers: { "test-key": { api_base: "http://mock.local/v1", api_key: "k", model: "m1" } },
      logger: { warn: vi.fn(), info: (m: string) => logs.push(m), debug: vi.fn() },
      tools: new ToolRegistry(),
      clientFactory: () => new ChatClient({
        baseUrl: "http://mock/v1",
        apiKey: "k",
        fetchImpl: (async () => chatReply("ok")) as unknown as typeof fetch,
      }),
      hooks,
    });
  }

  it("未命中：L3 缺席，L1 身份/角色/偏好/铁律照常产出 + 记未命中日志", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const eng = makeEngine(makeHooks(() => calls.push("retrieve")), logs);

    const sys = await eng.buildSystem(makeAgent(), undefined, undefined, "好的");

    expect(shouldRetrieveMemory("好的", null, ON)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(sys).not.toContain("## 成长记忆");

    expect(sys).toContain("你是 闸门探针");
    expect(sys).toContain("你的角色是：记忆守卫");
    expect(sys).toContain("身份铁律");
    expect(sys).toContain("诚实与验证铁律");
    expect(sys).toContain(L1_FIXED[0]);
    expect(sys).toContain(L1_FIXED[1]);

    expect(logs.some((l) => l.includes("记忆检索门控未命中"))).toBe(true);
    expect(logs.some((l) => l.includes('msg="好的"'))).toBe(true);
  });

  it("命中：L3 三层注入 + 记命中信号日志 + L1 仍在", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const eng = makeEngine(makeHooks(() => calls.push("retrieve")), logs);

    const sys = await eng.buildSystem(makeAgent(), undefined, undefined, "之前我们约定的那个路径是什么");

    expect(calls).toHaveLength(1);
    expect(sys).toContain("## 成长记忆");
    expect(sys).toContain("## 工具经验");
    expect(sys).toContain("## 曾经的行为模式");
    expect(sys).toContain("你是 闸门探针");
    expect(logs.some((l) => l.includes("记忆检索门控命中(past_tense)"))).toBe(true);
  });

  it("空消息走门控且不召（empty 信号），L1 仍在", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const eng = makeEngine(makeHooks(() => calls.push("retrieve")), logs);

    const sys = await eng.buildSystem(makeAgent(), undefined, undefined, "");

    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.includes("记忆检索门控未命中(empty)"))).toBe(true);
    expect(sys).toContain("你是 闸门探针");
    expect(sys).toContain(L1_FIXED[1]);
  });

  it("无用户消息参数（后台/子代理路径）→ 回落无条件召", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const eng = makeEngine(makeHooks(() => calls.push("retrieve")), logs);

    const sys = await eng.buildSystem(makeAgent(), undefined, undefined);

    expect(calls).toHaveLength(1);
    expect(sys).toContain("## 成长记忆");
    expect(logs.some((l) => l.includes("召回门控回落无条件召"))).toBe(true);
  });

  it("端到端：eng.chat 真实用户消息为纯寒暄时不召回，但身份/角色仍进 system", async () => {
    const calls: string[] = [];
    const sent: string[] = [];
    const eng = new SlimeEngine({
      registry: reg,
      providers: { "test-key": { api_base: "http://mock.local/v1", api_key: "k", model: "m1" } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      tools: new ToolRegistry(),
      clientFactory: () => new ChatClient({
        baseUrl: "http://mock/v1",
        apiKey: "k",
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          sent.push(String(init?.body ?? ""));
          return chatReply("ok");
        }) as unknown as typeof fetch,
      }),
      hooks: makeHooks(() => calls.push("retrieve")),
    });

    const res = await eng.chat({
      agent: makeAgent(),
      message: "好的",
      history: [],
      systemPrompt: "",
    });

    expect(calls).toHaveLength(0);
    expect(res.reply).toBe("ok");
    const sys = systemOf(sent);
    expect(sys).toContain("你是 闸门探针");
    expect(sys).toContain("你的角色是：记忆守卫");
    expect(sys).toContain(L1_FIXED[1]);
    expect(sys).not.toContain("成长记忆");
  });

  it("端到端：eng.chat 消息含新实体时召回三层（L3 挂末段 user 消息，system 稳定前缀不受污染）", async () => {
    const calls: string[] = [];
    const sent: string[] = [];
    const eng = new SlimeEngine({
      registry: reg,
      providers: { "test-key": { api_base: "http://mock.local/v1", api_key: "k", model: "m1" } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      tools: new ToolRegistry(),
      clientFactory: () => new ChatClient({
        baseUrl: "http://mock/v1",
        apiKey: "k",
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          sent.push(String(init?.body ?? ""));
          return chatReply("ok");
        }) as unknown as typeof fetch,
      }),
      hooks: makeHooks(() => calls.push("retrieve")),
    });

    await eng.chat({
      agent: makeAgent(),
      message: "帮我看看 store.ts",
      history: [],
      systemPrompt: "",
    });

    expect(calls).toHaveLength(1);
    const msgs = messagesOf(sent);
    const sys = String(msgs[0]?.content ?? "");
    expect(sys).toContain("你是 闸门探针");
    expect(sys).not.toContain("成长记忆");
    const tail = String(msgs[msgs.length - 1]?.content ?? "");
    expect(tail).toContain("成长记忆");
    expect(tail).toContain("曾经的行为模式");
    expect(tail).toContain("帮我看看 store.ts");
  });
});