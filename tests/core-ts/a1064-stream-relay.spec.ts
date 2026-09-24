/**
 * A-1064 守卫：引擎事件**必须穿过 `ChatService.stream` 抵达界面** —— 链路中间那一跳。
 *
 * ## 被修的 bug（形状：**链路中间少一环**，不是某一段写错）
 *
 * `EngineChunk["type"]` 声明了 11 种事件，但 `ChatService.stream()` 里
 * `for await (const chunk of this.engine.stream(...))` 的 if 链只列举了 6 种
 * （chunk / tool / reasoning / progress / done / error），**且没有兜底 else**
 * → 剩下的 `tool-start` / `steer` / `notice` 走到循环末尾被**静默丢弃**。
 *
 * 为什么长期没被发现 —— 三个必要环节**各自都有守卫**，唯独缺中间这一环：
 *   · `tool_loop.ts` 在执行前广播 `tool-start` / 轮次边界广播 `steer`……（有测试）
 *   · `engine.ts` 把它们抬进 `liveQueue`……（有测试）
 *   · 类型联合、`gui/src/shared/ipc.ts`、主进程白名单 `toStreamChunk` 都认它们……（有测试）
 *   · 界面 `onChunk` 的 `tool-start` / `steer` / `notice` 分支都写好了……（有测试）
 *   ⇒ 四段各自绿，整条链路断。用户侧症状全部同一个根因：
 *     ① 中途「引导」已注入本轮，却因为 `steer` 事件到不了界面而**不被撤卡**
 *        → 本轮结束 `onDone` 的续发路径把它当普通排队**再发一遍**
 *        （用户原话："引导内容仍然在排队队列？而且会在这轮输出完毕后再次输出"）；
 *     ② 同一条 `steer` 事件还负责把引导折进**思考历程** → 历程里看不到自己插入的引导；
 *     ③ `tool-start` 到不了界面 → 脚本/命令**没有"执行中"态**，只剩事后成败；
 *     ④ `notice` 到不了界面 → 上游重试期仍是静默的"加载半天没动静"。
 *
 * ## 两条断言（互补，缺一不可）
 *
 * 1. **穷举型行为断言**：把源码里 `EngineChunk.type` 联合的成员全部读出来，
 *    逐个喂进 `stream()` 并断言**每一个都真的出来了**。这条断言的价值在于
 *    **将来往联合里加事件类型时会自动变红** —— 补三个 `else if` 只能治这一次。
 * 2. **结构断言**：中继 if 链必须以原样透传收尾（`else { yield emitChunk(chunk); }`），
 *    杜绝"允许静默丢弃"这个形状本身回归。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ChatService, type ChatEngine, type ChatEngineCall, type EngineChunk,
} from "../../core-ts/src/services/chat.js";
import { AgentRegistry, type AgentState, emptyPersona } from "../../core-ts/src/services/agents.js";
import { memoryHistoryStore } from "./helpers/memoryHistoryStore.js";

const ROOT = join(__dirname, "../..");
const CHAT_SVC = "core-ts/src/services/chat.ts";

const code = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * 从源码读出 `EngineChunk.type` 联合的**全部成员**（界面契约的唯一出处）。
 * 刻意读源码而不是在测试里抄一份：抄一份就又是一处"两个产地"，加类型时必然漂移。
 */
function declaredEventTypes(): string[] {
  const src = code(CHAT_SVC);
  const at = src.indexOf("export interface EngineChunk {");
  expect(at, "找不到 EngineChunk 声明").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n}", at));
  const m = body.match(/type:\s*([^;]+);/);
  expect(m, "读不出 EngineChunk.type 联合").not.toBeNull();
  const types = [...m![1]!.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]!);
  expect(types.length, "联合成员数异常，提取逻辑可能被重构打破").toBeGreaterThanOrEqual(6);
  return types;
}

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

class FakeEngine implements ChatEngine {
  chatImpl: (opts: ChatEngineCall) => Promise<never> = async () => {
    throw new Error("本 spec 不走非流式路径");
  };
  streamImpl: (opts: ChatEngineCall) => AsyncIterable<EngineChunk> = async function* () {};
  forcedStreamImpl: (opts: ChatEngineCall) => AsyncIterable<EngineChunk> = async function* () {};

  chat = vi.fn(async (opts: ChatEngineCall) => this.chatImpl(opts));
  stream = vi.fn((opts: ChatEngineCall) => {
    if (opts.toolsOnly && opts.toolsOnly.length > 0) {
      return this.forcedStreamImpl(opts);
    }
    return this.streamImpl(opts);
  });
}

const quietLogger = (): Pick<Console, "warn" | "info" | "debug"> =>
  ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() });

// A-1035：知识/技能落盘根挪到临时目录，避免后处理链路污染仓库真实 Knowledge/
const knowTmp = await mkdtemp(join(tmpdir(), "slime-chat-relay-"));
process.on("exit", () => { try { rmSync(knowTmp, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });

describe("A-1064 ChatService.stream 中继：声明了的事件类型必须全部抵达", () => {
  let dir = "";
  let reg: AgentRegistry;
  let engine: FakeEngine;
  let service: ChatService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-chat-relay-src-"));
    const f = join(dir, "agents.json");
    await writeFile(f, JSON.stringify([makeAgent()]), "utf8");
    reg = new AgentRegistry(f);
    await reg.load();
    engine = new FakeEngine();
    service = new ChatService({ registry: reg, engine, dataDir: knowTmp, history: memoryHistoryStore(), logger: quietLogger() });
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try { await rm(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 40)); }
    }
    await rm(dir, { recursive: true, force: true });
  });

  const collect = async (g: AsyncIterable<{ seq: number; type: string; data: unknown }>) => {
    const out: Array<{ seq: number; type: string; data: unknown }> = [];
    for await (const ev of g) { out.push(ev); }
    return out;
  };

  it("🐛 穷举：源码联合里的**每一个**事件类型都能穿过中继（缺一个就是链路断一环）", async () => {
    const types = declaredEventTypes();
    // 每个类型给一份"可识别"的最小载荷；done 放最后，保证本轮正常收尾
    const samples: Record<string, EngineChunk> = {
      chunk: { type: "chunk", content: "正文" },
      tool: { type: "tool", name: "file_read", args: "{}", result: "ok", toolId: "t1" },
      "tool-start": { type: "tool-start", name: "file_read", args: "{}", toolId: "t1" },
      reasoning: { type: "reasoning", content: "思考" },
      progress: { type: "progress", content: "50%" },
      error: { type: "error", message: "[错误] 演示" },
      heartbeat: { type: "heartbeat" },
      member: { type: "member", name: "成员甲", agentId: "a_x", content: "成员发言" },
      steer: { type: "steer", content: "插入的引导原文", steerId: "7" },
      notice: { type: "notice", content: "被限流（429），30s 后重试（第 1/4 次）" },
      done: { type: "done", reply: "正文", reply_raw: "正文", model: "m1", elapsed_ms: 5 },
    };
    // 契约自检：联合里每个成员都必须在样本表里有载荷（加了新类型却忘了加样本 → 这里先红）
    for (const t of types) {
      expect(samples[t], `联合成员 "${t}" 没有样本载荷，请同步本 spec`).toBeDefined();
    }

    // 顺序：先非 done 的（保持 done 最后收尾）
    const order = types.filter((t) => t !== "done");
    engine.streamImpl = async function* () {
      for (const t of order) { yield samples[t]!; }
      yield samples.done!;
    };

    const evs = await collect(service.stream("agent_test1", { message: "你好" }));
    const seen = new Set(evs.map((e) => e.type));
    for (const t of types) {
      expect(seen.has(t), `事件 "${t}" 被中继吞掉了（引擎产出了、界面却收不到）`).toBe(true);
    }
  });

  it("🐛 steer 事件必须带全 steerId 与原文（撤卡与折进思考历程都靠它们）", async () => {
    engine.streamImpl = async function* () {
      yield { type: "steer", content: "把颜色改成红色", steerId: "12" };
      yield { type: "done", reply: "好", reply_raw: "好" };
    };
    const evs = await collect(service.stream("agent_test1", { message: "你好" }));
    const steer = evs.find((e) => e.type === "steer");
    expect(steer, "steer 事件没到（待发卡片因此永远撤不掉 → 本轮结束会重复发一遍）").toBeDefined();
    expect((steer!.data as { steerId?: string }).steerId).toBe("12");
    expect((steer!.data as { content?: string }).content).toBe("把颜色改成红色");
  });

  it("🐛 tool-start 事件必须带全 toolId / name / args（「执行中」→ 成功的配对靠它）", async () => {
    engine.streamImpl = async function* () {
      yield { type: "tool-start", name: "run_script", args: "{\"cmd\":\"ls\"}", toolId: "t9" };
      yield { type: "tool", name: "run_script", args: "{\"cmd\":\"ls\"}", result: "ok", toolId: "t9" };
      yield { type: "done", reply: "跑完了", reply_raw: "跑完了" };
    };
    const evs = await collect(service.stream("agent_test1", { message: "你好" }));
    const start = evs.find((e) => e.type === "tool-start");
    expect(start, "tool-start 没到（脚本执行不会有「执行中」态，只剩事后成败）").toBeDefined();
    const d = start!.data as { toolId?: string; name?: string; args?: string };
    expect(d.toolId).toBe("t9");
    expect(d.name).toBe("run_script");
    expect(d.args).toBe("{\"cmd\":\"ls\"}");
  });

  it("notice 事件必须带 content（上游重试期不该是静默的）", async () => {
    engine.streamImpl = async function* () {
      yield { type: "notice", content: "被限流（429），30s 后重试（第 1/4 次）" };
      yield { type: "done", reply: "好了", reply_raw: "好了" };
    };
    const evs = await collect(service.stream("agent_test1", { message: "你好" }));
    const n = evs.find((e) => e.type === "notice");
    expect(n, "notice 没到（等上游期间界面只剩「加载半天没动静」）").toBeDefined();
    expect((n!.data as { content?: string }).content).toContain("限流");
  });

  it("结构：中继 if 链必须以**原样透传**收尾（不允许静默丢弃任何事件类型）", () => {
    const src = code(CHAT_SVC);
    const atErr = src.indexOf('} else if (chunk.type === "error") {');
    expect(atErr, "找不到 error 分支（中继 if 链的最后一个显式分支）").toBeGreaterThan(-1);
    const tail = src.slice(atErr, atErr + 600);
    // error 分支之后必须紧跟原样透传的兜底 else
    expect(tail, "error 分支之后没有透传兜底 —— 未列举的类型会被静默吞掉")
      .toMatch(/\}\s*else\s*\{\s*yield emitChunk\(chunk\);/);
    // 兜底之后**不许**再出现 `else if`（永远不生效，写在那里就是给下一个人的陷阱）
    const afterElse = tail.slice(tail.indexOf("yield emitChunk(chunk);"));
    expect(afterElse, "兜底 else 之后还有 else if —— 那个分支永远不生效").not.toContain("else if");
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // "静默丢弃"的模型：只列举 6 种，其余落到循环末尾被丢掉 —— 用同一份样本走一遍
    const relay = (declared: string[], listed: string[]): string[] => declared.filter((t) => listed.includes(t));
    const all = declaredEventTypes();
    const buggy = relay(all, ["chunk", "tool", "reasoning", "progress", "done", "error"]);
    expect(buggy.includes("steer"), "旧写法本该丢掉 steer").toBe(false);
    expect(buggy.includes("tool-start"), "旧写法本该丢掉 tool-start").toBe(false);
    expect(buggy.includes("notice"), "旧写法本该丢掉 notice").toBe(false);
    // 修好之后：兜底使"全部抵达"
    expect(relay(all, all).length).toBe(all.length);
  });
});
