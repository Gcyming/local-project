import { describe, expect, it, vi } from "vitest";
import { ChatClient, AnthropicClient, ResponsesClient, GoogleClient, UpstreamError, RETRY_429_BACKOFF, joinApiEndpoint } from "../../core-ts/src/llm/client.js";
import type { ChatMessage, ChatResponse } from "../../shared/gen/schemas.js";

/**
 * 取首个 choice 的 message。
 *
 * `ChatChoice.message` 在 `shared/gen/schemas.ts` 里是 **optional**（wire 上确实可能没有，
 * 例如只带 finish_reason 的响应），所以 `r.choices[0].message.content` 属于潜在的
 * undefined 解引用 —— 这就是本文件 7 条 TS2532 的共同根因。
 *
 * 用**显式抛错**而非 `?.`：这些用例断言的是具体文本，message 缺失即失败；
 * 写成 `?.` 会把"整个 message 没了"降级成 `expected undefined to be '答案'`，看不出真因。
 */
function firstMessage(r: ChatResponse): ChatMessage {
  const m = r.choices[0]?.message;
  if (!m) { throw new Error("响应缺少 choices[0].message（schema 里该字段可选，但本用例要求它存在）"); }
  return m;
}

function sseBody(lines: string[]): Response {
  const text = lines.join("\n") + "\n";
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("ChatClient（OpenAI 兼容，语义移植自 core/llm.py _RETRY_429_BACKOFF）", () => {
  it("429 退避表与 Python 一致（5, 15, 30, 60）", () => {
    expect(RETRY_429_BACKOFF).toEqual([5.0, 15.0, 30.0, 60.0]);
  });

  it("端点容错：base URL 多种形态（无 /v1 / 含 /v1 / 尾斜杠 / 已含完整路径）均拼出正确 chat 端点", async () => {
    const urls: string[] = [];
    const mk = (baseUrl: string) => {
      const fetchImpl = vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
          id: "x", object: "chat.completion", created: 1, model: "qwen",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch;
      return new ChatClient({ baseUrl, fetchImpl });
    };
    // 无 /v1
    await mk("https://gw.example.com").chat({ messages: [] });
    // 含 /v1
    await mk("https://gw.example.com/v1").chat({ messages: [] });
    // /v1 尾斜杠
    await mk("https://gw.example.com/v1/").chat({ messages: [] });
    // 已含完整路径
    await mk("https://gw.example.com/v1/chat/completions").chat({ messages: [] });
    // 完整路径 + 尾斜杠
    await mk("https://gw.example.com/v1/chat/completions/").chat({ messages: [] });
    // ⚠️ A-1008 回归：厂商 base 自带**非 /v1** 的版本段。智谱官方 base =
    //    https://open.bigmodel.cn/api/paas/v4，旧逻辑只硬化 endsWith("/v1") →
    //    拼出 /api/paas/v4/v1/chat/completions → 上游 404（用户实测群里某成员每轮发言都失败）。
    await mk("https://open.bigmodel.cn/api/paas/v4").chat({ messages: [] });
    await mk("https://open.bigmodel.cn/api/paas/v4/").chat({ messages: [] });
    await mk("https://open.bigmodel.cn/api/paas/v4/chat/completions").chat({ messages: [] });
    expect(urls).toEqual([
      "https://gw.example.com/v1/chat/completions",
      "https://gw.example.com/v1/chat/completions",
      "https://gw.example.com/v1/chat/completions",
      "https://gw.example.com/v1/chat/completions",
      "https://gw.example.com/v1/chat/completions",
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    ]);
  });

  it("非流式 chat 解析响应", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        id: "x1", object: "chat.completion", created: 1, model: "qwen",
        choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const resp = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(resp.choices[0].message?.content).toBe("你好");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("流式 SSE 逐 chunk 回调 + [DONE] 终止", async () => {
    const fetchImpl = vi.fn(async () =>
      sseBody([
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { content: "你" } }] })}`,
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { content: "好" } }] })}`,
        "data: [DONE]",
      ]),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const deltas: string[] = [];
    const r = await client.chatStream({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(["你", "好"]);
    expect(r.text).toBe("你好");
    expect(r.chunks).toBe(2);
    expect(r.model).toBe("qwen");
  });

  it("429 触发重试（最多 4 次尝试），成功后返回", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push("call");
      if (calls.length < 4) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({
        id: "x2", object: "chat.completion", created: 1, model: "qwen",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(50_000);
    const resp = await p;
    vi.useRealTimers();
    expect(resp.choices[0].message?.content).toBe("ok");
    expect(calls.length).toBe(4);
  });

  it("429 耗尽后抛 UpstreamError(kind=rate_limited)", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    let caught: unknown;
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(110_000);
    await p;
    vi.useRealTimers();
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).kind).toBe("rate_limited");
    expect((caught as UpstreamError).status).toBe(429);
  });

  it("语义/会话级 4xx（400）不重试（重试不会成功，对齐厂商语义错误分类）", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("上游 500/502 视为瞬态触发重试，耗尽后如实抛 status（A-175 对齐 OpenAI/Anthropic SDK 5xx 默认重试）", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push("call");
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    let caught: unknown;
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(15_000); // 抖动退避 1/3/7s 上限 11s
    await p;
    vi.useRealTimers();
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(500);
    expect(calls.length).toBe(4);

    // 502 同属瞬态集合（网关错误），耗尽后 status 透传
    const fetch502 = vi.fn(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const client502 = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl: fetch502 });
    vi.useFakeTimers();
    let caught502: unknown;
    const p502 = client502.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => {
      caught502 = e;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await p502;
    vi.useRealTimers();
    expect((caught502 as UpstreamError).status).toBe(502);
  });

  it("503 瞬态状态码触发重试（A-156），第 2 次成功后返回", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push(calls.length);
      if (calls.length < 2) {
        return new Response("service overloaded", { status: 503 });
      }
      return new Response(JSON.stringify({
        id: "x503", object: "chat.completion", created: 1, model: "qwen",
        choices: [{ index: 0, message: { role: "assistant", content: "recovered-503" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(10_000);
    const resp = await p;
    vi.useRealTimers();
    expect(resp.choices[0].message?.content).toBe("recovered-503");
    expect(calls.length).toBe(2);
  });

  it("429 携带 Retry-After 头 → 按头等待（A-156，不落默认 5s 退避表）", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push(calls.length);
      if (calls.length < 2) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } });
      }
      return new Response(JSON.stringify({
        id: "xra", object: "chat.completion", created: 1, model: "qwen",
        choices: [{ index: 0, message: { role: "assistant", content: "ok-retryafter" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(5_000);
    const resp = await p;
    vi.useRealTimers();
    expect(resp.choices[0].message?.content).toBe("ok-retryafter");
    expect(calls.length).toBe(2);
  });

  it("504 重试耗尽 → 如实抛出（A-156 瞬态需限次）", async () => {
    const fetchImpl = vi.fn(async () => new Response("gateway timeout", { status: 504 })) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await p;
    vi.useRealTimers();
    expect(out).toBeInstanceOf(UpstreamError);
    expect((out as UpstreamError).status).toBe(504);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("网络级瞬时错误（fetch failed）触发重试，第 2 次成功后返回（A-153 稳定性）", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push("call");
      if (calls.length < 2) {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({
        id: "x3", object: "chat.completion", created: 1, model: "qwen",
        choices: [{ index: 0, message: { role: "assistant", content: "retried-ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(20_000);
    const resp = await p;
    vi.useRealTimers();
    expect(resp.choices[0].message?.content).toBe("retried-ok");
    expect(calls.length).toBe(2);
  });

  it("网络级错误 4 次全失败 → 原样抛错（错误类型不被吞成 429 假象）（A-153）", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    vi.useFakeTimers();
    let caught: unknown;
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(150_000);
    await p;
    vi.useRealTimers();
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("embeddings 返回向量列表", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        object: "list", model: "bge-m3",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        usage: {},
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const vecs = await client.embeddings("你好");
    expect(vecs).toEqual([[0.1, 0.2]]);
  });

  it("Authorization 头仅在 apiKey 存在时携带", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>) ?? {});
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const noKey = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    await noKey.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(seen[0].Authorization).toBeUndefined();
    const withKey = new ChatClient({ baseUrl: "http://127.0.0.1:19100", apiKey: "sk-test", fetchImpl });
    await withKey.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(seen[1].Authorization).toBe("Bearer sk-test");
  });

  it("外部 signal 预中断：不发起请求，直接 reject 为已取消（GUI 停止按钮）", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () =>
      new Response("should not happen", { status: 200 }),
    ) as unknown as typeof fetch;
    controller.abort(); // 先拦截
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const out = await client
      .chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {}, controller.signal)
      .then(() => "resolved")
      .catch((e: unknown) => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out).toBeInstanceOf(UpstreamError);
    expect((out as UpstreamError).kind).toBe("protocol");
    expect((out as UpstreamError).message).toContain("取消");
  });

  it("外部 signal 流式中途中断：抛已取消（不误报超时）", async () => {
    const controller = new AbortController();
    const enc = new TextEncoder();
    let hookSignal: AbortSignal | null | undefined;
    let pulledOnce = false;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      hookSignal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
        },
        pull(c) {
          // 只吐一次分片，之后保持流打开；外部 abort → 触发 fetch 取消
          if (pulledOnce) {
            return;
          }
          pulledOnce = true;
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { content: "部" } }] })}\n\n`));
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const deltas: string[] = [];
    const p = client
      .chatStream({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d), controller.signal)
      .then(() => "resolved")
      .catch((e: unknown) => e);
    // 等首个分片消费后中断
    await new Promise((r) => setImmediate(r));
    expect(hookSignal?.aborted).toBe(false);
    controller.abort();
    const out = await p;
    expect(out).toBeInstanceOf(UpstreamError);
    expect((out as UpstreamError).kind).toBe("protocol");
    expect((out as UpstreamError).message).toContain("取消");
  });
});

describe("非流式 JSON 兜底（A-149：上游忽略 stream:true 直接返回完整 JSON，无 data: 行）", () => {
  const base = {
    id: "chatcmpl-ns",
    object: "chat.completion",
    created: 123,
    model: "ling-3.0-flash-fin-free",
  };

  function makeClient(bodyChunks: Uint8Array[]): ChatClient {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of bodyChunks) controller.enqueue(c);
        controller.close();
      },
    });
    const fetchImpl = (async () => ({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: stream,
    })) as unknown as typeof fetch;
    return new ChatClient({ baseUrl: "https://stub.example/v1", fetchImpl, timeoutMs: 5000 });
  }

  const enc = new TextEncoder();
  const json = (m: Record<string, unknown>) =>
    JSON.stringify({ ...base, choices: [{ index: 0, message: m, finish_reason: "stop" }] });

  it("单块完整非流式 JSON → 正文与 model 恢复（不再静默空回复）", async () => {
    const client = makeClient([enc.encode(json({ role: "assistant", content: "test1" }))]);
    const deltas: string[] = [];
    const r = await client.chatStream(
      { model: "ling-3.0-flash-fin-free", messages: [{ role: "user", content: "t" }] },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["test1"]);
    expect(r.text).toBe("test1");
    expect(r.chunks).toBe(1);
    expect(r.model).toBe("ling-3.0-flash-fin-free");
  });

  it("分块裸 JSON（全程无 data: 前缀）→ 正文恢复", async () => {
    const body = json({ role: "assistant", content: "分块正文" });
    const client = makeClient([enc.encode(body.slice(0, 20)), enc.encode(body.slice(20))]);
    const deltas: string[] = [];
    const r = await client.chatStream({ messages: [{ role: "user", content: "t" }] }, (d) => deltas.push(d));
    expect(r.text).toBe("分块正文");
    expect(deltas).toEqual(["分块正文"]);
  });

  it("非流式 JSON 携带 reasoning_content → 思考恢复 + 正文恢复", async () => {
    const client = makeClient([
      enc.encode(json({ role: "assistant", content: "最终正文", reasoning_content: "这是思考" })),
    ]);
    const reasonings: string[] = [];
    const r = await client.chatStream(
      { messages: [{ role: "user", content: "t" }] },
      () => undefined,
      undefined,
      (re) => reasonings.push(re),
    );
    expect(r.text).toBe("最终正文");
    expect(reasonings.join("")).toBe("这是思考");
  });

  it("非流式 JSON 携带 tool_calls → 工具调用经 onToolDelta 恢复", async () => {
    const client = makeClient([
      enc.encode(json({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_a", type: "function", function: { name: "record_todo", arguments: '{"text":"x"}' } }],
      })),
    ]);
    let toolDeltas: unknown[] = [];
    const r = await client.chatStream(
      { messages: [{ role: "user", content: "t" }] },
      () => undefined,
      undefined,
      undefined,
      (t) => { toolDeltas = t; },
    );
    expect(r.text).toBe("");
    expect(toolDeltas.length).toBe(1);
    const fn = (toolDeltas[0] as { index?: number; function?: { name?: string; arguments?: string } }).function;
    expect(fn?.name).toBe("record_todo");
    expect(fn?.arguments).toBe('{"text":"x"}');
  });

  it("既非流式也不是可解析 JSON → 抛 UpstreamError（不静默空回复）", async () => {
    const client = makeClient([enc.encode("<html>502 Bad Gateway</html>")]);
    await expect(
      client.chatStream({ messages: [{ role: "user", content: "t" }] }, () => undefined),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("完全空响应 → 抛 UpstreamError（提示上游空响应）", async () => {
    const client = makeClient([enc.encode("")]);
    const out = await client
      .chatStream({ messages: [] }, () => undefined)
      .then(() => "resolved")
      .catch((e: unknown) => e);
    expect(out).toBeInstanceOf(UpstreamError);
    expect((out as UpstreamError).message).toContain("空响应");
  });
});

describe("message 形态 SSE 块（A-149 补漏：网关缓冲非真流式模型，内容在 choices[0].message 而非 delta，且仍走 data: 行）", () => {
  const sseChunk = (choiceExtra: Record<string, unknown>) =>
    `data: ${JSON.stringify({
      id: "s1",
      object: "chat.completion.chunk",
      created: 1,
      model: "ling-3.0-flash-fin-free",
      choices: [{ index: 0, ...choiceExtra }],
    })}`;

  const client = (lines: string[]) =>
    new ChatClient({
      baseUrl: "https://stub.example/v1",
      timeoutMs: 5000,
      fetchImpl: (async () =>
        sseBody([
          ...lines,
          "data: [DONE]",
        ])) as unknown as typeof fetch,
    });

  it("message 形态单块 + [DONE]（model 已设置，此前逃逸 A-149 兜底门禁 → 静默空回复）→ 正文恢复", async () => {
    const deltas: string[] = [];
    const r = await client([
      sseChunk({ message: { role: "assistant", content: "test1" }, finish_reason: "stop" }),
    ]).chatStream(
      { model: "ling-3.0-flash-fin-free", messages: [{ role: "user", content: "t" }] },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["test1"]);
    expect(r.text).toBe("test1");
    expect(r.model).toBe("ling-3.0-flash-fin-free");
  });

  it("message 形态携带 reasoning_content → 思考恢复 + 正文恢复", async () => {
    const reasonings: string[] = [];
    const r = await client([
      sseChunk({ message: { role: "assistant", content: "最终正文", reasoning_content: "缓冲思考" }, finish_reason: "stop" }),
    ]).chatStream(
      { messages: [{ role: "user", content: "t" }] },
      () => undefined,
      undefined,
      (re) => reasonings.push(re),
    );
    expect(r.text).toBe("最终正文");
    expect(reasonings.join("")).toBe("缓冲思考");
  });

  it("message 形态 tool_calls → 完整对象经 onToolDelta 整体下发（枚举编号）", async () => {
    let toolDeltas: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> = [];
    const r = await client([
      sseChunk({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_b", type: "function", function: { name: "web_search", arguments: '{"q":"天气预报"}' } }],
        },
        finish_reason: "tool_calls",
      }),
    ]).chatStream(
      { messages: [{ role: "user", content: "t" }] },
      () => undefined,
      undefined,
      undefined,
      (t) => { toolDeltas = t as typeof toolDeltas; },
    );
    expect(r.text).toBe("");
    expect(toolDeltas.length).toBe(1);
    expect(toolDeltas[0].index).toBe(0);
    expect(toolDeltas[0].id).toBe("call_b");
    expect(toolDeltas[0].function?.name).toBe("web_search");
    expect(toolDeltas[0].function?.arguments).toBe('{"q":"天气预报"}');
  });

  it("messages 数组形态（AsyncAPI）→ 从末条 assistant 消息恢复正文", async () => {
    const deltas: string[] = [];
    const r = await client([
      sseChunk({
        messages: [
          { role: "assistant", content: "", tool_calls: [] },
          { role: "assistant", content: "数组形态正文" },
        ],
        finish_reason: "stop",
      }),
    ]).chatStream({ messages: [{ role: "user", content: "t" }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(["数组形态正文"]);
    expect(r.text).toBe("数组形态正文");
  });

  it("delta 仅含 role + message 携带正文（并存形态）→ 正文恢复且不重复", async () => {
    const deltas: string[] = [];
    const r = await client([
      sseChunk({ delta: { role: "assistant" }, message: { role: "assistant", content: "并存正文" }, finish_reason: "stop" }),
    ]).chatStream({ messages: [{ role: "user", content: "t" }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(["并存正文"]);
    expect(r.text).toBe("并存正文");
  });

  it("标准 delta 碎片工具调用保留原 index（message 回退不破坏增量拼接）", async () => {
    const toolDeltas: Array<{ index?: number; function?: { name?: string; arguments?: string } }> = [];
    await client([
      sseChunk({ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "a", arguments: "" } }] } }),
      sseChunk({ delta: { tool_calls: [{ index: 0, type: "function", function: { arguments: '{"x":1}' } }] } }),
    ]).chatStream(
      { messages: [{ role: "user", content: "t" }] },
      () => undefined,
      undefined,
      undefined,
      (t) => { toolDeltas.push(...(t as typeof toolDeltas)); },
    );
    expect(toolDeltas.length).toBe(2);
    expect(toolDeltas.map((d) => d.index)).toEqual([0, 0]);
    expect(toolDeltas.map((d) => d.function?.arguments ?? "")).toEqual(["", '{"x":1}']);
  });
});

describe("AnthropicClient 非流式兜底（A-149：/v1/messages 网关忽略 stream:true）", () => {
  function makeClient(lines: string): AnthropicClient {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(lines)); c.close(); },
    });
    const fetchImpl = (async () => ({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: stream,
    })) as unknown as typeof fetch;
    return new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl, timeoutMs: 5000 });
  }

  it("非流式 messages JSON → 正文从 content[0].text 恢复，model 恢复", async () => {
    const body = JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-x",
      content: [{ type: "text", text: "非流式正文" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 },
    });
    const client = makeClient(body);
    const deltas: string[] = [];
    const r = await client.chatStream({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d));
    expect(r.text).toBe("非流式正文");
    expect(deltas).toEqual(["非流式正文"]);
    expect(r.model).toBe("claude-x");
  });

  it("非流式 JSON 无正文 → 抛 UpstreamError", async () => {
    const body = JSON.stringify({ id: "m2", type: "message", content: [], stop_reason: "end_turn", usage: {} });
    const client = makeClient(body);
    await expect(client.chatStream({ messages: [] }, () => undefined)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("AnthropicClient 网络重试对称（A-156：与 ChatClient 同一套瞬态策略）", () => {
  function anthropicOk(body: string) {
    return JSON.stringify({
      id: "m1", type: "message", model: "claude-x",
      content: [{ type: "text", text: body }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 },
    });
  }

  it("网络瞬时错误触发重试，第 2 次成功后返回（此前零重试直接断联）", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push(calls.length);
      if (calls.length < 2) {
        throw new TypeError("fetch failed");
      }
      return new Response(anthropicOk("cliok"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl });
    vi.useFakeTimers();
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(10_000);
    const resp = await p;
    vi.useRealTimers();
    expect(resp.choices[0].message?.content).toBe("cliok");
    expect(calls).toHaveLength(2);
  });

  it("上游 429 触发重试（与 ChatClient 同表最多 4 次尝试）", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push(calls.length);
      if (calls.length < 4) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(anthropicOk("cliok-after-429"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl });
    vi.useFakeTimers();
    const p = client.chat({ messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(60_000);
    const resp = await p;
    vi.useRealTimers();
    expect(resp.choices[0].message?.content).toBe("cliok-after-429");
    expect(calls).toHaveLength(4);
  });

  it("上游 500 视为瞬态重试，耗尽后如实抛 status（A-175 与 ChatClient 同表 5xx 重试）", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push("call");
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const client = new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl });
    vi.useFakeTimers();
    let caught: unknown;
    const p = client.chat({ messages: [] }).catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(15_000); // 抖动退避 1/3/7s 上限 11s
    await p;
    vi.useRealTimers();
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(500);
    expect(calls).toHaveLength(4);
  });

  it("外部 signal 流式中途中断（Anthropic 取消桥，A-156 对齐 ChatClient）", async () => {
    const controller = new AbortController();
    const enc = new TextEncoder();
    let pulledOnce = false;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
        },
        pull(c) {
          if (pulledOnce) { return; }
          pulledOnce = true;
          c.enqueue(enc.encode(`data: ${JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "部" },
          })}\n\n`));
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl });
    const deltas: string[] = [];
    const p = client
      .chatStream({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d), controller.signal)
      .then(() => "resolved")
      .catch((e: unknown) => e);
    await new Promise((r) => setImmediate(r));
    expect(deltas).toEqual(["部"]);
    controller.abort();
    const out = await p;
    expect(out).toBeInstanceOf(UpstreamError);
    expect((out as UpstreamError).kind).toBe("protocol");
    expect((out as UpstreamError).message).toContain("取消");
  });
});

describe("模型级/供应商级错误作用域（A-157：RegionError/Model unavailable → 换模型可恢复）", () => {
  function chatErr(status: number, body: unknown): ChatClient {
    return new ChatClient({
      baseUrl: "http://mock/v1",
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
      ) as unknown as typeof fetch,
    });
  }

  it("403 RegionError 区域限制 → modelScope=model（可降级换模型）", async () => {
    const client = chatErr(403, { type: "error", error: { type: "RegionError", message: "This model is not available in your country." } });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).modelScope).toBe("model");
  });

  it("400 Model is unavailable → modelScope=model（可降级换模型）", async () => {
    const client = chatErr(400, { error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Model is unavailable." } });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect((e as UpstreamError).modelScope).toBe("model");
  });

  it("503 Endpoint is unavailable → modelScope=model（可降级换模型）", async () => {
    const client = new ChatClient({
      baseUrl: "http://mock/v1",
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Endpoint is unavailable." } }),
          { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "0" } },
        ),
      ) as unknown as typeof fetch,
    });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect((e as UpstreamError).modelScope).toBe("model");
  });

  it("401 认证失败 → modelScope=provider（换模型无意义，不降级）", async () => {
    const client = chatErr(401, { error: { type: "invalid_request_error", message: "Invalid API key provided" } });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect((e as UpstreamError).modelScope).toBe("provider");
  });

  it("普通 400 参数错误（非模型级关键词）→ modelScope 未识别（保守）", async () => {
    const client = chatErr(400, { error: { type: "invalid_request_error", message: "system message too long" } });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect((e as UpstreamError).modelScope).toBeUndefined();
  });
});

describe("SSE 空闲看门狗（A-157：连接建立后长时间无数据 → 判定上游僵死抛 timeout）", () => {
  it("headers 到达后流空转超过 IDLE_STREAM_MS → 抛 UpstreamError(timeout)（不无限挂起）", async () => {
    // 环境变量把看门狗调小（150ms），真实 timer 确定性验证。vi.resetModules 清缓存，
    // 让动态 import 重新读取 SLIME_STREAM_IDLE_MS（模块级常量首次求值）
    const prevIdle = process.env.SLIME_STREAM_IDLE_MS;
    process.env.SLIME_STREAM_IDLE_MS = "150";
    try {
      vi.resetModules();
      const mod = await import("../../core-ts/src/llm/client.js");
      const { ChatClient, UpstreamError } = mod as typeof import("../../core-ts/src/llm/client.js");
      const enc = new TextEncoder();
      const fetchImpl = vi.fn(async () => {
        let enqueued = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(c) {
            if (!enqueued) {
              enqueued = true;
              c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "你" } }] })}\n\n`));
            }
            // 后续 pull 不再 enqueue → 流保持打开但无数据（模拟上游 200 后静默断流）
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }) as unknown as typeof fetch;
      const client = new ChatClient({ baseUrl: "http://mock/v1", fetchImpl });
      const deltas: string[] = [];
      const p = client.chatStream({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d))
        .then(() => "resolved")
        .catch((e: unknown) => e);
      // 首个 chunk 实时交付
      await new Promise((r) => setTimeout(r, 400));
      expect(deltas).toEqual(["你"]);
      // 继续空转超过 150ms 看门狗 → 抛 timeout
      const out = await p;
      expect(out).toBeInstanceOf(UpstreamError);
      expect((out as UpstreamError).kind).toBe("timeout");
      expect((out as UpstreamError).message).toContain("空闲超时");
    } finally {
      process.env.SLIME_STREAM_IDLE_MS = prevIdle ?? "";
    }
  });
});

describe("缓存命中 token 采集（缓存命中率监测数据源）", () => {
  it("OpenAI 非流式 chat：prompt_tokens_details.cached_tokens / cache_write_tokens 归一化进 usage", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        id: "x", object: "chat.completion", created: 1, model: "qwen",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 100 } },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const resp = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(resp.usage?.cache_read_tokens).toBe(80);
    expect(resp.usage?.cache_creation_tokens).toBe(100);
    // A-974-R8：OpenAI 兼容系 `prompt_tokens` 是总量（已含 cached）→ 标记 true，窗口占用不再重复加 cache
    expect(resp.usage?.cache_read_in_prompt).toBe(true);
  });

  it("OpenAI 流式请求体带 stream_options.include_usage（缓存命中采集前提）", async () => {
    let body: unknown;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return sseBody([
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { content: "你" } }] })}`,
        "data: [DONE]",
      ]);
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    await client.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => undefined);
    expect((body as { stream?: boolean }).stream).toBe(true);
    expect((body as { stream_options?: unknown }).stream_options).toEqual({ include_usage: true });
  });

  it("OpenAI 流式末尾 usage 块（choices 空 + usage 非空）→ r.usage 含缓存命中 token", async () => {
    const fetchImpl = vi.fn(async () =>
      sseBody([
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { content: "你" } }] })}`,
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 90 } } })}`,
        "data: [DONE]",
      ]),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const deltas: string[] = [];
    const r = await client.chatStream({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(["你"]);
    expect(r.usage?.prompt_tokens).toBe(120);
    expect(r.usage?.completion_tokens).toBe(30);
    expect(r.usage?.cache_read_tokens).toBe(90);
  });

  // A-974-R6：DeepSeek 系网关的缓存命中字段名与 OpenAI 不同（prompt_cache_hit_tokens），
  // 此前只读 prompt_tokens_details.cached_tokens → 命中率恒 0%（静默失效，必须有回归兜住）。
  it("OpenAI 流式：DeepSeek 的 prompt_cache_hit_tokens → cache_read_tokens", async () => {
    const fetchImpl = vi.fn(async () =>
      sseBody([
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { content: "好" } }] })}`,
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 360 } })}`,
        "data: [DONE]",
      ]),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const r = await client.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => undefined);
    expect(r.usage?.prompt_tokens).toBe(1000);
    expect(r.usage?.cache_read_tokens).toBe(640);
    // 未命中部分（prompt_cache_miss_tokens）不单独计入——它本就在 prompt_tokens 里，重复计会虚高
    expect(r.usage?.cache_creation_tokens).toBeUndefined();
  });

  it("OpenAI 流式：completion_tokens_details.reasoning_tokens → reasoning_tokens（思考模型成本）", async () => {
    const fetchImpl = vi.fn(async () =>
      sseBody([
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "deepseek-reasoner", choices: [{ index: 0, delta: { content: "答案" } }] })}`,
        `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model: "deepseek-reasoner", choices: [], usage: { prompt_tokens: 50, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 260 } } })}`,
        "data: [DONE]",
      ]),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    const r = await client.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => undefined);
    expect(r.usage?.reasoning_tokens).toBe(260);
  });

  it("Anthropic 非流式 chat：cache_read_input_tokens / cache_creation_input_tokens 归一化进 usage", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        id: "m1", type: "message", model: "claude-x", role: "assistant",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 100 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const client = new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl });
    const resp = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(resp.usage?.prompt_tokens).toBe(100);
    expect(resp.usage?.completion_tokens).toBe(20);
    expect(resp.usage?.cache_read_tokens).toBe(80);
    expect(resp.usage?.cache_creation_tokens).toBe(100);
    // A-974-R8：Anthropic `input_tokens` 不含 cache → 标记 false，窗口占用须 prompt+cache_read
    expect(resp.usage?.cache_read_in_prompt).toBe(false);
  });

  it("Anthropic 流式 message_start(input 侧) + message_delta(output 侧) 归并 usage", async () => {
    const fetchImpl = vi.fn(async () =>
      sseBody([
        `data: ${JSON.stringify({ type: "message_start", message: { id: "m1", model: "claude-x", usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 100 } } })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "你" } })}`,
        `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 20 } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ]),
    ) as unknown as typeof fetch;
    const client = new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl });
    const deltas: string[] = [];
    const r = await client.chatStream({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(["你"]);
    expect(r.usage?.prompt_tokens).toBe(100);
    expect(r.usage?.completion_tokens).toBe(20);
    expect(r.usage?.cache_read_tokens).toBe(80);
    expect(r.usage?.cache_creation_tokens).toBe(100);
  });

  it("Anthropic 请求体：messages[0]=system 提升到顶层 system 并标记 cache_control:ephemeral", async () => {
    let body: unknown;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "m1", type: "message", model: "claude-x", role: "assistant",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new AnthropicClient({ baseUrl: "https://stub.example", apiKey: "sk-x", fetchImpl });
    await client.chat({ messages: [{ role: "system", content: "你是助手" }, { role: "user", content: "hi" }] });
    const b = body as { system?: Array<{ type: string; text: string; cache_control?: { type: string } }>; messages?: Array<{ role: string }> };
    expect(b.system).toEqual([{ type: "text", text: "你是助手", cache_control: { type: "ephemeral" } }]);
    expect(b.messages).toHaveLength(1);
    expect(b.messages?.[0].role).toBe("user");
  });
});

describe("ResponsesClient（OpenAI Responses API，GPT-5 系列）", () => {
  it("chat：发 /v1/responses，input 归一 + reasoning.effort，output 转 ChatResponse", async () => {
    const captured: { url?: string; body?: any } = {};
    const fetchImpl = vi.fn(async (url: unknown, init?: any) => {
      captured.url = String(url);
      captured.body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        id: "resp_1",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "思考中..." }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "答案" }] },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const c = new ResponsesClient({ baseUrl: "https://api.openai.com", fetchImpl });
    const r = await c.chat({ model: "gpt-5", messages: [{ role: "system", content: "你是助手" }, { role: "user", content: "hi" }], reasoning_effort: "high" } as any);
    expect(captured.url).toContain("/v1/responses");
    expect(captured.body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(captured.body.instructions).toBe("你是助手");
    expect(captured.body.reasoning).toEqual({ effort: "high" });
    expect(firstMessage(r).content).toBe("答案");
    expect(firstMessage(r).reasoning_content).toBe("思考中...");
    expect(r.usage?.prompt_tokens).toBe(5);
  });
});

describe("GoogleClient（Gemini generateContent）", () => {
  it("chat：发 generateContent，contents + thinkingConfig，candidates 转 ChatResponse", async () => {
    const captured: { url?: string; body?: any } = {};
    const fetchImpl = vi.fn(async (url: unknown, init?: any) => {
      captured.url = String(url);
      captured.body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "思考", thought: true }, { text: "回答" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const c = new GoogleClient({ baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k", fetchImpl });
    const r = await c.chat({ model: "gemini-3-flash", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" } as any);
    expect(captured.url).toContain("gemini-3-flash:generateContent");
    expect(captured.body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(captured.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "HIGH" });
    expect(firstMessage(r).content).toBe("回答");
    expect(firstMessage(r).reasoning_content).toBe("思考");
    expect(r.usage?.prompt_tokens).toBe(5);
  });
});

describe("ResponsesClient 工具往返", () => {
  it("tool 消息 → function_call_output，assistant tool_calls → function_call，function_call → tool_calls", async () => {
    const captured: { body?: any } = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: any) => {
      captured.body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        id: "r",
        output: [
          { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"beijing"}' },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const c = new ResponsesClient({ baseUrl: "https://x", fetchImpl });
    const r = await c.chat({ model: "gpt-5", messages: [
      { role: "user", content: "查天气" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"beijing"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "晴天" },
    ] } as any);
    expect(captured.body.input.some((i: any) => i.type === "function_call_output" && i.call_id === "call_1")).toBe(true);
    expect(captured.body.input.some((i: any) => i.type === "function_call" && i.name === "get_weather")).toBe(true);
    expect(firstMessage(r).tool_calls?.[0].function.name).toBe("get_weather");
  });
});

describe("GoogleClient 工具往返", () => {
  it("functionCall part → tool_calls", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "beijing" } } }] }, finishReason: "STOP" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const c = new GoogleClient({ baseUrl: "https://g", apiKey: "k", fetchImpl });
    const r = await c.chat({ model: "gemini-3", messages: [{ role: "user", content: "查天气" }] } as any);
    expect(firstMessage(r).tool_calls?.[0].function.name).toBe("get_weather");
    expect(firstMessage(r).tool_calls?.[0].function.arguments).toBe(JSON.stringify({ city: "beijing" }));
  });
});

describe("ResponsesClient 真流式", () => {
  it("解析 output_text.delta / reasoning_summary_text.delta / completed usage", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"type":"response.output_text.delta","delta":"你"}\n\ndata: {"type":"response.output_text.delta","delta":"好"}\n\ndata: {"type":"response.reasoning_summary_text.delta","delta":"思考"}\n\ndata: {"type":"response.completed","response":{"model":"gpt-5","usage":{"input_tokens":5,"output_tokens":3}}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    const c = new ResponsesClient({ baseUrl: "https://x", fetchImpl });
    const deltas: string[] = [];
    const reasonings: string[] = [];
    const r = await c.chatStream({ model: "gpt-5", messages: [] } as any, (d) => deltas.push(d), undefined, (rr) => reasonings.push(rr));
    expect(r.text).toBe("你好");
    expect(reasonings.join("")).toBe("思考");
    expect(r.usage?.prompt_tokens).toBe(5);
  });
});

describe("GoogleClient 真流式", () => {
  it("解析 streamGenerateContent 的 candidates SSE", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("streamGenerateContent");
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"世界"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const c = new GoogleClient({ baseUrl: "https://g", apiKey: "k", fetchImpl });
    const deltas: string[] = [];
    const r = await c.chatStream({ model: "gemini-3", messages: [] } as any, (d) => deltas.push(d));
    expect(r.text).toBe("你好世界");
    expect(r.usage?.prompt_tokens).toBe(5);
  });
});

describe("newApiConfigMap（new-api/one-api 倍率配置解析）", () => {
  it("按 new-api 源码基准换算：1 倍率 = $2/1M tokens", async () => {
    const { newApiConfigMap } = await import("../../gui/src/main/providers.js");
    // 源码 setting/ratio_setting/model_ratio.go 的 defaultModelRatio 真实值：
    //   gpt-4o = 1.25（源码注释即标 "$2.5 / 1M tokens"）、deepseek-chat = 0.135（$0.27/1M）
    const m = newApiConfigMap({
      model_ratio: { "gpt-4o": 1.25, "deepseek-chat": 0.135, "bad": 0 },
      completion_ratio: { "gpt-4o": 4 },
    });
    expect(m.get("gpt-4o")?.pricing).toEqual({ prompt: 2.5, completion: 10 });
    expect(m.get("deepseek-chat")?.pricing?.prompt).toBeCloseTo(0.27, 5);
    expect(m.has("bad")).toBe(false); // 非正数倍率跳过
  });

  it("model_price 是「按次计费」单价，不作 token 定价；无 model_ratio → 空表", async () => {
    const { newApiConfigMap } = await import("../../gui/src/main/providers.js");
    expect(newApiConfigMap(null).size).toBe(0);
    // 只有 model_price（图像/音乐/视频按次计费，如 dall-e-3=0.04/次）→ 不产出 token 定价
    expect(newApiConfigMap({ model_price: { "dall-e-3": 0.04 } }).size).toBe(0);
  });

  it("cache_ratio × prompt 派生缓存价（实测 deepseek-chat 案例）", async () => {
    const { newApiConfigMap } = await import("../../gui/src/main/providers.js");
    // deepseek-chat: ratio=0.135（$0.27/1M prompt），cache_ratio=0.25 → cacheRead = $0.0675/1M
    // create_cache_ratio=1.0（官方同 prompt 价）→ cacheCreate = $0.27/1M
    const m = newApiConfigMap({
      model_ratio: { "deepseek-chat": 0.135 },
      cache_ratio: { "deepseek-chat": 0.25 },
      create_cache_ratio: { "deepseek-chat": 1.0 },
    });
    expect(m.get("deepseek-chat")?.pricing?.promptCacheRead).toBeCloseTo(0.0675, 5);
    expect(m.get("deepseek-chat")?.pricing?.promptCacheCreate).toBeCloseTo(0.27, 5);
    // 没有 cache_ratio 的模型 → promptCacheRead undefined（不污染）
    expect(m.get("deepseek-chat")?.pricing?.prompt).toBeCloseTo(0.27, 5);
  });

  it("billing_expr 解析为 ParsedBillingExpr（含 boundary + 各 tier 乘数）", async () => {
    const { newApiConfigMap } = await import("../../gui/src/main/providers.js");
    // 真实 new-api v1.0 公式：gpt-6-astra 分档
    const m = newApiConfigMap({
      model_ratio: { "gpt-6-astra": 5 },
      billing_expr: {
        "gpt-6-astra": 'len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + cc * 12.5) : tier("long_context", p * 20 + c * 75 + cr * 2 + cc * 25)',
      },
      billing_mode: { "gpt-6-astra": "tiered_expr" },
    });
    const pricing = m.get("gpt-6-astra")?.pricing;
    expect(pricing?.billingMode).toBe("tiered_expr");
    expect(pricing?.tiered?.tiered).toBe(true);
    expect(pricing?.tiered?.boundary).toBe(272000);
    expect(pricing?.tiered?.tiers).toHaveLength(2);
    expect(pricing?.tiered?.tiers[0].label).toBe("standard");
    expect(pricing?.tiered?.tiers[0].multipliers?.prompt).toBe(10);
    expect(pricing?.tiered?.tiers[0].multipliers?.completion).toBe(50);
    expect(pricing?.tiered?.tiers[0].multipliers?.cacheRead).toBe(1);
    expect(pricing?.tiered?.tiers[0].multipliers?.cacheCreate).toBe(12.5);
    expect(pricing?.tiered?.tiers[1].label).toBe("long_context");
    expect(pricing?.tiered?.tiers[1].multipliers?.prompt).toBe(20);
  });
});

describe("parseBillingExpr（new-api 分档计费公式解析）", () => {
  it("非字符串/空输入 → undefined", async () => {
    const { parseBillingExpr } = await import("../../gui/src/main/providers.js");
    expect(parseBillingExpr(null)).toBeUndefined();
    expect(parseBillingExpr(undefined)).toBeUndefined();
    expect(parseBillingExpr(42)).toBeUndefined();
    expect(parseBillingExpr("")).toBeUndefined();
    expect(parseBillingExpr("   ")).toBeUndefined();
  });

  it("单 tier（无条件）→ tiered=false、tiers.length=1", async () => {
    const { parseBillingExpr } = await import("../../gui/src/main/providers.js");
    const r = parseBillingExpr('tier("flat", p * 1 + c * 4)');
    expect(r?.tiered).toBe(false);
    expect(r?.boundary).toBeUndefined();
    expect(r?.tiers).toHaveLength(1);
    expect(r?.tiers[0].label).toBe("flat");
    expect(r?.tiers[0].multipliers).toEqual({ prompt: 1, completion: 4, cacheRead: undefined, cacheCreate: undefined });
  });

  it("条件公式 → boundary + 2 tier，标签/乘数都正确", async () => {
    const { parseBillingExpr } = await import("../../gui/src/main/providers.js");
    const r = parseBillingExpr(
      'len <= 200000 ? tier("std", p * 5 + c * 15) : tier("long", p * 10 + c * 30)',
      "tiered_expr"
    );
    expect(r?.tiered).toBe(true);
    expect(r?.boundary).toBe(200000);
    expect(r?.mode).toBe("tiered_expr");
    expect(r?.raw).toContain("len <= 200000");
    expect(r?.tiers[0].label).toBe("std");
    expect(r?.tiers[1].label).toBe("long");
    expect(r?.tiers[0].multipliers).toEqual({ prompt: 5, completion: 15, cacheRead: undefined, cacheCreate: undefined });
    expect(r?.tiers[1].multipliers).toEqual({ prompt: 10, completion: 30, cacheRead: undefined, cacheCreate: undefined });
  });

  it("cr/cc 缓存乘数独立提取", async () => {
    const { parseBillingExpr } = await import("../../gui/src/main/providers.js");
    const r = parseBillingExpr('tier("with_cache", p * 3 + c * 15 + cr * 0.3 + cc * 3.75)');
    expect(r?.tiers[0].multipliers).toEqual({ prompt: 3, completion: 15, cacheRead: 0.3, cacheCreate: 3.75 });
  });

  it("畸形公式 → tiers 为空（不抛、不假阳性）", async () => {
    const { parseBillingExpr } = await import("../../gui/src/main/providers.js");
    expect(parseBillingExpr("garbage formula")?.tiers).toEqual([]);
    expect(parseBillingExpr("tier(bad quotes)")?.tiers).toEqual([]);
    expect(parseBillingExpr("tier()")?.tiers).toEqual([]);
    // len 边界非数字 → 不当条件分支处理，当单 tier 解析失败 → tiers 空、boundary undefined
    const r = parseBillingExpr("len <= abc ? tier(\"a\", p*1) : tier(\"b\", p*2)");
    expect(r?.boundary).toBeUndefined();
    expect(r?.tiers).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────
 * A-1008：API 端点拼接**唯一实现**的正交用例。
 *
 * 为什么单独立一组：上面那组走 ChatClient.chat()（含 fetch mock，只覆盖 openai 形态）。
 * 端点规则被 Chat / Anthropic / Responses / Gemini(含 streamGenerateContent) / thread_worker
 * **六处**调用 —— 必须在**规则层**穷举，否则「改一处漏四处」会再次发生
 * （智谱 /v4 被拼成 /v4/v1/chat/completions 即此类事故）。
 * ───────────────────────────────────────────────────────────── */
describe("joinApiEndpoint（A-1008 端点拼接唯一实现）", () => {
  it("base 无版本段 → 补上 path 的版本段", () => {
    expect(joinApiEndpoint("https://gw.example.com", "/v1/chat/completions"))
      .toBe("https://gw.example.com/v1/chat/completions");
  });

  it("base 带 /v1 → 不重复补版本段", () => {
    expect(joinApiEndpoint("https://api.deepseek.com/v1", "/v1/chat/completions"))
      .toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("⚠️ 回归：base 带非 /v1 的厂商版本段（智谱 /v4）→ 不再插入 /v1", () => {
    expect(joinApiEndpoint("https://open.bigmodel.cn/api/paas/v4", "/v1/chat/completions"))
      .toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
  });

  it("字母后缀版本段（/v1beta）整体吃掉 → 不产生 /v1beta/v1beta", () => {
    expect(joinApiEndpoint("https://generativelanguage.googleapis.com/v1beta", "/v1beta/models/gemini-2.5-pro:generateContent"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
  });

  it("尾斜杠归一（含多重斜杠）", () => {
    expect(joinApiEndpoint("https://gw.example.com/v1/", "/v1/chat/completions"))
      .toBe("https://gw.example.com/v1/chat/completions");
    expect(joinApiEndpoint("https://gw.example.com///", "/v1/chat/completions"))
      .toBe("https://gw.example.com/v1/chat/completions");
  });

  it("幂等：已含完整 path（可带尾斜杠）→ 原样返回，可重复调用", () => {
    const full = "https://gw.example.com/v1/chat/completions";
    expect(joinApiEndpoint(full, "/v1/chat/completions")).toBe(full);
    expect(joinApiEndpoint(full + "/", "/v1/chat/completions")).toBe(full);
    expect(joinApiEndpoint(full, "/v1/chat/completions")).toBe(full);
    const zp = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
    expect(joinApiEndpoint(zp, "/v1/chat/completions")).toBe(zp);
  });

  it("base 已含功能段（无版本，极端自定义网关）→ 原样返回", () => {
    expect(joinApiEndpoint("https://gw.example.com/chat/completions", "/v1/chat/completions"))
      .toBe("https://gw.example.com/chat/completions");
  });

  it("空 base → 退化为 path（不产出畸形相对串）", () => {
    expect(joinApiEndpoint("", "/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("Anthropic / Responses / Gemini(流式) 三种 path 同样走通", () => {
    expect(joinApiEndpoint("https://api.anthropic.com", "/v1/messages"))
      .toBe("https://api.anthropic.com/v1/messages");
    expect(joinApiEndpoint("https://api.openai.com/v1", "/v1/responses"))
      .toBe("https://api.openai.com/v1/responses");
    expect(joinApiEndpoint("https://generativelanguage.googleapis.com", "/v1beta/models/m:streamGenerateContent?alt=sse"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse");
  });
});
