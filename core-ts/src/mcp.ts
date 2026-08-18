/**
 * core-ts/src/mcp.ts — MCP 客户端（语义移植自 core/mcp_client.py，逐行对照）。
 * 传输：stdio（子进程，JSONL/Content-Length 双帧嗅探 + 后台 reader 事件驱动）
 *       + Streamable HTTP（fetch + SSE 逐行，Mcp-Session-Id）。
 * 能力：tools / resources / prompts 桥接进 ToolRegistry（mcp_ / mcp_res_ / mcp_prompt_ 前缀）。
 * 权限：P2-3 按名覆写（tool_permissions），非法值回退 network；resources/prompts 固定 read。
 * 重连：A-096 上限 10 次，退避 1→60s（约 10 分钟），达上限 /mcp start 手动拉起。
 * OAuth 2.1（P2-5）：占位 OAuthManagerStub（未授权语义），完整浏览器授权流 = Electron 阶段 TODO。
 */

import { spawn, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Tool, ToolRegistry, ToolPermission, getRegistry } from "./tools/registry.js";

const JSONRPC = "2.0";
const PROTOCOL_VERSION = "2025-11-25";
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;
const MAX_BRIDGED = 64;
const MAX_RECONNECT = 10;
const MEDIA_LABEL: Record<string, string> = { image: "图片", audio: "音频", video: "视频" };
const VALID_PERMISSIONS: ToolPermission[] = ["read", "write", "terminal", "network"];

const PROJECT_ROOT = process.cwd();

// A-113：MCP 子进程环境白名单（不继承完整父环境，防窃取 API keys；slime.toml env 显式补充）
const ENV_ALLOWLIST = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "USERNAME", "USERPROFILE", "HOME",
  "LANG", "LC_ALL", "LANGUAGE", "APPDATA", "LOCALAPPDATA",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "VIRTUAL_ENV", "PYTHONIOENCODING",
];

export type MCPServerStatus = {
  name: string;
  running: boolean;
  tools: number;
  resources: number;
  prompts: number;
  last_error: string | null;
  oauth: string;
};

export type OAuthStatus = "pending" | "authorized" | "expired" | "none";

// ── OAuth 2.1 占位（P2-5 完整流 = Electron 阶段 TODO）────────────────

export class OAuthManagerStub {
  readonly serverName: string;
  readonly serverUrl: string;
  lastError: string | null = null;

  constructor(opts: { serverName: string; serverUrl: string }) {
    this.serverName = opts.serverName;
    this.serverUrl = opts.serverUrl;
  }

  status(): OAuthStatus {
    return "none";
  }

  async warmup(): Promise<boolean> {
    this.lastError = "OAuth 浏览器授权流未移植（Electron 阶段 TODO 5B.1）";
    return false;
  }

  getAuthHeader(): Record<string, string> {
    return {};
  }

  async ensureToken(_wwwAuth: string | null): Promise<string | null> {
    return null;
  }
}

// ── 传输抽象 ──────────────────────────────────────────────

export interface Transport {
  start(): Promise<boolean>;
  close(): Promise<void>;
  readonly running: boolean;
  request(payload: string, reqId: number, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  notify(payload: string): Promise<void>;
  flipFraming?(): boolean;
  onNotification?(frame: Record<string, unknown>): void | Promise<void>;
  onClose?(): void | Promise<void>;
}

// ── stdio 传输（JSONL / Content-Length 双帧嗅探，事件驱动 reader）──

export class StdioTransport implements Transport {
  private command: string;
  private args: string[];
  private env: Record<string, string> | undefined;
  private name: string;
  private framing: "jsonl" | "content_length";
  private proc: ChildProcess | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: Record<string, unknown> | null) => void; timer: NodeJS.Timeout }>();
  private closedByUs = false;

  onNotification?: (frame: Record<string, unknown>) => void | Promise<void>;
  onClose?: () => void | Promise<void>;

  constructor(opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    name: string;
    framing?: "jsonl" | "content_length";
  }) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.env = opts.env;
    this.name = opts.name;
    this.framing = opts.framing ?? "jsonl";
  }

  async start(): Promise<boolean> {
    if (this.proc && this.proc.exitCode === null) {
      return true;
    }
    try {
      const merged: Record<string, string> = {};
      for (const k of ENV_ALLOWLIST) {
        const v = process.env[k];
        if (v !== undefined) merged[k] = v;
      }
      if (this.env) Object.assign(merged, this.env);
      const proc = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: merged,
        windowsHide: true,
      });
      this.proc = proc;
      this.closedByUs = false;
      this.buf = Buffer.alloc(0);
      proc.stdout!.on("data", (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        this.processBuffered();
      });
      proc.stdout!.on("end", () => this.handleEof());
      proc.stdout!.on("error", () => this.handleEof());
      proc.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").replace(/\s+$/, "");
        if (text) console.debug(`[mcp] ${this.name} stderr: ${text}`);
      });
      return true;
    } catch (e) {
      console.warn(`[mcp] ${this.name} 启动失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.closedByUs = true;
    if (proc && proc.exitCode === null) {
      this.terminateTree(proc);
    }
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.pending.clear();
  }

  private terminateTree(proc: ChildProcess): void {
    // Windows：uvx/npx 包装器孙进程须 taskkill /T /F 整棵树；失败回退 kill
    if (process.platform === "win32" && proc.pid) {
      try {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
      } catch {
        // 忽略
      }
    }
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  private serialize(payload: string): Buffer {
    if (this.framing === "jsonl") {
      return Buffer.from(payload + "\n", "utf8");
    }
    return Buffer.from(
      `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`,
      "utf8",
    );
  }

  flipFraming(): boolean {
    this.framing = this.framing === "jsonl" ? "content_length" : "jsonl";
    return true;
  }

  request(payload: string, reqId: number, timeoutMs = REQUEST_TIMEOUT): Promise<Record<string, unknown> | null> {
    const proc = this.proc;
    if (!this.running || !proc) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时不杀进程：只丢弃本次 pending，reader 继续
        this.pending.delete(reqId);
        console.warn(`[mcp] ${this.name}: 请求超时 (id=${reqId})`);
        resolve(null);
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      try {
        proc.stdin!.write(this.serialize(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        console.warn(`[mcp] ${this.name} 通信失败: ${e instanceof Error ? e.message : String(e)}`);
        resolve(null);
      }
    });
  }

  async notify(payload: string): Promise<void> {
    const proc = this.proc;
    if (!this.running || !proc) {
      return;
    }
    try {
      proc.stdin!.write(this.serialize(payload));
    } catch {
      // 忽略
    }
  }

  private handleEof(): void {
    // 进程退出：清空所有 pending（在途 request 返回 null）
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.pending.clear();
    // 自然死亡（非 close()）→ 触发重连回调
    if (this.proc !== null && !this.closedByUs) {
      this.proc = null;
      const cb = this.onClose;
      if (cb) {
        try {
          void cb();
        } catch {
          // 忽略
        }
      }
    }
  }

  /** 同步解析缓冲中的完整帧（一个 chunk 可含多帧，循环处理） */
  private processBuffered(): void {
    for (;;) {
      const frame = this.readFrame();
      if (frame === undefined) {
        return; // 缓冲不足，等下一 chunk
      }
      if (frame === null) {
        continue; // 超限帧已排空，继续
      }
      this.dispatch(frame);
    }
  }

  /** 返回 undefined=缓冲不足；null=超限已排空；dict=完整帧 */
  private readFrame(): Record<string, unknown> | null | undefined {
    if (this.buf.length === 0) {
      return undefined;
    }
    const first = this.buf[0];
    if (first === 0x7b) {
      // JSONL：`{json}\n`
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) {
        if (this.buf.length > MAX_RESPONSE_BYTES) {
          console.warn(`[mcp] ${this.name}: JSONL 行超 ${MAX_RESPONSE_BYTES}B，排空跳过`);
          this.buf = Buffer.alloc(0);
          return null;
        }
        return undefined;
      }
      const line = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      try {
        return JSON.parse(line.toString("utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    // Content-Length：LSP 风格
    const headerEnd = this.buf.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) {
      if (this.buf.length > MAX_HEADER_BYTES) {
        console.warn(`[mcp] ${this.name}: Content-Length 头超大`);
        this.buf = Buffer.alloc(0);
        return null;
      }
      return undefined;
    }
    const headerLine = this.buf.subarray(0, headerEnd).toString("utf8").split("\r\n")[0];
    const m = /^Content-Length:\s*(\d+)$/i.exec(headerLine);
    if (!m) {
      this.buf = Buffer.alloc(0);
      return null;
    }
    const contentLen = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (contentLen > MAX_RESPONSE_BYTES || contentLen < 0) {
      console.warn(`[mcp] ${this.name}: 响应体过大 ${contentLen}B，排空跳过`);
      this.buf = this.buf.subarray(Math.min(bodyStart + contentLen, this.buf.length));
      return null;
    }
    if (this.buf.length < bodyStart + contentLen) {
      return undefined;
    }
    const body = this.buf.subarray(bodyStart, bodyStart + contentLen);
    this.buf = this.buf.subarray(bodyStart + contentLen);
    try {
      return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private dispatch(frame: Record<string, unknown>): void {
    const rid = frame.id;
    if (rid !== undefined) {
      const entry = this.pending.get(Number(rid));
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(Number(rid));
        entry.resolve(frame);
      } else {
        console.warn(`[mcp] ${this.name}: 迟到/未知响应 id=${String(rid)} 丢弃`);
      }
    } else {
      // notification（无 id）：异步分发回调，不卡读循环
      console.info(`[mcp] ${this.name}: notification ${String(frame.method ?? "")}`);
      const cb = this.onNotification;
      if (cb) {
        try {
          void cb(frame);
        } catch {
          // 忽略
        }
      }
    }
  }
}

// ── HTTP 传输（Streamable HTTP）────────────────────────────

export class HTTPTransport implements Transport {
  private url: string;
  private extraHeaders: Record<string, string>;
  private name: string;
  private sessionId: string | null = null;
  private oauth: OAuthManagerStub | null;
  private fetchImpl: typeof fetch;

  onNotification?: (frame: Record<string, unknown>) => void | Promise<void>;
  onClose?: () => void | Promise<void>;

  constructor(opts: {
    url: string;
    headers?: Record<string, string>;
    name: string;
    oauth?: OAuthManagerStub | null;
    fetchImpl?: typeof fetch;
  }) {
    this.url = opts.url.replace(/\/+$/, "");
    this.extraHeaders = opts.headers ?? {};
    this.name = opts.name;
    this.oauth = opts.oauth ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async start(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }

  get running(): boolean {
    return true;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const staticAuth = Object.keys(this.extraHeaders).some((k) => k.toLowerCase() === "authorization");
    if (this.oauth && !staticAuth) {
      Object.assign(h, this.oauth.getAuthHeader());
    }
    Object.assign(h, this.extraHeaders);
    if (this.sessionId) {
      h["Mcp-Session-Id"] = this.sessionId;
    }
    return h;
  }

  async request(payload: string, reqId: number, timeoutMs = REQUEST_TIMEOUT): Promise<Record<string, unknown> | null> {
    const data = await this.requestOnce(payload, reqId, timeoutMs);
    return data;
  }

  private async requestOnce(
    payload: string,
    reqId: number,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await this.fetchImpl(this.url, {
        method: "POST",
        body: payload,
        headers: this.headers(),
        signal: controller.signal,
      });
      const sid = resp.headers.get("Mcp-Session-Id");
      if (sid) {
        this.sessionId = sid;
      }
      const ctype = resp.headers.get("content-type") ?? "";
      if (ctype.includes("text/event-stream")) {
        return await this.readSseStream(resp, reqId, timeoutMs);
      }
      if (resp.status >= 400) {
        console.warn(`[mcp] ${this.name}: HTTP ${resp.status}`);
        return null;
      }
      return (await resp.json()) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[mcp] ${this.name} HTTP 请求失败: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 逐行读 SSE，命中 reqId 即返回；流结束未命中返回 null */
  private async readSseStream(
    resp: Response,
    reqId: number,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    if (!resp.body) {
      return null;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
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
          if (!data || data === "[DONE]") {
            continue;
          }
          try {
            const msg = JSON.parse(data) as Record<string, unknown>;
            if (msg.id === reqId) {
              return msg;
            }
          } catch {
            // 跳过坏行
          }
        }
        if (Date.now() > deadline) {
          console.warn(`[mcp] ${this.name}: SSE 流超时 (id=${reqId})`);
          return null;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return null;
  }

  async notify(payload: string): Promise<void> {
    try {
      await this.fetchImpl(this.url, { method: "POST", body: payload, headers: this.headers() });
    } catch {
      // 忽略
    }
  }
}

// ── MCP Server 连接 ────────────────────────────────────────

export class MCPServerError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "MCPServerError";
    this.code = code;
  }
}

export interface MCPCapabilityItem {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  uri?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  [key: string]: unknown;
}

export class MCPServer {
  name: string;
  toolPermissions: Record<string, string[]>;
  lastError: string | null = null;
  tools: MCPCapabilityItem[] = [];
  resources: MCPCapabilityItem[] = [];
  prompts: MCPCapabilityItem[] = [];

  private transport: Transport;
  private timeoutMs: number;
  private nextId = 0;
  private oauth: OAuthManagerStub | null;
  private refreshChain: Promise<void> = Promise.resolve();

  constructor(opts: {
    name: string;
    transport: Transport;
    timeoutMs?: number;
    toolPermissions?: Record<string, string[]>;
    oauth?: OAuthManagerStub | null;
  }) {
    this.name = opts.name;
    this.transport = opts.transport;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT;
    this.toolPermissions = opts.toolPermissions ?? {};
    this.oauth = opts.oauth ?? null;
  }

  /** P2-5：oauth 是否启用（startAll/startOne 的外壳超时判定） */
  get oauthEnabled(): boolean {
    return this.oauth !== null;
  }

  get oauthStatus(): string {
    return this.oauth ? this.oauth.status() : "none";
  }

  /** 暴露传输（MCPClient 挂 stdio 通知/断连回调用） */
  get transportInstance(): Transport {
    return this.transport;
  }

  /** 并发 list_changed 刷新串行化（收尾观察项 2） */
  refreshLock(fn: () => Promise<void> | void): Promise<void> {
    const run = this.refreshChain.then(async () => {
      await fn();
    });
    this.refreshChain = run.catch(() => undefined);
    return run;
  }

  async start(): Promise<boolean> {
    if (!(await this.transport.start())) {
      return false;
    }
    try {
      const params = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        clientInfo: { name: "slime", version: "0.3.0" },
      };
      const flip = this.transport.flipFraming;
      // stdio 握手探测：帧格式不符时短超时快速失败 → 同帧重试（启动慢）→ flip 重启重试
      let init = await this.request("initialize", params, flip ? 5_000 : undefined);
      if (init === null && flip) {
        if (this.transport.running) {
          console.info(`[mcp] ${this.name}: 握手探测超时但进程存活，先同帧格式重试`);
          init = await this.request("initialize", params);
        }
        if (init === null && flip()) {
          console.info(`[mcp] ${this.name}: 切换 stdio 帧格式重试握手`);
          await this.transport.close();
          if (await this.transport.start()) {
            init = await this.request("initialize", params);
          }
        }
      }
      if (init === null) {
        await this.transport.close();
        return false;
      }
      await this.notify("notifications/initialized", {});
      await this.discover();
      return true;
    } catch (e) {
      console.warn(`[mcp] ${this.name} 启动失败: ${e instanceof Error ? e.message : String(e)}`);
      await this.transport.close();
      return false;
    }
  }

  async stop(): Promise<void> {
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    await this.transport.close();
  }

  get running(): boolean {
    return this.transport.running;
  }

  async discover(): Promise<void> {
    const r = await this.listCapability("tools/list");
    if (r && typeof r === "object") {
      const arr = (r as Record<string, unknown>).tools;
      this.tools = Array.isArray(arr)
        ? arr.filter((t): t is MCPCapabilityItem => typeof t === "object" && t !== null)
        : [];
    }
    const rr = await this.listCapability("resources/list");
    if (rr && typeof rr === "object") {
      const arr = (rr as Record<string, unknown>).resources;
      this.resources = (Array.isArray(arr)
        ? arr.filter((x): x is MCPCapabilityItem => typeof x === "object" && x !== null)
        : []
      ).slice(0, MAX_BRIDGED);
    }
    const pr = await this.listCapability("prompts/list");
    if (pr && typeof pr === "object") {
      const arr = (pr as Record<string, unknown>).prompts;
      this.prompts = (Array.isArray(arr)
        ? arr.filter((p): p is MCPCapabilityItem => typeof p === "object" && p !== null)
        : []
      ).slice(0, MAX_BRIDGED);
    }
    console.info(
      `[mcp] ${this.name}: ${this.tools.length} tools / ${this.resources.length} resources / ${this.prompts.length} prompts`,
    );
  }

  private async listCapability(method: string): Promise<unknown> {
    try {
      return await this.request(method, {});
    } catch (e) {
      if (e instanceof MCPServerError) {
        console.info(`[mcp] ${this.name}: ${method} 不可用: ${e.message}`);
        return null;
      }
      throw e;
    }
  }

  private nextRequestId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const reqId = this.nextRequestId();
    const payload = JSON.stringify({ jsonrpc: JSONRPC, id: reqId, method, params });
    const resp = await this.transport.request(payload, reqId, timeoutMs ?? this.timeoutMs);
    if (resp === null) {
      return null;
    }
    if (resp.id !== reqId) {
      console.warn(`[mcp] ${this.name}: 响应 ID 不匹配 ${String(resp.id)} != ${reqId}`);
      return null;
    }
    if (resp.error) {
      const err = resp.error as Record<string, unknown>;
      throw new MCPServerError(Number(err.code ?? -1), String(err.message ?? JSON.stringify(err)));
    }
    return resp.result;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify({ jsonrpc: JSONRPC, method, params });
    await this.transport.notify(payload);
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    let result: unknown;
    try {
      result = await this.request("tools/call", { name: toolName, arguments: args });
    } catch (e) {
      if (e instanceof MCPServerError) {
        return `[错误] MCP 工具 '${toolName}' 调用失败: ${e.message} (code=${e.code})`;
      }
      throw e;
    }
    if (result === null) {
      return `[错误] MCP 工具 '${toolName}' 调用失败：服务无响应`;
    }
    const content = (result as Record<string, unknown>).content;
    return await this.contentToText(Array.isArray(content) ? content : []);
  }

  async readResource(uri: string): Promise<string> {
    let result: unknown;
    try {
      result = await this.request("resources/read", { uri });
    } catch (e) {
      if (e instanceof MCPServerError) {
        return `[错误] MCP 资源 '${uri}' 读取失败: ${e.message} (code=${e.code})`;
      }
      throw e;
    }
    if (result === null) {
      return `[错误] MCP 资源 '${uri}' 读取失败：服务无响应`;
    }
    const contents = (result as Record<string, unknown>).contents;
    const parts: string[] = [];
    if (Array.isArray(contents)) {
      for (const c of contents) {
        if (!c || typeof c !== "object") {
          continue;
        }
        const item = c as Record<string, unknown>;
        if (typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.blob === "string") {
          parts.push(`[二进制资源: ${String(item.mimeType ?? "unknown")}, ${String(item.uri ?? "")}]`);
        }
      }
    }
    return parts.length > 0 ? parts.join("\n") : "[MCP 空资源]";
  }

  async getPrompt(name: string, arguments_: Record<string, unknown> | null = null): Promise<string> {
    let result: unknown;
    try {
      result = await this.request("prompts/get", { name, arguments: arguments_ ?? {} });
    } catch (e) {
      if (e instanceof MCPServerError) {
        return `[错误] MCP 提示 '${name}' 获取失败: ${e.message} (code=${e.code})`;
      }
      throw e;
    }
    if (result === null) {
      return `[错误] MCP 提示 '${name}' 获取失败：服务无响应`;
    }
    const parts: string[] = [];
    if (typeof result === "object" && result !== null) {
      const res = result as Record<string, unknown>;
      if (typeof res.description === "string") {
        parts.push(res.description);
      }
      const messages = Array.isArray(res.messages) ? res.messages : [];
      for (const m of messages) {
        if (!m || typeof m !== "object") {
          continue;
        }
        const content = (m as Record<string, unknown>).content;
        if (content && typeof content === "object" && (content as Record<string, unknown>).type === "text") {
          parts.push(String((content as Record<string, unknown>).text ?? ""));
        }
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : "[MCP 空提示]";
  }

  /** MCP content 数组 → 文本；image/audio/video 落盘回传路径（P0-4） */
  private async contentToText(content: unknown[]): Promise<string> {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const it = item as Record<string, unknown>;
      const t = String(it.type ?? "");
      if (t === "text") {
        parts.push(String(it.text ?? ""));
      } else if (t === "resource") {
        parts.push(`[资源: ${JSON.stringify(it.resource ?? {})}]`);
      } else if (t === "image" || t === "audio" || t === "video") {
        const label = MEDIA_LABEL[t] ?? t;
        const data = String(it.data ?? "");
        let raw: Buffer;
        try {
          raw = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
        } catch {
          raw = Buffer.alloc(0);
        }
        if (raw.length === 0) {
          parts.push(`[${label}: 无数据]`);
          continue;
        }
        const path = await this.saveMedia(raw, String(it.mimeType ?? ""), t);
        parts.push(path ? `[${label}已保存: ${path}]` : `[${label}过大，已跳过]`);
      }
    }
    return parts.length > 0 ? parts.join("\n") : "[MCP 空响应]";
  }

  /** 二进制内容落盘 data/mcp/{server}/，返回绝对路径；超限/写失败返回 null */
  private async saveMedia(data: Buffer, mime: string, kind: string): Promise<string | null> {
    if (data.length > MAX_MEDIA_BYTES) {
      console.warn(`[mcp] ${this.name}: ${kind} 超 ${MAX_MEDIA_BYTES}B，跳过落盘`);
      return null;
    }
    let ext = "";
    if (mime && mime.includes("/")) {
      const raw = mime.split("/")[1].split(";")[0].split("+")[0].toLowerCase();
      ext = /^[a-z0-9]+$/.test(raw) ? `.${raw}` : "";
    }
    if (!ext) {
      ext = ({ image: ".png", audio: ".bin", video: ".bin" })[kind] ?? ".bin";
    }
    const digest = createHash("sha256").update(data).digest("hex").slice(0, 16);
    const safeName = this.name.replace(/[^A-Za-z0-9_-]/g, "_");
    const dir = join(PROJECT_ROOT, "data", "mcp", safeName);
    const path = join(dir, `${digest}${ext}`);
    try {
      await access(path);
    } catch {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(path, data);
      } catch (e) {
        console.warn(`[mcp] ${this.name}: 落盘失败: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
    return path;
  }
}

// ── MCP 客户端管理器 ────────────────────────────────────────

type ToolMapEntry = { server: string; kind: "tool" | "resource" | "prompt"; orig: string };

export class MCPClient {
  private servers = new Map<string, MCPServer>();
  private toolMap = new Map<string, ToolMapEntry>();
  private reconnectTasks = new Map<string, Promise<void>>();
  private registry: ToolRegistry;

  constructor(registry?: ToolRegistry) {
    this.registry = registry ?? getRegistry();
  }

  addServer(opts: {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    toolPermissions?: Record<string, string[]>;
    oauth?: boolean;
  }): void {
    const { name, command = "", args = [], env, url = "", headers, timeoutMs, toolPermissions, oauth = false } = opts;
    let transport: Transport;
    let oauthMgr: OAuthManagerStub | null = null;
    if (command) {
      transport = new StdioTransport({ command, args, env, name });
    } else if (url) {
      if (oauth) {
        if (!url) {
          console.warn(`[mcp] Server '${name}': oauth=true 仅对 url 型（HTTP）server 有效，已忽略`);
        } else {
          oauthMgr = new OAuthManagerStub({ serverName: name, serverUrl: url });
        }
      }
      transport = new HTTPTransport({ url, headers, name, oauth: oauthMgr });
    } else {
      throw new Error(`MCP Server '${name}' 缺少 command 或 url`);
    }
    this.servers.set(
      name,
      new MCPServer({ name, transport, timeoutMs: timeoutMs ?? REQUEST_TIMEOUT, toolPermissions, oauth: oauthMgr }),
    );
  }

  /** 注入已构造的 MCPServer（测试/宿主组装用；等价 addServer 的注册效果） */
  attachServer(name: string, server: MCPServer): void {
    this.servers.set(name, server);
  }

  /** 并发启动，每 server 独立超时；oauth server 放宽 360s，非 oauth 60s */
  async startAll(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    await Promise.all(
      [...this.servers.entries()].map(async ([name, server]) => {
        const limit = server.oauthEnabled ? 360_000 : 60_000;
        const ok = await this.withTimeout(server.start(), limit, `[mcp] ${name}: 启动失败/超时`);
        out[name] = ok;
        if (ok) {
          this.wireServer(name, server);
          this.registerCapabilities(name, server);
        }
      }),
    );
    return out;
  }

  async startOne(name: string): Promise<boolean> {
    const server = this.servers.get(name);
    if (!server) {
      return false;
    }
    let ok: boolean;
    if (server.oauthEnabled) {
      ok = await this.withTimeout(server.start(), 360_000, `[mcp] ${name}: 启动超时（360s，OAuth 授权窗口）`);
    } else {
      ok = await server.start();
    }
    if (ok) {
      this.wireServer(name, server);
      this.registerCapabilities(name, server);
    }
    return ok;
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, warnMsg: string): Promise<T> {
    const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(warnMsg)), ms));
    try {
      return await Promise.race([p, timer]);
    } catch (e) {
      console.warn(e instanceof Error ? e.message : String(e));
      return false as T;
    }
  }

  async stopAll(): Promise<void> {
    this.reconnectTasks.clear();
    await Promise.all([...this.servers.values()].map((s) => s.stop()));
    this.unregisterTools([...this.toolMap.keys()]);
    this.toolMap.clear();
  }

  async stopOne(name: string): Promise<boolean> {
    const server = this.servers.get(name);
    if (!server) {
      return false;
    }
    this.reconnectTasks.delete(name);
    this.unregisterServerTools(name);
    await server.stop();
    return true;
  }

  status(): MCPServerStatus[] {
    const out: MCPServerStatus[] = [];
    for (const [name, srv] of this.servers) {
      out.push({
        name,
        running: srv.running,
        tools: srv.tools.length,
        resources: srv.resources.length,
        prompts: srv.prompts.length,
        last_error: srv.lastError,
        oauth: srv.oauthStatus,
      });
    }
    return out;
  }

  async callTool(slimeName: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolMap.get(slimeName);
    if (!entry) {
      return `[错误] MCP 未找到工具 '${slimeName}'`;
    }
    const server = this.servers.get(entry.server);
    if (!server || !server.running) {
      return `[错误] MCP Server '${entry.server}' 未运行`;
    }
    if (entry.kind === "tool") {
      return server.callTool(entry.orig, args);
    }
    if (entry.kind === "resource") {
      return server.readResource(entry.orig);
    }
    return server.getPrompt(entry.orig, args);
  }

  // ── 桥接 ─────────────────────────────────────────────

  private registerCapabilities(serverName: string, server: MCPServer): void {
    for (const t of server.tools) {
      const name = t.name;
      if (!name) {
        continue;
      }
      const slimeName = this.uniqueSlimeName(`mcp_${name}`);
      this.toolMap.set(slimeName, { server: serverName, kind: "tool", orig: name });
      this.registry.register(new Tool({
        name: slimeName,
        description: t.description ?? `MCP 工具: ${name}`,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {}, required: [] },
        executeFn: async (args) => this.callTool(slimeName, args ?? {}),
        permissions: this.resolveToolPermissions(server, name),
      }));
    }
    for (let i = 0; i < server.resources.length; i++) {
      const r = server.resources[i];
      const uri = r.uri ?? "";
      if (!uri) {
        continue;
      }
      const name = r.name || `resource_${i}`;
      const slimeName = this.uniqueSlimeName(`mcp_res_${name}`);
      this.toolMap.set(slimeName, { server: serverName, kind: "resource", orig: uri });
      this.registry.register(new Tool({
        name: slimeName,
        description: r.description ?? `MCP 资源: ${name}`,
        parameters: { type: "object", properties: {}, required: [] },
        executeFn: async () => this.callTool(slimeName, {}),
        permissions: ["read"],
      }));
    }
    for (const p of server.prompts) {
      const name = p.name;
      if (!name) {
        continue;
      }
      const slimeName = this.uniqueSlimeName(`mcp_prompt_${name}`);
      this.toolMap.set(slimeName, { server: serverName, kind: "prompt", orig: name });
      this.registry.register(new Tool({
        name: slimeName,
        description: p.description ?? `MCP 提示: ${name}`,
        parameters: promptArgsToSchema(p.arguments ?? []),
        executeFn: async (args) => this.callTool(slimeName, args ?? {}),
        permissions: ["read"],
      }));
    }
  }

  /** 桥接名去重（P2-4）：已占用则后缀 _2/_3/... */
  private uniqueSlimeName(base: string): string {
    let name = base;
    let i = 2;
    while (this.toolMap.has(name)) {
      console.warn(`[mcp] 工具名 '${base}' 冲突，改用 '${base}_${i}'`);
      name = `${base}_${i}`;
      i += 1;
    }
    return name;
  }

  /** P2-3：按工具名/默认键解析权限，非法值回退 network */
  private resolveToolPermissions(server: MCPServer, toolName: string): ToolPermission[] {
    const cfg = server.toolPermissions ?? {};
    const raw = cfg[toolName] ?? cfg["default"] ?? ["network"];
    let perms: unknown[] = Array.isArray(raw) ? raw : [raw];
    perms = perms.filter((p): p is string => typeof p === "string");
    if (perms.length === 0) {
      return ["network"];
    }
    if (perms.some((p) => !VALID_PERMISSIONS.includes(p as ToolPermission))) {
      console.warn(`[mcp] ${server.name}: 工具 '${toolName}' 权限 ${JSON.stringify(perms)} 含非法值，回退 network`);
      return ["network"];
    }
    return perms as ToolPermission[];
  }

  private unregisterTools(names: string[]): void {
    for (const n of names) {
      this.registry.unregister(n);
    }
  }

  private unregisterServerTools(name: string): void {
    const toRemove: string[] = [];
    for (const [t, entry] of this.toolMap) {
      if (entry.server === name) {
        toRemove.push(t);
      }
    }
    for (const t of toRemove) {
      this.toolMap.delete(t);
    }
    this.unregisterTools(toRemove);
  }

  // ── 通知 / 重连接线（P1-3 / P2-1）──────────────────────

  private wireServer(name: string, server: MCPServer): void {
    const transport = server.transportInstance;
    if (!(transport instanceof StdioTransport)) {
      return;
    }
    transport.onNotification = (frame) => this.handleNotification(name, frame);
    transport.onClose = () => this.scheduleReconnect(name);
  }

  private async handleNotification(name: string, frame: Record<string, unknown>): Promise<void> {
    try {
      if (frame.method === "notifications/tools/list_changed") {
        await this.refreshServerTools(name);
      }
    } catch (e) {
      console.error(`[mcp] ${name}: 通知处理异常: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** list_changed → 重新发现 + 重注册（先摘旧再挂新，P1-3） */
  private async refreshServerTools(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server || !server.running) {
      return;
    }
    await server.refreshLock(() => {
      if (!server.running) {
        return;
      }
      return server.discover().then(() => {
        this.unregisterServerTools(name);
        this.registerCapabilities(name, server);
        console.info(`[mcp] ${name}: tools/list_changed 已刷新`);
      });
    });
  }

  /** 宿主/测试触发：tools/list_changed 通知处理 */
  async handleNotificationForTest(name: string): Promise<void> {
    await this.refreshServerTools(name);
  }

  /** 宿主/测试触发：传输断连 → 摘除工具 + 调度重连 */
  async simulateTransportCloseForTest(name: string): Promise<void> {
    this.scheduleReconnect(name);
  }

  /** 断连后摘除已死工具并调度指数退避重连（P2-1） */
  private scheduleReconnect(name: string): void {
    if (this.reconnectTasks.has(name)) {
      return;
    }
    const server = this.servers.get(name);
    if (!server) {
      return;
    }
    if (server.lastError === null) {
      server.lastError = "传输断开";
    }
    this.unregisterServerTools(name);
    const task = this.reconnectLoop(name);
    this.reconnectTasks.set(name, task);
    void task.finally(() => this.reconnectTasks.delete(name));
  }

  /** A-096：重连上限 10 次（退避 1→60s），达上限放弃，/mcp start 手动拉起 */
  private async reconnectLoop(name: string): Promise<void> {
    let backoff = 1_000;
    let attempt = 0;
    while (attempt < MAX_RECONNECT) {
      const server = this.servers.get(name);
      if (!server) {
        return;
      }
      await sleep(backoff);
      let ok = false;
      try {
        ok = await server.start();
      } catch (e) {
        server.lastError = e instanceof Error ? e.message : String(e);
      }
      if (ok) {
        this.registerCapabilities(name, server);
        server.lastError = null;
        console.info(`[mcp] ${name}: 重连成功`);
        return;
      }
      attempt += 1;
      backoff = Math.min(backoff * 2, 60_000);
      server.lastError = `重连失败（${attempt}/${MAX_RECONNECT}），${Math.round(backoff / 1000)}s 后重试`;
    }
    const srv = this.servers.get(name);
    if (srv) {
      srv.lastError = `重连放弃（${MAX_RECONNECT} 次），请用 /mcp start 手动拉起`;
    }
    console.warn(`[mcp] ${name}: 重连放弃（${MAX_RECONNECT} 次）`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** MCP prompt arguments → JSON Schema（全部 string 类型） */
export function promptArgsToSchema(arguments_: Array<{ name?: string; description?: string; required?: boolean }>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of arguments_) {
    const n = a.name ?? "";
    if (!n) {
      continue;
    }
    props[n] = { type: "string", description: a.description ?? "" };
    if (a.required) {
      required.push(n);
    }
  }
  return { type: "object", properties: props, required };
}

// ── 全局单例 ──────────────────────────────────────────────

let client: MCPClient | null = null;

export function getMCPClient(): MCPClient {
  if (client === null) {
    client = new MCPClient();
  }
  return client;
}

export function resetMCPClient(): void {
  client = null;
}
