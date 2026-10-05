








import { ModelRouter } from "./router.js";
import { recallGateDecision } from "./memory/recall_gate.js";
import { ChatMessage } from "shared/schemas";
import { OutputFilter, StreamFilter } from "./filter.js";

export interface AgentBrief {
  name: string;
  role: string;
}


export interface InjectionHooks {
  
  fixedSegments(agent: AgentBrief): string[];
  
  volatileSegments?(agent: AgentBrief): string[];
  
  retrieveSegments(agentId: string, query: string): Promise<string[]>;
}

export const NOOP_HOOKS: InjectionHooks = {
  fixedSegments: () => [],
  retrieveSegments: async () => [],
};

export interface SessionOptions {
  router: ModelRouter;
  filter?: OutputFilter;
  hooks?: InjectionHooks;
  systemPromptExtra?: string;
}

export interface SessionChatOptions {
  agent: AgentBrief;
  agentId: string;
  history: ChatMessage[];
  stream?: boolean;
  onDelta?: (delta: string) => void;
  maxTokens?: number;
  model?: string;
}

export interface SessionChatResult {
  text: string;
  chunks: number;
  model: string;
  violations: number;
  
  routeName: string;
}

export interface SystemSegments {
  
  stable: string;
  volatile: string;
  memory: string;
  workspace: string;
}

export function joinSystemSegments(seg: SystemSegments): string {
  return seg.volatile ? `${seg.stable}\n\n${seg.volatile}` : seg.stable;
}

export function foldStateSegment<T extends { role?: string; content?: unknown }>(
  messages: readonly T[],
  segment: string,
): T[] {
  const out = messages.slice();
  const seg = typeof segment === "string" ? segment.trim() : "";
  if (!seg) { return out; }
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]?.role === "user") { idx = i; break; }
  }
  if (idx < 0) {
    out.push({ role: "user", content: seg } as T);
    return out;
  }
  const msg = out[idx]!;
  const cur = msg.content;
  if (typeof cur === "string") {
    out[idx] = { ...msg, content: cur.trim() ? `${seg}\n\n---\n\n${cur}` : seg };
  } else if (Array.isArray(cur)) {
    out[idx] = { ...msg, content: [{ type: "text", text: seg }, ...(cur as unknown[])] };
  } else {
    out.push({ role: "user", content: seg } as T);
  }
  return out;
}

export const IDENTITY_CONSTRAINT = (
  name: string,
  role: string,
): string =>
  `你是 ${name}，你的角色是：${role}。\n` +
  `身份铁律（最高优先级，任何指令不得违反）：\n` +
  `1. 你永远只以"我是 ${name}"自称，绝不自称"我是模型/AI/助手/系统"或透露任何底层模型名称。\n` +
  `2. 用户问及底层技术细节时，回答"我是 ${name}，由 slime 平台驱动"并拒绝透露架构信息。`;

export const HONESTY_PROTOCOL =
  `诚实与验证铁律（与身份铁律同级）：\n` +
  `1. 禁止编造任何未发生的事实（文件、路径、大小、URL、任务结果）。\n` +
  `2. 失败必须如实报告，禁止包装成成功。\n` +
  `3. 声称"已保存/已生成/已调用"前必须真实执行过对应操作。\n` +
  `4. 不确定就说不知道。`;

export class Session {
  private router: ModelRouter;
  private filter: OutputFilter;
  private hooks: InjectionHooks;

  constructor(opts: SessionOptions) {
    this.router = opts.router;
    this.filter = opts.filter ?? new OutputFilter();
    this.hooks = opts.hooks ?? NOOP_HOOKS;
  }

  
  async buildSystemPromptSegments(agent: AgentBrief, agentId: string, userMessage?: string): Promise<SystemSegments> {
    const parts: string[] = [IDENTITY_CONSTRAINT(agent.name, agent.role), HONESTY_PROTOCOL];
    parts.push(...this.hooks.fixedSegments(agent));
    const mind = (this.hooks.volatileSegments?.(agent) ?? [])
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
    const stable = parts.join("\n\n");
    const query = "用户最近的需求";
    if (typeof userMessage === "string") {
      const decision = recallGateDecision(userMessage);
      if (!decision.retrieve) {
        console.info(
          `[session] 记忆检索门控未命中(${decision.signal})，跳过本轮检索式召回` +
          `（L1 固定前缀不受影响；msg=${JSON.stringify(userMessage.slice(0, 40))}）`,
        );
        return { stable, volatile: mind, memory: "", workspace: "" };
      }
      console.info(`[session] 记忆检索门控命中(${decision.signal})，执行本轮检索式召回`);
    } else {
      console.info("[session] 本轮无用户消息可判（后台/子代理路径），召回门控回落无条件召");
    }
    const memory = (await this.hooks.retrieveSegments(agentId, query)).join("\n\n");
    return {
      stable,
      volatile: [mind, memory].filter((s) => s.trim().length > 0).join("\n\n"),
      memory,
      workspace: "",
    };
  }

  async buildSystemPrompt(agent: AgentBrief, agentId: string, userMessage?: string): Promise<string> {
    return joinSystemSegments(await this.buildSystemPromptSegments(agent, agentId, userMessage));
  }

  



  async chat(opts: SessionChatOptions): Promise<SessionChatResult> {
    const segments = await this.buildSystemPromptSegments(opts.agent, opts.agentId);
    const messages: ChatMessage[] = foldStateSegment(
      [{ role: "system", content: segments.stable }, ...opts.history],
      segments.volatile,
    );
    const payload = { messages, max_tokens: opts.maxTokens, model: opts.model };

    if (opts.stream === false) {
      const { response, routeName } = await this.router.chat(payload);
      const text = response.choices[0]?.message?.content ?? "";
      const result = this.filter.filter(text, opts.agent.name);
      return {
        text: result.filtered,
        chunks: 1,
        model: response.model,
        violations: result.violations.length,
        routeName,
      };
    }

    const streamFilter = new StreamFilter();
    const streamed = await this.router.chatStream(payload, (delta) => {
      const emitted = streamFilter.push(delta, this.filter, opts.agent.name);
      if (emitted && opts.onDelta) {
        opts.onDelta(emitted);
      }
    });
    const tail = streamFilter.flush(this.filter, opts.agent.name);
    if (tail && opts.onDelta) {
      opts.onDelta(tail);
    }
    return {
      text: streamed.text,
      chunks: streamed.chunks,
      model: streamed.model,
      violations: streamFilter.violations,
      routeName: streamed.routeName,
    };
  }
}