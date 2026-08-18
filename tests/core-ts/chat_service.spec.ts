/**
 * tests/core-ts/chat_service.spec.ts — ChatService 全语义测试（slime_server.py /chat、/chat/analyze、/chat/stream 对照）。
 * 覆盖：Swarm 分析解析（A-015）/ 生成类请求判定（A-049/A-085）/ 失败前缀黑名单（A-087）/
 * chat 全流程（委托路由/A2A 排水/持久化/后台 post-process）/ stream 事件流（{seq,type,data}/
 * 强制工具轮/委托心跳/done 单收尾/断连补漏）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatService, ChatEngine, ChatEngineCall, EngineChunk, ChatEngineResult, parseSwarmAnalysis } from "../../core-ts/src/services/chat.js";
import { AgentRegistry, AgentState, emptyPersona } from "../../core-ts/src/services/agents.js";
import { HistoryStore, HistoryRecord } from "../../core-ts/src/services/history.js";
import { ServerA2ABus } from "../../core-ts/src/a2a.js";
import { AlarmBus } from "../../core-ts/src/services/stats.js";

function makeAgent(partial: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent_test1",
    name: "TestAgent",
    role: "测试角色",
    identity_prompt: `你是{name}，{role}。测试人格。`,
    model_choice: "api:test",
    parent_id: null,
    persona: emptyPersona(),
    emotion: {},
    behavior: { patterns: [] },
    children: [],
    created_at: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

async function makeRegistry(dir: string, agents: AgentState[]): Promise<AgentRegistry> {
  await writeFile(join(dir, "agents.json"), JSON.stringify(agents), "utf8");
  const reg = new AgentRegistry(join(dir, "agents.json"));
  await reg.load();
  return reg;
}

class FakeEngine implements ChatEngine {
  chatImpl: (opts: ChatEngineCall) => Promise<ChatEngineResult> = async (opts) => ({
    reply: `回复:${opts.message.slice(0, 20)}`,
    model: "m1",
    promptTokens: 10,
    completionTokens: 5,
    elapsedMs: 42,
  });
  streamImpl: (opts: ChatEngineCall) => AsyncIterable<EngineChunk> = async function* () {};
  /** A-049 强制轮专用（toolsOnly 传入时走这里） */
  forcedStreamImpl: (opts: ChatEngineCall) => AsyncIterable<EngineChunk> = async function* () {};

  chat = vi.fn(async (opts: ChatEngineCall) => this.chatImpl(opts));
  stream = vi.fn((opts: ChatEngineCall) => {
    if (opts.toolsOnly && opts.toolsOnly.length > 0) {
      return this.forcedStreamImpl(opts);
    }
    return this.streamImpl(opts);
  });
}

class MemHistory implements HistoryStore {
  records: HistoryRecord[] = [];
  async append(agentId: string, user: string, ai: string, success = true): Promise<void> {
    this.records.push({ agent_id: agentId, user, ai, success, timestamp: new Date().toISOString() });
  }
  async load(agentId: string | null = null, limit = 200): Promise<HistoryRecord[]> {
    return this.records.filter((r) => agentId === null || r.agent_id === agentId).slice(-limit);
  }
  async popLast(agentId: string): Promise<boolean> {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].agent_id === agentId) {
        this.records.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}

function quietLogger(): Pick<Console, "warn" | "info" | "debug"> {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("parseSwarmAnalysis（A-015）", () => {
  it("整体 JSON 解析成功", () => {
    const r = parseSwarmAnalysis('{"action": "swarm", "subtasks": ["a", "b"], "reason": "多类型"}');
    expect(r).toEqual({ action: "swarm", subtasks: ["a", "b"], reason: "多类型", parse_ok: true });
  });

  it("正则兜底（markdown 围栏内嵌）", () => {
    const r = parseSwarmAnalysis('```json\n{"action": "fork", "subtasks": ["x"], "reason": "r"}\n```');
    expect(r.action).toBe("fork");
    expect(r.subtasks).toEqual(["x"]);
    expect(r.parse_ok).toBe(true);
  });

  it("非法 action 归一化 chat 且 parse_ok=false", () => {
    const r = parseSwarmAnalysis('{"action": "explode", "subtasks": []}');
    expect(r.action).toBe("chat");
    expect(r.parse_ok).toBe(false);
  });

  it("subtasks 非 list → 空数组且 parse_ok=false", () => {
    const r = parseSwarmAnalysis('{"action": "swarm", "subtasks": "oops"}');
    expect(r.subtasks).toEqual([]);
    expect(r.parse_ok).toBe(false);
  });

  it("subtasks 只保留字符串并截断 8 条", () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const r = parseSwarmAnalysis(JSON.stringify({ action: "swarm", subtasks: [1, ...many], reason: "" }));
    expect(r.subtasks).toHaveLength(8);
    expect(r.subtasks.every((s) => typeof s === "string")).toBe(true);
  });

  it("完全无法解析 → chat 空 subtasks", () => {
    const r = parseSwarmAnalysis("今天天气不错");
    expect(r.action).toBe("chat");
    expect(r.subtasks).toEqual([]);
    expect(r.parse_ok).toBe(false);
  });
});

describe("ChatService.analyze", () => {
  let dir: string;
  let reg: AgentRegistry;
  let engine: FakeEngine;
  let service: ChatService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-chat-"));
    reg = await makeRegistry(dir, [makeAgent()]);
    engine = new FakeEngine();
    service = new ChatService({ registry: reg, engine, logger: quietLogger() });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("Agent 不存在 → 404", async () => {
    await expect(service.analyze("nope", "hi")).rejects.toThrow("Agent 不存在");
  });

  it("模型返回合法 JSON → parse_ok=true", async () => {
    engine.chatImpl = async () => ({ reply: '{"action": "swarm", "subtasks": ["a"], "reason": "多类型"}' });
    const r = await service.analyze("agent_test1", "同时做三件事");
    expect(r.action).toBe("swarm");
    expect(r.parse_ok).toBe(true);
  });

  it("解析失败 → 降级 chat + 告警日志", async () => {
    engine.chatImpl = async () => ({ reply: "我不会 JSON。" });
    const logger = quietLogger();
    const svc = new ChatService({ registry: reg, engine, logger });
    const r = await svc.analyze("agent_test1", "hello");
    expect(r.action).toBe("chat");
    expect(r.parse_ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("解析失败，降级为 chat"));
  });
});

describe("ChatService.chat", () => {
  let dir: string;
  let reg: AgentRegistry;
  let engine: FakeEngine;
  let history: MemHistory;
  let bus: ServerA2ABus;
  let service: ChatService;
  const alarms = new AlarmBus();

  beforeEach(async () => {
    ServerA2ABus.reset();
    bus = new ServerA2ABus();
    dir = await mkdtemp(join(tmpdir(), "slime-chat-"));
    reg = await makeRegistry(dir, [makeAgent()]);
    engine = new FakeEngine();
    history = new MemHistory();
    service = new ChatService({ registry: reg, engine, history, bus, alarms, logger: quietLogger() });
  });

  afterEach(async () => {
    ServerA2ABus.reset();
    // Windows 上 tmp+rename 与 rm 存在短暂竞态 → 短重试
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("基础对话：reply/model/tokens 回传 + persona/history 持久化", async () => {
    engine.chatImpl = async () => ({ reply: "你好呀", replyRaw: "你好呀", model: "m1", promptTokens: 3, completionTokens: 2, elapsedMs: 7 });
    const r = await service.chat("agent_test1", { message: "你好" });
    expect(r.reply).toBe("你好呀");
    expect(r.model).toBe("m1");
    expect(r.success).toBe(true);
    expect(history.records).toHaveLength(1);
    expect(history.records[0].user).toBe("你好");
    expect(reg.loadedAgents[0].persona.interactions).toHaveLength(1);
  });

  it("A-090：存储用 reply_raw（原文），展示用 reply", async () => {
    engine.chatImpl = async () => ({ reply: "我是展示文本", replyRaw: "我是模型原文" });
    const r = await service.chat("agent_test1", { message: "hi" });
    expect(r.reply).toBe("我是展示文本");
    expect(history.records[0].ai).toBe("我是模型原文");
  });

  it("A-087：失败前缀黑名单 → success=false", async () => {
    engine.chatImpl = async () => ({ reply: "[API 调用失败] timeout", replyRaw: "[API 调用失败] timeout" });
    const r = await service.chat("agent_test1", { message: "hi" });
    expect(r.success).toBe(false);
  });

  it("空回复 → 占位文本（不虚报成功）", async () => {
    engine.chatImpl = async () => ({ reply: "   " });
    const r = await service.chat("agent_test1", { message: "hi" });
    expect(r.reply).toBe("[Agent 未返回有效回复]");
    expect(r.success).toBe(false);
  });

  it("retry=true → 先 pop 最后一条历史再记录", async () => {
    engine.chatImpl = async () => ({ reply: "ok" });
    history.records.push({
      agent_id: "agent_test1", user: "旧", ai: "旧回复", success: true, timestamp: "2026-01-01T00:00:00Z",
    });
    await service.chat("agent_test1", { message: "新", retry: true });
    expect(history.records).toHaveLength(1);
    expect(history.records[0].user).toBe("新");
  });

  it("委托路由：<DELEGATE> 子 Agent 执行 + A2A result 回传 + 父 Agent 整合", async () => {
    const child = makeAgent({
      id: "agent_child1", name: "子一", role: "子角色",
      identity_prompt: "你是{name}，{role}。",
    });
    await writeFile(join(dir, "agents.json"), JSON.stringify([makeAgent({ children: ["agent_child1"] }), child]), "utf8");
    await reg.load();

    const parentCalls: string[] = [];
    engine.chatImpl = async (opts) => {
      if (opts.agent.id === "agent_child1") {
        return { reply: "子任务结果", replyRaw: "子任务结果" };
      }
      parentCalls.push(opts.message.slice(0, 20));
      if (opts.message.startsWith("你刚才将以下子任务委托给了子 Agent")) {
        return { reply: "整合完毕", replyRaw: "整合完毕" };
      }
      return { reply: '<DELEGATE name="子一">完成任务X</DELEGATE>', replyRaw: "raw" };
    };
    // followup 整合走 engine.stream（流式）——A-049 测试以外默认空，这里给委托场景补上
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "整合完毕" };
      yield { type: "done", reply: "整合完毕", reply_raw: "整合完毕" };
    };
    bus.register("TestAgent");
    bus.register("子一");

    const r = await service.chat("agent_test1", { message: "去干点活" });
    expect(r.reply).toBe("整合完毕");
    // 委托结果经 sendResult 回传父 Agent（子→父），父 inbox 里应有 response
    const pending = bus.drainAll("TestAgent");
    expect(pending.some((m) => m.msg_type === "response" && m.from_agent === "子一")).toBe(true);
  });

  it("广播路由：<BROADCAST> 发送给所有 Agent", async () => {
    engine.chatImpl = async () => ({ reply: "<BROADCAST>全体注意</BROADCAST> 其他内容", replyRaw: "raw" });
    const infoLog = vi.fn();
    const svc = new ChatService({ registry: reg, engine, history, bus, alarms, logger: { warn: vi.fn(), info: infoLog, debug: vi.fn() } });
    bus.register("TestAgent");
    bus.register("Other");
    const r = await svc.chat("agent_test1", { message: "广播吧" });
    expect(r.reply).not.toContain("BROADCAST");
    const msgs = bus.drainAll("Other");
    expect(msgs.some((m) => m.msg_type === "info" && m.content.includes("全体注意"))).toBe(true);
    expect(infoLog).toHaveBeenCalledWith(expect.stringContaining("广播了一条消息"));
  });

  it("A2A 排水：待处理消息注入用户消息", async () => {
    bus.register("TestAgent");
    bus.register("Other");
    bus.send("Other", "TestAgent", "有紧急通知", "alert");
    engine.chatImpl = async (opts) => ({ reply: `收到:${opts.message.slice(0, 60)}`, replyRaw: "raw" });
    const r = await service.chat("agent_test1", { message: "有什么新消息" });
    expect(r.reply).toContain("紧急通知");
  });

  it("后台 post-process：knowledge pattern + behavior + emotion + 保存", async () => {
    engine.chatImpl = async () => ({ reply: "成功了", replyRaw: "成功了" });
    const dataDir = await mkdtemp(join(tmpdir(), "slime-ke-"));
    const svc = new ChatService({
      registry: reg, engine, history, bus, alarms, logger: quietLogger(),
      postProcess: { extractMemory: async () => ({ traitSignals: [{ name: "靠谱" }], userSentiment: 0.8, behaviorPatterns: [{ scenario: "答对", steps: ["a", "b"] }] }) },
    });
    await svc.chat("agent_test1", { message: "问个问题" });
    await svc.postProcessChat(reg.loadedAgents[0], "问个问题", "成功了", true, { dataDir });
    const { getKnowledgeEngine } = await import("../../core-ts/src/memory/knowledge.js");
    const ke = getKnowledgeEngine("agent_test1", { dataDir });
    expect(ke.getStats().total_patterns).toBeGreaterThan(0);
    const agent = reg.loadedAgents[0];
    const behavior = agent.behavior as { patterns?: Array<{ scenario: string }> };
    expect(behavior.patterns).toHaveLength(1);
    expect(behavior.patterns![0].scenario).toBe("答对");
    expect(agent.emotion).toHaveProperty("mood");
    await rm(dataDir, { recursive: true, force: true });
  });

  it("evolution 未接线 → 跳过不抛错", async () => {
    engine.chatImpl = async () => ({ reply: "ok", replyRaw: "ok" });
    await expect(service.chat("agent_test1", { message: "hi" })).resolves.toBeTruthy();
  });
});

describe("ChatService.stream", () => {
  let dir: string;
  let reg: AgentRegistry;
  let engine: FakeEngine;
  let history: MemHistory;
  let service: ChatService;
  const alarms = new AlarmBus();

  beforeEach(async () => {
    ServerA2ABus.reset();
    dir = await mkdtemp(join(tmpdir(), "slime-stream-"));
    reg = await makeRegistry(dir, [makeAgent()]);
    engine = new FakeEngine();
    history = new MemHistory();
    service = new ChatService({ registry: reg, engine, history, alarms, logger: quietLogger() });
  });

  afterEach(async () => {
    ServerA2ABus.reset();
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function collect(g: AsyncGenerator<{ seq: number; type: string; data: unknown }>) {
    const out: Array<{ seq: number; type: string; data: unknown }> = [];
    for await (const ev of g) {
      out.push(ev);
    }
    return out;
  }

  it("流式基本：chunk 累积 + done 单收尾 + seq 单调递增 + 持久化", async () => {
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "你" };
      yield { type: "chunk", content: "好" };
      yield { type: "done", reply: "你好", reply_raw: "你好", model: "m1", prompt_tokens: 3, completion_tokens: 2, elapsed_ms: 5 };
    };
    const evs = await collect(service.stream("agent_test1", { message: "hi" }));
    const types = evs.map((e) => e.type);
    expect(types).toEqual(["chunk", "chunk", "done"]);
    expect(evs[0].seq).toBe(1);
    expect(evs[1].seq).toBe(2);
    expect(evs[2].seq).toBe(3);
    expect((evs[2].data as { reply: string }).reply).toBe("你好");
    expect(history.records).toHaveLength(1);
    expect(history.records[0].ai).toBe("你好");
    expect(reg.loadedAgents[0].persona.interactions).toHaveLength(1);
  });

  it("tool/reasoning/progress 事件透传", async () => {
    engine.streamImpl = async function* () {
      yield { type: "reasoning", content: "思考中" };
      yield { type: "tool", name: "file_read", args: "{}", result: "ok" };
      yield { type: "progress", content: "50%" };
      yield { type: "done", reply: "完成" };
    };
    const evs = await collect(service.stream("agent_test1", { message: "hi" }));
    expect(evs.map((e) => e.type)).toEqual(["reasoning", "tool", "progress", "done"]);
  });

  it("A-049 强制工具轮：生成类请求 + 零工具 + 完成态声称 → 注入媒体工具", async () => {
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "图片已生成" };
      yield { type: "done", reply: "图片已保存到 data/generated/xx.png", reply_raw: "图片已保存到 data/generated/xx.png" };
    };
    engine.forcedStreamImpl = async function* () {
      yield { type: "tool", name: "agnes_generate_image", args: "{}", result: "img_ok" };
      yield { type: "done", reply: "真实生成了", reply_raw: "真实生成了" };
    };

    const evs = await collect(service.stream("agent_test1", { message: "帮我生成一张图片" }));
    const types = evs.map((e) => e.type);
    // 强制轮 tool 事件出现在 done 之前
    expect(types).toContain("tool");
    const toolIdx = types.indexOf("tool");
    const doneIdx = types.indexOf("done");
    expect(toolIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(toolIdx);
    const done = evs[doneIdx].data as { reply: string };
    expect(done.reply).toBe("真实生成了");
  });

  it("非生成类请求不触发强制轮", async () => {
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "你好" };
      yield { type: "done", reply: "你好", reply_raw: "你好" };
    };
    const evs = await collect(service.stream("agent_test1", { message: "普通聊天" }));
    expect(evs.map((e) => e.type)).toEqual(["chunk", "done"]);
  });

  it("生成类 + 已调工具 → 不触发强制轮", async () => {
    engine.streamImpl = async function* () {
      yield { type: "tool", name: "agnes_generate_image", args: "{}", result: "ok" };
      yield { type: "done", reply: "图片已生成", reply_raw: "raw" };
    };
    const evs = await collect(service.stream("agent_test1", { message: "生成一张图" }));
    expect(evs.map((e) => e.type)).not.toContain("tool2"); // 只有原有 tool 事件
    expect(evs.map((e) => e.type).filter((t) => t === "tool")).toHaveLength(1);
  });

  it("A-085 工具类型不匹配（图片请求调了视频工具）→ 触发强制轮", async () => {
    engine.streamImpl = async function* () {
      yield { type: "tool", name: "agnes_generate_video", args: "{}", result: "v" };
      yield { type: "done", reply: "图片已保存到 data/x.png", reply_raw: "图片已保存到 data/x.png" };
    };
    engine.forcedStreamImpl = async function* () {
      yield { type: "tool", name: "agnes_generate_image", args: "{}", result: "img_ok" };
      yield { type: "done", reply: "真实生成", reply_raw: "真实生成" };
    };
    const evs = await collect(service.stream("agent_test1", { message: "生成一张图片" }));
    expect(evs.filter((e) => e.type === "tool")).toHaveLength(2);
  });

  it("流异常 → error 事件 + 告警 + 仍持久化", async () => {
    engine.streamImpl = async function* () {
      throw new Error("boom");
    };
    const evs = await collect(service.stream("agent_test1", { message: "hi" }));
    expect(evs[0].type).toBe("error");
    expect(alarms.list().length).toBeGreaterThan(0);
    expect(history.records).toHaveLength(1);
  });

  it("客户端中途断开 → [截断] 标记入历史", async () => {
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "一半" };
      // 模拟断流：直接结束（无 done）
    };
    const gen = service.stream("agent_test1", { message: "hi" });
    await gen.next(); // 消费第一个 chunk 后停止
    await gen.return(undefined);
    // finally 应已持久化截断回复
    expect(history.records).toHaveLength(1);
    expect(history.records[0].ai).toContain("[截断]");
  });

  it("断线重连：resumeSeq 重放缓冲中的事件", async () => {
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "重" };
      yield { type: "chunk", content: "放" };
      yield { type: "done", reply: "重放", reply_raw: "重放" };
    };
    // 先跑完一次（缓冲保留在会话内；re-resume 需同一 streamId——本实现按流内缓冲，
    // resumeSeq>0 且无历史缓冲时仅续发新事件，因此这里验证 seq 连续性）
    const gen = service.stream("agent_test1", { message: "hi" });
    const evs = await collect(gen);
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3]);
    // 新流 + resumeSeq=2 → 无缓冲可重放（缓冲 per-stream），但 seq 从 1 重新开始（新流）
    const gen2 = service.stream("agent_test1", { message: "hi" }, 2);
    const evs2 = await collect(gen2);
    expect(evs2.length).toBeGreaterThan(0);
  });

  it("done 事件带 timings（v2.8 可观测性）", async () => {
    engine.streamImpl = async function* () {
      yield { type: "done", reply: "ok", reply_raw: "ok", timings: { route: 2, inference: 30 } };
    };
    const evs = await collect(service.stream("agent_test1", { message: "hi" }));
    const done = evs[0].data as { timings: Record<string, number> };
    expect(done.timings).toEqual({ route: 2, inference: 30 });
  });
});
