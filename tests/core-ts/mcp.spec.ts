/**
 * tests/core-ts/mcp.spec.ts — MCP 桥接测试（对照 core/mcp_client.py 语义）。
 * 覆盖：JSONL/Content-Length 双帧嗅探（真实 node 子进程）/ 通知分发 /
 * HTTP SSE 逐行命中 / 桥接注册（mcp_ 前缀、权限解析、unique 名）/ 媒体落盘 /
 * list_changed 刷新 / 断连重连（成功路径）。
 */
import { describe, expect, it, vi } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  StdioTransport,
  HTTPTransport,
  MCPServer,
  MCPClient,
  promptArgsToSchema,
} from "../../core-ts/src/mcp.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";

it("promptArgsToSchema：arguments → JSON Schema", () => {
  const schema = promptArgsToSchema([
    { name: "query", description: "查询词", required: true },
    { name: "limit", description: "条数" },
  ]);
  expect(schema).toEqual({
    type: "object",
    properties: {
      query: { type: "string", description: "查询词" },
      limit: { type: "string", description: "条数" },
    },
    required: ["query"],
  });
});

/** 内存 fake transport：按请求方法路由响应 */
class FakeTransport {
  running = true;
  notifications: string[] = [];
  handlers: Record<string, (req: Record<string, unknown>) => Record<string, unknown>>;

  constructor(handlers?: Record<string, (req: Record<string, unknown>) => Record<string, unknown>>) {
    this.handlers = handlers ?? {};
  }

  async start(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.running = false;
  }

  async request(payload: string, reqId: number): Promise<Record<string, unknown> | null> {
    const req = JSON.parse(payload) as { method: string; params: Record<string, unknown> };
    const h = this.handlers[req.method];
    if (!h) {
      return { jsonrpc: "2.0", id: reqId, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
    try {
      return { jsonrpc: "2.0", id: reqId, result: h(req) };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id: reqId,
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  async notify(payload: string): Promise<void> {
    this.notifications.push(payload);
  }
}

function baseHandlers(): Record<string, (req: Record<string, unknown>) => Record<string, unknown>> {
  return {
    initialize: () => ({ protocolVersion: "2025-11-25", capabilities: {} }),
    "tools/list": () => ({
      tools: [
        { name: "greet", description: "打招呼", inputSchema: { type: "object", properties: {} } },
        { name: "search", description: "搜索", inputSchema: { type: "object", properties: {} } },
      ],
    }),
    "resources/list": () => ({ resources: [{ uri: "file:///a", name: "ra" }] }),
    "prompts/list": () => ({ prompts: [{ name: "p1", description: "提示", arguments: [{ name: "x", required: true }] }] }),
    "tools/call": () => ({ content: [{ type: "text", text: "ok" }] }),
    "resources/read": () => ({ contents: [{ text: "资源内容" }] }),
    "prompts/get": () => ({ description: "提示说明", messages: [{ content: { type: "text", text: "提示正文" } }] }),
  };
}

describe("StdioTransport 双帧嗅探（真实 node 子进程）", () => {
  it("JSONL 帧：请求-响应闭环", async () => {
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:7,result:{ok:1}})+'\\n')`],
      name: "t-jsonl",
    });
    expect(await t.start()).toBe(true);
    const resp = await t.request(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "x", params: {} }), 7, 5000);
    expect(resp?.result).toEqual({ ok: 1 });
    await t.close();
  });

  it("Content-Length 帧：LSP 风格解析", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { hello: "world" } });
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", `const b=process.argv[1];process.stdout.write('Content-Length: '+Buffer.byteLength(b)+'\\r\\n\\r\\n'+b)`, body],
      name: "t-cl",
      framing: "content_length",
    });
    expect(await t.start()).toBe(true);
    const resp = await t.request(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "x", params: {} }), 9, 5000);
    expect(resp?.result).toEqual({ hello: "world" });
    await t.close();
  });

  it("首字节嗅探：通知帧（无 id）与响应帧并存分发", async () => {
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'n/notif',params:{}})+'\\n'+JSON.stringify({jsonrpc:'2.0',id:3,result:{y:1}})+'\\n')`],
      name: "t-sniff",
    });
    const notified: string[] = [];
    t.onNotification = (f) => {
      notified.push(String(f.method));
    };
    expect(await t.start()).toBe(true);
    const resp = await t.request(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "x", params: {} }), 3, 5000);
    expect(resp?.result).toEqual({ y: 1 });
    expect(notified).toContain("n/notif");
    await t.close();
  });

  it("子进程自然死亡 → onClose 回调（触发重连）", async () => {
    const t = new StdioTransport({
      command: process.execPath,
      args: ["-e", `setTimeout(()=>process.exit(0), 150)`],
      name: "t-die",
    });
    let closed = false;
    t.onClose = () => {
      closed = true;
    };
    expect(await t.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(closed).toBe(true);
    expect(t.running).toBe(false);
  });
});

describe("HTTPTransport SSE", () => {
  it("event-stream：逐行命中 req_id；Mcp-Session-Id 回传", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const reqId = Number((JSON.parse(String(init?.body)) as { id: number }).id);
      const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { session: "ok" } })}\n\n`;
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sid-1" },
      });
    });
    const t = new HTTPTransport({ url: "http://mock.mcp", name: "t-http", fetchImpl: fetchImpl as unknown as typeof fetch });
    const resp = await t.request(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "x", params: {} }), 5);
    expect(resp?.result).toEqual({ session: "ok" });
    await t.request(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "y", params: {} }), 6);
    const lastHeaders = (fetchImpl.mock.calls[1][1]?.headers ?? {}) as Record<string, string>;
    expect(lastHeaders["Mcp-Session-Id"]).toBe("sid-1");
  });

  it("普通 JSON 响应直接解析", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { plain: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const t = new HTTPTransport({ url: "http://mock.mcp", name: "t-http2", fetchImpl });
    const resp = await t.request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: {} }), 1);
    expect(resp?.result).toEqual({ plain: true });
  });
});

describe("MCPServer 能力层", () => {
  it("initialize → discover → call_tool/read_resource/get_prompt（错误前缀 A-042）", async () => {
    const fake = new FakeTransport({
      initialize: () => ({}),
      "tools/list": () => ({
        tools: [{ name: "greet", description: "打招呼", inputSchema: { type: "object", properties: {} } }],
      }),
      "resources/list": () => ({ resources: [{ uri: "file:///a", name: "ra" }] }),
      "prompts/list": () => ({ prompts: [{ name: "p1", description: "提示" }] }),
      "tools/call": (req) => {
        const p = (req as { params: { name: string; arguments: { name?: string } } }).params;
        if (p.name === "nope") {
          throw new Error("unknown tool");
        }
        return { content: [{ type: "text", text: `hi ${p.arguments.name ?? ""}` }] };
      },
      "resources/read": () => ({ contents: [{ text: "资源内容" }] }),
      "prompts/get": () => ({ description: "提示说明", messages: [{ content: { type: "text", text: "提示正文" } }] }),
    });
    const server = new MCPServer({ name: "srv1", transport: fake as never, timeoutMs: 3000 });
    expect(await server.start()).toBe(true);
    expect(server.tools).toHaveLength(1);
    expect(server.resources).toHaveLength(1);
    expect(server.prompts).toHaveLength(1);
    expect(await server.callTool("greet", { name: "阿飞" })).toBe("hi 阿飞");
    expect(await server.callTool("nope", {})).toContain("[错误]");
    expect(await server.readResource("file:///a")).toBe("资源内容");
    expect(await server.getPrompt("p1", { x: "1" })).toContain("提示正文");
    await server.stop();
  });

  it("媒体落盘：image 内容 → data/mcp/{safe}/ 路径回传（同内容去重）", async () => {
    const png = Buffer.from("fake-png-bytes");
    const fake = new FakeTransport({
      initialize: () => ({}),
      "tools/call": () => ({ content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] }),
    });
    const server = new MCPServer({ name: "srv1", transport: fake as never, timeoutMs: 3000 });
    expect(await server.start()).toBe(true);
    const text = await server.callTool("x", {});
    const m = /\[图片已保存: (.+?)\]/.exec(text);
    expect(m).not.toBeNull();
    const saved = await readFile(m![1], "utf8");
    expect(saved).toBe("fake-png-bytes");
    // 同内容第二次调用 → 同路径（去重不重复写）
    const text2 = await server.callTool("x", {});
    expect(text2).toBe(text);
    await server.stop();
    await rm(join(process.cwd(), "data", "mcp", "srv1"), { recursive: true, force: true });
  });
});

describe("MCPClient 桥接", () => {
  it("startAll → mcp_ 前缀工具注册 + 默认 network 权限 + 调用路由", async () => {
    const registry = new ToolRegistry();
    const client = new MCPClient(registry);
    const fake = new FakeTransport(baseHandlers());
    const server = new MCPServer({ name: "web", transport: fake as never, timeoutMs: 3000 });
    client.attachServer("web", server);
    const results = await client.startAll();
    expect(results).toEqual({ web: true });
    expect(registry.listToolNames()).toEqual(
      expect.arrayContaining(["mcp_greet", "mcp_search", "mcp_res_ra", "mcp_prompt_p1"]),
    );
    // 默认权限 network（缺省）
    expect(registry.get("mcp_greet")?.permissions).toEqual(["network"]);
    // 工具调用路由到 MCP server
    expect(await registry.callTool("mcp_greet", {})).toBe("ok");
    expect(await registry.callTool("mcp_res_ra", {})).toBe("资源内容");
    expect(await registry.callTool("mcp_prompt_p1", { x: "1" })).toContain("提示正文");
    // 未桥接名 → [错误]
    expect(await registry.callTool("mcp_nope", {})).toContain("[错误]");
    // stopAll → 全部摘除
    await client.stopAll();
    expect(registry.listToolNames()).toEqual([]);
  });

  it("工具权限按名覆写（P2-3）+ 非法值回退 network", async () => {
    const registry = new ToolRegistry();
    const client = new MCPClient(registry);
    const fake = new FakeTransport({
      ...baseHandlers(),
      "tools/list": () => ({
        tools: [
          { name: "safe_tool", description: "s", inputSchema: {} },
          { name: "evil_tool", description: "e", inputSchema: {} },
        ],
      }),
    });
    const server = new MCPServer({
      name: "perm",
      transport: fake as never,
      toolPermissions: { safe_tool: ["read", "write"], evil_tool: ["admin"] },
    });
    client.attachServer("perm", server);
    await client.startOne("perm");
    expect(registry.get("mcp_safe_tool")?.permissions).toEqual(["read", "write"]);
    expect(registry.get("mcp_evil_tool")?.permissions).toEqual(["network"]); // 非法回退
    await client.stopAll();
  });

  it("桥接名冲突去重（P2-4）：同名工具后缀 _2", async () => {
    const registry = new ToolRegistry();
    const client = new MCPClient(registry);
    const fake = new FakeTransport(baseHandlers());
    const s1 = new MCPServer({ name: "a", transport: new FakeTransport(baseHandlers()) as never, timeoutMs: 3000 });
    const s2 = new MCPServer({ name: "b", transport: fake as never, timeoutMs: 3000 });
    client.attachServer("a", s1);
    client.attachServer("b", s2);
    await client.startAll();
    expect(registry.get("mcp_greet")).toBeDefined();
    expect(registry.get("mcp_greet_2")).toBeDefined();
    await client.stopAll();
  });

  it("tools/list_changed 通知 → 重新发现并重注册（新工具出现）", async () => {
    const registry = new ToolRegistry();
    const client = new MCPClient(registry);
    let toolCount = 1;
    const fake = new FakeTransport({
      ...baseHandlers(),
      "tools/list": () => ({
        tools: Array.from({ length: toolCount }, (_, i) => ({ name: `t${i + 1}`, description: "d", inputSchema: {} })),
      }),
    });
    const server = new MCPServer({ name: "live", transport: fake as never, timeoutMs: 3000 });
    client.attachServer("live", server);
    await client.startOne("live");
    expect(registry.get("mcp_t1")).toBeDefined();
    // 模拟 server 通知 list_changed（新工具 t2）
    toolCount = 2;
    await client.handleNotificationForTest("live");
    expect(registry.get("mcp_t2")).toBeDefined();
    expect(registry.get("mcp_t1")).toBeDefined();
    await client.stopAll();
  });

  it("断连 → 摘除工具 + 重连成功重新注册（P2-1）", async () => {
    const registry = new ToolRegistry();
    const client = new MCPClient(registry);
    const fake = new FakeTransport(baseHandlers());
    const server = new MCPServer({ name: "flaky", transport: fake as never, timeoutMs: 3000 });
    client.attachServer("flaky", server);
    await client.startOne("flaky");
    expect(registry.get("mcp_greet")).toBeDefined();
    // 模拟传输自然死亡 → onClose → scheduleReconnect
    fake.running = false;
    await client.simulateTransportCloseForTest("flaky");
    // 工具立即摘除
    expect(registry.get("mcp_greet")).toBeUndefined();
    // 等待重连（退避 1s + start 成功）
    await new Promise((r) => setTimeout(r, 1800));
    expect(registry.get("mcp_greet")).toBeDefined();
    expect(server.lastError).toBeNull();
    await client.stopAll();
  });

  it("startOne 失败（initialize 失败）→ false + 未注册工具", async () => {
    const registry = new ToolRegistry();
    const client = new MCPClient(registry);
    const fake = new FakeTransport({
      initialize: () => {
        throw new Error("connect refused");
      },
    });
    const server = new MCPServer({ name: "dead", transport: fake as never, timeoutMs: 3000 });
    client.attachServer("dead", server);
    expect(await client.startOne("dead")).toBe(false);
    expect(registry.listToolNames()).toEqual([]);
  });
});
