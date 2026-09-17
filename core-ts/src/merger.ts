/**
 * core-ts/src/merger.ts — 主 Agent 合并器（Merger）。
 * 语义移植自 core/merger.py：
 * - collect_results / analyze_errors / assess_risks（规则式风险分级）
 * - trial_run：基础检查 → 一致性检查（关键词启发式 + A-013 LLM 裁定）→
 *   完成度检查（长度 50% + 覆盖率 50%）→ LLM 质量评分 → 加权总分 0-10
 * - A-047 幻觉护栏硬信号：claims 声称"已保存/已生成"但文件不存在 → 记 errors →
 *   trial 基础检查失败 → 不虚报成功（复用 core-ts/claims.ts）
 * - finalize：collect → analyze → claims → risks → trial → verdict（LLM 或模板兜底）
 * - P2-23 修复语义：验证超时按失败处理（Python 侧曾返回 passed=True，TS 移植为修正语义）
 */

import { findUnverifiedClaims } from "./claims.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface MergeResult {
  task_id: string;
  original_task: string;
  summary: string;
  subtask_results: Array<{ name: string; state: string; result: string; error: string; rounds: number }>;
  errors: string[];
  risks: Array<{ level: RiskLevel; description: string }>;
  trial_passed: boolean;
  trial_log: string;
  trial_score: number;
  trial_details: Record<string, unknown>;
  final_verdict: string;
  created_at: number;
}

export interface SubtaskLike {
  name: string;
  state: string; // "done" | "failed" | ...
  description?: string;
  result: string;
  error: string;
  rounds: number;
}

export interface TrialOutcome {
  passed: boolean;
  log: string;
  score: number;
  details: Record<string, unknown>;
}

export function makeMergeResult(taskId: string, originalTask: string): MergeResult {
  return {
    task_id: taskId,
    original_task: originalTask,
    summary: "",
    subtask_results: [],
    errors: [],
    risks: [],
    trial_passed: false,
    trial_log: "",
    trial_score: 0,
    trial_details: {},
    final_verdict: "",
    created_at: Date.now() / 1000,
  };
}

/** LLM 回调：接收 prompt 返回文本（同步或异步均可；异步优先） */
export type LlmFn = (prompt: string) => Promise<string> | string;

function safeAwait<T>(fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve(fn());
}

export class Merger {
  readonly taskId: string;
  readonly originalTask: string;
  result: MergeResult;

  constructor(taskId: string, originalTask: string) {
    this.taskId = taskId;
    this.originalTask = originalTask;
    this.result = makeMergeResult(taskId, originalTask);
  }

  /** 收集所有子任务结果，生成合并上下文（返回给主 Agent 的合并 prompt） */
  collectResults(subtasks: SubtaskLike[]): string {
    const parts = [`## 原始任务\n${this.originalTask}\n`, "## 子 Agent 执行结果\n"];
    for (const st of subtasks) {
      const status = st.state === "done" ? "✓ 完成" : "✗ 失败";
      parts.push(`### ${st.name} [${status}]`);
      parts.push(`任务: ${st.description ?? ""}`);
      parts.push(`轮次: ${st.rounds}`);
      if (st.result) parts.push(`结果: ${st.result}`);
      if (st.error) parts.push(`错误: ${st.error}`);
      parts.push("");
    }
    return parts.join("\n");
  }

  analyzeErrors(subtasks: SubtaskLike[]): string[] {
    const errors: string[] = [];
    for (const st of subtasks) {
      if (st.state === "failed") errors.push(`[${st.name}] ${st.error}`);
      else if (st.error) errors.push(`[${st.name}] ${st.error}`);
    }
    this.result.errors = errors;
    return errors;
  }

  assessRisks(subtasks: SubtaskLike[]): Array<{ level: RiskLevel; description: string }> {
    const risks: Array<{ level: RiskLevel; description: string }> = [];
    const failed = subtasks.filter((st) => st.state === "failed");
    const hasErrors = subtasks.some((st) => st.error);
    if (subtasks.length === 0) {
      risks.push({ level: "high", description: "无子任务执行结果" });
    } else if (failed.length > 0) {
      const total = subtasks.length;
      const failCount = failed.length;
      if (failCount === total) {
        risks.push({ level: "critical", description: `所有 ${total} 个子任务全部失败` });
      } else if (failCount > total / 2) {
        risks.push({ level: "high", description: `${failCount}/${total} 个子任务失败` });
      } else {
        risks.push({ level: "medium", description: `${failCount}/${total} 个子任务失败` });
      }
    } else if (hasErrors) {
      risks.push({ level: "medium", description: `存在 ${this.result.errors.length} 个警告/错误` });
    } else {
      risks.push({ level: "low", description: "所有子任务执行成功" });
    }
    this.result.risks = risks;
    return risks;
  }

  /** 试运行验证（真实验证逻辑）：基础/一致性/完成度/质量评分 */
  async trialRun(summary: string, subtasks: SubtaskLike[], llmFn?: LlmFn): Promise<TrialOutcome> {
    const details: Record<string, unknown> = {};

    // ── 维度 1: 基础检查 ──────────────────────────────
    const hasErrors = this.result.errors.length > 0;
    const hasCriticalRisks = this.result.risks.some((r) => r.level === "high" || r.level === "critical");
    const hasSummary = Boolean(summary && summary.trim());
    const basePassed = !hasErrors && !hasCriticalRisks && hasSummary;
    details["base_check"] = {
      has_errors: hasErrors,
      error_count: this.result.errors.length,
      has_critical_risks: hasCriticalRisks,
      has_summary: hasSummary,
      summary_length: summary ? summary.length : 0,
    };

    // ── 维度 2: 一致性检查 ──────────────────────────────
    const consistencyResult = this.checkConsistency(subtasks);
    if (llmFn && !consistencyResult.consistent) {
      const adjudication = await this.adjudicateConflict(llmFn, subtasks);
      consistencyResult.llm_adjudication = adjudication;
      if (adjudication.is_conflict === false) {
        consistencyResult.consistent = true;
        consistencyResult.issue = null;
      }
    }
    details["consistency"] = consistencyResult;
    const consistencyPassed = consistencyResult.consistent;

    // ── 维度 3: 完成度检查 ──────────────────────────────
    const completionResult = this.checkCompletion(summary, subtasks);
    details["completion"] = completionResult;
    const completionScore = completionResult.score;

    // ── 维度 4: 质量评分（需要 LLM）────────────────────
    let qualityScore = 5;
    if (llmFn && summary) {
      try {
        qualityScore = await this.evaluateQuality(llmFn, summary, subtasks);
      } catch {
        // LLM 质量评估失败 → 默认分
      }
    }
    details["quality_score"] = qualityScore;

    // ── 综合判断 ────────────────────────────────────────
    this.result.trial_passed = basePassed && consistencyPassed && completionScore >= 0.5;
    let score = Math.round(
      qualityScore * 0.4 + // 质量 40%
        completionScore * 10 * 0.3 + // 完成度 30%
        (consistencyPassed ? 10 : 3) * 0.3, // 一致性 30%
    );
    score = Math.max(0, Math.min(10, score));
    this.result.trial_score = score;

    // ── 生成日志 ────────────────────────────────────────
    const logParts: string[] = [];
    if (subtasks.length === 0) logParts.push("试运行：无子任务结果，无法验证");
    else if (!hasSummary) logParts.push("试运行：主 Agent 未生成有效总结，需人工审查");
    else if (hasErrors) logParts.push(`试运行：发现 ${this.result.errors.length} 个错误，需人工审查`);
    else if (hasCriticalRisks) logParts.push("试运行：存在高风险，需人工审查");
    else logParts.push("试运行：基础检查通过");
    if (!consistencyPassed) logParts.push(`一致性警告：${consistencyResult.issue ?? "结果存在矛盾"}`);
    logParts.push(`完成度评分：${completionScore.toFixed(1)}/1.0`);
    logParts.push(`质量评分：${this.result.trial_score}/10`);
    this.result.trial_log = logParts.join("；");
    this.result.trial_details = details;

    return { passed: this.result.trial_passed, log: this.result.trial_log, score: this.result.trial_score, details };
  }

  /** 一致性检查：关键词启发式基线（A-013：命中矛盾时经 LLM 裁定解除误报） */
  checkConsistency(subtasks: SubtaskLike[]): { consistent: boolean; issue: string | null; positive_count: number; negative_count: number; llm_adjudication?: unknown } {
    const results = subtasks.filter((st) => st.result).map((st) => st.result);
    if (results.length < 2) {
      return { consistent: true, issue: null, positive_count: 0, negative_count: 0 };
    }
    const positiveKeywords = ["成功", "完成", "正确", "通过"];
    const negativeKeywords = ["失败", "错误", "异常", "拒绝"];
    const positiveCount = results.filter((r) => positiveKeywords.some((kw) => r.includes(kw))).length;
    const negativeCount = results.filter((r) => negativeKeywords.some((kw) => r.includes(kw))).length;
    const issues: string[] = [];
    if (positiveCount > 0 && negativeCount > 0) {
      const ratio = negativeCount / (positiveCount + negativeCount);
      if (ratio > 0.5) {
        issues.push(`结果存在矛盾：${negativeCount}个负面 vs ${positiveCount}个正面`);
      }
    }
    return {
      consistent: issues.length === 0,
      issue: issues[0] ?? null,
      positive_count: positiveCount,
      negative_count: negativeCount,
    };
  }

  /** A-013：LLM 裁定关键词启发式矛盾是否真实（描述不同侧面 → 解除误报） */
  async adjudicateConflict(llmFn: LlmFn, subtasks: SubtaskLike[]): Promise<{ is_conflict: boolean | null; reason: string }> {
    const results = subtasks
      .filter((st) => st.result || st.error)
      .map((st) => ({ name: st.name, text: (st.result || st.error).slice(0, 400) }));
    if (results.length < 2) {
      return { is_conflict: null, reason: "样本不足，无法裁定" };
    }
    const lines = results.map((r) => `- [${r.name}]: ${r.text}`).join("\n");
    const prompt =
      `以下是 Swarm 任务中不同子 Agent 的执行结果。关键词启发式怀疑它们互相矛盾，` +
      `请判断这些结果是否真的构成事实矛盾（对同一事实给出相反结论），` +
      `还是各自描述不同侧面（例如一个说构建成功、另一个说测试失败——这不矛盾）。\n\n` +
      `${lines}\n\n` +
      `请严格回复 JSON：{"is_conflict": true|false, "reason": "一句话理由"}`;
    try {
      const result = await safeAwait(() => llmFn(prompt));
      const m = /\{"is_conflict"\s*:\s*(true|false)[^{}]*\}/.exec(String(result));
      if (m) {
        const data = JSON.parse(m[0]);
        return { is_conflict: Boolean(data.is_conflict), reason: String(data.reason ?? "").slice(0, 200) };
      }
    } catch {
      // 裁定失败 → 保守保留启发式结论
    }
    return { is_conflict: null, reason: "裁定失败" };
  }

  /** 完成度检查：总结是否真正回答了原始任务（长度 50% + 覆盖率 50%） */
  checkCompletion(summary: string, subtasks: SubtaskLike[]): { score: number; summary_length: number; subtask_count: number; success_count: number; length_score: number; coverage_score: number } {
    if (!summary || !this.originalTask) {
      return { score: 0.0, summary_length: summary?.length ?? 0, subtask_count: subtasks.length, success_count: 0, length_score: 0, coverage_score: 0 };
    }
    const summaryLen = summary.length;
    const successCount = subtasks.filter((st) => st.state === "done").length;
    const lengthScore = Math.min(1.0, summaryLen / 200); // 200 字以上满分
    const coverageScore = successCount / Math.max(1, subtasks.length);
    const score = lengthScore * 0.5 + coverageScore * 0.5;
    return {
      score,
      summary_length: summaryLen,
      subtask_count: subtasks.length,
      success_count: successCount,
      length_score: lengthScore,
      coverage_score: coverageScore,
    };
  }

  /** 使用 LLM 评估合并质量（0-10 分） */
  async evaluateQuality(llmFn: LlmFn, summary: string, subtasks: SubtaskLike[]): Promise<number> {
    const subtaskInfo = subtasks
      .map((st) => `- ${st.name}: ${st.state} (${(st.result ?? "").length}字符)`)
      .join("\n");
    const prompt = `评估以下 Swarm 任务合并结果的质量（0-10分）：\n\n原始任务：${this.originalTask}\n\n子任务执行结果：\n${subtaskInfo}\n\n合并总结：\n${summary.slice(0, 1000)}\n\n评分标准：\n- 10分：完美完成任务，总结全面准确\n- 7-9分：任务完成，总结较好\n- 4-6分：任务基本完成，总结有不足\n- 1-3分：任务未完成或总结质量差\n- 0分：完全失败\n\n只返回一个数字（0-10），不要其他内容。`;
    try {
      const result = await safeAwait(() => llmFn(prompt));
      const m = /\b([0-9]|10)\b/.exec(String(result));
      if (m) return parseInt(m[1], 10);
    } catch {
      // 解析失败 → 默认分
    }
    return 5;
  }

  /** 完成合并流程（A-047 幻觉护栏硬信号在 analyze_errors 后注入） */
  async finalize(summary: string, subtasks: SubtaskLike[], llmFn?: LlmFn): Promise<MergeResult> {
    this.collectResults(subtasks);
    this.analyzeErrors(subtasks);
    await this.appendClaimErrors(summary, subtasks);
    this.assessRisks(subtasks);
    await this.trialRun(summary, subtasks, llmFn);
    this.result.summary = summary;
    this.result.subtask_results = subtasks.map((st) => ({
      name: st.name,
      state: st.state,
      result: st.result,
      error: st.error,
      rounds: st.rounds,
    }));
    this.result.final_verdict = await this.buildVerdict(summary, subtasks, llmFn);
    return this.result;
  }

  /** A-047：幻觉护栏硬信号——总结/子任务结果声称已生成但文件不存在 → 记 errors */
  async appendClaimErrors(summary: string, subtasks: SubtaskLike[]): Promise<string[]> {
    try {
      // 只核验总结与子任务产出（result），不核验 error（失败描述不是完成态声称）
      const texts = [summary ?? ""];
      for (const st of subtasks) texts.push(st.result ?? "");
      const unverified = [...new Set(await findUnverifiedClaims(texts.join("\n")))];
      if (unverified.length > 0) {
        for (const p of unverified.slice(0, 5)) {
          this.result.errors.push(`幻觉护栏：声称已生成/已保存但文件不存在: ${p}`);
        }
      }
      return unverified;
    } catch {
      return []; // 护栏异常不阻断合并主流程
    }
  }

  /** 生成最终结论：有 LLM 时调用生成，否则模板兜底 */
  async buildVerdict(summary: string, subtasks: SubtaskLike[], llmFn?: LlmFn): Promise<string> {
    const riskLines = this.result.risks.map((r) => `[${r.level}] ${r.description}`);
    const riskSummary = riskLines.length > 0 ? riskLines.join("; ") : "无风险";
    if (llmFn && summary) {
      try {
        const verdict = await this.llmVerdict(llmFn, summary, subtasks, riskSummary);
        if (verdict) return verdict;
      } catch {
        // 回退模板
      }
    }
    if (this.result.trial_passed && this.result.errors.length === 0) {
      return `✓ 任务完成（评分 ${this.result.trial_score}/10），所有子 Agent 执行成功。${riskSummary}`;
    } else if (this.result.errors.length > 0) {
      return `⚠ 任务部分完成（评分 ${this.result.trial_score}/10），${this.result.errors.length} 个错误需关注。${riskSummary}`;
    } else if (!this.result.trial_passed) {
      return `⚠ 任务完成但验证未通过（评分 ${this.result.trial_score}/10），建议人工审查。${riskSummary}`;
    }
    return `⚠ 任务完成但存在风险（评分 ${this.result.trial_score}/10）。${riskSummary}`;
  }

  /** 用 LLM 生成自然的最终结论 */
  async llmVerdict(llmFn: LlmFn, summary: string, subtasks: SubtaskLike[], riskSummary: string): Promise<string> {
    const doneCount = subtasks.filter((st) => st.state === "done").length;
    const failCount = subtasks.filter((st) => st.state === "failed").length;
    const total = subtasks.length;
    const prompt =
      `你是 Swarm 任务的主 Agent。请根据以下信息，用简洁自然的语言给出任务结论（2-4句话，中文）：\n\n` +
      `原始任务：${this.originalTask}\n\n` +
      `子任务执行情况：共 ${total} 个，${doneCount} 成功 ${failCount} 失败\n` +
      `质量评分：${this.result.trial_score}/10\n` +
      `风险：${riskSummary}\n\n` +
      `合并总结：${summary.slice(0, 800)}\n\n` +
      `直接给出结论，不要加前缀或标记。`;
    try {
      const result = await safeAwait(() => llmFn(prompt));
      return String(result).trim();
    } catch {
      return "";
    }
  }
}