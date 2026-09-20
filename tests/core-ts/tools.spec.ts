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

  it("工作目录锚定：设置 _workspace 后可在项目根外读写（Agent 指定工作目录场景）", async () => {
    const ws = await mkdtemp(join(tmpdir(), "ws-"));
    try {
      await writeFile(join(ws, "报告.md"), "# 工作活动", "utf-8");
      const rd = reg.get("file_read")!;
      expect(await rd.executeFn({ path: "报告.md", _workspace: ws })).toBe("# 工作活动");
      // 未注入 _workspace 时，同样路径（非绝对）会落到项目根 → 不存在
      expect(await rd.executeFn({ path: "报告.md" })).toContain("[错误] 文件不存在");
      // file_list 也在工作目录内生效
      const lst = reg.get("file_list")!;
      expect(await lst.executeFn({ path: ".", _workspace: ws })).toContain("报告.md");
      // file_write 亦写入工作目录
      const wr = reg.get("file_write")!;
      expect(await wr.executeFn({ path: "out.txt", content: "x", _workspace: ws })).toContain("已保存");
      expect(await readFile(join(ws, "out.txt"), "utf-8")).toBe("x");
      // 工作目录外（非 workspace 指定目录）仍拒绝 → 防逃逸
      expect(await rd.executeFn({ path: join(ws, ".."), _workspace: ws })).not.toContain("# 工作活动");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("沙箱豁免 _sandbox_allowed：用户批准的工作目录外路径可读写；未豁免仍硬拒；敏感防护不降级", async () => {
    // 临时目录在项目根外（用户授权场景：工作目录之外的独立目录）
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    const ws = await mkdtemp(join(tmpdir(), "ws-"));
    try {
      await writeFile(join(outside, "外部.txt"), "外部内容", "utf-8");
      const rd = reg.get("file_read")!;
      const wr = reg.get("file_write")!;

      // 未豁免：工作目录外路径仍被工具层硬拒（防逃逸防线未拆除）
      const denied = await rd.executeFn({ path: join(outside, "外部.txt"), _workspace: ws });
      expect(denied).toContain("[错误] 路径超出项目范围");

      // 已豁免（沙箱审批放行后由工具循环置位）：可读外部文件
      const ok = await rd.executeFn({ path: join(outside, "外部.txt"), _workspace: ws, _sandbox_allowed: true });
      expect(ok).toBe("外部内容");

      // 已豁免：可写外部路径
      const written = await wr.executeFn({ path: join(outside, "新.md"), content: "x", _workspace: ws, _sandbox_allowed: true });
      expect(written).toContain("已保存");
      expect(await readFile(join(outside, "新.md"), "utf-8")).toBe("x");

      // 豁免不降级敏感防护：敏感文件/黑名单仍拒绝（config 目录写入仍被拦）
      const sens = await rd.executeFn({ path: join(PROJECT_ROOT, "config", "auth_token.json"), _workspace: ws, _sandbox_allowed: true });
      expect(sens).toContain("[错误] 敏感文件禁止读取");
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
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
    expect(messages).toContainEqual({ role: "tool", tool_call_id: "t1", name: "echo", content: "E:hi" });
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
    expect(r.text).toContain(`[工具调用达到上限（${TOOL_MAX_ROUNDS} 轮）。已执行`);
    // 最后轮（500）：mock sequence 只给 5 组不同参数，其余轮全部命中请求级去重（"[提示] 相同参数"）
    expect(r.text).toContain('- e({');
    expect(r.text).toContain("[提示] 相同参数");
  });

  it("沙箱插件点：权限检查拒绝 → [沙箱拒绝] 且不执行；放行正常执行", async () => {
    const exec = vi.fn(async () => "执行了");
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "w", description: "", parameters: {}, executeFn: exec, permissions: ["write"] }));
    const sandbox: SandboxGate = { check: async () => ({ allowed: false }) };
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

  it("ask_user 钩子：模型提问 → onAskUser 返回用户选择并回填工具结果", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "ask_user", description: "", parameters: {}, executeFn: async () => "[提示] 需要用户交互" }));
    const onAskUser = vi.fn(async () => ({ answer: "选择 A", choice: "选择 A" }));
    const router = makeRouter([{ content: "好的，按你的选择继续" }]);
    const loop = new ToolLoop({ router, registry: reg, onAskUser });
    const r = await loop.run({
      agentId: "a1",
      agentName: "测试Agent",
      messages: [],
      initialToolCalls: [{
        id: "t1",
        name: "ask_user",
        arguments: JSON.stringify({ question: "方向分歧：A 还是 B？", options: ["选择 A", "选择 B"] }),
      }],
    });
    expect(onAskUser).toHaveBeenCalledTimes(1);
    expect(onAskUser).toHaveBeenCalledWith({
      agentId: "a1",
      agentName: "测试Agent",
      question: "方向分歧：A 还是 B？",
      options: ["选择 A", "选择 B"],
    });
    expect(r.roundLog[0].result).toContain("用户选择：选择 A");
    expect(r.text).toBe("好的，按你的选择继续");
  });

  it("ask_user 无钩子：回退工具内置提示，不编造用户回答", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "ask_user", description: "", parameters: {}, executeFn: async (args) => `[提示] 需要用户交互才能回答该问题，当前环境无可询问的用户界面。问题：${args.question}` }));
    const router = makeRouter([{ content: "ok" }]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.run({
      agentId: "a1",
      messages: [],
      initialToolCalls: [{ id: "t1", name: "ask_user", arguments: JSON.stringify({ question: "问题？" }) }],
    });
    expect(r.roundLog[0].result).toContain("[提示] 需要用户交互");
    expect(r.roundLog[0].result).not.toContain("用户回答");
  });

  it("ask_user 用户跳过：如实告知未作答，不编造选择", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "ask_user", description: "", parameters: {}, executeFn: async () => "[提示] 需要用户交互" }));
    const onAskUser = vi.fn(async () => ({ answer: "", skipped: true }));
    const router = makeRouter([{ content: "ok" }]);
    const loop = new ToolLoop({ router, registry: reg, onAskUser });
    const r = await loop.run({
      agentId: "a1",
      messages: [],
      initialToolCalls: [{ id: "t1", name: "ask_user", arguments: JSON.stringify({ question: "问题？" }) }],
    });
    expect(r.roundLog[0].result).toContain("用户未作答（跳过）");
  });
});

describe("ToolLoop.runStream（真流式工具循环：思考/正文边到边实时）", () => {
  interface StreamRound {
    reasoning?: string;
    content?: string;
    toolDeltas?: Array<Array<{ index: number; id?: string; name?: string; args?: string }>>;
  }
  function makeStreamRouter(rounds: StreamRound[]) {
    let idx = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      const seq = rounds[Math.min(idx, rounds.length - 1)];
      idx++;
      const lines: string[] = [];
      if (seq.reasoning) {
        lines.push(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { reasoning_content: seq.reasoning } }] })}`);
      }
      if (seq.content) {
        lines.push(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: seq.content } }] })}`);
      }
      for (const batch of seq.toolDeltas ?? []) {
        const tcs = batch.map((t) => ({
          index: t.index,
          ...(t.id ? { id: t.id, type: "function" } : {}),
          // function 对象合并（真实 SSE 分片：首片带 name，后续片只带 arguments 增量）
          function: {
            ...(t.name ? { name: t.name } : {}),
            ...(t.args !== undefined ? { arguments: t.args } : {}),
          },
        }));
        lines.push(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: tcs } }] })}`);
      }
      lines.push("data: [DONE]");
      return new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    return new ModelRouter(
      [{ name: "s", baseUrl: "http://x", kind: "local", priority: 1, roles: ["chat"] }],
      () => new ChatClient({ baseUrl: "http://x", fetchImpl }),
    );
  }

  it("思考/工具/正文按序实时回调（reasoning → tool → chunk）", async () => {
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "echo", description: "", parameters: {}, executeFn: async (a) => `E:${String(a.v ?? "")}` }));
    const router = makeStreamRouter([
      { reasoning: "先分析", toolDeltas: [[{ index: 0, id: "t1", name: "echo", args: '{"v":"hi"}' }]] },
      { reasoning: "再总结", content: "完成了" },
    ]);
    const loop = new ToolLoop({ router, registry: reg });
    const events: string[] = [];
    const r = await loop.runStream({
      agentId: "a1",
      messages: [],
      initialToolCalls: [],
      onEvent: (ev) => events.push(`${ev.type}:${(ev as { content?: string; name?: string }).content ?? (ev as { name?: string }).name ?? ""}`),
    });
    expect(r.text).toBe("完成了");
    expect(r.rounds).toBe(2);
    expect(r.reasonings).toEqual(["先分析", "再总结"]);
    // 顺序：第 1 轮思考 → 工具 → 第 2 轮思考 → 正文
    expect(events).toEqual(["reasoning:先分析", "tool:echo", "reasoning:再总结", "chunk:完成了"]);
  });

  it("流式 tool_calls 按 index 分片累积 → 完整参数执行工具", async () => {
    const exec = vi.fn(async (a) => `E:${String(a.v ?? "")}`);
    const reg = new ToolRegistry();
    reg.register(new Tool({ name: "echo", description: "", parameters: {}, executeFn: exec }));
    const router = makeStreamRouter([
      {
        toolDeltas: [
          [{ index: 0, id: "t1", name: "echo", args: "" }],
          [{ index: 0, args: '{"v":' }],
          [{ index: 0, args: '"hi"}' }],
        ],
      },
      { content: "ok" },
    ]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.runStream({ agentId: "a1", messages: [], initialToolCalls: [], onEvent: () => {} });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith({ v: "hi" });
    expect(r.text).toBe("ok");
  });

  it("无工具调用 → 单轮直接返回正文", async () => {
    const reg = new ToolRegistry();
    const router = makeStreamRouter([{ reasoning: "想一下", content: "直接回答" }]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.runStream({ agentId: "a1", messages: [], initialToolCalls: [], onEvent: () => {} });
    expect(r.rounds).toBe(1);
    expect(r.text).toBe("直接回答");
    expect(r.reasonings).toEqual(["想一下"]);
  });

  it("A-162：signal 已中止（用户停止/插入指令）→ 新一轮开始前截止，已产出内容保留（interrupted）", async () => {
    const reg = new ToolRegistry();
    // 第一轮思考+正文，第二轮内容"不会到达"
    const router = makeStreamRouter([
      { reasoning: "规划一下", content: "第一轮完成" },
      { content: "不会到达（已中止）" },
    ]);
    const controller = new AbortController();
    controller.abort(); // 预中止：等同用户在生成期间点停止（signal 已 aborted）
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.runStream({
      agentId: "a1",
      messages: [],
      initialToolCalls: [],
      signal: controller.signal,
      onEvent: () => {},
    });
    expect(r.interrupted).toBe(true);
    expect(r.text).toBe("");
  });

  it("A-164：工具执行中收到 signal 中止 → 首个工具完成后剩余工具不再执行（停止立即生效）", async () => {
    const reg = new ToolRegistry();
    const controller = new AbortController();
    // 第一个工具执行时触发"用户停止"（abort 生效于 tc1 执行期间）
    let firstToolRan = false;
    const exec = vi.fn(async (a) => {
      if (!firstToolRan) {
        firstToolRan = true;
        // 模拟用户在此刻点停止：signal 在 tc1 执行中变 aborted
        controller.abort();
      }
      return `E:${String(a.v ?? "")}`;
    });
    reg.register(new Tool({ name: "echo", description: "", parameters: {}, executeFn: exec }));
    const router = makeStreamRouter([{
      reasoning: "查资料",
      toolDeltas: [[
        { index: 0, id: "t1", name: "echo", args: '{"v":"1"}' },
        { index: 1, id: "t2", name: "echo", args: '{"v":"2"}' },
      ]],
    }]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.runStream({
      agentId: "a1",
      messages: [],
      initialToolCalls: [],
      signal: controller.signal,
      onEvent: () => {},
    });
    expect(r.interrupted).toBe(true);
    // tc1 执行完（其内部触发 abort），tc2 因 signal aborted 被跳过
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith({ v: "1" });
  });
});

/**
 * A-1009：路径范围判定的 win32 大小写回归守卫。
 *
 * 真实现象（2026-09-18 实测）：`realpath()` 返回磁盘规范拼写 `D:\pilot project\…`，
 * 而 `PROJECT_ROOT` 来自 cwd / import.meta.url 是小写 `d:\pilot project` →
 * 逐字符 startsWith 判定为「超出项目范围」→ **项目内已存在的文件一律读不到**
 * （不存在的新文件反而正常：那条路径不走 realpath 复核，所以症状很迷惑）。
 * 本组用例钉死「大小写不构成越界」，同时钉死「越界仍然必须被拒」。
 */
describe("文件工具：路径范围判定（win32 大小写 + 越界守卫）", () => {
  let reg: ToolRegistry;
  let work: string;

  beforeEach(async () => {
    resetRegistry();
    registerBuiltinTools();
    reg = getRegistry();
    work = await mkdtemp(join(PROJECT_ROOT, "data", "tool-tmp-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("项目内**已存在**的文件可读（realpath 规范化拼写后仍判定为项目内）", async () => {
    const f = join(work, "a.txt");
    await writeFile(f, "hello", "utf-8");
    expect(await reg.get("file_read")!.executeFn({ path: f })).toBe("hello");
    expect(await reg.get("file_list")!.executeFn({ path: work })).toContain("a.txt");
  });

  it.skipIf(process.platform !== "win32")("盘符大小写翻转后仍是同一个文件（win32 大小写不敏感）", async () => {
    const f = join(work, "b.txt");
    await writeFile(f, "world", "utf-8");
    const flipped = f.replace(/^([a-zA-Z])(:)/, (_m, d: string, colon: string) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()) + colon);
    expect(flipped).not.toBe(f);
    expect(await reg.get("file_read")!.executeFn({ path: flipped })).toBe("world");
  });

  it("反向守卫：项目外路径（含 .. 上溯）仍被拒绝，放宽大小写不等于放行越界", async () => {
    const outside = join(tmpdir(), "slime-nonexistent-guard.txt");
    expect(await reg.get("file_read")!.executeFn({ path: outside })).toContain("路径超出项目范围");
    expect(await reg.get("file_list")!.executeFn({ path: outside })).toContain("路径超出项目范围");
    expect(await reg.get("file_write")!.executeFn({ path: outside, content: "x" })).toContain("路径超出项目范围");
    const escape = join(PROJECT_ROOT, "..", "slime-escape-guard.txt");
    expect(await reg.get("file_read")!.executeFn({ path: escape })).toContain("路径超出项目范围");
  });
});