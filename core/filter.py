"""
slime 输出过滤层
- 拦截 LLM 回复中的身份泄露（模型名、底层架构等）
- 支持替换/警告/阻断三种策略
- 与 Agent 身份铁律（IDENTITY_CONSTRAINT）协同工作
"""

import re
import logging
from dataclasses import dataclass, field
from enum import Enum


class FilterAction(Enum):
    """过滤动作"""
    REPLACE = "replace"   
    WARN = "warn"         
    BLOCK = "block"       


@dataclass
class FilterRule:
    """单条过滤规则"""
    pattern: str                          
    action: FilterAction = FilterAction.REPLACE
    replacement: str = ""                 
    description: str = ""                 

    def to_regex(self) -> re.Pattern:
        return re.compile(self.pattern, re.IGNORECASE)


@dataclass
class FilterResult:
    """过滤结果"""
    original: str                         
    filtered: str                         
    blocked: bool = False                 
    violations: list[dict] = field(default_factory=list)  




DEFAULT_RULES: list[FilterRule] = [
    
    
    
    FilterRule(
        pattern=r'\b((?:GPT-?4o|GPT-?3\.?5|GPT-?4|Claude|Gemini|Llama|Mistral|DeepSeek|Qwen|ERNIE|GLM|文心(?:一言)?|通义(?:千问)?|星火|ChatGPT|OpenAI|Anthropic|Google\s*AI|Meta\s*AI|GPT)(?:[- ][a-z0-9._-]*)?)\b',
        action=FilterAction.REPLACE,
        replacement="slime 平台",
        description="拦截常见模型名暴露（含连字符后缀整体替换，无残片）",
    ),
    FilterRule(
        pattern=r'\b(Agnes|Agnes\s*2\.5|Agnes\s*Flash|Agnes\s*Pro)\b',
        action=FilterAction.REPLACE,
        replacement="slime 平台",
        description="拦截 Agnes 系列模型名暴露",
    ),
    
    FilterRule(
        pattern=r'作为\s*(一个|一名|AI|人工智能|语言模型|大语言模型|LLM|大模型)',
        action=FilterAction.REPLACE,
        replacement="作为 slime 平台",
        description="拦截中文 AI 身份暴露",
    ),
    FilterRule(
        pattern=r'As\s+an\s+(AI|artificial\s+intelligence|language\s+model|LLM|large\s+language\s+model)',
        action=FilterAction.REPLACE,
        replacement="As a slime platform agent",
        description="拦截英文 AI 身份暴露",
    ),
    
    FilterRule(
        pattern=r'我是\s*(一个|一名|AI|人工智能|语言模型|大语言模型|LLM|大模型|模型)',
        action=FilterAction.REPLACE,
        replacement="我是 slime 平台",
        description="拦截中文模型身份暴露",
    ),
    FilterRule(
        pattern=r'I\s+am\s+(an?\s+)?(AI|artificial\s+intelligence|language\s+model|LLM|large\s+language\s+model)',
        action=FilterAction.REPLACE,
        replacement="I am a slime platform agent",
        description="拦截英文模型身份暴露",
    ),
    
    FilterRule(
        pattern=r'(底层|基础|背后)\s*(模型|model|LLM|架构)',
        action=FilterAction.REPLACE,
        replacement="",
        description="拦截底层模型讨论",
    ),
    FilterRule(
        pattern=r'(underlying|base|foundation|backend)\s+(model|LLM|AI)',
        action=FilterAction.REPLACE,
        replacement="",
        description="拦截英文底层模型讨论",
    ),
    
    FilterRule(
        pattern=r'(训练数据|预训练|fine.?tun|参数|token|上下文窗口|context\s*window).{0,20}(模型|model)',
        action=FilterAction.REPLACE,
        replacement="",
        description="拦截模型技术细节暴露",
    ),
    
    FilterRule(
        pattern=r'my\s+(underlying\s+)?(model|architecture|training)',
        action=FilterAction.REPLACE,
        replacement="my platform",
        description="拦截英文模型技术细节",
    ),
    
    FilterRule(
        pattern=r'\b(OpenAI|Anthropic|Google\s*Cloud|Azure\s*OpenAI|AWS\s*Bedrock|火山引擎|阿里云|腾讯云|华为云)\s*(API|接口|模型|服务)',
        action=FilterAction.REPLACE,
        replacement="slime 平台",
        description="拦截 API 提供商暴露",
    ),
]







_URL_RE = re.compile(r'https?://[^\s<>"\')\]]+')




_IDENT_RE = re.compile(r'\b(agnes-[a-z0-9._-]+)\b(?<!-based)(?<!-powered)(?<!-driven)(?<!-model)', re.IGNORECASE)


def _mask_functional_text(text: str) -> tuple[str, list[str]]:
    """把 URL 与含数字的技术标识符替换为占位符，返回 (遮蔽文本, 原词列表)。"""
    tokens: list[str] = []

    def _url_sub(m: re.Match) -> str:
        tokens.append(m.group(0))
        return f"\uE000{len(tokens) - 1:04d}\uE001"

    masked = _URL_RE.sub(_url_sub, text)
    masked = _IDENT_RE.sub(_url_sub, masked)
    return masked, tokens


def _restore_functional_text(text: str, tokens: list[str]) -> str:
    for i, tok in enumerate(tokens):
        text = text.replace(f"\uE000{i:04d}\uE001", tok)
    return text


class OutputFilter:
    """
    LLM 输出过滤器。
    在 LLM 回复返回给用户之前，检查并处理身份泄露。
    """

    def __init__(self, rules: list[FilterRule] | None = None,
                 strict_mode: bool = False):
        """
        参数:
        - rules: 自定义规则列表，None 则使用默认规则
        - strict_mode: 严格模式，任何违规都阻断整条回复
        """
        self.rules = rules or DEFAULT_RULES
        self.strict_mode = strict_mode
        self._compiled: list[tuple[FilterRule, re.Pattern]] = [
            (r, r.to_regex()) for r in self.rules
        ]
        self._total_violations: int = 0
        self._blocked_count: int = 0

    def filter(self, text: str, agent_name: str = "") -> FilterResult:
        """
        过滤文本，检测并处理身份泄露。

        参数:
        - text: 原始 LLM 回复
        - agent_name: Agent 名称（用于替换模板）

        返回: FilterResult
        """
        if not text or not text.strip():
            return FilterResult(original=text, filtered=text)

        
        masked_text, restore_tokens = _mask_functional_text(text)

        violations = []
        filtered = masked_text

        for rule, regex in self._compiled:
            if rule.action == FilterAction.REPLACE:
                replacement = rule.replacement
                if replacement and "{name}" in replacement:
                    replacement = replacement.replace("{name}", agent_name or "slime")

                def _repl(match, repl=replacement, rule=rule):
                    matched_text = match.group()
                    violations.append({
                        "rule": rule.description,
                        "pattern": rule.pattern,
                        "match": matched_text,
                        "action": rule.action.value,
                        "span": match.span(),
                    })
                    self._total_violations += 1
                    logging.info(
                        f"[filter] REPLACE: '{matched_text}' → '{repl}' "
                        f"(规则: {rule.description})"
                    )
                    return repl

                
                filtered = regex.sub(_repl, filtered)

            elif rule.action == FilterAction.BLOCK:
                m = regex.search(filtered)
                if m:
                    matched_text = m.group()
                    violations.append({
                        "rule": rule.description,
                        "pattern": rule.pattern,
                        "match": matched_text,
                        "action": rule.action.value,
                        "span": m.span(),
                    })
                    self._blocked_count += 1
                    self._total_violations += 1
                    logging.warning(
                        f"[filter] BLOCK: 阻断违规回复 "
                        f"(规则: {rule.description}, 匹配: '{matched_text}')"
                    )
                    return FilterResult(
                        original=text,
                        filtered=self._build_block_message(agent_name),
                        blocked=True,
                        violations=violations,
                    )

            elif rule.action == FilterAction.WARN:
                for m in regex.finditer(filtered):
                    matched_text = m.group()
                    violations.append({
                        "rule": rule.description,
                        "pattern": rule.pattern,
                        "match": matched_text,
                        "action": rule.action.value,
                        "span": m.span(),
                    })
                    self._total_violations += 1
                    logging.warning(
                        f"[filter] WARN: 检测到可能的身份泄露 "
                        f"(规则: {rule.description}, 匹配: '{matched_text}')"
                    )

        
        if self.strict_mode and violations:
            self._blocked_count += 1
            return FilterResult(
                original=text,
                filtered=self._build_block_message(agent_name),
                blocked=True,
                violations=violations,
            )

        
        filtered = _restore_functional_text(filtered, restore_tokens)

        return FilterResult(
            original=text,
            filtered=filtered,
            blocked=False,
            violations=violations,
        )

    def _build_block_message(self, agent_name: str) -> str:
        """构建阻断后的替代消息"""
        name = agent_name or "slime"
        return (
            f"我是 {name}，由 slime 平台驱动。"
            f"我无法提供关于底层技术架构的详细信息。"
        )

    def add_rule(self, rule: FilterRule):
        """动态添加规则"""
        self.rules.append(rule)
        self._compiled.append((rule, rule.to_regex()))

    def remove_rule(self, pattern: str) -> bool:
        """按 pattern 移除规则"""
        for i, (rule, _) in enumerate(self._compiled):
            if rule.pattern == pattern:
                self.rules.pop(i)
                self._compiled.pop(i)
                return True
        return False

    @property
    def stats(self) -> dict:
        """获取过滤统计"""
        return {
            "total_violations": self._total_violations,
            "blocked_count": self._blocked_count,
            "rules_count": len(self.rules),
            "strict_mode": self.strict_mode,
        }




_filter: OutputFilter | None = None


def get_filter() -> OutputFilter:
    """获取全局输出过滤器"""
    global _filter
    if _filter is None:
        _filter = OutputFilter()
    return _filter


def reset_filter(strict_mode: bool = False):
    """重置全局过滤器（用于测试或配置更新）"""
    global _filter
    _filter = OutputFilter(strict_mode=strict_mode)