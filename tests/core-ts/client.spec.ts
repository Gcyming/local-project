import { describe, expect, it, vi } from "vitest";
import { ChatClient, UpstreamError, RETRY_429_BACKOFF } from "../../core-ts/src/llm/client.js";

function sseBody(lines: string[]): Response {
  const text = lines.join("\n") + "\n";
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("ChatClient（OpenAI 兼容，语义移植自 core/llm.py _RETRY_429_BACKOFF）", () => {
  it("退避表与 Python 一致（5, 15, 30, 60）", () => {
    expect(RETRY_429_BACKOFF).toEqual([5.0, 15.0, 30.0, 60.0]);
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

  it("上游 5xx 直接抛 UpstreamError（不重试）", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
});
