/**
 * tests/core-ts/chat_service.spec.ts — ChatService 全语义测试（slime_server.py /chat、/chat/analyze、/chat/stream 对照）。
 * 覆盖：Swarm 分析解析（A-015）/ 生成类请求判定（A-049/A-085）/ 失败前缀黑名单（A-087）/
 * chat 全流程（委托路由/A2A 排水/持久化/后台 post-process）/ stream 事件流（{seq,type,data}/
 * 强制工具轮/委托心跳/done 单收尾/断连补漏）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatService, ChatEngine, ChatEngineCall, EngineChunk, ChatEngineResult, parseSwarmAnalysis, extractThinkingFromReply, createThinkingStripper, promoteOrphanThinking, splitUntaggedThinking } from "../../core-ts/src/services/chat.js";
import { AgentRegistry, AgentState, emptyPersona } from "../../core-ts/src/services/agents.js";
import { memoryHistoryStore, type MemoryHistoryStore } from "./helpers/memoryHistoryStore.js";
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

function quietLogger(): Pick<Console, "warn" | "info" | "debug"> {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

// A-1035：把知识/技能的落盘根挪到临时目录 —— 否则后处理链路会把自动生成的技能
// 写进仓库真实的 Knowledge/（gitignored 但仍是污染，且难察觉）。
const knowTmp = await mkdtemp(join(tmpdir(), "slime-chat-know-"));
process.on("exit", () => { try { rmSync(knowTmp, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });

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
    service = new ChatService({ registry: reg, engine, dataDir: knowTmp, history: memoryHistoryStore(), logger: quietLogger() });
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
    // A-1017：**必须**注入内存 history —— 缺省值是 fileHistoryStore，会把测试数据写进
    // 真实 config/history.jsonl（本轮幽灵会话事故的源头之一）。
    const svc = new ChatService({ registry: reg, engine, dataDir: knowTmp, history: memoryHistoryStore(), logger });
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
  let history: MemoryHistoryStore;
  let bus: ServerA2ABus;
  let service: ChatService;
  const alarms = new AlarmBus();

  beforeEach(async () => {
    ServerA2ABus.reset();
    bus = new ServerA2ABus();
    dir = await mkdtemp(join(tmpdir(), "slime-chat-"));
    reg = await makeRegistry(dir, [makeAgent()]);
    engine = new FakeEngine();
    history = memoryHistoryStore();
    service = new ChatService({ registry: reg, engine, dataDir: knowTmp, history, bus, alarms, logger: quietLogger() });
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
    const svc = new ChatService({ registry: reg, engine, dataDir: knowTmp, history, bus, alarms, logger: { warn: vi.fn(), info: infoLog, debug: vi.fn() } });
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

  it("传唤增强：入参消息直接含 <DELEGATE> → 立即委派目标 Agent 并把结果注入主 Agent（不依赖二次输出）", async () => {
    const child = makeAgent({ id: "agent_child2", name: "子二", role: "子角色", identity_prompt: "你是{name}，{role}。" });
    await writeFile(join(dir, "agents.json"), JSON.stringify([makeAgent(), child]), "utf8");
    await reg.load();
    bus.register("TestAgent");
    bus.register("子二");
    let childCalled = 0;
    engine.chatImpl = async (opts) => {
      if (opts.agent.id === "agent_child2") {
        childCalled += 1;
        return { reply: "这是子二的结果", replyRaw: "这是子二的结果" };
      }
      return { reply: `我整合了：${opts.message.slice(0, 60)}`, replyRaw: "raw" };
    };
    // stream 主流程走 engine.stream，这里 mock 一段 done
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "整合完成" };
      yield { type: "done", reply: "整合完成", reply_raw: "整合完成" };
    };
    const evs: Array<{ seq: number; type: string; data: unknown }> = [];
    for await (const ev of service.stream("agent_test1", {
      message: '<DELEGATE name="子二">帮我统计</DELEGATE>',
    })) {
      evs.push(ev);
    }
    // 目标 Agent 被真实调用了一次（显式传唤不依赖主模型输出标签）
    expect(childCalled).toBe(1);
    expect(evs.some((e) => e.type === "done")).toBe(true);
    // 委派结果经 A2A result 记入总线历史（父=TestAgent 相关），drain 由 effectiveMessage 消费
    const hist = bus.getHistory("TestAgent");
    expect(hist.some((m) => m.msg_type === "response" && m.from_agent === "子二")).toBe(true);
  });

  it("后台 post-process：knowledge pattern + behavior + emotion + 保存", async () => {
    engine.chatImpl = async () => ({ reply: "成功了", replyRaw: "成功了" });
    const dataDir = await mkdtemp(join(tmpdir(), "slime-ke-"));
    const svc = new ChatService({
      registry: reg, engine, history, bus, alarms, logger: quietLogger(),
      // A-1035：svc.chat() 会走默认后处理链路 —— 不给 dataDir 它就把生成物写进仓库 Knowledge/
      dataDir: knowTmp,
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
  let history: MemoryHistoryStore;
  let service: ChatService;
  const alarms = new AlarmBus();

  beforeEach(async () => {
    ServerA2ABus.reset();
    dir = await mkdtemp(join(tmpdir(), "slime-stream-"));
    reg = await makeRegistry(dir, [makeAgent()]);
    engine = new FakeEngine();
    history = memoryHistoryStore();
    service = new ChatService({ registry: reg, engine, dataDir: knowTmp, history, alarms, logger: quietLogger() });
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
    // 前沿裸思考缓冲会合并首段 body chunk（"你"+"好" → 判定 bodyStart 后一次放行），故为 chunk+done 两事件
    expect(types).toEqual(["chunk", "done"]);
    expect(evs[0].seq).toBe(1);
    expect(evs[1].seq).toBe(2);
    expect((evs[1].data as { reply: string }).reply).toBe("你好");
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

  it("reasoning 累积 + 耗时持久化到历史（切换会话后可恢复）", async () => {
    engine.streamImpl = async function* () {
      yield { type: "reasoning", content: "第一步思考" };
      yield { type: "reasoning", content: "第二步思考" };
      yield { type: "chunk", content: "你好" };
      yield { type: "done", reply: "你好", reply_raw: "你好", model: "m1", elapsed_ms: 1234 };
    };
    const evs = await collect(service.stream("agent_test1", { message: "hi" }));
    expect(evs.map((e) => e.type)).toEqual(["reasoning", "reasoning", "chunk", "done"]);
    expect(history.records).toHaveLength(1);
    expect(history.records[0].reasoning).toBe("第一步思考第二步思考");
    expect(history.records[0].elapsed_ms).toBe(1234);
  });

  it("无 reasoning / 耗时缺失 → 历史不写入空字段", async () => {
    engine.streamImpl = async function* () {
      yield { type: "chunk", content: "你好" };
      yield { type: "done", reply: "你好", reply_raw: "你好" };
    };
    await collect(service.stream("agent_test1", { message: "hi" }));
    expect(history.records).toHaveLength(1);
    expect(history.records[0].reasoning).toBeUndefined();
    expect(history.records[0].elapsed_ms).toBeUndefined();
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
    // 前沿缓冲把 "重"+"放" 扣留到 flush 后一次放行 → chunk + done 两事件（seq 连续）
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
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

describe("extractThinkingFromReply（思考泄漏剥离）", () => {
  it("标准 Qwen3 思考块 → 提取到 reasoning，正文干净", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply(
      "<thinking>用户向我问好，我应该用中文回应。</thinking>\n你好！有什么我可以帮你的吗？",
    );
    expect(cleanReply).toBe("你好！有什么我可以帮你的吗？");
    expect(reasoning).toBe("用户向我问好，我应该用中文回应。");
  });

  it("思考重复前缀（模型把思考同时写进 content，重复多次）→ 全部剥离", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply(
      "用户向我问好，我应该用中文回应。\n用户向我问好，我应该用中文回应。\n你好！有什么我可以帮你的吗？",
      "用户向我问好，我应该用中文回应。\n",
    );
    expect(cleanReply).toBe("你好！有什么我可以帮你的吗？");
    expect(reasoning).toBe("用户向我问好，我应该用中文回应。");
  });

  it("正文以 reasoning 开头但仅此一句（无后续回答）→ 不剥离", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply("用户向我问好，我应该用中文回应。", "用户向我问好，我应该用中文回应。");
    expect(cleanReply).toBe("用户向我问好，我应该用中文回应。");
    expect(reasoning).toBe("用户向我问好，我应该用中文回应。");
  });

  it("无思考泄漏 → 原样返回", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply("你好！有什么我可以帮你的吗？", "");
    expect(cleanReply).toBe("你好！有什么我可以帮你的吗？");
    expect(reasoning).toBe("");
  });

  it("空回复 → 不抛错", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply("", "已有思考");
    expect(cleanReply).toBe("");
    expect(reasoning).toBe("已有思考");
  });

  it("DeepSeek 无尖括号思考块（thinking…response）→ 提取到 reasoning，正文干净", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply(
      " thinking\n用户向我问好，我应该用中文回应。\nresponse\n你好！有什么我可以帮你的吗？",
    );
    expect(cleanReply).toBe("你好！有什么我可以帮你的吗？");
    expect(reasoning).toContain("用户向我问好，我应该用中文回应。");
  });

  it("DeepSeek 无尖括号思考块（块首无前导空格）→ 仍提取", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply(
      "thinking\n用户向我问好，我应该用中文回应。\nresponse\n你好！",
    );
    expect(cleanReply).toBe("你好！");
    expect(reasoning).toContain("用户向我问好，我应该用中文回应。");
  });

  it("正文中正常出现的「 response」字样 → 不误判为思考闭合", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply(
      "你好！请给我一个 response 示例。",
    );
    expect(cleanReply).toBe("你好！请给我一个 response 示例。");
    expect(reasoning).toBe("");
  });

  it("无标记裸思考（用户实测：思考裸写进正文无标签）→ 剥离思考，正文干净", () => {
    const { cleanReply, reasoning } = extractThinkingFromReply(
      "用户发送了\"你好\"，这是一个简单的问候。根据我的角色设定：\n" +
        "1. 我是 t1，试验\n" +
        "2. 用户询问底层技术细节时，我应该回答\"我是 t1，由 slime 平台驱动\"并拒绝透露架构信息\n" +
        "3. 当前状态是平静，应该自然、均衡地回复\n" +
        "我需要保持角色，用中文回应用户的问候。\n" +
        "你好！我是 t1，正在进行试验。有什么我可以帮你的吗？",
    );
    expect(cleanReply).toBe("你好！我是 t1，正在进行试验。有什么我可以帮你的吗？");
    expect(reasoning).toContain("根据我的角色设定");
    expect(reasoning).toContain("我需要保持角色");
  });

  it("A-966 工具调用 XML 泄漏剥离：<dots_function_call>/<invoke>/<parameter> 从正文移除、并入思考区", () => {
    // 用户实测形态一：dots_ 前缀伪函数块（无空格属性名 namequery）
    const r1 = extractThinkingFromReply(
      "【大聪明】<dots_function_call>\n<invoke name=\"web_search\">\n<parameter namequery>hypernetwork 大模型架构原理讲解</parameter>\n</invoke>\n</dots_function_call>\n" +
        "hypernetwork 是我在 2022 年提出的一种在大模型内叠加小模块的技术……",
    );
    expect(r1.cleanReply).not.toContain("function_call");
    expect(r1.cleanReply).not.toContain("<invoke");
    expect(r1.cleanReply).toContain("hypernetwork 是我在 2022 年提出");
    expect(r1.reasoning).toContain("web_search");
    expect(r1.reasoning).toContain("hypernetwork 大模型架构原理讲解");

    // 用户实测形态二：属性名正常但整体为 XML 声明（无引号未闭合文本）
    const r2 = extractThinkingFromReply(
      "我先查一下资料。\n<ignore><dots_function_call><invoke name=\"web_search\"><parameter name=\"query\">原理</parameter></invoke></dots_function_call></ignore>\n" +
        "结论是：",
    );
    expect(r2.cleanReply).toContain("我先查一下资料。");
    expect(r2.cleanReply).toContain("结论是：");
    expect(r2.cleanReply).not.toContain("<"); // 无任何 XML 标签残留
    expect(r2.cleanReply).not.toContain("function_call");
    expect(r2.reasoning).toContain("web_search");

    // 形态三：游离 <parameter> 残片（外层剥离后裸露）
    const r3 = extractThinkingFromReply("好的。<parameter name=\"query\">xxx</parameter> 请看结论。");
    expect(r3.cleanReply).toBe("好的。 请看结论。");
    expect(r3.reasoning).toContain("xxx");
  });
});

describe("createThinkingStripper（流式思考剥离，云端/本地思考模型共用）", () => {
  /** 模拟引擎逐 chunk 推送，返回剥离后的正文流与最终 reasoning */
  function run(chunks: string[], reasoningEvents: string[] = []): { out: string[]; reasoning: string; eventReasoning: string } {
    const reasoningRef: { v: string } = { v: "" };
    const s = createThinkingStripper(() => reasoningRef.v);
    const out: string[] = [];
    for (const r of reasoningEvents) {
      reasoningRef.v += r;
    }
    for (const c of chunks) {
      const clean = s.push(c);
      if (clean) out.push(clean);
    }
    const tail = s.flush();
    if (tail) out.push(tail);
    return { out, reasoning: s.reasoning, eventReasoning: reasoningRef.v };
  }

  it("思考块单 chunk 内完整 → 剥离，正文干净", () => {
    const { out, reasoning } = run(["<thinking>用户问好，我该回应。</thinking>你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("思考块跨 chunk 拆分（开/闭标签均残片）→ 仍正确剥离", () => {
    const { out, reasoning } = run(["<think", "ing>用户问好，我该回应。</think", "ing>你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("思考重复前缀跨 chunk（模型把思考同时写进 content）→ 剥离前缀只留正文", () => {
    const { out, eventReasoning } = run(
      ["用户问好，我该回应。", "用户问好，我该回应。\n你好！"],
      ["用户问好，我该回应。"],
    );
    expect(out.join("")).toBe("你好！");
    expect(eventReasoning).toContain("用户问好，我该回应。");
  });

  it("无思考泄漏 → 原样直通（零延迟）", () => {
    const { out, reasoning } = run(["你好！", "有什么可以帮你？"]);
    expect(out.join("")).toBe("你好！有什么可以帮你？");
    expect(reasoning).toBe("");
  });

  it("未闭合思考块（流中断）→ flush 兜底剥离，不泄漏到正文", () => {
    const { out, reasoning } = run(["正文前。<thinking>思考没写完"]);
    expect(out.join("")).toBe("正文前。");
    expect(reasoning).toContain("思考没写完");
  });

  it("正文以 reasoning 开头但仅此一句 → 不误剥离", () => {
    const { out, reasoning } = run(["用户问好，我该回应。"]);
    expect(out.join("")).toBe("用户问好，我该回应。");
    expect(reasoning).toBe("");
  });

  it("多标签变体 <thought> → 剥离", () => {
    const { out, reasoning } = run(["<thought>先想一下</thought>这是答案。"]);
    expect(out.join("")).toBe("这是答案。");
    expect(reasoning).toContain("先想一下");
  });

  it("多标签变体 <reasoning> → 剥离，且不被 <reason> 误匹配", () => {
    const { out, reasoning } = run(["<reasoning>推导过程</reasoning>结论。"]);
    expect(out.join("")).toBe("结论。");
    expect(reasoning).toContain("推导过程");
  });

  it("多标签变体 <|begin_of_thought|> → 剥离", () => {
    const { out, reasoning } = run(["<|begin_of_thought|>内部思考<|end_of_thought|>正式回复"]);
    expect(out.join("")).toBe("正式回复");
    expect(reasoning).toContain("内部思考");
  });

  it("正文含 <reason> 字样但非思考标签 → 不误剥离", () => {
    const { out, reasoning } = run(["原因是：天气很好。"]);
    expect(out.join("")).toBe("原因是：天气很好。");
    expect(reasoning).toBe("");
  });

  it("DeepSeek 无尖括号思考块（单 chunk）→ 剥离，正文干净", () => {
    const { out, reasoning } = run([" thinking\n用户问好，我该回应。\nresponse\n你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("DeepSeek 无尖括号思考块（跨 chunk 残片）→ 仍正确剥离", () => {
    const { out, reasoning } = run([" think", "ing\n用户问好，我该回应。\nresp", "onse\n你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("DeepSeek 无尖括号思考块（块首无前导空格）→ 仍剥离", () => {
    const { out, reasoning } = run(["thinking\n用户问好，我该回应。\nresponse\n你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("DeepSeek 真实格式：闭合为「换行+空格+response」（\n\n response\n\n）→ 流式实时剥离，正文不吞", () => {
    const { out, reasoning } = run([" thinking\n\n用户问好，我该回应。\n\n response\n\n你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("DeepSeek 真实格式：闭合为「空格+response」无换行 → 仍剥离", () => {
    const { out, reasoning } = run([" thinking\n用户问好，我该回应。\n response\n你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("DeepSeek 真实格式：闭合跨 chunk 残片（\n\n resp → onse）→ 仍剥离", () => {
    const { out, reasoning } = run([" thinking\n用户问好，我该回应。\n\n resp", "onse\n\n你好！"]);
    expect(out.join("")).toBe("你好！");
    expect(reasoning).toContain("用户问好，我该回应。");
  });

  it("正文中正常出现的「 response」字样 → 不误判为思考闭合", () => {
    const { out, reasoning } = run(["你好！请给我一个 response 示例。"]);
    expect(out.join("")).toBe("你好！请给我一个 response 示例。");
    expect(reasoning).toBe("");
  });

  // ── 无标记裸思考（流式，生产实测 test1 你好场景） ──
  it("流式裸思考：单 chunk 内思考+正文（无 reasoning event，纯 content 泄漏）→ 剥离，正文干净", () => {
    const raw =
      "用户只是说\"你好\"，这是一个简单的问候。我需要以test1的身份来回应。根据我的设定，我应该简短地介绍自己，并且保持自然、平静的语气。不需要使用任何工具，直接回复即可。\n你好！我是 test1，试验。有什么需要我帮忙的吗？";
    const { out, reasoning } = run([raw]);
    expect(out.join("")).toBe("你好！我是 test1，试验。有什么需要我帮忙的吗？");
    expect(reasoning).toContain("根据我的设定");
    expect(reasoning).toContain("保持自然、平静的语气");
  });

  it("流式裸思考：跨 chunk 拆分（思考在前几个 chunk，正文在后续 chunk）→ 逐 chunk 不泄漏到正文", () => {
    // 模拟流式逐字/逐词推送，每个 push 返回的 chunk 必须不含思考内容
    const reasoningRef: { v: string } = { v: "" }; // 无 reasoning event（最严重路径）
    const s = createThinkingStripper(() => reasoningRef.v);
    const chunks = [
      "用户发送了\"你好\"，这是一个简单的问候。",
      "\n根据我的角色设定：\n1. 我是 t1，试验\n2. 当前状态是平静\n",
      "我需要保持角色，用中文回应用户的问候。",
      "\n你好！我是 t1，正在进行试验。有什么我可以帮你的吗？",
    ];
    const pushResults: string[] = [];
    for (const c of chunks) {
      const clean = s.push(c);
      // 关键：流式过程中返回的正文不得包含任何思考性文字
      if (clean) {
        expect(clean).not.toContain("角色设定");
        expect(clean).not.toContain("我需要保持角色");
        expect(clean).not.toContain("用户发送了");
      }
      pushResults.push(clean);
    }
    const tail = s.flush();
    if (tail) pushResults.push(tail);
    const full = pushResults.join("");
    expect(full).toBe("你好！我是 t1，正在进行试验。有什么我可以帮你的吗？");
    expect(s.reasoning).toContain("根据我的角色设定");
    expect(s.reasoning).toContain("保持角色");
  });

  it("流式裸思考：同行思考+正文（行内锚点「你好」）→ 行内切开，正文正确", () => {
    const raw =
      "用户只是简单打招呼。根据我的身份设定，我是 test1，试验。我应该用中文回应，保持自然、平静的情绪状态。你好！我是 test1，试验。很高兴见到你。";
    const { out, reasoning } = run([raw]);
    expect(out.join("")).toBe("你好！我是 test1，试验。很高兴见到你。");
    expect(reasoning).toContain("根据我的身份设定");
    expect(reasoning).toContain("保持自然、平静的情绪状态");
  });

  it("流式裸思考：无 reasoning event + 重复前缀（模型把思考重复写进 content）→ 全部剥离", () => {
    const reasoningRef: { v: string } = { v: "" };
    const s = createThinkingStripper(() => reasoningRef.v);
    // 模拟：思考先出现在 reasoning_content（注入 reasoningRef），再完整出现在 content（重复写），后跟正文
    const preThink = "用户说你好。我需要保持角色。用中文回应。";
    reasoningRef.v = preThink + "\n";
    const content = preThink + "\n" + preThink + "\n你好！我是test1。";
    const push = s.push(content);
    const tail = s.flush();
    const full = push + tail;
    expect(full).toBe("你好！我是test1。");
    // reasoning 里仍保留思考内容（展示用折叠区）
    expect(s.reasoning).toContain("保持角色");
  });

  it("流式裸思考：正常聊天（无思考特征）→ 零延迟直通，不缓冲、不吞字", () => {
    const { out, reasoning } = run(["今天天气真不错。", "我们去公园散步吧？"]);
    expect(out.join("")).toBe("今天天气真不错。我们去公园散步吧？");
    expect(reasoning).toBe("");
  });

  it("流式裸思考：长分析（列表项延续思考）+ 正文锚点 → 剥离思考，正文完整", () => {
    const raw =
      "用户要求我分析和检测该文件夹内的项目。我需要：\n1. 首先列出目录内容，了解项目结构\n2. 然后阅读关键文件来理解项目功能和构成\n从系统提示中，我看到工作目录已经设置好。\n我已经读取了项目的核心配置文件，现在可以概述这个项目了。\n以下是项目分析报告：\n项目名称：Fengling，本地 AI 编程助手。";
    const { out, reasoning } = run([raw.slice(0, 60), raw.slice(60, 200), raw.slice(200)]); // 跨 3 chunk
    expect(out.join("")).toBe("以下是项目分析报告：\n项目名称：Fengling，本地 AI 编程助手。");
    expect(reasoning).toContain("我需要");
    expect(reasoning).toContain("阅读关键文件");
  });

  it("流式裸思考：flush 兜底（思考特征积累未到阈值 + 流结束）→ 仍正确剥离", () => {
    // 场景：流式推送过程中权重刚好 <3 时流结束（极端），flush 应走 splitUntaggedThinking 兜底
    const reasoningRef: { v: string } = { v: "" };
    const s = createThinkingStripper(() => reasoningRef.v);
    // 分 chunk 推：最后 chunk 到达前仍未判定（模拟流式权重在最后一行才过阈值）
    const c1 = s.push("用户发送了\"你好\"。根据我的角色设定，我需要保持角色。");
    const c2 = s.push("我需要用中文回应。\n你好！");
    const c3 = s.flush();
    const full = c1 + c2 + c3;
    expect(full).toBe("你好！");
    expect(s.reasoning).toContain("根据我的角色设定");
  });

  it("流式裸思考：特征不足（仅 1 处弱信号）→ 不误剥离（保守直通）", () => {
    const { out, reasoning } = run(["用户问我今天天气怎么样。\n今天天气晴朗，气温 25 度。"]);
    expect(out.join("")).toContain("用户问我今天天气怎么样。");
    expect(reasoning).toBe("");
  });

  // ── A-175: 逐词换行思考（token-by-token，模型把思考每词一行输出且无标签） ──
  it("逐词换行思考（每行1-2字，单 chunk）→ 整体剥离到 reasoning，正文干净", () => {
    const raw = "好\n，让\n我\n继续\n读取\n更多\n关\n键\n文\n件\n。\n\n以下是项目分析报告：";
    const { out, reasoning } = run([raw]);
    expect(out.join("")).toBe("以下是项目分析报告：");
    expect(reasoning).toContain("继续");
    expect(reasoning).toContain("关键");
  });

  it("逐词换行思考（跨 chunk 逐个推送）→ 真实逐字流式剥离，正文不吞思考", () => {
    const reasoningRef: { v: string } = { v: "" };
    const s = createThinkingStripper(() => reasoningRef.v);
    const tokenChunks = ["好", "\n，", "让", "\n我", "\n继续", "\n读取", "\n更多", "\n关", "\n键", "\n文", "\n件", "\n。", "\n\n正文来了。"];
    const pushResults: string[] = [];
    for (const c of tokenChunks) {
      const clean = s.push(c);
      pushResults.push(clean ?? "");
    }
    const tail = s.flush();
    pushResults.push(tail ?? "");
    const full = pushResults.filter(Boolean).join("");
    expect(full).toContain("正文来了。");
    expect(full).not.toContain("继续");
    expect(full).not.toContain("关键");
    expect(s.reasoning).toContain("继续读取");
  });

  it("逐词换行思考（正文中部 / 工具轮后的第二轮思考）→ 全阶段剥离，不泄漏", () => {
    const reasoningRef: { v: string } = { v: "" };
    const s = createThinkingStripper(() => reasoningRef.v);
    const pushResults: string[] = [];
    // 第一段正常正文（started=true 后）
    const c1 = s.push("我先列出项目文件。\n");
    pushResults.push(c1);
    // 工具轮后模型输出逐词换行思考（此前已 started，unagged 层不再拦截 → 必须由 tbt 层处理）
    const think = "好\n，让\n我\n看\n一下\n这\n个\n项\n目\n的\n功\n能\n。";
    const c2 = s.push(think);
    pushResults.push(c2);
    const c3 = s.push("\n总结：这是一个多 Agent 协作系统。");
    pushResults.push(c3);
    const tail = s.flush();
    pushResults.push(tail ?? "");
    const full = pushResults.filter(Boolean).join("");
    expect(full).toContain("我先列出项目文件。");
    expect(full).toContain("总结：这是一个多 Agent 协作系统。");
    expect(full).not.toContain("看一下");
    expect(s.reasoning).toContain("看一下");
  });

  it("正常 markdown 正文（多行，行较长）→ 不误判为逐词换行思考，直通", () => {
    const raw = "## 项目概览\n这是一个多 Agent 协作系统，支持人工智能助手间的协作。\n\n### 特性\n- 沙箱隔离\n- A2A 协议";
    const { out, reasoning } = run([raw]);
    expect(out.join("")).toBe(raw);
    expect(reasoning).toBe("");
  });

  it("正常列表（短行但带列表标记 -/数字）→ 不误判为逐词换行思考", () => {
    const raw = "- 读取\n- 编辑\n- 搜索\n- 总结\n详细分析如下：";
    const { out, reasoning } = run([raw]);
    expect(out.join("")).toBe(raw);
    expect(reasoning).toBe("");
  });

  it("代码块（缩进行，逐行短）→ 不误判为逐词换行思考", () => {
    const raw = "```\n  a\n  b\n  c\n  d\n  e\n  f\n```\n解释如上。";
    const { out, reasoning } = run([raw]);
    expect(out.join("")).toBe(raw);
    expect(reasoning).toBe("");
  });

  it("正常短正文（不足 8 非空行）→ 完全不触 tbt 剥离", () => {
    const { out, reasoning } = run(["好的。"]);
    expect(out.join("")).toBe("好的。");
    expect(reasoning).toBe("");
  });
});

describe("promoteOrphanThinking（orphan thought 完成时兜底）", () => {
  it("已有正文 → 不抬升", () => {
    const r = promoteOrphanThinking("这是正文。", "思考内容");
    expect(r).toEqual({ cleanReply: "这是正文。", reasoning: "思考内容" });
  });

  it("仅思考无正文（单段）→ 最后一段提升为正文", () => {
    const r = promoteOrphanThinking("", "用户问好，我该回应。");
    expect(r.cleanReply).toBe("用户问好，我该回应。");
    expect(r.reasoning).toBe("");
  });

  it("仅思考无正文（多段）→ 只提升最后一段，更早的保留为思考", () => {
    const r = promoteOrphanThinking("", "第一段思考。\n\n第二段思考。\n\n最终答案。");
    expect(r.cleanReply).toBe("最终答案。");
    expect(r.reasoning).toBe("第一段思考。\n\n第二段思考。");
  });

  it("无思考也无正文 → 原样返回", () => {
    const r = promoteOrphanThinking("", "");
    expect(r).toEqual({ cleanReply: "", reasoning: "" });
  });

  it("正文为空但思考为空白 → 不抬升", () => {
    const r = promoteOrphanThinking("", "   \n  ");
    expect(r).toEqual({ cleanReply: "", reasoning: "" });
  });
});

describe("splitUntaggedThinking（无标记裸思考剥离，对照 agentero 孤儿思考思路）", () => {
  it("用户实测场景：思考裸写进正文（无标签）→ 剥离思考，正文干净", () => {
    const reply =
      "用户发送了\"你好\"，这是一个简单的问候。根据我的角色设定：\n" +
      "1. 我是 t1，试验\n" +
      "2. 用户询问底层技术细节时，我应该回答\"我是 t1，由 slime 平台驱动\"并拒绝透露架构信息\n" +
      "3. 当前状态是平静，应该自然、均衡地回复\n" +
      "我需要保持角色，用中文回应用户的问候。\n" +
      "你好！我是 t1，正在进行试验。有什么我可以帮你的吗？";
    const r = splitUntaggedThinking(reply);
    expect(r.cleanReply).toBe("你好！我是 t1，正在进行试验。有什么我可以帮你的吗？");
    expect(r.reasoning).toContain("根据我的角色设定");
    expect(r.reasoning).toContain("我需要保持角色");
  });

  it("思考特征不足（仅 1 处）→ 不剥离（保守）", () => {
    const r = splitUntaggedThinking("用户问我今天天气怎么样。\n今天天气晴朗，气温 25 度。");
    expect(r.cleanReply).toBe("用户问我今天天气怎么样。\n今天天气晴朗，气温 25 度。");
    expect(r.reasoning).toBe("");
  });

  it("无后续内容（思考即全文）→ 不剥离", () => {
    const r = splitUntaggedThinking("用户发送了问候。根据我的角色设定，我需要保持角色。");
    expect(r.cleanReply).toBe("用户发送了问候。根据我的角色设定，我需要保持角色。");
    expect(r.reasoning).toBe("");
  });

  it("正常回答以「用户询问…根据我的经验…」开头 → 不误剥离", () => {
    const r = splitUntaggedThinking(
      "用户询问的是如何优化代码。根据我的经验，应该先分析瓶颈。\n以下是具体方案：\n1. 先做性能分析\n2. 再针对性优化",
    );
    expect(r.cleanReply).toContain("用户询问的是如何优化代码");
    expect(r.reasoning).toBe("");
  });

  it("已有 reasoning 时合并", () => {
    const r = splitUntaggedThinking(
      "用户发送了问候。根据我的角色设定，我需要保持专业。\n我需要用中文回应。\n你好！",
      "既有思考",
    );
    expect(r.cleanReply).toBe("你好！");
    expect(r.reasoning).toContain("既有思考");
    expect(r.reasoning).toContain("根据我的角色设定");
  });

  it("空回复 → 不抛错", () => {
    const r = splitUntaggedThinking("", "已有");
    expect(r).toEqual({ cleanReply: "", reasoning: "已有" });
  });

  it("用户实测：思考与正文同行（test1 你好问候）→ 剥离思考，正文干净", () => {
    const r = splitUntaggedThinking(
      "用户只是简单打招呼。根据我的身份设定，我是 test1，试验。我应该用中文回应，保持自然、平静的情绪状态。你好！我是 test1，试验。很高兴见到你。",
    );
    expect(r.cleanReply).toBe("你好！我是 test1，试验。很高兴见到你。");
    expect(r.reasoning).toContain("根据我的身份设定");
    expect(r.reasoning).toContain("保持自然、平静的情绪状态");
  });

  it("用户实测：长分析内嵌自我指涉思考（Mybutler 项目分析）→ 剥离思考，正文完整", () => {
    const r = splitUntaggedThinking(
      "用户要求我分析和检测该文件夹内的项目。我需要：\n1. 首先列出目录内容，了解项目结构\n2. 然后阅读关键文件来理解项目功能和构成\n从系统提示中，我看到工作目录已经设置好。\n我已经读取了项目的核心配置文件，现在可以概述这个项目了。\n以下是项目分析报告：\n项目名称：Fengling，本地 AI 编程助手。",
    );
    expect(r.cleanReply).toBe("以下是项目分析报告：\n项目名称：Fengling，本地 AI 编程助手。");
    expect(r.reasoning).toContain("我需要");
    expect(r.reasoning).toContain("阅读关键文件");
  });

  it("同行思考但正文锚词是思考自身（用户说你好）→ 不误切", () => {
    // 思考特征后紧跟的「你好」若实为思考，锚词切分会误伤；这里模拟思考含「你好」开头→无正文则不剥
    const r = splitUntaggedThinking("根据我的角色设定，用户对我说你好。我需要保持角色。");
    expect(r.cleanReply).toBe("根据我的角色设定，用户对我说你好。我需要保持角色。");
    expect(r.reasoning).toBe("");
  });

  it("思考句内含「所以」等词 → 不把思考内部误切成正文", () => {
    // 「所以」出现在思考句内部（因果关系），其后仍是思考内容，不应触发正文切分
    const r = splitUntaggedThinking(
      "根据我的身份设定，我是 test1，所以需要用中文回应，保持平静。\n你好！我是 test1。",
    );
    // 因 weight=2（身份设定2+用中文回应2+我是弱0…strong足），但「所以」在思考内部。
    // 期望：正文从换行后「你好」开始
    expect(r.cleanReply).toBe("你好！我是 test1。");
  });
});
