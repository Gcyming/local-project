/**
 * core-ts/src/a2a.ts — A2A (Agent-to-Agent) 通信总线 + 委托标记协议。
 * 语义移植自 core/a2a.py：
 * - 内存消息总线：register/send(点对点+broadcast)/drain_all/get_history/get_shared_context
 * - N10-L1：MAX_HISTORY=500、TTL=24h、MAX_CONTENT=100000 截断
 * - 委托协议（N10-S1 平衡标签解析）：<DELEGATE name="..">..</DELEGATE> /
 *   <DELEGATE_RESULT name="..">..</DELEGATE_RESULT> / <BROADCAST>..</BROADCAST>
 * - ServerA2ABus 单例（服务级生命周期）
 * TS 侧无 asyncio.Queue：队列为同步数组（drain_all 取空），send 同步。
 */

const MAX_HISTORY = 500;
const HISTORY_TTL = 86_400_000; // 24h（毫秒）
const MAX_CONTENT = 100_000;

export type A2AMsgType = "info" | "request" | "response" | "alert" | "done";

export interface A2AMessage {
  id: string;
  from_agent: string;
  to_agent: string; // "broadcast" = 广播给所有人
  content: string;
  msg_type: A2AMsgType;
  timestamp: number;
  request_id: string;
  in_reply_to: string;
}

export function makeA2AMessage(partial: Partial<A2AMessage> & { from_agent: string; to_agent: string; content: string }): A2AMessage {
  return {
    id: `msg_${Math.random().toString(16).slice(2, 10)}`,
    msg_type: "info",
    timestamp: Date.now(),
    request_id: "",
    in_reply_to: "",
    ...partial,
  };
}

function truncateContent(content: string): string {
  return content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content;
}

export class A2ABus {
  protected queues = new Map<string, A2AMessage[]>();
  private history: A2AMessage[] = [];
  private warnings: string[] = [];

  register(agentName: string): void {
    if (!this.queues.has(agentName)) {
      this.queues.set(agentName, []);
    }
  }

  unregister(agentName: string): void {
    this.queues.delete(agentName);
  }

  /** 发送消息。返回 delivered（至少一个接收方成功投递）。 */
  send(fromAgent: string, toAgent: string, content: string, msgType: A2AMsgType = "info", requestId = "", inReplyTo = ""): { msg: A2AMessage; delivered: boolean } {
    const msg = makeA2AMessage({ from_agent: fromAgent, to_agent: toAgent, content: truncateContent(content), msg_type: msgType, request_id: requestId, in_reply_to: inReplyTo });
    this.history.push(msg);
    this.pruneHistory();
    let delivered = false;
    if (toAgent === "broadcast") {
      for (const [name, q] of this.queues) {
        if (name !== fromAgent) {
          q.push(msg);
          delivered = true;
        }
      }
      if (!delivered) {
        this.warnings.push(`[broadcast] ${fromAgent} → 无其他 Agent 在线`);
      }
    } else {
      const q = this.queues.get(toAgent);
      if (q) {
        q.push(msg);
        delivered = true;
      } else {
        this.warnings.push(`[${fromAgent} → ${toAgent}] 接收方未注册`);
      }
    }
    return { msg, delivered };
  }

  /** 一次性取出所有待处理消息（非阻塞） */
  drainAll(agentName: string): A2AMessage[] {
    const q = this.queues.get(agentName);
    if (!q) return [];
    const msgs = q.splice(0);
    return msgs;
  }

  getHistory(agentName?: string): A2AMessage[] {
    if (agentName) {
      return this.history.filter(
        (m) => m.from_agent === agentName || m.to_agent === agentName || m.to_agent === "broadcast",
      );
    }
    return [...this.history];
  }

  /** 其他 Agent 进展共享上下文（最近 30 条筛选 → 最近 20 条渲染） */
  getSharedContext(agentName = ""): string {
    if (this.history.length === 0) return "";
    const relevant: string[] = [];
    for (const msg of this.history.slice(-30)) {
      if (agentName && msg.from_agent === agentName) continue;
      if (msg.msg_type === "done") relevant.push(`- [${msg.from_agent}] ✓ 已完成: ${msg.content}`);
      else if (msg.msg_type === "alert") relevant.push(`- [${msg.from_agent}] ⚠ 警告: ${msg.content}`);
      else if (msg.msg_type === "request") relevant.push(`- [${msg.from_agent}] 请求: ${msg.content}`);
      else if (msg.msg_type === "response") relevant.push(`- [${msg.from_agent}] 回复: ${msg.content}`);
      else relevant.push(`- [${msg.from_agent}] ${msg.content}`);
    }
    if (relevant.length === 0) return "";
    return ["## 其他 Agent 的进展：", ...relevant.slice(-20)].join("\n");
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  private pruneHistory(): void {
    const now = Date.now();
    this.history = this.history.filter((m) => now - m.timestamp < HISTORY_TTL);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  clear(): void {
    this.queues.clear();
    this.history = [];
    this.warnings = [];
  }
}

// ── 委托标记协议 ──────────────────────────────────────────

const DELEGATE_OPEN = "<DELEGATE";
const DELEGATE_CLOSE = "</DELEGATE>";

/** N10-S1：平衡标签解析（嵌套深度计数），返回 [{name, task}] */
export function parseDelegations(reply: string): Array<{ name: string; task: string }> {
  const results: Array<{ name: string; task: string }> = [];
  let pos = 0;
  for (;;) {
    const idx = reply.indexOf(DELEGATE_OPEN, pos);
    if (idx === -1) break;
    const tagEnd = reply.indexOf(">", idx);
    if (tagEnd === -1) break;
    const tagContent = reply.slice(idx + DELEGATE_OPEN.length, tagEnd);
    const nameMatch = /name="([^"]*)"/.exec(tagContent);
    if (!nameMatch) {
      pos = tagEnd + 1;
      continue;
    }
    const name = nameMatch[1].trim().slice(0, 64);
    if (!name) {
      pos = tagEnd + 1;
      continue;
    }
    let depth = 1;
    let scan = tagEnd + 1;
    while (depth > 0 && scan < reply.length) {
      const nextOpen = reply.indexOf(DELEGATE_OPEN, scan);
      const nextClose = reply.indexOf(DELEGATE_CLOSE, scan);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        scan = nextOpen + DELEGATE_OPEN.length;
      } else {
        depth -= 1;
        if (depth === 0) {
          const task = reply.slice(tagEnd + 1, nextClose).trim().slice(0, 2000);
          if (task) results.push({ name, task });
          scan = nextClose + DELEGATE_CLOSE.length;
          break;
        }
        scan = nextClose + DELEGATE_CLOSE.length;
      }
    }
    pos = Math.max(scan, tagEnd + 1);
  }
  return results;
}

const DELEGATE_RESULT_RE = /<DELEGATE_RESULT\s+name="([^"]+)"\s*>(.*?)<\/DELEGATE_RESULT>/g;
const BROADCAST_RE = /<BROADCAST\s*>(.*?)<\/BROADCAST>/g;

export function parseDelegationResults(reply: string): Array<{ name: string; result: string }> {
  const out: Array<{ name: string; result: string }> = [];
  for (const m of reply.matchAll(DELEGATE_RESULT_RE)) {
    out.push({ name: m[1].trim(), result: m[2].trim() });
  }
  return out;
}

export function parseBroadcast(reply: string): string | null {
  const m = BROADCAST_RE.exec(reply);
  return m ? m[1].trim() : null;
}

/** N10-S1：平衡标签移除（不依赖非贪婪正则），返回干净显示文本 */
export function stripDelegationTags(text: string): string {
  let t = text;
  for (;;) {
    const idx = t.indexOf(DELEGATE_OPEN);
    if (idx === -1) break;
    const tagEnd = t.indexOf(">", idx);
    if (tagEnd === -1) break;
    let depth = 1;
    let scan = tagEnd + 1;
    let found = false;
    while (depth > 0 && scan < t.length) {
      const no = t.indexOf(DELEGATE_OPEN, scan);
      const nc = t.indexOf(DELEGATE_CLOSE, scan);
      if (nc === -1) break;
      if (no !== -1 && no < nc) {
        depth += 1;
        scan = no + DELEGATE_OPEN.length;
      } else {
        depth -= 1;
        if (depth === 0) {
          t = t.slice(0, idx) + t.slice(nc + DELEGATE_CLOSE.length);
          found = true;
          break;
        }
        scan = nc + DELEGATE_CLOSE.length;
      }
    }
    if (!found) break;
  }
  t = t.replace(DELEGATE_RESULT_RE, "");
  t = t.replace(BROADCAST_RE, "");
  t = t.replace(/<\/DELEGATE>/g, "").replace(/<\/DELEGATE_RESULT>/g, "");
  return t.trim();
}

export function buildDelegationPrompt(children: Array<{ name: string; role?: string }>, allAgents?: string[]): string {
  const lines = ["\n## Agent 通信能力", "你可以通过以下方式与其他 Agent 协作：", ""];
  if (children.length > 0) {
    lines.push("### 点对点委托");
    lines.push("将子任务委托给特定子 Agent：");
    lines.push("");
    for (const c of children) {
      lines.push(`- **${c.name}**（${c.role ?? ""}）→ \`<DELEGATE name="${c.name}">具体子任务</DELEGATE>\``);
    }
    lines.push("");
  }
  if (allAgents && allAgents.length > 1) {
    lines.push("### 广播");
    lines.push("需要通知所有 Agent 或征集意见时，使用广播：");
    lines.push("`<BROADCAST>消息内容</BROADCAST>`");
    lines.push(`可广播的 Agent：${allAgents.join(", ")}`);
    lines.push("");
  }
  lines.push("### 使用规则：");
  lines.push("1. 点对点委托：当子任务明显属于特定子 Agent 的专业领域时使用");
  lines.push("2. 广播：当需要多个 Agent 的意见、或需要通知全体时使用");
  lines.push("3. 一次回复最多 3 个委托标记 + 1 个广播标记");
  lines.push("4. 所有标记会从显示文本中自动移除，用户看不到");
  lines.push("5. 委托/广播结果会自动回填，你可以基于结果继续回复用户");
  return lines.join("\n");
}

// ── ServerA2ABus（服务级单例）──────────────────────────────

export class ServerA2ABus extends A2ABus {
  private static instance: ServerA2ABus | null = null;

  static get(): ServerA2ABus | null {
    return ServerA2ABus.instance;
  }

  static reset(): void {
    ServerA2ABus.instance = null;
  }

  constructor() {
    super();
    ServerA2ABus.instance = this;
  }

  /** 委托任务给子 Agent */
  delegate(fromAgent: string, toAgent: string, task: string): { msgId: string; delivered: boolean } {
    const r = this.send(fromAgent, toAgent, truncateContent(task), "request");
    return { msgId: r.msg.id, delivered: r.delivered };
  }

  /** 子 Agent 回传委托结果 */
  sendResult(fromAgent: string, toAgent: string, result: string, requestId = ""): { msgId: string; delivered: boolean } {
    const r = this.send(fromAgent, toAgent, truncateContent(result), "response", requestId);
    return { msgId: r.msg.id, delivered: r.delivered };
  }

  broadcast(fromAgent: string, content: string, msgType: A2AMsgType = "info"): { msgId: string; delivered: boolean; count: number } {
    const names = this.getRegisteredNames().filter((n) => n !== fromAgent);
    const r = this.send(fromAgent, "broadcast", truncateContent(content), msgType);
    return { msgId: r.msg.id, delivered: r.delivered, count: names.length };
  }

  getRegisteredNames(): string[] {
    return [...this.queues.keys()];
  }
}