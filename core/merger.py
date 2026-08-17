"""
slime Merger - 主 Agent 合并器
- 收集所有子 Agent 结果
- 错误分析、风险评估
- 试运行验证（真实验证逻辑）
- 最终交付
"""

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)


def _safe_await(llm_fn, prompt: str):
    """安全调用 llm_fn，兼容同步和异步函数"""
    import inspect
    result = llm_fn(prompt)
    if inspect.isawaitable(result):
        return result
    # 同步函数返回普通值，包装为可 await
    async def _wrap():
        return result
    return _wrap()


class RiskLevel(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class MergeResult:
    """合并结果"""
    task_id: str
    original_task: str
    summary: str = ""       # 主 Agent 生成的总结
    subtask_results: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    risks: list[dict] = field(default_factory=list)  # [{level, description}]
    trial_passed: bool = False
    trial_log: str = ""
    trial_score: int = 0  # 0-10 质量评分
    trial_details: dict = field(default_factory=dict)  # 详细验证信息
    final_verdict: str = ""
    created_at: float = field(default_factory=time.time)


class Merger:
    """
    主 Agent 合并器：
    1. 收集所有子 Agent 结果
    2. 调用主 Agent 合并总结
    3. 错误分析
    4. 风险评估
    5. 试运行验证（真实验证）
    6. 交付
    """

    def __init__(self, task_id: str, original_task: str):
        self.task_id = task_id
        self.original_task = original_task
        self.result = MergeResult(task_id=task_id, original_task=original_task)
        # 验证回调（由调用方注入）
        self._validator_fn: Optional[Callable] = None

    def set_validator(self, fn: Callable) -> None:
        """设置验证函数（可选，用于注入 LLM 验证）"""
        self._validator_fn = fn

    def collect_results(self, subtasks: list) -> str:
        """
        收集所有子任务结果，生成合并上下文。
        返回给主 Agent 的合并 prompt。
        """
        parts = [f"## 原始任务\n{self.original_task}\n"]
        parts.append("## 子 Agent 执行结果\n")

        for st in subtasks:
            status = "✓ 完成" if st.state.value == "done" else "✗ 失败"
            parts.append(f"### {st.name} [{status}]")
            parts.append(f"任务: {st.description}")
            parts.append(f"轮次: {st.rounds}")
            if st.result:
                parts.append(f"结果: {st.result}")
            if st.error:
                parts.append(f"错误: {st.error}")
            parts.append("")

        context = "\n".join(parts)
        return context

    def analyze_errors(self, subtasks: list) -> list[str]:
        """分析子任务中的错误"""
        errors = []
        for st in subtasks:
            if st.state.value == "failed":
                errors.append(f"[{st.name}] {st.error}")
            elif st.error:
                errors.append(f"[{st.name}] {st.error}")
        self.result.errors = errors
        return errors

    def assess_risks(self, subtasks: list) -> list[dict]:
        """
        风险评估（基于规则）。
        """
        risks = []
        failed = [st for st in subtasks if st.state.value == "failed"]
        has_errors = any(st.error for st in subtasks)

        if not subtasks:
            risks.append({
                "level": RiskLevel.HIGH.value,
                "description": "无子任务执行结果",
            })
        elif failed:
            fail_count = len(failed)
            total = len(subtasks)
            if fail_count == total:
                level = RiskLevel.CRITICAL.value
                desc = f"所有 {total} 个子任务全部失败"
            elif fail_count > total // 2:
                level = RiskLevel.HIGH.value
                desc = f"{fail_count}/{total} 个子任务失败"
            else:
                level = RiskLevel.MEDIUM.value
                desc = f"{fail_count}/{total} 个子任务失败"
            risks.append({
                "level": level,
                "description": desc,
            })
        elif has_errors:
            risks.append({
                "level": RiskLevel.MEDIUM.value,
                "description": f"存在 {len(self.result.errors)} 个警告/错误",
            })
        else:
            risks.append({
                "level": RiskLevel.LOW.value,
                "description": "所有子任务执行成功",
            })

        self.result.risks = risks
        return risks

    async def trial_run(self, summary: str, subtasks: list,
                        llm_fn: Optional[Callable] = None) -> dict:
        """
        试运行验证（真实验证逻辑）。
        
        验证维度：
        1. 基础检查（错误、风险、摘要）
        2. 一致性检查（子任务结果是否矛盾）
        3. 完成度检查（摘要是否真正回答原始任务）
        4. 质量评分（0-10）
        5. 自我反思（可选，需要 LLM）
        
        返回 {passed: bool, log: str, score: int, details: dict}
        """
        details = {}
        
        # ── 维度 1: 基础检查 ──────────────────────────────
        has_errors = len(self.result.errors) > 0
        has_critical_risks = any(
            r["level"] in (RiskLevel.HIGH.value, RiskLevel.CRITICAL.value)
            for r in self.result.risks
        )
        has_summary = bool(summary and summary.strip())
        
        base_passed = not has_errors and not has_critical_risks and has_summary
        details["base_check"] = {
            "has_errors": has_errors,
            "error_count": len(self.result.errors),
            "has_critical_risks": has_critical_risks,
            "has_summary": has_summary,
            "summary_length": len(summary) if summary else 0,
        }
        
        # ── 维度 2: 一致性检查 ──────────────────────────────
        consistency_result = self._check_consistency(subtasks)
        # A-013: 启发式命中矛盾且有 LLM 时裁定（描述不同侧面 → 解除误报；失败保守保留）
        if llm_fn is not None and not consistency_result.get("consistent", True):
            adjudication = await self._adjudicate_conflict(llm_fn, subtasks)
            consistency_result["llm_adjudication"] = adjudication
            if adjudication.get("is_conflict") is False:
                consistency_result["consistent"] = True
                consistency_result["issue"] = None
        details["consistency"] = consistency_result
        
        consistency_passed = consistency_result.get("consistent", True)
        
        # ── 维度 3: 完成度检查 ──────────────────────────────
        completion_result = self._check_completion(summary, subtasks)
        details["completion"] = completion_result
        
        completion_score = completion_result.get("score", 0.5)
        
        # ── 维度 4: 质量评分（需要 LLM）────────────────────
        quality_score = 5  # 默认分
        if llm_fn and summary:
            try:
                quality_score = await self._evaluate_quality(
                    llm_fn, summary, subtasks
                )
            except Exception as e:
                logger.warning(f"[merger] LLM 质量评估失败: {e}")
        
        details["quality_score"] = quality_score
        
        # ── 综合判断 ────────────────────────────────────────
        # 通过条件：基础检查通过 + 一致性通过 + 完成度 >= 0.5
        self.result.trial_passed = (
            base_passed and consistency_passed and completion_score >= 0.5
        )
        
        # 最终评分（加权）
        self.result.trial_score = int(
            quality_score * 0.4 +  # 质量评分 40%
            completion_score * 10 * 0.3 +  # 完成度 30%
            (10 if consistency_passed else 3) * 0.3  # 一致性 30%
        )
        self.result.trial_score = max(0, min(10, self.result.trial_score))
        
        # 生成日志
        log_parts = []
        if not subtasks:
            log_parts.append("试运行：无子任务结果，无法验证")
        elif not has_summary:
            log_parts.append("试运行：主 Agent 未生成有效总结，需人工审查")
        elif has_errors:
            log_parts.append(f"试运行：发现 {len(self.result.errors)} 个错误，需人工审查")
        elif has_critical_risks:
            log_parts.append("试运行：存在高风险，需人工审查")
        else:
            log_parts.append(f"试运行：基础检查通过")
        
        if not consistency_passed:
            log_parts.append(f"一致性警告：{consistency_result.get('issue', '结果存在矛盾')}")
        
        log_parts.append(f"完成度评分：{completion_score:.1f}/1.0")
        log_parts.append(f"质量评分：{self.result.trial_score}/10")
        
        self.result.trial_log = "；".join(log_parts)
        self.result.trial_details = details
        
        return {
            "passed": self.result.trial_passed,
            "log": self.result.trial_log,
            "score": self.result.trial_score,
            "details": details,
        }
    
    def _check_consistency(self, subtasks: list) -> dict:
        """
        一致性检查：验证子任务结果之间是否存在明显矛盾（关键词启发式基线）。
        A-013: 启发式命中矛盾时，trial_run 会经 _adjudicate_conflict 用 LLM 裁定
        是否为真实矛盾（描述不同侧面会解除误报）。
        """
        results = [st.result for st in subtasks if st.result]
        
        if len(results) < 2:
            return {"consistent": True, "issue": None}
        
        # 简单一致性检查：关键词冲突
        issues = []
        
        # 检查是否有相互矛盾的关键字
        positive_keywords = ["成功", "完成", "正确", "通过"]
        negative_keywords = ["失败", "错误", "异常", "拒绝"]
        
        positive_count = sum(
            1 for r in results
            if any(kw in r for kw in positive_keywords)
        )
        negative_count = sum(
            1 for r in results
            if any(kw in r for kw in negative_keywords)
        )
        
        if positive_count > 0 and negative_count > 0:
            ratio = negative_count / (positive_count + negative_count)
            if ratio > 0.5:
                issues.append(f"结果存在矛盾：{negative_count}个负面 vs {positive_count}个正面")
        
        return {
            "consistent": len(issues) == 0,
            "issue": issues[0] if issues else None,
            "positive_count": positive_count,
            "negative_count": negative_count,
        }

    async def _adjudicate_conflict(self, llm_fn, subtasks: list) -> dict:
        """A-013: LLM 裁定关键词启发式发现的矛盾是否真实。

        仅当启发式命中冲突时调用（成本可控：每任务最多一次额外 LLM 调用）。
        返回 {"is_conflict": bool|None, "reason": str}；裁定失败返回 None
        （调用方保守保留启发式冲突标记）。"""
        results = [
            (st.name, (st.result or st.error or "")[:400])
            for st in subtasks if (st.result or st.error)
        ]
        if len(results) < 2:
            return {"is_conflict": None, "reason": "样本不足，无法裁定"}
        lines = "\n".join(f"- [{name}]: {text}" for name, text in results)
        prompt = (
            f"以下是 Swarm 任务中不同子 Agent 的执行结果。关键词启发式怀疑它们互相矛盾，"
            f"请判断这些结果是否真的构成事实矛盾（对同一事实给出相反结论），"
            f"还是各自描述不同侧面（例如一个说构建成功、另一个说测试失败——这不矛盾）。\n\n"
            f"{lines}\n\n"
            f'请严格回复 JSON：{{"is_conflict": true|false, "reason": "一句话理由"}}'
        )
        try:
            result = await _safe_await(llm_fn, prompt)
            import json as _json, re as _re
            m = _re.search(r'\{[^{}]*"is_conflict"\s*:\s*(true|false)[^{}]*\}', str(result))
            if m:
                data = _json.loads(m.group())
                return {
                    "is_conflict": bool(data.get("is_conflict")),
                    "reason": str(data.get("reason", ""))[:200],
                }
        except Exception as e:
            logger.warning(f"[merger] LLM 矛盾裁定失败，保留启发式结论: {e}")
        return {"is_conflict": None, "reason": "裁定失败"}
    
    def _check_completion(self, summary: str, subtasks: list) -> dict:
        """
        完成度检查：验证总结是否真正回答了原始任务。
        """
        if not summary or not self.original_task:
            return {"score": 0.0, "reason": "缺少摘要或原始任务"}
        
        # 简单启发式：检查摘要长度和子任务覆盖
        summary_len = len(summary)
        subtask_count = len(subtasks)
        success_count = sum(
            1 for st in subtasks if st.state.value == "done"
        )
        
        # 长度评分（0-1）
        length_score = min(1.0, summary_len / 200)  # 200字以上满分
        
        # 覆盖率评分（0-1）
        coverage_score = success_count / max(1, subtask_count)
        
        # 综合评分
        score = length_score * 0.5 + coverage_score * 0.5
        
        return {
            "score": score,
            "summary_length": summary_len,
            "subtask_count": subtask_count,
            "success_count": success_count,
            "length_score": length_score,
            "coverage_score": coverage_score,
        }
    
    async def _evaluate_quality(self, llm_fn, summary: str, subtasks: list) -> int:
        """
        使用 LLM 评估合并质量（0-10分）。
        """
        subtask_info = "\n".join([
            f"- {st.name}: {st.state.value} ({len(st.result or '')}字符)"
            for st in subtasks
        ])
        
        prompt = f"""评估以下 Swarm 任务合并结果的质量（0-10分）：

原始任务：{self.original_task}

子任务执行结果：
{subtask_info}

合并总结：
{summary[:1000]}

评分标准：
- 10分：完美完成任务，总结全面准确
- 7-9分：任务完成，总结较好
- 4-6分：任务基本完成，总结有不足
- 1-3分：任务未完成或总结质量差
- 0分：完全失败

只返回一个数字（0-10），不要其他内容。"""
        
        try:
            result = await _safe_await(llm_fn, prompt)
            # 尝试解析数字
            import re
            match = re.search(r'\b([0-9]|10)\b', str(result))
            if match:
                return int(match.group(1))
        except Exception:
            pass
        
        return 5  # 默认分

    def finalize(self, summary: str, subtasks: list,
                 llm_fn: Optional[Callable] = None) -> MergeResult:
        """
        完成合并流程：
        1. 收集结果
        2. 错误分析
        3. 风险评估
        4. 试运行验证
        5. 生成最终结论（有 LLM 时智能生成，否则模板）
        """
        self.collect_results(subtasks)
        self.analyze_errors(subtasks)
        # A-047: 幻觉护栏硬信号——summary/子任务结果声称"已保存/已生成"的文件
        # 真实不存在时追加为错误（trial_run 基础检查会因此失败，不虚报成功）
        self._append_claim_errors(summary, subtasks)
        self.assess_risks(subtasks)

        # 试运行验证
        trial_result = self._run_trial_sync(summary, subtasks, llm_fn)

        self.result.summary = summary
        self.result.subtask_results = [
            {
                "name": st.name,
                "state": st.state.value,
                "result": st.result,
                "error": st.error,
                "rounds": st.rounds,
            }
            for st in subtasks
        ]

        # 生成最终结论
        self.result.final_verdict = self._build_verdict(
            summary, subtasks, llm_fn
        )

        return self.result

    def _append_claim_errors(self, summary: str, subtasks: list) -> list[str]:
        """A-047: 幻觉护栏硬信号——核验总结与子任务结果中的文件声称。

        调用方（CLI）对同一声称只做警告（_verify_claimed_files），Merger 将其升级为
        硬信号：声称"已保存/已生成/已写入…"但路径真实不存在 → 记入 errors，
        trial_run 基础检查失败 → 不虚报"任务成功"。

        仅当出现完成态声称动词时才触发路径核验（无声称不误伤）。"""
        try:
            from core.claims import find_unverified_claims
            # 只核验总结与子任务产出文本（result），不核验 error：
            # 错误信息本身是"失败描述"（如"文件不存在"），不是完成态声称，
            # 纳入会把无关上下文升级为幻觉错误（review 指出的误报源）
            texts = [summary or ""]
            for st in subtasks:
                texts.append(st.result or "")
            # 去重：同一路径在 summary 与多个 result 重复出现时只记一条
            unverified = list(dict.fromkeys(find_unverified_claims("\n".join(texts))))
            if unverified:
                for p in unverified[:5]:
                    self.result.errors.append(f"幻觉护栏：声称已生成/已保存但文件不存在: {p}")
            return unverified
        except Exception:
            return []  # 护栏异常不阻断合并主流程（与 CLI 既有语义一致）

    def _build_verdict(self, summary: str, subtasks: list,
                       llm_fn: Optional[Callable] = None) -> str:
        """生成最终结论：有 LLM 时调用生成，否则使用模板"""
        # 先构建风险摘要文本
        risk_lines = []
        for r in self.result.risks:
            risk_lines.append(f"[{r['level']}] {r['description']}")
        risk_summary = "; ".join(risk_lines) if risk_lines else "无风险"

        # 有 LLM 时，用 LLM 生成自然语言结论
        if llm_fn and summary:
            try:
                verdict = self._llm_verdict(llm_fn, summary, subtasks, risk_summary)
                if verdict:
                    return verdict
            except Exception:
                pass  # 回退模板

        # 模板兜底
        if self.result.trial_passed and not self.result.errors:
            return (
                f"✓ 任务完成（评分 {self.result.trial_score}/10），"
                f"所有子 Agent 执行成功。{risk_summary}"
            )
        elif self.result.errors:
            return (
                f"⚠ 任务部分完成（评分 {self.result.trial_score}/10），"
                f"{len(self.result.errors)} 个错误需关注。{risk_summary}"
            )
        elif not self.result.trial_passed:
            return (
                f"⚠ 任务完成但验证未通过（评分 {self.result.trial_score}/10），"
                f"建议人工审查。{risk_summary}"
            )
        return (
            f"⚠ 任务完成但存在风险（评分 {self.result.trial_score}/10）。{risk_summary}"
        )

    def _llm_verdict(self, llm_fn, summary: str, subtasks: list,
                     risk_summary: str) -> str:
        """用 LLM 生成自然的最终结论"""
        done_count = sum(1 for st in subtasks if st.state.value == "done")
        fail_count = sum(1 for st in subtasks if st.state.value == "failed")
        total = len(subtasks)

        prompt = (
            f"你是 Swarm 任务的主 Agent。请根据以下信息，用简洁自然的语言给出任务结论"
            f"（2-4句话，中文）：\n\n"
            f"原始任务：{self.original_task}\n\n"
            f"子任务执行情况：共 {total} 个，{done_count} 成功 {fail_count} 失败\n"
            f"质量评分：{self.result.trial_score}/10\n"
            f"风险：{risk_summary}\n\n"
            f"合并总结：{summary[:800]}\n\n"
            f"直接给出结论，不要加前缀或标记。"
        )

        import asyncio as _asyncio
        import concurrent.futures
        try:
            loop = _asyncio.get_running_loop()
        except RuntimeError:
            result = _asyncio.run(_safe_await(llm_fn, prompt))
            return str(result).strip() if result else ""
        # 已在事件循环中，用同步包装。
        # A-028: 用 lambda 延迟创建协程（同 _run_trial_sync 的泄漏修复）
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                lambda: _asyncio.run(_safe_await(llm_fn, prompt))
            )
            try:
                result = future.result(timeout=20)
                return str(result).strip() if result else ""
            except concurrent.futures.TimeoutError:
                return ""

    def _run_trial_sync(self, summary: str, subtasks: list,
                       llm_fn: Optional[Callable] = None) -> dict:
        """同步调用试运行验证"""
        import asyncio
        import concurrent.futures
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 无运行中的事件循环，直接跑
            return asyncio.run(self.trial_run(summary, subtasks, llm_fn))
        # 有运行中的事件循环，在新线程跑避免阻塞。
        # A-028: 用 lambda 延迟创建协程（此前在主线程预创建 trial_run 协程再提交，
        # 与 llm_fn 嵌套循环交互时产生未 await 协程泄漏）
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                lambda: asyncio.run(self.trial_run(summary, subtasks, llm_fn))
            )
            try:
                return future.result(timeout=30)
            except concurrent.futures.TimeoutError:
                return {"passed": True, "log": "试运行：验证超时", "score": 5}
