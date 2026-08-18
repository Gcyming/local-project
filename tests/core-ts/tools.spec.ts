/**
 * tests/core-ts/tools.spec.ts — 工具注册表 + 内置工具 + 工具轮循环测试。
 * 对照 tools/registry.py + tools/builtin.py + core/llm.py _handle_tool_calls 语义。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tool, ToolRegistry, getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, PROJECT_ROOT } from "../../core-ts/src/tools/builtin.js";
import { ToolLoop, TOOL_MAX_ROUNDS, type SandboxGate } from "../../core-ts/src/tool_loop.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ModelRouter } from "../../core-ts/src/router.js";

describe("ToolRegistry（统一工具注册表）", () => {
  it("注册 + 同名拒绝覆盖（force 才覆盖）", () => {
    const r = new ToolRegistry();
    const t1 = new Tool({ name: "a", description: "d1", parameters: {}, executeFn: async () => "x" });
    const t2 = new Tool({ name: "a", description: "d2", parameters: {}, executeFn: async () => "y" });
    expect(r.register(t1)).toBe(true);
    expect(r.register(t2)).toBe(false);
    expect(r.get("a")?.description).toBe("d1");
    expect(r.register(t2, true)).toBe(true);
    expect(r.get("a")?.description).toBe("d2");
  });

  it("权限默认 read（最小权限）；to_llm_schema 统一格式", () => {
    const t = new Tool({ name: "b", description: "d", parameters: { type: "object" }, executeFn: async () => "" });
    expect(t.permissions).toEqual(["read"]);
    const t2 = new Tool({ name: "c", description: "d", parameters: {}, executeFn: async () => "", permissions: ["write"] });
    expect(t2.permissions).toEqual(["write"]);
    expect(t.toLLMSchema()).toEqual({
      type: "function",
      function: { name: "b", description: "d", parameters: { type: "object" } },
    });
  });

  it("未注册工具/执行异常统一返回 [错误] 前缀（不抛）", async () => {
    const r = new ToolRegistry();
    expect(await r.callTool("nope", {})).toBe("[错误] 工具 'nope' 未注册");
    r.register(new Tool({ name: "boom", description: "", parameters: {}, executeFn: async () => { throw new Error("炸了"); } }));
    expect(await r.callTool("boom", {})).toContain("[错误] 工具 'boom' 执行失败");
  });

  it("全局单例 + resetRegistry", () => {
    resetRegistry();
    const r1 = getRegistry();
    const r2 = getRegistry();
    expect(r1).toBe(r2);
  });
});

describe("内置工具（builtin.ts）", () => {
  let reg: ToolRegistry;
  let work: string;

  beforeEach(async () => {
    resetRegistry();
    registerBuiltinTools();
    reg = getRegistry();
    work = await mkdtemp(join(PROJECT_ROOT, "data", "tool-tmp-")); // 项目根内临时目录（对齐 Python 语义）
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("file_read：项目根内读取 + 敏感文件屏蔽", async () => {
    const t = reg.get("file_read");
    expect(t).toBeDefined();
    expect(t?.permissions).toEqual(["read"]);
    const ok = await t!.executeFn({ path: join(work, "a.txt") });
    expect(ok).toContain("[错误] 文件不存在");
    await writeFile(join(work, "a.txt"), "hello", "utf-8");
    expect(await t!.executeFn({ path: join(work, "a.txt") })).toBe("hello");
    // 相对路径锚定项目根
    const rel = await t!.executeFn({ path: "package.json" });
    expect(rel).toContain("name");
    // 敏感文件
    const sens = await t!.executeFn({ path: "config/auth_token.json" });
    expect(sens).toContain("[错误] 敏感文件禁止读取");
  });

  it("file_read：路径超出项目范围拒绝", async () => {
    const t = reg.get("file_read")!;
    const outside = await t.executeFn({ path: join(tmpdir(), "nope.txt") });
    expect(outside).toContain("[错误] 路径超出项目范围");
  });

  it("file_list：目录列表 + 空目录标记", async () => {
    const t = reg.get("file_list")!;
    await mkdir(join(work, "sub"));
    await writeFile(join(work, "a.txt"), "x", "utf-8");
    const list = await t.executeFn({ path: work });
    expect(list).toContain("📄 a.txt");
    expect(list).toContain("📁 sub");
    const empty = await t.executeFn({ path: join(work, "sub") });
    expect(empty).toBe("[空目录]");
  });

  it("file_write：原子写入 + 敏感黑名单（config 目录拒绝）", async () => {
    const t = reg.get("file_write")!;
    expect(t?.permissions).toEqual(["write"]);
    const p = join(work, "out", "report.md");
    const r = await t.executeFn({ path: p, content: "内容" });
    expect(r).toContain("已保存");
    expect(await readFile(p, "utf-8")).toBe("内容");
    const blocked = await t.executeFn({ path: "config/agents.json", content: "{}" });
    expect(blocked).toContain("[错误] 敏感文件/目录禁止写入");
  });

  it("code_check：Python py_compile + JS node --check + 非代码类型提示", async () => {
    const t = reg.get("code_check")!;
    await writeFile(join(work, "bad.py"), "def f(:\n", "utf-8");
    expect(await t.executeFn({ path: join(work, "bad.py") })).toContain("[错误] Python 语法错误");
    await writeFile(join(work, "ok.py"), "def f():\n    return 1\n", "utf-8");
    expect(await t.executeFn({ path: join(work, "ok.py") })).toContain("语法校验通过");
    await writeFile(join(work, "bad.js"), "const x = ;", "utf-8");
    expect(await t.executeFn({ path: join(work, "bad.js") })).toContain("[错误]");
    await writeFile(join(work, "ok.md"), "# t", "utf-8");
    expect(await t.executeFn({ path: join(work, "ok.md") })).toContain("[提示] 不支持的代码类型");
  });

  it("web_fetch：非法协议拒绝；本地 mock 服务器抓正文", async () => {
    const t = reg.get("web_fetch")!;
    expect((await t.executeFn({ url: "ftp://x" })).startsWith("[错误]")).toBe(true);
    expect((await t.executeFn({ url: "" })).startsWith("[错误]")).toBe(true);
    // 用本地 http 服务器验证（通过 fetch 转发）
    const server = new (await import("node:http")).Server((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("<html><head><title>t</title></head><body><script>var x=1;</script>正文内容</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await t.executeFn({ url: `http://127.0.0.1:${port}/page` });
      expect(r).toContain("正文内容");
      expect(r).not.toContain("var x");
    } finally {
      server.close();
    }
  });

  it("web_search：缺 query 拒绝；真实 Bing 调用失败时返回 [错误] 前缀（不抛）", async () => {
    const t = reg.get("web_search")!;
    expect((await t.executeFn({ query: "" })).startsWith("[错误]")).toBe(true);
    const r = await t.executeFn({ query: "slime" });
    expect(r.startsWith("[错误]") || r.length > 0).toBe(true);
  }, 20000);
});

describe("ToolLoop（多轮工具循环 MAX_ROUNDS=3）", () => {
  function makeRouter(sequence: Array<{ content?: string | null; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>) {
    let idx = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      const seq = sequence[Math.min(idx, sequence.length - 1)];
      idx++;
      return new Response(JSON.stringify({
        id: "x", object: "chat.completion", created: 1, model: "m",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: seq.content ?? null,
            tool_calls: seq.toolCalls ? seq.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) : undefined,
          },
          finish_reason: "stop",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const router = new ModelRouter(
      [{ name: "s", baseUrl: "http://x", kind: "local", priority: 1, roles: ["chat"] }],
      () => new ChatClient({ baseUrl: "http://x", fetchImpl }),
    );
    return router;
  }

  it("单轮：执行工具 → 回填 tool 消息 → 模型结束 → 返回最终文本", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "echo", description: "", parameters: {}, executeFn: async (a) => `E:${String(a.v ?? "")}` }));
    const router = makeRouter([
      { toolCalls: [{ id: "t1", name: "echo", arguments: '{"v":"hi"}' }] },
      { content: "完成了" },
    ]);
    const loop = new ToolLoop({ router, registry: reg });
    const messages = [
      { role: "user" as const, content: "调用工具" },
    ];
    const r = await loop.run({ agentId: "a1", messages, initialToolCalls: [{ id: "t1", name: "echo", arguments: '{"v":"hi"}' }] });
    expect(r.text).toBe("完成了");
    expect(r.rounds).toBe(2);
    expect(r.roundLog[0]).toEqual({ name: "echo", args: '{"v":"hi"}', result: "E:hi" });
    // 第 2 轮收到同参数调用 → 去重提示（不重复执行）
    expect(r.roundLog[1].result).toContain("已在本请求中执行过");
    expect(messages).toContainEqual({ role: "tool", tool_call_id: "t1", content: "E:hi" });
  });

  it("参数 JSON 解析失败 → 回填错误不执行工具", async () => {
    const exec = vi.fn(async () => "不应执行");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "e", description: "", parameters: {}, executeFn: exec }));
    const router = makeRouter([{ content: "结束" }]);
    const loop = new ToolLoop({ router, registry: reg });
    await loop.run({ agentId: "a1", messages: [], initialToolCalls: [{ id: "t1", name: "e", arguments: "{bad json" }] });
    expect(exec).not.toHaveBeenCalled();
  });

  it("请求级去重：同工具同参数只真实执行一次", async () => {
    const exec = vi.fn(async () => "结果");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "e", description: "", parameters: {}, executeFn: exec }));
    const router = makeRouter([
      { toolCalls: [{ id: "t1", name: "e", arguments: '{"a":1}' }] },
      { toolCalls: [{ id: "t2", name: "e", arguments: '{"a":1}' }] },
      { content: "done" },
    ]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [{ id: "t1", name: "e", arguments: '{"a":1}' }] });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r.roundLog.length).toBe(3); // t1 执行 + t1 去重 + t2 执行
    expect(r.roundLog[1].result).toContain("已在本请求中执行过");
    expect(r.roundLog[2].name).toBe("e");
  });

  it("轮次耗尽 → 返回上限摘要（含每轮工具链）", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "e", description: "", parameters: {}, executeFn: async () => "结果" }));
    // 每轮新参数 → 每轮真实执行 → 3 轮耗尽
    const router = makeRouter([
      { toolCalls: [{ id: "t1", name: "e", arguments: '{"i":1}' }] },
      { toolCalls: [{ id: "t2", name: "e", arguments: '{"i":2}' }] },
      { toolCalls: [{ id: "t3", name: "e", arguments: '{"i":3}' }] },
      { toolCalls: [{ id: "t4", name: "e", arguments: '{"i":4}' }] },
      { toolCalls: [{ id: "t5", name: "e", arguments: '{"i":5}' }] },
    ]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [{ id: "t0", name: "e", arguments: '{"i":0}' }] });
    expect(r.rounds).toBe(TOOL_MAX_ROUNDS);
    expect(r.text).toContain(`[工具调用轮次已达上限（${TOOL_MAX_ROUNDS} 轮）]`);
    expect(r.text).toContain('第3轮: e({"i":2}) → 结果');
  });

  it("沙箱插件点：权限检查拒绝 → [沙箱拒绝] 且不执行；放行正常执行", async () => {
    const exec = vi.fn(async () => "执行了");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "w", description: "", parameters: {}, executeFn: exec, permissions: ["write"] }));
    const sandbox: SandboxGate = { check: () => ({ allowed: false }) };
    const router = makeRouter([{ content: "结束" }]);
    const loop = new ToolLoop({ router, registry: reg, sandbox });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [{ id: "t1", name: "w", arguments: "{}" }] });
    expect(exec).not.toHaveBeenCalled();
    expect(r.roundLog[0].result).toContain("[沙箱拒绝]");
    expect(r.text).toBe("结束");
  });

  it("无沙箱时直接执行（默认放行）", async () => {
    const exec = vi.fn(async () => "执行了");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "w", description: "", parameters: {}, executeFn: exec, permissions: ["write"] }));
    const router = makeRouter([{ toolCalls: [{ id: "t1", name: "w", arguments: "{}" }] }, { content: "ok" }]);
    const loop = new ToolLoop({ router, registry: reg });
    await loop.run({ agentId: "a1", messages: [], initialToolCalls: [{ id: "t1", name: "w", arguments: "{}" }] });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});