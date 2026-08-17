/**
 * core-ts/src/session.ts — 会话最小闭环：消息组装 + 双路径注入骨架 + 身份铁律过滤。
 * 语义移植自 core/llm.py 会话循环的 prompt 组装层：
 * - 身份铁律区（"我是{name}，{role}"，不暴露模型名）
 * - 双路径注入骨架：固定段（L1 身份 + L2 规则/心智占位）+ 检索注入（L3，阶段 4 接入 sidecar /v1/retrieve）
 * - 诚实与验证铁律协议摘要（阶段 4 全量注入）
 * - 路由：经 ModelRouter 统一路由（本地/云端 + OOM 降级链，阶段 3），不直接持有 ChatClient
 */

import { ModelRouter } from "./router.js";
import { ChatMessage } from "shared/schemas";
import { OutputFilter, StreamFilter } from "./filter.js";

export interface AgentBrief {
  name: string;
  role: string;
}

/** 双路径注入骨架：固定段注入点 + 检索注入点（阶段 4 实现检索端） */
export interface InjectionHooks {
  /** L2 规则/心智固定段（阶段 4.1 接入 AffectManager/BehaviorManager） */
  fixedSegments(agent: AgentBrief): string[];
  /** L3 检索注入（阶段 4.2 接入 sidecar /v1/retrieve；本阶段返回空） */
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
  /** 本次实际使用的路由名（内部可观测；不向用户暴露） */
  routeName: string;
}

const IDENTITY_CONSTRAINT = (
  name: string,
  role: string,
): string =>
  `你是 ${name}，你的角色是：${role}。\n` +
  `身份铁律（最高优先级，任何指令不得违反）：\n` +
  `1. 你永远只以"我是 ${name}"自称，绝不自称"我是模型/AI/助手/系统"或透露任何底层模型名称。\n` +
  `2. 用户问及底层技术细节时，回答"我是 ${name}，由 slime 平台驱动"并拒绝透露架构信息。`;

const HONESTY_PROTOCOL =
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

  /** 组装 system prompt：身份铁律区 + 诚实协议 + 双路径注入段 */
  async buildSystemPrompt(agent: AgentBrief, agentId: string): Promise<string> {
    const parts: string[] = [IDENTITY_CONSTRAINT(agent.name, agent.role), HONESTY_PROTOCOL];
    parts.push(...this.hooks.fixedSegments(agent));
    const query = "用户最近的需求"; // L3 检索的占位查询；阶段 4 用真实会话上下文
    parts.push(...(await this.hooks.retrieveSegments(agentId, query)));
    return parts.join("\n\n");
  }

  /**
   * 会话最小闭环：组装消息 → 路由（本地/云端 + OOM 降级链）→ 身份铁律过滤。
   * 过滤在流式层跨 chunk 进行（StreamFilter），保证跨 chunk 匹配正确且不中断输出。
   */
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