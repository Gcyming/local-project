











import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ChatService,
  ChatEngine,
  ChatEngineCall,
  EngineChunk,
  ChatEngineResult,
} from "../../core-ts/src/services/chat.js";
import { AgentRegistry, AgentState, emptyPersona } from "../../core-ts/src/services/agents.js";
import { memoryHistoryStore } from "./helpers/memoryHistoryStore.js";
import { Tool, ToolRegistry, setToolCategoryGate } from "../../core-ts/src/tools/registry.js";


const knowTmp = await mkdtemp(join(tmpdir(), "slime-know-"));
process.on("exit", () => { try { rmSync(knowTmp, { recursive: true, force: true }); } catch {  } });


const CHAT_TS = readFileSync(
  new URL("../../core-ts/src/services/chat.ts", import.meta.url),
  "utf8",
);
const INDEX_TS = readFileSync(
  new URL("../../gui/src/main/index.ts", import.meta.url),
  "utf8",
);


class CaptureEngine implements ChatEngine {
  chatOpts: ChatEngineCall[] = [];
  streamOpts: ChatEngineCall[] = [];
  chat = vi.fn(async (opts: ChatEngineCall): Promise<ChatEngineResult> => {
    this.chatOpts.push(opts);
    return { reply: "ok", model: "m", promptTokens: 1, completionTokens: 1, elapsedMs: 1 };
  });
  stream = vi.fn((opts: ChatEngineCall): AsyncIterable<EngineChunk> => {
    this.streamOpts.push(opts);
    return this.gen();
  });
  
  private async *gen(): AsyncIterable<EngineChunk> {
    yield { type: "done", reply: "ok" };
  }
}

function quietLogger(): Pick<Console, "warn" | "info" | "debug"> {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

async function makeRegistry(dir: string, agents: AgentState[]): Promise<AgentRegistry> {
  await writeFile(join(dir, "agents.json"), JSON.stringify(agents), "utf8");
  const reg = new AgentRegistry(join(dir, "agents.json"));
  await reg.load();
  return reg;
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

describe("断链 A — networkEnabled 必须原样透传到引擎（普通聊天联网开关不能再是死的）", () => {
  it("源码守卫：chat.ts 里除两处豁免外，**每一个**引擎调用点都透传 networkEnabled: req.networkEnabled", () => {
    
    
    
    
    const total = (CHAT_TS.match(/this\.engine\.(chat|stream)\(/g) ?? []).length;
    const pass = (CHAT_TS.match(/networkEnabled: req\.networkEnabled/g) ?? []).length;
    expect(total).toBeGreaterThanOrEqual(9);
    expect(pass).toBe(total - 2); 
  });

  it("源码守卫：豁免之一 runForcedRound 靠 toolsOnly 锁死工具集（媒体轮本就无联网工具）", () => {
    
    
    expect(CHAT_TS).toContain("toolsOnly: MEDIA_TOOLS");
    const m = CHAT_TS.match(/export const MEDIA_TOOLS = \[([^\]]*)\]/);
    expect(m, "MEDIA_TOOLS 定义应存在").toBeTruthy();
    expect(m![1]).not.toMatch(/web_search|web_fetch/);
  });

  it("源码守卫：豁免之二 analyze 是网关 HTTP 入口（该路径无开关来源，故不接）", () => {
    
    
    
    
    expect(CHAT_TS).toMatch(/async analyze\(agentId: string, message: string\)/);
  });

  let dir: string;
  let reg: AgentRegistry;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "net-gate-"));
    reg = await makeRegistry(dir, [makeAgent()]);
  });
  afterEach(async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      
    }
  });

  it("行为：engine.stream 收到 networkEnabled === false（关联网能原样到达）", async () => {
    const engine = new CaptureEngine();
    
    
    const svc = new ChatService({ dataDir: knowTmp, registry: reg, engine, history: memoryHistoryStore(), logger: quietLogger() });
    for await (const _ of svc.stream("agent_test1", { message: "hi", networkEnabled: false })) {
      void _;
    }
    expect(engine.streamOpts.length).toBeGreaterThanOrEqual(1);
    expect(engine.streamOpts[0].networkEnabled).toBe(false);
  });

  it("行为：不传 networkEnabled 时 stream 收到 undefined（保住 A-918+ 缺省即开，不能变成 false）", async () => {
    const engine = new CaptureEngine();
    
    
    const svc = new ChatService({ dataDir: knowTmp, registry: reg, engine, history: memoryHistoryStore(), logger: quietLogger() });
    for await (const _ of svc.stream("agent_test1", { message: "hi" })) {
      void _;
    }
    expect(engine.streamOpts[0].networkEnabled).toBeUndefined();
  });

  it("行为：engine.chat（非流式）收到 networkEnabled === false", async () => {
    const engine = new CaptureEngine();
    
    
    const svc = new ChatService({ dataDir: knowTmp, registry: reg, engine, history: memoryHistoryStore(), logger: quietLogger() });
    await svc.chat("agent_test1", { message: "hi", networkEnabled: false });
    expect(engine.chatOpts.length).toBeGreaterThanOrEqual(1);
    expect(engine.chatOpts[0].networkEnabled).toBe(false);
  });

  it("行为：不传 networkEnabled 时 chat 收到 undefined（缺省即开不能静默变 false）", async () => {
    const engine = new CaptureEngine();
    
    
    const svc = new ChatService({ dataDir: knowTmp, registry: reg, engine, history: memoryHistoryStore(), logger: quietLogger() });
    await svc.chat("agent_test1", { message: "hi" });
    expect(engine.chatOpts[0].networkEnabled).toBeUndefined();
  });
});

describe("断链 B — 设置面板的 MCP / 技能 开关必须接到工具类别闸门（假开关不能再假）", () => {
  
  
  
  
  
  it("源码守卫：判据本体住在 policy.ts，按工具名前缀 mcp_ / skill_ 拒绝并带中文原因", () => {
    const POLICY_TS = readFileSync(
      new URL("../../core-ts/src/tools/policy.ts", import.meta.url),
      "utf8",
    );
    
    
    expect(POLICY_TS).toContain('n.startsWith("mcp_")');
    expect(POLICY_TS).toContain('n.startsWith("skill_")');
    expect(POLICY_TS).toContain("MCP 已在「设置 → 权限」中关闭");
    expect(POLICY_TS).toContain("技能已在「设置 → 权限」中关闭");
  });

  it("源码守卫：唯一真闸门委托这份判据，且实时读开关（判据不许搬回装配层）", () => {
    
    expect(INDEX_TS).toContain("setToolCategoryGate((tool, args) => gateToolCall({");
    expect(INDEX_TS).toContain("switches: permSwitches(getPermissions())");
  });

  
  
  
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(new Tool({ name: "mcp_list_servers", description: "m", parameters: { type: "object", properties: {} }, executeFn: async () => "OK", permissions: [] }));
    registry.register(new Tool({ name: "skill_search", description: "m", parameters: { type: "object", properties: {} }, executeFn: async () => "OK", permissions: [] }));
    registry.register(new Tool({ name: "skill_lookup", description: "m", parameters: { type: "object", properties: {} }, executeFn: async () => "OK", permissions: [] }));
    registry.register(new Tool({ name: "screen_click", description: "m", parameters: { type: "object", properties: {} }, executeFn: async () => "OK", permissions: [] }));
    registry.register(new Tool({ name: "read_file", description: "m", parameters: { type: "object", properties: {} }, executeFn: async () => "OK", permissions: ["read"] }));
  });
  afterEach(() => {
    setToolCategoryGate(null);
  });

  function installGate(perms: { screenEnabled: boolean; mcpEnabled: boolean; skillsEnabled: boolean }) {
    
    setToolCategoryGate((tool) => {
      if (!perms.screenEnabled && tool.name.startsWith("screen_")) {
        return { allowed: false, reason: "图形控制已在「设置 → 权限」中关闭" };
      }
      if (!perms.mcpEnabled && tool.name.startsWith("mcp_")) {
        return { allowed: false, reason: "MCP 已在「设置 → 权限」中关闭" };
      }
      if (!perms.skillsEnabled && tool.name.startsWith("skill_")) {
        return { allowed: false, reason: "技能已在「设置 → 权限」中关闭" };
      }
      return { allowed: true };
    });
  }

  it("行为对照：mcpEnabled=false 时 mcp_ 工具被拒，其余放行", async () => {
    installGate({ screenEnabled: false, mcpEnabled: false, skillsEnabled: true });
    expect(await registry.callTool("mcp_list_servers", {})).toContain("权限已关闭");
    expect(await registry.callTool("skill_search", {})).not.toContain("权限已关闭");
    expect(await registry.callTool("read_file", {})).not.toContain("权限已关闭");
  });

  it("行为对照：skillsEnabled=false 时 skill_ 工具被拒，其余放行", async () => {
    installGate({ screenEnabled: false, mcpEnabled: true, skillsEnabled: false });
    expect(await registry.callTool("skill_search", {})).toContain("权限已关闭");
    expect(await registry.callTool("skill_lookup", {})).toContain("权限已关闭");
    expect(await registry.callTool("mcp_list_servers", {})).not.toContain("权限已关闭");
  });

  it("行为对照：开关全开时 mcp_ / skill_ 工具放行（开关默认 true = 不挡）", async () => {
    installGate({ screenEnabled: true, mcpEnabled: true, skillsEnabled: true });
    expect(await registry.callTool("mcp_list_servers", {})).toBe("OK");
    expect(await registry.callTool("skill_search", {})).toBe("OK");
  });
});

describe("断链 C — 子代理继承父请求联网开关（关了联网子代理也不能偷偷联网）", () => {
  it("源码守卫：父请求开关经 tool_loop 注入 delegate_subagent（_network_enabled）且防模型伪造", () => {
    const TOOL_LOOP = readFileSync(
      new URL("../../core-ts/src/tool_loop.ts", import.meta.url),
      "utf8",
    );
    
    expect(TOOL_LOOP).toContain('delete args._network_enabled');
    expect(TOOL_LOOP).toContain('args._network_enabled = this.networkEnabled');
  });

  it("源码守卫：SubAgentManager.execute 把 networkEnabled 透传给 runner ctx", () => {
    const SUBAGENT = readFileSync(
      new URL("../../core-ts/src/services/subagent.ts", import.meta.url),
      "utf8",
    );
    
    expect(SUBAGENT).toContain("networkEnabled: effectiveDef.networkEnabled");
    
    expect(SUBAGENT).toContain("interface SubAgentRunContext");
    expect(SUBAGENT).toMatch(/networkEnabled\?:\s*boolean[\s\S]*?interface SubAgentRunContext/);
  });

  it("源码守卫：index.ts 子代理 runner 把 ctx.networkEnabled 带进 engine.stream（不再「有意不传」）", () => {
    expect(INDEX_TS).toContain("networkEnabled: ctx?.networkEnabled");
    
    expect(INDEX_TS).not.toContain("networkEnabled 有意不传");
  });
});
