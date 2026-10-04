








import { ModelRouter } from "./router.js";
import { ChatMessage } from "shared/schemas";
import { OutputFilter, StreamFilter } from "./filter.js";

export interface AgentBrief {
  name: string;
  role: string;
}


export interface InjectionHooks {
  
  fixedSegments(agent: AgentBrief): string[];
  
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

  
  async buildSystemPrompt(agent: AgentBrief, agentId: string): Promise<string> {
    const parts: string[] = [IDENTITY_CONSTRAINT(agent.name, agent.role), HONESTY_PROTOCOL];
    parts.push(...this.hooks.fixedSegments(agent));
    const query = "用户最近的需求"; 
    parts.push(...(await this.hooks.retrieveSegments(agentId, query)));
    return parts.join("\n\n");
  }

  



  async chat(opts: SessionChatOptions): Promise<SessionChatResult> {
    const system = await this.buildSystemPrompt(opts.agent, opts.agentId);
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...opts.history,
    ];
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