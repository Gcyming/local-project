/**
 * core-ts/src/llm/client.ts — OpenAI 兼容客户端（流式 SSE + 429 退避）。
 * 语义移植自 core/llm.py：_RETRY_429_BACKOFF = (5.0, 15.0, 30.0, 60.0)，最多 3 次重试。
 * 仅依赖 Node 原生 fetch（undici），零额外 HTTP 依赖。
 */

import { ChatCompletionChunk, ChatRequest, ChatResponse } from "shared/schemas";

export const RETRY_429_BACKOFF = [5.0, 15.0, 30.0, 60.0];

export interface ChatStreamResult {
  /** 拼接的完整文本 */
  text: string;
  /** 收到的内容 chunk 数 */
  chunks: number;
  /** 上游返回的 model 名（过滤层消费，不向用户暴露） */
  model: string;
}

export class UpstreamError extends Error {
  public readonly status: number;
  public readonly kind: "rate_limited" | "upstream" | "timeout" | "protocol";

  constructor(message: string, status: number, kind: "rate_limited" | "upstream" | "timeout" | "protocol") {
    super(message);
    this.status = status;
    this.kind = kind;
    this.name = "UpstreamError";
  }
}

export interface ChatClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ChatClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: ChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async requestWithRetry(
    url: string,
    init: RequestInit,
    maxAttempts: number,
  ): Promise<Response> {
    let lastResp: Response | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await this.fetchImpl(url, { ...init, signal: controller.signal });
        if (resp.status !== 429 || attempt === maxAttempts - 1) {
          return resp;
        }
        lastResp = resp;
        const delay = RETRY_429_BACKOFF[attempt];
        await new Promise((r) => setTimeout(r, delay * 1000));
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          throw new UpstreamError(`请求超时（${this.timeoutMs}ms）`, 0, "timeout");
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new UpstreamError(`429 重试次数耗尽（${maxAttempts - 1} 次）`, lastResp?.status ?? 429, "rate_limited");
  }

  private async post(url: string, payload: unknown, maxAttempts: number): Promise<Response> {
    return this.requestWithRetry(
      url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(payload) },
      maxAttempts,
    );
  }

  /** 非流式 chat/completions */
  async chat(payload: ChatRequest): Promise<ChatResponse> {
    const resp = await this.post(`${this.baseUrl}/v1/chat/completions`, payload, RETRY_429_BACKOFF.length);
    if (resp.status >= 400) {
      throw new UpstreamError(
        `上游错误 ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
        resp.status,
        resp.status === 429 ? "rate_limited" : "upstream",
      );
    }
    try {
      return (await resp.json()) as ChatResponse;
    } catch {
      throw new UpstreamError("上游响应非 JSON", resp.status, "protocol");
    }
  }

  /**
   * 流式 chat/completions：逐 chunk 回调，返回拼接结果。
   * SSE 行格式：`data: {json}`，终止于 `data: [DONE]`。
   */
  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
  ): Promise<ChatStreamResult> {
    const resp = await this.post(
      `${this.baseUrl}/v1/chat/completions`,
      { ...payload, stream: true },
      RETRY_429_BACKOFF.length,
    );
    if (resp.status >= 400) {
      const text = (await resp.text()).slice(0, 200);
      throw new UpstreamError(
        `上游错误 ${resp.status}: ${text}`,
        resp.status,
        resp.status === 429 ? "rate_limited" : "upstream",
      );
    }
    if (!resp.body) {
      throw new UpstreamError("上游无响应体", resp.status, "protocol");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunks = 0;
    let text = "";
    let model = "";
    let done = false;

    try {
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            done = true;
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // 半行 JSON（极端分块），丢弃等下一行
          }
          const chunk = parsed as ChatCompletionChunk;
          if (!chunk.choices || chunk.choices.length === 0) {
            continue;
          }
          if (chunk.model && !model) {
            model = chunk.model;
          }
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            chunks++;
            text += delta;
            onDelta(delta);
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new UpstreamError("流式中断（上游超时）", 0, "timeout");
      }
      throw e;
    }

    return { text, chunks, model };
  }

  /** 嵌入（BGE-M3，OpenAI 格式） */
  async embeddings(input: string | string[]): Promise<number[][]> {
    const resp = await this.post(
      `${this.baseUrl}/v1/embeddings`,
      { model: "bge-m3", input },
      RETRY_429_BACKOFF.length,
    );
    if (resp.status >= 400) {
      throw new UpstreamError(
        `上游错误 ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
        resp.status,
        resp.status === 429 ? "rate_limited" : "upstream",
      );
    }
    const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
    return (data.data ?? []).map((d) => d.embedding ?? []);
  }
}