/**
 * core-ts/src/tool_loop.ts — 多轮工具调用循环（BUG-032 语义移植）。
 * 语义移植自 core/llm.py _handle_tool_calls：
 * - 每轮：执行 pending 工具调用（沙箱检查 → 去重 → 回填 tool 消息）→ 再请求模型
 * - MAX_ROUNDS=3 上限（与 core.executor.MAX_ROUNDS 对齐）；耗尽返回轮次摘要（不过滤模型名）
 * - 参数 JSON 解析失败回填错误不执行；请求级去重（同工具同参数只真实执行一次）
 * - 沙箱为插件点：sandboxGateFrom 把 L0-L5 SandboxManager 桥接为 SandboxGate（4.4）
 */

import { ModelRouter } from "./router.js";
import { ChatMessage } from "shared/schemas";
import { ToolRegistry } from "./tools/registry.js";
import { SandboxManager } from "./sandbox.js";

export const TOOL_MAX_ROUNDS = 3;

export interface SandboxDecision {
  allowed: boolean;
  anomalyDetected?: boolean;
  anomalyAlerts?: string[];
}

export interface SandboxGate {
  /** 按工具所需权限逐级检查；返回拒绝原因时工具不执行（对齐 manager.check_permission 语义） */
  check(agentId: string, toolName: string, target: string, level: number): SandboxDecision;
}

export interface ToolLoopOptions {
  router: ModelRouter;
  registry: ToolRegistry;
  sandbox?: SandboxGate;
}

/** 请求体 tools schema 项（契约 ChatToolSchema） */
export interface ToolSchema {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ToolRoundDetail {
  name: string;
  args: string;
  result: string;
}

/** 扁平工具调用（执行用） */
export interface FlatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 把 L0-L5 沙箱管理器桥接为 SandboxGate（4.4 接入点；授权同步 + 审计） */
export function sandboxGateFrom(manager: SandboxManager): SandboxGate {
  return {
    check(agentId, toolName, target, level) {
      const r = manager.grantPermissionSync({ agentId, action: toolName, target, level });
      return { allowed: r.allowed, anomalyDetected: r.anomalyDetected, anomalyAlerts: r.anomalyAlerts };
    },
  };
}

/** 契约格式（消息回填用） */
export interface ContractToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toFlat(calls: ContractToolCall[]): FlatToolCall[] {
  return calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
}

function toContract(calls: FlatToolCall[]): ContractToolCall[] {
  return calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
}

export interface ToolLoopResult {
  /** 最终文本（模型内容 / 工具调用后无文本回复 / 轮次上限摘要） */
  text: string;
  raw: string;
  rounds: number;
  roundLog: ToolRoundDetail[];
}

/** 权限等级映射（read=0, write=2, terminal=3, network=4；未知 fail-closed 最高级） */
const PERM_LEVEL: Record<string, number> = { read: 0, write: 2, terminal: 3, network: 4 };

export class ToolLoop {
  private router: ModelRouter;
  private registry: ToolRegistry;
  private sandbox: SandboxGate | null;

  constructor(opts: ToolLoopOptions) {
    this.router = opts.router;
    this.registry = opts.registry;
    this.sandbox = opts.sandbox ?? null;
  }

  private async executePendingTools(
    messages: ChatMessage[],
    pending: FlatToolCall[],
    agentId: string,
    dedup: Set<string>,
  ): Promise<ToolRoundDetail[]> {
    const details: ToolRoundDetail[] = [];
    for (const tc of pending) {
      let args: Record<string, unknown>;
      let argsStr = tc.arguments;
      try {
        args = JSON.parse(tc.arguments || "{}");
        argsStr = JSON.stringify(args);
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "[错误] 工具参数 JSON 解析失败，未执行",
        });
        details.push({ name: tc.name, args: tc.arguments, result: "[错误] 参数 JSON 解析失败" });
        continue;
      }

      const dedupKey = `${tc.name}:${argsStr}`;
      if (dedup.has(dedupKey)) {
        const msg = "[提示] 相同参数的该工具已在本请求中执行过（结果见上方工具记录），不再重复执行";
        messages.push({ role: "tool", tool_call_id: tc.id, content: msg });
        details.push({ name: tc.name, args: argsStr, result: msg });
        continue;
      }

      const tool = this.registry.get(tc.name);
      let result: string;
      if (tool && this.sandbox) {
        const target = String(args.url ?? args.path ?? args.file ?? args.target ?? JSON.stringify(args));
        let denied = false;
        for (const perm of tool.permissions) {
          const level = PERM_LEVEL[perm] ?? 4;
          const decision = this.sandbox.check(agentId, tc.name, target, level);
          if (!decision.allowed) {
            denied = true;
            break;
          }
        }
        if (denied) {
          result = `[沙箱拒绝] 工具 '${tc.name}' 需要未授权的权限`;
        } else {
          result = await this.registry.callTool(tc.name, args);
        }
      } else {
        result = await this.registry.callTool(tc.name, args);
      }

      if (!result.startsWith("[沙箱拒绝]")) {
        dedup.add(dedupKey); // 真实执行后记录；沙箱拒绝允许重试
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      details.push({ name: tc.name, args: argsStr, result: result.slice(0, 200) });
    }
    return details;
  }

  /**
   * 多轮工具循环：执行工具 → 请求 → 模型继续要工具则再轮（上限 TOOL_MAX_ROUNDS）。
   * 返回 { text, raw, rounds, roundLog }；text 为对外安全文本（raw 供存储/学习）。
   */
  async run(opts: {
    agentId: string;
    messages: ChatMessage[];
    initialToolCalls: FlatToolCall[];
    maxTokens?: number;
    model?: string;
    /** 4.5：工具 schema 列表（模型可主动发起工具调用；Worker 首轮必须注入） */
    tools?: ToolSchema[];
  }): Promise<ToolLoopResult> {
    const dedup = new Set<string>();
    let pending = opts.initialToolCalls;
    const roundLog: Array<{ round: number; details: ToolRoundDetail[] }> = [];

    for (let round = 1; round <= TOOL_MAX_ROUNDS; round++) {
      const details = await this.executePendingTools(opts.messages, pending, opts.agentId, dedup);
      roundLog.push({ round, details });

      const resp = await this.router.chat({
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        model: opts.model,
        tools: opts.tools,
      });
      const msg = resp.response.choices[0]?.message;
      const nextCalls = toFlat((msg?.tool_calls ?? []) as unknown as ContractToolCall[]);
      if (nextCalls.length === 0) {
        const raw = msg?.content ?? "";
        return {
          text: raw,
          raw,
          rounds: round,
          roundLog: roundLog.map((r) => r.details).flat(),
        };
      }
      opts.messages.push({
        role: "assistant",
        content: msg?.content ?? null,
        tool_calls: toContract(nextCalls),
      });
      pending = nextCalls;
    }

    const text = this.formatRoundLimit(roundLog);
    return { text, raw: text, rounds: TOOL_MAX_ROUNDS, roundLog: roundLog.map((r) => r.details).flat() };
  }

  /** 工具轮次上限文案（附每轮工具链摘要，便于直接看出卡点） */
  formatRoundLimit(roundLog: Array<{ round: number; details: ToolRoundDetail[] }>): string {
    const lines = [`[工具调用轮次已达上限（${TOOL_MAX_ROUNDS} 轮）]`];
    for (const r of roundLog) {
      for (const d of r.details) {
        lines.push(`第${r.round}轮: ${d.name}(${d.args}) → ${d.result}`);
      }
    }
    return lines.join("\n");
  }
}