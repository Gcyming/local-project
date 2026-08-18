/**
 * core-ts/src/services/swarm.ts — SwarmService（slime_server.py /swarm/report 语义移植 + 调度封装）。
 * - report：Swarm 任务完成上报（A-031）——输入校验（task/summary 非空、results ≤16、
 *   state 白名单、字段截断）→ _post_process_swarm 管线（记忆提取 → 演化 → 知识 pattern
 *   task.swarm.* → 行为 reinforce（swarm_extracted）→ 情绪（novelty/violation）→ 巩固 → 保存）
 * - dispatch：Swarm 任务调度封装（拆解 → SwarmExecutor.run → 合并），复用 core-ts executor/merger
 */

import { RunOptions, RunResult, SwarmExecutor, WorkerAgentSpec } from "../executor.js";
import { sandboxGateFrom } from "../tool_loop.js";
import { AgentRegistry, AgentState } from "./agents.js";
import { detectNovelty } from "./novelty.js";
import { historyUserLoader } from "./history.js";
import { PostProcessHooks } from "./chat.js";
import { ChatServiceError } from "./chat.js";
import { SlimeEngine } from "./engine.js";

export interface SwarmReportItem {
  name?: unknown;
  state?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface SwarmReportRequest {
  task: string;
  summary: string;
  results: SwarmReportItem[];
}

export interface SwarmReportResult {
  ok: boolean;
  success: boolean;
  memory_count: { facts: number; traits: number };
  lifecycle: string;
}

export interface SwarmServiceOptions {
  registry: AgentRegistry;
  /** 调度执行器（缺省用 engine 组装 SwarmExecutor；Electron 主进程/CLI 注入覆盖） */
  dispatchRunner?: (agent: AgentState, opts: RunOptions) => Promise<RunResult>;
  /** 真执行器（SlimeEngine）；未提供且无 dispatchRunner → 501 */
  engine?: SlimeEngine;
  postProcess?: PostProcessHooks;
  /** 记忆提取开关（slime.toml memory.enabled；5B.3 接线配置读取，缺省 false） */
  memoryEnabled?: boolean;
  /** 知识引擎数据目录（测试隔离用；缺省项目 Knowledge 目录） */
  dataDir?: string;
  logger?: Pick<Console, "warn" | "info" | "debug">;
}

/** 输入清洗（对齐 slime_server.py swarm_report：state 白名单 + 字段截断） */
export function cleanSwarmResults(results: unknown): Array<{
  name: string;
  state: "done" | "failed";
  result: string;
  error: string;
}> {
  const out: Array<{ name: string; state: "done" | "failed"; result: string; error: string }> = [];
  if (!Array.isArray(results)) {
    return out;
  }
  for (const r of results) {
    if (!r || typeof r !== "object") {
      continue;
    }
    const item = r as Record<string, unknown>;
    const rawState = String(item.state ?? "");
    const state = rawState === "done" ? "done" : "failed";
    out.push({
      name: String(item.name ?? "").slice(0, 64),
      state,
      result: String(item.result ?? "").slice(0, 2000),
      error: String(item.error ?? "").slice(0, 500),
    });
  }
  return out;
}

export class SwarmService {
  private registry: AgentRegistry;
  private dispatchRunner: (agent: AgentState, opts: RunOptions) => Promise<RunResult>;
  private postProcess: PostProcessHooks;
  private memoryEnabled: boolean;
  private dataDir: string | undefined;
  private logger: Pick<Console, "warn" | "info" | "debug">;

  constructor(opts: SwarmServiceOptions) {
    this.registry = opts.registry;
    this.dispatchRunner =
      opts.dispatchRunner ??
      (opts.engine
        ? ((agent: AgentState, runOpts: RunOptions) => this.runWithEngine(opts.engine!, agent, runOpts))
        : (async () => {
            throw new ChatServiceError(501, "Swarm 调度执行器未接线（注入 engine 或 dispatchRunner）");
          }));
    this.postProcess = opts.postProcess ?? {};
    this.memoryEnabled = opts.memoryEnabled ?? false;
    this.dataDir = opts.dataDir;
    this.logger = opts.logger ?? console;
  }

  /** 默认调度：用 SlimeEngine 组装 SwarmExecutor（真执行器接线，A1 闭环） */
  private async runWithEngine(engine: SlimeEngine, agent: AgentState, runOpts: RunOptions): Promise<RunResult> {
    const router = await engine.routerFor(agent);
    if (!router) {
      throw new ChatServiceError(503, "主 Agent 未配置可用模型路由（provider 缺失），无法调度 Swarm");
    }
    // 持久子 Agent 名单（config/agents.json 其余 Agent，A-053 角色路由）
    const roster: WorkerAgentSpec[] = this.registry.loadedAgents
      .filter((a) => a.id !== agent.id)
      .map((a) => ({
        name: a.name,
        role: a.role,
        providerKey: a.model_choice.startsWith("api:") ? a.model_choice.slice(4) : undefined,
        identityPrompt: a.identity_prompt,
      }));
    const executor = new SwarmExecutor({
      providersCount: Math.max(1, engine.providersCount),
      router,
      registry: engine.toolRegistry,
      sandbox: engine.sandboxManager ? sandboxGateFrom(engine.sandboxManager) : undefined,
      agents: roster,
      mainAgentName: agent.name,
      mainIdentityPrompt: agent.identity_prompt,
    });
    return executor.run(runOpts);
  }

  /** Swarm 任务调度（CLI/Electron 入口；拆解/执行/合并全在 executor 内） */
  async dispatch(agentId: string, task: string, opts: Partial<RunOptions> = {}): Promise<RunResult> {
    const agent = await this.registry.findAgent(agentId);
    if (!agent) {
      throw new ChatServiceError(404, "Agent 不存在");
    }
    if (!task?.trim()) {
      throw new ChatServiceError(400, "task 不能为空");
    }
    const runOptions: RunOptions = { task, ...opts };
    return this.dispatchRunner(agent, runOptions);
  }

  /** Swarm 任务完成上报（A-031）：主 Agent 沉淀本次 Swarm 经验（记忆/演化/行为） */
  async report(agentId: string, req: SwarmReportRequest): Promise<SwarmReportResult> {
    const agent = await this.registry.findAgent(agentId);
    if (!agent) {
      throw new ChatServiceError(404, "Agent 不存在");
    }
    const task = String(req.task ?? "").trim();
    const summary = String(req.summary ?? "").trim();
    if (!task || !summary) {
      throw new ChatServiceError(400, "task 与 summary 不能为空");
    }
    if (!Array.isArray(req.results) || req.results.length > 16) {
      throw new ChatServiceError(400, "results 必须是不超过 16 项的列表");
    }
    const cleanResults = cleanSwarmResults(req.results);
    const success = cleanResults.length > 0 && cleanResults.every((r) => r.state === "done");

    const outcome = await this.postProcessSwarm(agent, task, summary, cleanResults, success);
    return { ok: true, ...outcome };
  }

  /** _post_process_swarm 语义（与 _post_process_chat 同管线，输入侧为任务与合并总结） */
  async postProcessSwarm(
    agent: AgentState,
    task: string,
    summary: string,
    results: Array<{ name: string; state: string; result: string; error: string }>,
    success: boolean,
  ): Promise<{ success: boolean; memory_count: { facts: number; traits: number }; lifecycle: string }> {
    let traitSignals: unknown[] = [];
    let userSentiment = 0.0;
    let behaviorPatterns: Array<{ scenario: string; steps: string[]; rationale?: string }> = [];

    if (this.memoryEnabled && success && this.postProcess.extractMemory) {
      try {
        const extracted = await this.postProcess.extractMemory({
          agent,
          userMsg: task,
          reply: summary,
          success,
        });
        traitSignals = extracted.traitSignals ?? [];
        userSentiment = extracted.userSentiment ?? 0;
        behaviorPatterns = extracted.behaviorPatterns ?? [];
      } catch (e) {
        this.logger.warn(`[slime] Swarm 记忆提取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (this.memoryEnabled && success && !this.postProcess.extractMemory) {
      this.logger.debug("[slime] Swarm 记忆提取未接线（5B.3 迁移后启用），跳过");
    }

    if (this.postProcess.evolve) {
      try {
        await this.postProcess.evolve({ agent, success, traitSignals, userSentiment });
      } catch (e) {
        this.logger.warn(`[slime] Swarm 演化失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      this.logger.debug("[slime] Swarm 演化引擎未接线（5B.3 迁移后启用），跳过");
    }

    // 知识引擎：Swarm 成功/失败 pattern
    try {
      const { getKnowledgeEngine } = await import("../memory/knowledge.js");
      const ke = getKnowledgeEngine(agent.id, this.dataDir ? { dataDir: this.dataDir } : {});
      if (success) {
        ke.recordPattern("task.swarm.success", "task", `Swarm 任务成功: ${task.slice(0, 80)}`, "low");
      } else {
        const failed = results.filter((r) => r.state !== "done").length;
        ke.recordPattern("task.swarm.fail", "task", `Swarm 任务 ${failed} 个子任务失败: ${task.slice(0, 80)}`, "medium");
      }
    } catch (e) {
      this.logger.debug(`[slime] Swarm 知识引擎更新失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // L3→L2 沉淀：提取的行为模式 → 行为模式库
    const { BehaviorStore, ConsolidationEngine } = await import("../mind/behavior.js");
    const behavior = BehaviorStore.fromDict(agent.behavior);
    for (const bp of behaviorPatterns) {
      behavior.reinforce({
        scenario: bp.scenario,
        steps: bp.steps,
        source: "swarm_extracted",
        rationale: bp.rationale ?? "",
      });
    }

    // 情绪更新（novelty 基于任务；violation/praise 不适用）
    const { EmotionalState } = await import("../mind/emotion.js");
    const emotion = new EmotionalState(agent.emotion as Record<string, unknown>);
    const novelty = await detectNovelty(agent.id, task, historyUserLoader);
    emotion.update({
      success,
      userSentiment,
      failureType: undefined,
      novelty,
      violation: false,
      praise: false,
    });

    // 巩固（每 50 次交互触发）
    try {
      const ce = new ConsolidationEngine();
      const total = agent.persona?.interactions?.length ?? 0;
      if (ce.shouldConsolidate(total)) {
        ce.consolidate({
          behavior,
          totalInteractions: total,
          existingScenarios: new Set(behaviorPatterns.map((bp) => bp.scenario)),
          onArchived: (pat) => behavior.archive(pat),
        });
      }
    } catch (e) {
      this.logger.debug(`[slime] Swarm 巩固失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    agent.behavior = behavior.toDict();
    agent.emotion = emotion.toDict();
    await this.registry.save();

    return {
      success,
      memory_count: { facts: 0, traits: traitSignals.length },
      lifecycle: String(agent.lifecycle ?? "growth"),
    };
  }
}