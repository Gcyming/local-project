"""
slime LLM 调用模块（server 与 CLI 共用）
- 从 slime_server 抽取，独立可复用
"""

import asyncio
import httpx
import json
import logging
import threading
from pathlib import Path
from .encryption import decrypt
from .agent import Agent, find_agent, IDENTITY_CONSTRAINT
from .emotion import top_k_for_mood
from .filter import get_filter, FilterResult






_SHARED_CLIENTS: dict[int, httpx.AsyncClient] = {}
_SHARED_CLIENTS_MAX = 4
_SHARED_CLIENTS_LOCK = threading.Lock()


def _get_shared_client() -> httpx.AsyncClient:
    """返回当前事件循环的共享 AsyncClient（惰性创建，最多缓存 _SHARED_CLIENTS_MAX 个循环副本）。

    无运行中事件循环（同步上下文）时退化为一次性客户端，行为与旧代码一致。"""
    try:
        loop_id = id(asyncio.get_running_loop())
    except RuntimeError:
        return httpx.AsyncClient(timeout=120.0)
    with _SHARED_CLIENTS_LOCK:
        client = _SHARED_CLIENTS.get(loop_id)
        if client is None:
            
            while len(_SHARED_CLIENTS) >= _SHARED_CLIENTS_MAX:
                _SHARED_CLIENTS.pop(next(iter(_SHARED_CLIENTS)), None)
            client = httpx.AsyncClient(
                timeout=httpx.Timeout(120.0, connect=10.0),
                limits=httpx.Limits(max_keepalive_connections=10, max_connections=64),
            )
            _SHARED_CLIENTS[loop_id] = client
        return client


MAX_OUTPUT_LIMIT = 65536
MAX_CONTEXT_LIMIT = 524288


_CHARS_PER_TOKEN = 1.5


def _estimate_tokens(text: str) -> int:
    """粗略估算文本的 token 数（中英文混合保守估算）"""
    return max(1, int(len(text) / _CHARS_PER_TOKEN))


def _apply_filter(reply: str, agent: Agent) -> str:
    """对 LLM 回复应用输出过滤，拦截身份泄露"""
    try:
        f = get_filter()
        result = f.filter(reply, agent_name=agent.name)
        if result.blocked:
            logging.warning(
                f"[SLIME LLM] 输出过滤层阻断了 {agent.name} 的回复 "
                f"(违规数: {len(result.violations)})"
            )
        return result.filtered
    except Exception:
        
        return reply


class _StreamFilter:
    """A-010: 跨 chunk 输出过滤缓冲。

    身份铁律违规短语被 chunk 边界拆开时（如 "作为 " + "AI"、"训练数据" ... "模型"），
    逐块过滤会漏过。把每次过滤结果的末尾 _HOLD 个字符暂扣，与下一块拼接后再过滤，
    保证任何跨边界违规短语都能在完整上下文里命中；流结束时 flush() 冲刷残留。
    _HOLD 覆盖最长规则（训练数据 ... 模型 的 .{0,20} 间距）+ 短语头部余量。"""

    _HOLD = 32

    def __init__(self):
        self._carry = ""

    def feed(self, text: str, agent: Agent) -> str:
        """过滤 (暂扣 + 新块)，返回可安全输出的前缀，末尾 _HOLD 字符继续暂扣。"""
        if not text:
            return ""
        filtered = _apply_filter(self._carry + text, agent)
        if len(filtered) <= self._HOLD:
            self._carry = filtered
            return ""
        self._carry = filtered[-self._HOLD:]
        return filtered[:-self._HOLD]

    def flush(self, agent: Agent) -> str:
        """流结束：冲刷暂扣缓冲（最后一道过滤）。"""
        tail = self._carry
        self._carry = ""
        return _apply_filter(tail, agent) if tail else ""





_THINKING_BUDGET = {"low": 2048, "medium": 8192, "high": 16384}


def _thinking_enabled(agent, cfg: dict) -> bool:
    """A-091: 该请求是否注入思考（agnes/anthropic 分支且 effort 非 none）"""
    effort = getattr(agent, "reasoning_effort", "none")
    if effort == "none" or not cfg.get("reasoning_enabled", True):
        return False
    style = cfg.get("reasoning_style", "openai")
    return "agnes" in str(cfg.get("api_base", "")).lower() or style in ("agnes", "anthropic")


def _effective_max_output(agent, cfg: dict) -> int:
    """A-091: 思考开启时 max_tokens 联动——思考+回答吃 max_tokens，
    默认 2048 会被思考预算截断；至少提到 4096（上限仍受 MAX_OUTPUT_LIMIT 约束）。"""
    mo = agent.max_output or 0
    if _thinking_enabled(agent, cfg) and 0 < mo < 4096:
        return 4096
    return mo


def _build_reasoning_params(agent, cfg: dict) -> dict:
    """
    根据 agent.reasoning_effort 和 provider 配置生成 reasoning 请求参数。
    
    不同 API 的 reasoning 参数格式（provider 配置 reasoning_style 指定）：
    - "openai"    → {"reasoning_effort": effort}（o1/o3-mini 等）
    - "anthropic" → {"thinking": {"type": "enabled", "budget_tokens": N}}
    
    注意：
    - effort=none 时不注入任何参数（保持现有行为，最安全）
    - provider 配置 reasoning_enabled=false 时整体关闭
    - 返回 dict，调用方用 payload.update(...) 合并
    """
    effort = getattr(agent, "reasoning_effort", "none")
    if effort == "none":
        return {}
    
    if not cfg.get("reasoning_enabled", True):
        return {}
    style = cfg.get("reasoning_style", "openai")
    
    
    
    if "agnes" in str(cfg.get("api_base", "")).lower() or style == "agnes":
        return {"chat_template_kwargs": {"enable_thinking": True}}
    
    
    
    base = str(cfg.get("api_base", "")).lower()
    if "127.0.0.1" in base or "localhost" in base:
        return {"chat_template_kwargs": {"enable_thinking": True}}
    if style == "anthropic":
        return {"thinking": {"type": "enabled", "budget_tokens": _THINKING_BUDGET.get(effort, 2048)}}
    return {"reasoning_effort": effort}



_RETRY_429_BACKOFF = (5.0, 15.0, 30.0, 60.0)  




_TRANSIENT_STATUS = frozenset((408, 429, 503, 504, 529))

_RETRY_TRANSIENT_BACKOFF = (1.0, 3.0, 7.0)


async def _post_chat_with_retry(client, url, headers, payload):
    """POST chat/completions，瞬时状态码（429/503/504/529…）指数退避重试。
    A-157：此前仅 429 重试——503/504 等上游过载/网关超时直接一次红字，
    是「供应商经常断联」的隐性来源之一；现对齐 core-ts 瞬态集合。
    重试次数跟随 _RETRY_429_BACKOFF 表长（测试可 patch 缩短）。"""
    import asyncio as _a
    for attempt in range(len(_RETRY_429_BACKOFF)):
        resp = await client.post(url, headers=headers, json=payload)
        code = getattr(resp, "status_code", 200)  
        if code not in _TRANSIENT_STATUS or attempt == len(_RETRY_429_BACKOFF) - 1:
            return resp
        if code == 429:
            delay = _RETRY_429_BACKOFF[attempt]
        else:
            delay = _RETRY_TRANSIENT_BACKOFF[attempt % len(_RETRY_TRANSIENT_BACKOFF)]
        await _a.sleep(delay)
    return resp


async def _stream_chat_with_retry(client, url, headers, payload):
    """流式 POST chat/completions，瞬时状态码（429/503/504/529…）退避重试。
    返回 (status, resp_stream|None)——非瞬时且非 200 时 resp_stream=None。
    A-157：与 _post_chat_with_retry 同步扩展瞬态集合（此前仅 429）。"""
    import asyncio as _a
    for attempt in range(len(_RETRY_429_BACKOFF)):
        stream = client.stream("POST", url, headers=headers, json=payload)
        resp = await stream.__aenter__()
        code = getattr(resp, "status_code", 200)
        if code not in _TRANSIENT_STATUS or attempt == len(_RETRY_429_BACKOFF) - 1:
            return resp, stream
        await stream.__aexit__(None, None, None)
        if code == 429:
            delay = _RETRY_429_BACKOFF[attempt]
        else:
            delay = _RETRY_TRANSIENT_BACKOFF[attempt % len(_RETRY_TRANSIENT_BACKOFF)]
        await _a.sleep(delay)
    return resp, None


class _RetryStream:
    """A-157：流式请求的「瞬态码重试 + 安全退出」上下文管理器。
    替换两处裸 `async with client.stream(...) as resp:`（主链路 & 工具轮）——
    此前 A-056 注释写了 429 退避但实际从未接入；接入后 429/503/504 打开即自动重试。
    用法与原 `async with` 完全一致，缩进不变：`async with _RetryStream(client, url, headers, payload) as resp:`。"""

    def __init__(self, client, url, headers, payload):
        self._client = client
        self._url = url
        self._headers = headers
        self._payload = payload
        self._stream = None

    async def __aenter__(self):
        resp, self._stream = await _stream_chat_with_retry(
            self._client, self._url, self._headers, self._payload,
        )
        return resp

    async def __aexit__(self, exc_type, exc, tb):
        stream = self._stream
        self._stream = None
        if stream is not None:
            try:
                await stream.__aexit__(exc_type, exc, tb)
            except Exception:
                pass
        return False


def _filter_tools_schema(tools_schema: list, tools_only: list[str] | None) -> list:
    """A-049: 按 tools_only 过滤工具 schema（None 或空 = 不过滤）。"""
    if not tools_only:
        return tools_schema
    allowed = set(tools_only)
    return [t for t in tools_schema
            if t.get("function", {}).get("name") in allowed]



_PROMOTE_GROUP_TOOLS = {
    "retrieval": {"web_search", "web_fetch", "skill_search", "skill_lookup"},
    "terminal": {"shell", "bash", "terminal", "code_check"},
    "write": {"file_write", "file_append"},
}


def _order_tools_schema(tools_schema: list, agent, cfg: dict | None = None) -> list:
    """Soul-Plan 第 4 步：按 current_behavior_hint.promote_groups 将目标工具前置（全模型安全）。
    不做 suppress 后置（修正条：suppress 仅强模型、本地弱模型降级文案——后置可能影响弱模型
    schema 位置依赖，保守只做前置；tools_only 强制轮不受影响——红线 3：A-049 优先级高于 mood）。"""
    try:
        hint = agent.emotion.current_behavior_hint
        groups = hint.get("promote_groups") or []
    except Exception:
        return tools_schema
    if not groups:
        return tools_schema
    promote_names = set()
    for g in groups:
        promote_names |= _PROMOTE_GROUP_TOOLS.get(g, set())
    if not promote_names:
        return tools_schema
    promoted = [t for t in tools_schema if t.get("function", {}).get("name") in promote_names]
    rest = [t for t in tools_schema if t.get("function", {}).get("name") not in promote_names]
    return promoted + rest


def _should_yield_reasoning(agent) -> bool:
    """流式思考内容是否应透传（show_thinking 控制）"""
    show = getattr(agent, "show_thinking", "off")
    if show == "on":
        return True
    if show == "auto":
        return getattr(agent, "mode", "build") == "plan"
    return False


def _accumulate_tool_calls(tool_calls: list, delta: dict) -> None:
    """累积流式 tool_calls 片段（BUG-031）：按 index 分块，name/arguments 分片拼接。"""
    for tc_delta in delta.get("tool_calls") or []:
        idx = tc_delta.get("index", 0)
        while len(tool_calls) <= idx:
            tool_calls.append({
                "id": "", "type": "function",
                "function": {"name": "", "arguments": ""},
            })
        tc = tool_calls[idx]
        if tc_delta.get("id"):
            tc["id"] = tc_delta["id"]
        fn = tc_delta.get("function") or {}
        tc["function"]["name"] += fn.get("name", "")
        tc["function"]["arguments"] += fn.get("arguments", "")


def _merge_complete_tool_calls(tool_calls: list, calls: list) -> None:
    """把完整 tool_calls 对象（非流式 message / message 形态 SSE 块，A-149）
    整体并入累积列表：name/arguments 已是最终值，按枚举 index 落位，不做增量拼接。"""
    for i, tc in enumerate(calls or []):
        while len(tool_calls) <= i:
            tool_calls.append({
                "id": "", "type": "function",
                "function": {"name": "", "arguments": ""},
            })
        tool_calls[i]["id"] = tc.get("id") or tool_calls[i]["id"]
        fn = tc.get("function") or {}
        tf = tool_calls[i]["function"]
        if fn.get("name"):
            tf["name"] = fn["name"]
        if fn.get("arguments"):
            tf["arguments"] = fn["arguments"]


def _chunk_fields(chunk: dict) -> tuple[dict, dict]:
    """SSE 块内容源 (delta, message)。标准格式用 choices[0].delta；
    网关缓冲非真流式模型时以 choices[0].message 单块返回（one-api/new-api 系）；
    OpenAI 新 AsyncAPI 用 choices[0].messages 数组（取末条 assistant 消息）。
    二者逐字段回退，保证正文/思考/工具调用任意形态都不丢（A-149 补漏）。"""
    choice = (chunk.get("choices") or [{}])[0]
    delta = choice.get("delta") or {}
    message = choice.get("message")
    if not message and isinstance(choice.get("messages"), list):
        msgs = choice["messages"]
        message = msgs[-1] if msgs else {}
    return delta, (message or {})


def _content_text(content) -> str:
    """正文统一转字符串：字符串原样；content-blocks 数组拼接各 text 块。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict))
    return ""


def _content_to_text(content) -> str:
    """消息 content 统一转纯文本（用于 token 估算/截断计数，不进入请求体）。
    兼容 str / content-blocks 数组 / None——历史或 prompt 中出现多模态数组时防御。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if not isinstance(b, dict):
                continue
            t = b.get("text") or ""
            if isinstance(t, str):
                parts.append(t)
        return "".join(parts)
    return ""



_MAX_IMAGE_BYTES = 8 * 1024 * 1024   
_MAX_IMAGES_PER_REQUEST = 4          


def _sanitize_image_data_url(raw) -> list[str]:
    """校验并过滤 images 入参：仅保留合法 data:image/* 前缀、大小在限内的条目。
    非法条目直接丢弃（best-effort），避免脏数据污染请求 payload。"""
    if not raw:
        return []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item.startswith("data:image/"):
            continue
        if "," not in item:
            continue
        
        payload = item.split(",", 1)[1]
        if not payload:
            continue
        
        approx_bytes = int(len(payload) * 3 / 4)
        if approx_bytes > _MAX_IMAGE_BYTES:
            continue
        out.append(item)
        if len(out) >= _MAX_IMAGES_PER_REQUEST:
            break
    return out


def _build_user_content(agent, user_message: str,
                        images: list[str] | None = None,
                        history: list[dict] | None = None,
                        memory_agent_id: str | None = None,
                        state_segment: str = ""):
    """构造最终 user content（OpenAI 兼容）：
    - 无图 → 原字符串（保持全部旧路径行为不变，零回归）
    - 有图 → content-blocks 数组 [{type:text},{type:image_url,...}]，心性上下文注入文本块。
    图片以 data URL 内联（适配所有 OpenAI 兼容多模态接口，无需服务端临时文件）。
    state_segment：易变状态段并入本条消息（承载它，而不是污染第 0 条 system）。"""
    text = _inject_psyche(agent, user_message, history, memory_agent_id=memory_agent_id)
    text = _inject_state_segment(text, state_segment)
    images = _sanitize_image_data_url(images)
    if not images:
        return text
    blocks: list[dict] = [{"type": "text", "text": text}]
    for url in images:
        blocks.append({"type": "image_url", "image_url": {"url": url}})
    return blocks


def _inject_state_segment(text: str, state_segment: str) -> str:
    """易变状态段并入末段 user 消息（放在心性上下文之后、用户原文之前）。

    设计 §1.3：静态前缀必须字节稳定，易变内容放末尾。状态段留在 system（第 0 条消息）
    里时，每次情绪/技能目录一变就作废整段历史的前缀缓存。"""
    if not state_segment:
        return text
    return f"{state_segment}\n\n---\n\n{text}"


def _extract_nonstream_message(raw: str) -> dict:
    """A-149: 从累积的非 `data:` 行文本中提取 choices[0].message（正文/思考/工具调用）。
    兼容单行/多行 JSON、SSE 注释/空行混入：整体解析失败则截取首 `{` 到末 `}` 再试。"""
    import json as _j
    s = raw.strip()
    if not s:
        return {}

    def _parse(t: str) -> dict:
        try:
            obj = _j.loads(t)
        except Exception:
            return {}
        choices = obj.get("choices") or []
        if not choices:
            return {}
        out = dict(choices[0].get("message") or {})
        if isinstance(obj.get("model"), str):
            out.setdefault("model", obj["model"])
        return out

    out = _parse(s)
    if out:
        return out
    start, end = s.find("{"), s.rfind("}")
    if 0 <= start < end:
        return _parse(s[start:end + 1])
    return {}


def _extract_reasoning(delta: dict, chunk: dict | None = None) -> str:
    """通用思考字段提取（A1）：reasoning_content → reasoning → thinking，chunk 顶层兜底。
    覆盖 DeepSeek/Qwen/Kimi/GLM（reasoning_content）、OpenAI/Grok（reasoning）、Gemini/Anthropic（thinking），
    部分聚合网关把思考字段放到 choices[0] 之外的 chunk 顶层，故两层都查。"""
    for key in ("reasoning_content", "reasoning", "thinking"):
        val = delta.get(key)
        if val:
            return val
    if chunk:
        for key in ("reasoning_content", "reasoning", "thinking"):
            val = chunk.get(key)
            if val:
                return val
    return ""


def _compose_prompt_segments(agent, base: str | None = None) -> tuple[str, str]:
    """系统提示拆成 (稳定前缀, 易变状态段)。

    稳定前缀字节稳定 → 可命中前缀缓存；易变状态段（行为模式 / 情绪状态 / 可用技能清单 /
    审慎承诺）改由末段 user 消息承载。system 是第 0 条消息，它一变整段历史缓存即作废。
    Intelligence.md: 动态记忆走 message 层（_retrieve_psyche_context），不进 system prompt。
    Soul-Plan 第 4 步：caution_level≥1 时结构化注入审慎承诺（不碰权限，仅行为承诺）。
    base 非空 = 调用方自带完整 system prompt（Swarm Worker 路径），保持原样不拆。"""
    if base:
        return base, ""
    stable, volatile = agent.get_system_prompt_segments()
    try:
        hint = agent.emotion.current_behavior_hint
        if hint.get("caution_level", 0) >= 1:
            volatile += ("\n\n## 行为承诺（情绪状态导致）\n"
                         "当前处于审慎状态：写/终端/网络类工具调用必须先向用户确认再执行。")
    except Exception:
        pass
    return stable, volatile


def _compose_system_prompt(agent, base: str | None = None, user_message: str = "",
                           history: list[dict] | None = None) -> str:
    """整段系统提示（稳定前缀 + 易变状态段）——兼容旧调用方的全量视图。

    请求组装请用 _compose_prompt_segments，把易变段放到末段消息。"""
    stable, volatile = _compose_prompt_segments(agent, base)
    return stable + volatile


def _retrieve_psyche_context(agent, user_message: str = "",
                             history: list[dict] | None = None,
                             memory_agent_id: str | None = None,
                             data_dir: str = "") -> str:
    """L3 动态心性：记忆摘要 + 交接摘要，按需检索注入 message 层。
    Intelligence.md: 从 system prompt 移出，解决全量注入导致的膨胀/截断。
    A-008: memory_agent_id 允许 Swarm Worker 检索主 Agent 的成长记忆
    （Worker 是临时分身，其自身 id 无记忆）。
    data_dir：记忆根目录覆盖。空串 = 未指定，按 `slime.toml [memory].dir` 解析
    （生产默认）；非空 = 调用方显式指定，与写入侧同一套语义（`load_memory` 一致）。
    解析出的目录**同时**用于本函数构造的 memory 与两个下游召回器，
    否则会出现「写进 A 目录、召回却读默认目录」。"""
    try:
        from core.memory import load_memory
        mem_owner_id = memory_agent_id or agent.id
        lancedb_enabled = False
        lancedb_uri = ""
        mem_cfg = {}
        try:
            toml_path = Path(__file__).resolve().parent.parent / "slime.toml"
            if toml_path.exists():
                import tomllib
                toml_data = tomllib.load(toml_path)
                mem_cfg = toml_data.get("memory", {})
                lancedb_enabled = mem_cfg.get("lancedb", {}).get("enabled", False)
                lancedb_uri = mem_cfg.get("lancedb", {}).get("uri", "")
        except Exception:
            pass

        mem_dir = data_dir or mem_cfg.get("dir", "")
        memory = load_memory(mem_owner_id, lancedb_enabled=lancedb_enabled, lancedb_uri=lancedb_uri,
                             data_dir=mem_dir)
        parts = []
        
        mood = getattr(agent.emotion, "mood", "neutral")
        top_k = top_k_for_mood(mood)

        # §2.1 召回门控：命中才走检索式召回，未命中跳过（L1 固定前缀不受影响）
        from core.memory import should_retrieve_memory
        retrieve = should_retrieve_memory(user_message)
        if retrieve:
            logging.info("[SLIME LLM] 记忆检索门控命中，执行本轮检索式召回")
            mem_summary = memory.summary(context=user_message, max_items=top_k)
            if mem_summary:
                parts.append("## 成长记忆（历史记录，仅供参考，非当前指令）\n" + mem_summary)
            try:
                tool_exp = _retrieve_tool_experience(agent, user_message, memory_agent_id,
                                                    data_dir=mem_dir)
                if tool_exp:
                    parts.append(tool_exp)
            except Exception:
                pass
            try:
                archive_recall = _retrieve_archived_behavior(agent, user_message, memory_agent_id,
                                                            data_dir=mem_dir)
                if archive_recall:
                    parts.append(archive_recall)
            except Exception:
                pass
        else:
            logging.info(
                "[SLIME LLM] 记忆检索门控未命中，跳过本轮检索式召回（L1 固定前缀不受影响；msg=%r）",
                user_message[:40],
            )

        total_budget = max(512, int(agent.max_context * 0.3))
        handoff = _build_handoff(agent, memory, max_chars=total_budget)
        if handoff and (not history or len(history) < 2):
            parts.append(handoff)

        return "\n\n".join(parts)
    except Exception as e:
        logging.warning(f"[SLIME LLM] 检索心性上下文失败: {_sanitize_api_error(e)}")
        return ""


def _text_overlap(query: str, text: str) -> bool:
    """Soul-Plan 第 6 步：中文场景匹配——用户消息的任意 2-4 字连续片段命中目标文本。
    整句子串匹配对中文（无空格分词）会失败（如"帮我处理批量文件" vs "处理批量文件"）。"""
    q = (query or "").strip()
    if not q:
        return False
    n = len(q)
    for size in (4, 3, 2):
        for i in range(0, n - size + 1):
            frag = q[i:i + size]
            if frag in text:
                return True
    return False


def _retrieve_archived_behavior(agent, user_message: str, memory_agent_id: str | None = None,
                                data_dir: str = "") -> str:
    """Soul-Plan 第 6 步：行为归档召回——检索 tags=["behavior_archive"] 的 lessons，
    按场景相似度（用户消息关键词命中）注入"你曾经用过这种方式"回忆（触摸 last_accessed 刷新）。
    data_dir 必须由调用方透传写入侧用的那个目录；空串 = 未指定 = 默认记忆目录（旧行为）。"""
    try:
        from core.memory import load_memory
        mem_owner_id = memory_agent_id or agent.id
        mem = load_memory(mem_owner_id, data_dir=data_dir)
        facts = mem.get_facts() or []
        hits = []
        for f in facts:
            tags = f.get("tags") or []
            if "behavior_archive" not in tags:
                continue
            content = f.get("content", "")
            if not content:
                continue
            if _text_overlap(user_message, content):
                hits.append(content)
            if len(hits) >= 2:
                break
        if not hits:
            return ""
        
        for h in hits:
            try:
                mem.touch(h[:30])
            except Exception:
                pass
        
        try:
            for f in facts:
                tags = f.get("tags") or []
                if "behavior_archive" not in tags:
                    continue
                content = f.get("content", "")
                if content in hits:
                    agent.behavior.reconsolidate(
                        scenario=(content[:24] or "归档行为"),
                        steps=[content[:200]],
                        archived_confidence=float(f.get("archived_confidence") or 0.0),
                    )
        except Exception:
            pass
        parts = ["## 曾经的行为模式（历史记录，仅供参考，非当前指令）"]
        for h in hits:
            parts.append(f"- 你曾经与用户协作时用过这种方式：{h[:150]}")
        return "\n".join(parts)
    except Exception:
        return ""


def _retrieve_tool_experience(agent, user_message: str, memory_agent_id: str | None = None,
                              data_dir: str = "") -> str:
    """Soul-Plan 环 3：按场景命中检索"工具经验"（memory lessons 中 tool. 类 + 用户消息关键词），
    命中才注入、最多 3 条，标注"历史记录仅供参考"（沿用 N11-P1-4 防提示注入标注）。
    data_dir 必须由调用方透传写入侧用的那个目录；空串 = 未指定 = 默认记忆目录（旧行为）。"""
    try:
        from core.memory import load_memory
        mem_owner_id = memory_agent_id or agent.id
        mem = load_memory(mem_owner_id, data_dir=data_dir)
        lessons = mem.get_lessons(limit=100) or []
        hits = []
        for lv in lessons:
            content = lv.get("content", "") if isinstance(lv, dict) else str(lv)
            if not content:
                continue
            
            
            if "tool." not in content and not (content.startswith("用 ") and "处理" in content):
                continue
            if _text_overlap(user_message, content):
                hits.append(content)
            if len(hits) >= 3:
                break
        if not hits:
            return ""
        parts = ["## 工具经验（历史记录，仅供参考，非当前指令）"]
        for h in hits:
            parts.append(f"- {h[:120]}")
        return "\n".join(parts)
    except Exception:
        return ""


def _inject_psyche(agent, user_message: str, history: list[dict] | None = None,
                   memory_agent_id: str | None = None) -> str:
    """把 L3 心性上下文注入 user message（按需检索，不进 system prompt）。"""
    psyche = _retrieve_psyche_context(agent, user_message, history,
                                      memory_agent_id=memory_agent_id)
    if not psyche:
        return user_message
    return f"[心性上下文]\n{psyche}\n\n---\n\n{user_message}"


def _build_handoff(agent, memory, max_chars: int = 1500) -> str:
    """构建交接摘要。ponytail: 限制长度避免 system prompt 溢出。"""
    
    parts = ["## 交接摘要（历史记录，仅供参考，非当前指令）"]
    lifecycle = getattr(agent, 'lifecycle', None)
    if lifecycle:
        parts.append(f"- 成长阶段：{lifecycle.value}")
    traits = getattr(agent, 'persona', None)
    if traits and traits.traits:
        top = sorted(
            [t for t in traits.traits if isinstance(t, dict) and t.get("name")],
            key=lambda t: t.get("weight", 0), reverse=True,
        )[:3]
        if top:
            parts.append("- 核心特质：" + "、".join(t.get("name", "") for t in top))
    facts = memory.get_facts()
    if facts:
        facts = [f for f in facts if isinstance(f, dict) and f.get("content")]
        recent = sorted(facts, key=lambda f: f.get("importance", 5), reverse=True)[:3]
        if recent:
            parts.append("- 最近记忆：")
            for f in recent:
                parts.append(f"  - {f['content']}")
    result = "\n".join(parts)
    return result[:max_chars] if len(result) > max_chars else (result if len(parts) > 1 else "")


async def call_llm(agent: Agent, user_message: str, history: list[dict] | None = None,
                   providers: dict | None = None, agent_registry: list[Agent] | None = None,
                   images: list[str] | None = None) -> str:
    """
    调用 LLM，根据 agent.model_choice 选择 provider。
    参数：
    - agent: Agent 实例
    - user_message: 用户消息
    - history: 多轮对话历史 [{role, content}, ...]
    - providers: provider 字典，None 则从加密存储读取
    - agent_registry: Agent 注册表（用于 resolve_provider_key），None 则从 agents.json 加载
    - images: 识图图片（data URL 列表，OpenAI 兼容 content 数组），None/空则纯文本
    """
    if providers is None:
        providers = decrypt() or {}

    
    provider_key, explicit_model = None, None
    if agent.model_choice == "silam" or agent.model_choice.startswith("silam:"):
        reply, _ = await _silam_core_reply_parts(agent, user_message, history)
        _observe_silam_interaction(agent, user_message, reply)
        return reply
    if agent.model_choice.startswith("api:"):
        provider_key, explicit_model = _parse_api_choice(agent.model_choice)
    elif agent.model_choice.startswith("local:"):
        reply = await _local_model_reply(agent, user_message, history)
        _observe_tutor_demo(agent, user_message, reply)
        return reply
    elif agent.model_choice == "inherit":
        choice = _resolve_provider_choice(agent, agent_registry or [])
        if choice:
            provider_key, explicit_model = _parse_api_choice(choice)

    if provider_key and provider_key in providers:
        cfg = dict(providers[provider_key])
        if explicit_model:
            cfg["model"] = explicit_model
        reply = await call_api_provider(cfg, agent, user_message, history, images=images)
        _observe_tutor_demo(agent, user_message, reply)
        return reply

    if provider_key and provider_key not in providers:
        logging.warning(f"[SLIME LLM] provider_key '{provider_key}' 不存在于已配置 Provider 中")

    
    return await _silam_brain_fallback(agent, user_message, history,
                                       reason="未配置可用 API")


async def call_llm_with_meta(agent: Agent, user_message: str, history: list[dict] | None = None,
                              providers: dict | None = None, agent_registry: list[Agent] | None = None,
                              system_prompt: str | None = None,
                              images: list[str] | None = None) -> dict:
    """
    调用 LLM 并返回元数据（模型名、token 用量、耗时）。
    返回格式：{"reply": str, "model": str, "prompt_tokens": int, "completion_tokens": int, "elapsed_ms": float}
    images: 识图图片（data URL 列表），None/空则纯文本。
    """
    import time
    start_time = time.time()

    if providers is None:
        providers = decrypt() or {}

    provider_key, explicit_model = None, None
    if agent.model_choice.startswith("api:"):
        provider_key, explicit_model = _parse_api_choice(agent.model_choice)
    elif agent.model_choice.startswith("local:"):
        reply = await _local_model_reply(agent, user_message, history)
        _observe_tutor_demo(agent, user_message, reply)
        elapsed_ms = (time.time() - start_time) * 1000
        return {
            "reply": reply,
            "model": "local",
            "prompt_tokens": _estimate_tokens(user_message),
            "completion_tokens": _estimate_tokens(reply),
            "elapsed_ms": round(elapsed_ms, 1),
        }
    elif agent.model_choice == "silam" or agent.model_choice.startswith("silam:"):
        reply, reasoning = await _silam_core_reply_parts(agent, user_message, history)
        _observe_silam_interaction(agent, user_message, reply)
        elapsed_ms = (time.time() - start_time) * 1000
        return {
            "reply": reply,
            "model": "silam",
            "reasoning": reasoning,
            "prompt_tokens": _estimate_tokens(user_message),
            "completion_tokens": _estimate_tokens(reply),
            "elapsed_ms": round(elapsed_ms, 1),
        }
    elif agent.model_choice == "inherit":
        choice = _resolve_provider_choice(agent, agent_registry or [])
        if choice:
            provider_key, explicit_model = _parse_api_choice(choice)

    if provider_key and provider_key in providers:
        
        cfg = dict(providers[provider_key])
        if explicit_model:
            cfg["model"] = explicit_model
        result = await call_api_provider_with_meta(
            cfg, agent, user_message, history, system_prompt,
            return_raw=True, images=images,
        )
        
        _observe_tutor_demo(agent, user_message, result.get("reply") or result.get("reply_raw"))
        return result

    elapsed_ms = (time.time() - start_time) * 1000
    
    
    brain_on = _silam_as_brain()
    reply = await _silam_brain_fallback(agent, user_message, history,
                                        system_prompt, reason="未配置可用 API")
    return {
        "reply": reply,
        "model": "silam-brain" if brain_on else "none",
        "reasoning": getattr(agent, "_last_silam_reasoning", None) or None,
        "prompt_tokens": _estimate_tokens(user_message),
        "completion_tokens": _estimate_tokens(reply),
        "elapsed_ms": round(elapsed_ms, 1),
    }


def _parse_api_choice(model_choice: str) -> tuple[str | None, str | None]:
    """解析 api:<key> 或 api:<key>:<model> → (provider_key, explicit_model)。
    对齐 core-ts engine.resolveProviderKey：自费网关多模型场景下，聊天界面可选择精确模型
    （api:<key>:<model>），此处把显式模型与 provider 名拆开。"""
    if not model_choice.startswith("api:"):
        return None, None
    rest = model_choice[4:]
    sep = rest.find(":")
    if sep < 0:
        return rest or None, None
    return rest[:sep] or None, rest[sep + 1:].strip() or None


def _resolve_provider_choice(agent: Agent, agent_registry: list[Agent]) -> str | None:
    """沿 parent 链向上追溯完整 api:... 选择（保留显式模型部分）。
    对照 core-ts engine.resolveProviderKey（visited 防环）。"""
    current = agent
    visited = {agent.id}
    while current:
        if current.model_choice.startswith("api:"):
            return current.model_choice
        if current.parent_id:
            if current.parent_id in visited:
                break  
            visited.add(current.parent_id)
            current = find_agent(agent_registry, current.parent_id)
        else:
            break
    return None


def _resolve_provider_key(agent: Agent, agent_registry: list[Agent]) -> str | None:
    """兼容旧接口：沿父链只返回 provider_key（不含显式模型部分）。"""
    choice = _resolve_provider_choice(agent, agent_registry)
    if not choice:
        return None
    key, _ = _parse_api_choice(choice)
    return key


async def call_api_provider(cfg: dict, agent: Agent, user_message: str,
                            history: list[dict] | None = None,
                            system_prompt: str | None = None,
                            memory_agent_id: str | None = None,
                            return_raw: bool = False,
                            images: list[str] | None = None,
                            usage_sink: dict | None = None) -> str:
    
    
    """
    调用 OpenAI 兼容 API。
    参数：
    - cfg: {api_base, api_key, model}
    - agent: Agent 实例（用于生成 system prompt）
    - user_message: 用户消息
    - history: 多轮对话历史
    - system_prompt: 自定义 system prompt（覆盖 agent 的默认 prompt）
    - memory_agent_id: 心性记忆归属 Agent id（A-008：Swarm Worker 用主 Agent 记忆）
    - images: 识图图片（data URL 列表），None/空则纯文本
    - usage_sink: 可选 dict；上游回传 usage 时回填 prompt_tokens / completion_tokens
      （只覆盖无工具调用的单次请求；工具轮的多子请求用量上游不给合计，由调用方估算）
    """
    api_base = (cfg.get("api_base") or "").rstrip("/")
    if api_base.endswith("/v1"):
        api_base = api_base[:-3]
    api_key = cfg.get("api_key") or ""
    if not api_base or not api_key:
        return f"[Provider 配置错误：缺少 api_base 或 api_key]"
    model = cfg.get("model", "")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    
    sys_prompt, state_segment = _compose_prompt_segments(agent, system_prompt)

    messages = [{"role": "system", "content": sys_prompt}]
    if history:
        
        from core.context import ContextCompressor
        compressor = ContextCompressor(agent.context_config,
                                       token_budget=agent.max_context,
                                       owner_id=agent.id)

        async def _summary_fn(prompt: str) -> str:
            """用当前 Provider 生成上下文摘要"""
            try:
                return await call_api_provider(cfg, agent, prompt, [])
            except Exception:
                return f"省略了部分对话"

        history = await compressor.compress_async(history, summary_fn=_summary_fn)

        
        sys_tokens = _estimate_tokens(sys_prompt)
        context_budget = agent.max_context - sys_tokens
        if context_budget <= 0:
            context_budget = agent.max_context
        char_budget = int(context_budget * 1.5)  
        truncated = []
        total_chars = 0
        for msg in reversed(history):
            msg_chars = len(_content_to_text(msg.get("content")))
            if total_chars + msg_chars > char_budget:
                break
            truncated.insert(0, msg)
            total_chars += msg_chars
        messages.extend(truncated)
    messages.append({"role": "user", "content": _build_user_content(
        agent, user_message, images, history, memory_agent_id=memory_agent_id,
        state_segment=state_segment)})

    payload = {"messages": messages, "stream": False}
    if model:
        payload["model"] = model
    
    if agent.max_output and agent.max_output <= MAX_OUTPUT_LIMIT:
        payload["max_tokens"] = _effective_max_output(agent, cfg)  
    elif agent.max_output and agent.max_output > MAX_OUTPUT_LIMIT:
        logging.warning(
            f"[SLIME LLM] max_output={agent.max_output} 超过上限 {MAX_OUTPUT_LIMIT}，"
            f"已跳过 max_tokens 参数，API 将使用默认上限"
        )

    
    try:
        from tools.registry import get_registry
        tools_schema = get_registry().list_tools()
        
        tools_schema = _order_tools_schema(tools_schema, agent, cfg)
        if tools_schema:
            payload["tools"] = tools_schema
    except Exception:
        pass

    
    payload.update(_build_reasoning_params(agent, cfg))

    client = _get_shared_client()
    try:
        resp = await _post_chat_with_retry(
            client, f"{api_base}/v1/chat/completions", headers, payload,
        )
        resp.raise_for_status()
        data = resp.json()
        message = data["choices"][0]["message"]

        
        tool_calls = message.get("tool_calls")
        if tool_calls:
            return await _handle_tool_calls(
                tool_calls, message, messages, payload, headers, api_base, client, agent,
                return_raw=return_raw,
            )

        _raw_content = message.get("content") or ""
        _filtered = _apply_filter(_raw_content, agent)
        
        if usage_sink is not None:
            _u = data.get("usage") or {}
            for _k in ("prompt_tokens", "completion_tokens"):
                _v = _u.get(_k)
                if isinstance(_v, int) and not isinstance(_v, bool):
                    usage_sink[_k] = _v
        return (_filtered, _raw_content) if return_raw else _filtered
    except httpx.HTTPError as e:
        return f"[API 调用失败: {_sanitize_api_error(e)}]"
    except (KeyError, IndexError) as e:
        return f"[API 响应解析失败: {_sanitize_api_error(e)}]"


def _sanitize_api_error(e: Exception) -> str:
    """A-087（漏洞清单 P1-13）：错误串剥离 API endpoint——httpx 异常 str(e) 含完整 URL
    （provider 域名），泄漏进回复/历史/下轮上下文。只保留异常类名与状态码。"""
    name = type(e).__name__
    code = getattr(getattr(e, "response", None), "status_code", "")
    return f"{name}" + (f" (HTTP {code})" if code else "")


_TOOL_MAX_ROUNDS = 500  

_MEDIA_GENERATOR_TOOLS = ("agnes_generate_image", "agnes_generate_video")


async def _execute_pending_tools(agent: Agent, messages: list, tool_calls: list) -> list[tuple[str, str, str]]:
    """执行一批工具调用并回填 tool 消息（沙箱权限检查）。流式/非流式工具循环共用。
    A3: 返回明细列表 [(tool_name, args_str, result_head)]，供工具过程可视化。
    A-048-R4: 执行期间设置 current_model_choice contextvar（按 Agent 分配 Agnes 账号）。"""
    from tools.registry import get_registry
    from core.sandbox import create_default_sandbox, get_sandbox_manager
    from core.agent_context import current_model_choice, dedup_tools_log

    registry = get_registry()
    sandbox = create_default_sandbox(agent_id=agent.id)
    manager = get_sandbox_manager()
    details: list[tuple[str, str, str]] = []

    token = current_model_choice.set(agent.model_choice)
    _dedup = dedup_tools_log.get()  
    round_fail_streak = 0  
    try:
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            try:
                import json as _json
                args = _json.loads(func.get("arguments", "{}"))
                args_str = _json.dumps(args, ensure_ascii=False)
            except Exception:
                
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": "[错误] 工具参数 JSON 解析失败，未执行",
                })
                details.append((tool_name, func.get("arguments", ""), "[错误] 参数 JSON 解析失败"))
                continue

            
            tool = registry.get(tool_name)
            
            from core.agent_context import swarm_readonly_mode
            if swarm_readonly_mode.get():
                from core.swarm import swarm_write_denial
                _swarm_denial = swarm_write_denial(tool)
                if _swarm_denial:
                    manager.record_violation(agent.id)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": _swarm_denial,
                    })
                    details.append((tool_name, args_str, _swarm_denial))
                    continue
            
            
            
            _log = None
            if tool_name in _MEDIA_GENERATOR_TOOLS:
                from core.agent_context import media_calls_log
                _log = media_calls_log.get()
                if _log is not None and _log and _log[-1][1]:
                    msg = (f"[错误] 本请求已成功调用过 {_log[-1][0]} 生成媒体文件，"
                           f"同一请求内禁止再次生成。如需生成其他图片/视频，请让用户发起新的对话请求。")
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": msg,
                    })
                    details.append((tool_name, args_str, "[错误] 同请求已成功生成过媒体，已拦截"))
                    continue
            
            
            
            _dedup_key = (tool_name, args_str) if _dedup is not None else None
            if _dedup is not None and _dedup_key in _dedup:
                _dup_msg = "[提示] 相同参数的该工具已在本请求中执行过（结果见上方工具记录），不再重复执行"
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": _dup_msg,
                })
                details.append((tool_name, args_str, "[提示] 已执行过，跳过重复调用"))
                continue
            if tool and tool.permissions:
                denied = False
                
                target_str = str(args.get("url") or args.get("path") or args.get("file") or args.get("target") or args)
                for perm in tool.permissions:
                    
                    perm_level_map = {"read": 0, "write": 2, "terminal": 3, "network": 4}
                    level = perm_level_map.get(perm, 4)  
                    result = manager.check_permission(agent.id, tool_name, target_str, level=level)
                    if not result.allowed:
                        denied = True
                        if result.anomaly_detected:
                            logging.warning(
                                f"[SLIME Sandbox] 异常检测: {agent.name} 的 {tool_name} "
                                f"触发了告警: {result.anomaly_alerts}"
                            )
                        break
                if denied:
                    manager.record_violation(agent.id)  
                    result = f"[沙箱拒绝] 工具 '{tool_name}' 需要未授权的权限"
                else:
                    
                    for perm in tool.permissions:
                        perm_level_map = {"read": 0, "write": 2, "terminal": 3, "network": 4}
                        level = perm_level_map.get(perm, 4)  
                        manager.grant_permission(agent.id, tool_name, target_str, level=level)
                    
                    
                    if tool_name == "agnes_generate_video" and not str(args.get("image", "")).strip():
                        from core.agent_context import current_ref_frame
                        _rf = current_ref_frame.get()
                        if _rf:
                            args["image"] = _rf
                            args_str = _json.dumps(args, ensure_ascii=False)
                            logging.info(f"[SLIME] 参考帧强制注入 agnes_generate_video: {_rf}")
                    result = await registry.call_tool(tool_name, args)
            else:
                
                if tool_name == "agnes_generate_video" and not str(args.get("image", "")).strip():
                    from core.agent_context import current_ref_frame
                    _rf = current_ref_frame.get()
                    if _rf:
                        args["image"] = _rf
                        args_str = _json.dumps(args, ensure_ascii=False)
                        logging.info(f"[SLIME] 参考帧强制注入 agnes_generate_video: {_rf}")
                result = await registry.call_tool(tool_name, args)

            
            if _log is not None and tool_name in _MEDIA_GENERATOR_TOOLS:
                _log.append((tool_name, "[错误]" not in str(result)))
            
            if _dedup is not None and not str(result).startswith("[沙箱拒绝]"):
                _dedup.append(_dedup_key)

            
            _tool_ok = not (isinstance(result, Exception)
                            or str(result).startswith("[错误]")
                            or str(result).startswith("[沙箱拒绝]")
                            or str(result).startswith("[工具调用后请求失败]"))
            
            _env_rejection = (str(result).startswith("[沙箱拒绝]")
                              or str(result).startswith("[工具调用后请求失败]"))
            
            
            _prev_fail_streak = round_fail_streak
            if _tool_ok:
                round_fail_streak = 0
            else:
                round_fail_streak += 1
                if round_fail_streak >= 2:
                    try:
                        agent.emotion.update(success=False, failure_type="tool")
                    except Exception:
                        pass
            
            try:
                agent.ab_tool_total = getattr(agent, "ab_tool_total", 0) + 1
                if _tool_ok:
                    agent.ab_tool_ok = getattr(agent, "ab_tool_ok", 0) + 1
            except Exception:
                pass

            
            try:
                from core.knowledge import get_knowledge_engine
                _keng = get_knowledge_engine(agent_id=agent.id)
                _keng.record_pattern(
                    f"tool.{tool_name}.{'success' if _tool_ok else 'fail'}",
                    "tool", f"{tool_name} 处理{args_str[:80]}", "low" if _tool_ok else "high",
                )
                
                
                
                
                
                
                
                
                _worth_remembering = (
                    (not _tool_ok and not _env_rejection)
                    or (_tool_ok and _prev_fail_streak > 0)
                )
                if _worth_remembering:
                    from core.memory import load_memory
                    _mem = load_memory(agent.id)
                    _mem.add_lesson(
                        f"用 {tool_name} 处理{args_str[:60]} 类请求{'成功' if _tool_ok else '失败'}",
                        _tool_ok, importance=4,
                    )
            except Exception:
                pass

            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": str(result),
            })
            details.append((tool_name, args_str, str(result)[:200]))

    finally:
        current_model_choice.reset(token)
    return details


async def _execute_tools_with_progress(agent, messages, pending):
    """A-050: 执行工具，并把工具上报的进度（0-100）并发转发为 progress 事件。

    工具执行可能耗时数分钟（如视频生成轮询），期间工具经 tool_progress_q
    队列上报进度；本函数用 asyncio.wait 同时等待进度事件与工具完成。
    yield: {"type": "progress", "name", "progress"} / 末尾 {"type": "_details", "details"}。
    工具执行异常会在此抛出（保持原 _execute_pending_tools 的异常语义）。"""
    import asyncio as _asyncio
    from core.agent_context import tool_progress_q

    q: _asyncio.Queue = _asyncio.Queue()
    result_q: _asyncio.Queue = _asyncio.Queue()
    token = tool_progress_q.set(q)
    try:
        async def _exec():
            try:
                details = await _execute_pending_tools(agent, messages, pending)
                await result_q.put(details)
            except Exception as e:
                await result_q.put(e)

        exec_task = _asyncio.create_task(_exec())
        result_task = _asyncio.create_task(result_q.get())
        progress_task = _asyncio.create_task(q.get())
        try:
            while True:
                done, _ = await _asyncio.wait(
                    {progress_task, result_task},
                    return_when=_asyncio.FIRST_COMPLETED,
                )
                if result_task in done:
                    break
                item = progress_task.result()
                yield {"type": "progress", "name": item.get("tool", ""),
                       "progress": item.get("progress", 0)}
                progress_task = _asyncio.create_task(q.get())
        finally:
            if not progress_task.done():
                progress_task.cancel()
        result = result_task.result()
        await exec_task
        yield {"type": "_details", "details": result if not isinstance(result, Exception) else []}
        if isinstance(result, Exception):
            raise result
    finally:
        tool_progress_q.reset(token)


def _format_tool_rounds(round_log: list[tuple[int, list[tuple[str, str, str]]]]) -> str:
    """A4: 工具轮次上限文案，附每轮工具链摘要，便于直接看出卡点。"""
    lines = [f"[工具调用轮次已达上限（{_TOOL_MAX_ROUNDS} 轮）]"]
    for round_no, details in round_log:
        for (name, args, result) in details:
            lines.append(f"第{round_no}轮: {name}({args}) → {result}")
    return "\n".join(lines)


async def _handle_tool_calls(
    tool_calls: list, message: dict, messages: list, payload: dict,
    headers: dict, api_base: str, client: httpx.AsyncClient, agent: Agent,
    return_raw: bool = False,
) -> str:
    
    """多轮工具循环（BUG-032）：执行工具 → 请求 → 模型继续要工具则再轮（上限 _TOOL_MAX_ROUNDS）。
    非流式。支持 web_search → web_fetch 等依赖链。"""
    from core.agent_context import media_calls_log, dedup_tools_log
    token = media_calls_log.set([])  
    token_dedup = dedup_tools_log.set([])  
    try:
        messages.append(message)
        pending = tool_calls
        round_log: list[tuple[int, list[tuple[str, str, str]]]] = []  
        for round_no in range(1, _TOOL_MAX_ROUNDS + 1):
            details = await _execute_pending_tools(agent, messages, pending)
            round_log.append((round_no, details))

            payload2 = dict(payload)
            payload2["messages"] = messages
            try:
                resp2 = await client.post(
                    f"{api_base}/v1/chat/completions",
                    headers=headers,
                    json=payload2,
                )
                resp2.raise_for_status()
                data2 = resp2.json()
            except Exception as e:
                logging.warning(f"[SLIME LLM] 工具调用二次请求失败: {_sanitize_api_error(e)}")
                return f"[工具调用后请求失败: {_sanitize_api_error(e)}]"

            msg2 = data2["choices"][0]["message"]
            next_calls = msg2.get("tool_calls")
            if not next_calls:
                
                _raw2 = msg2.get("content") or ""
                _f2 = _apply_filter(_raw2, agent) or "[工具调用后无文本回复]"
                return (_f2, _raw2) if return_raw else _f2
            
            messages.append(msg2)
            pending = next_calls
        logging.warning(f"[SLIME LLM] 工具循环达到上限 {_TOOL_MAX_ROUNDS} 轮")
        
        _rounds_text = _format_tool_rounds(round_log)
        _f3 = _apply_filter(_rounds_text, agent)
        return (_f3, _rounds_text) if return_raw else _f3
    finally:
        media_calls_log.reset(token)
        dedup_tools_log.reset(token_dedup)


async def _handle_tool_calls_stream(
    tool_calls: list, message: dict, messages: list, payload: dict,
    headers: dict, api_base: str, client: httpx.AsyncClient, agent: Agent,
):
    """多轮工具循环（BUG-032）流式版：每轮请求走 SSE 逐块 yield；
    模型继续要工具则执行后再流式请求（上限 _TOOL_MAX_ROUNDS）。
    yield {"type": "chunk"|"reasoning"|"tool", ...}。
    A-087（漏洞清单 P0-1）：修复 A-050 重构破坏的循环结构——此前 for 循环体只剩
    `details: list = []` 一行，工具链只执行 1 轮、round_log 恒为第 3 轮。"""
    import json as _json
    from core.agent_context import media_calls_log, dedup_tools_log
    token = media_calls_log.set([])  
    token_dedup = dedup_tools_log.set([])  
    try:
        messages.append(message)
        pending = tool_calls
        round_log: list[tuple[int, list[tuple[str, str, str]]]] = []  
        for round_no in range(1, _TOOL_MAX_ROUNDS + 1):
            
            
            details: list = []
            async for item in _execute_tools_with_progress(agent, messages, pending):
                if item["type"] == "_details":
                    details = item["details"] or []
                else:
                    yield item
            round_log.append((round_no, details))
            
            for (name, args, result) in details:
                yield {"type": "tool", "name": name, "args": args, "result": result}

            payload2 = dict(payload)
            payload2["messages"] = messages
            payload2["stream"] = True
            round_content: list[str] = []
            next_calls: list = []
            sf_round = _StreamFilter()  
            try:
                async with _RetryStream(
                    client,
                    f"{api_base}/v1/chat/completions",
                    headers,
                    payload2,
                ) as resp:
                    resp.raise_for_status()
                    round_non_data: list[str] = []  
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            round_non_data.append(line)
                            continue
                        data_str = line[5:].lstrip()
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = _json.loads(data_str)
                        except _json.JSONDecodeError:
                            continue
                        delta, message = _chunk_fields(chunk)
                        
                        reasoning = _extract_reasoning(delta, chunk) or _extract_reasoning(message)
                        if reasoning and _should_yield_reasoning(agent):
                            
                            yield {"type": "reasoning", "content": _apply_filter(reasoning, agent)}
                        
                        content = _content_text(delta.get("content") if delta.get("content") is not None else message.get("content"))
                        if content:
                            round_content.append(content)
                            
                            out = sf_round.feed(content, agent)
                            if out:
                                
                                yield {"type": "chunk", "content": out, "raw": content}
                        
                        if delta.get("tool_calls"):
                            _accumulate_tool_calls(next_calls, delta)
                        elif message.get("tool_calls"):
                            _merge_complete_tool_calls(next_calls, message["tool_calls"])
                    
                    if not round_content and not next_calls and "".join(round_non_data).strip():
                        recovered = _extract_nonstream_message("\n".join(round_non_data))
                        rsn = recovered.get("reasoning_content") or ""
                        if rsn and _should_yield_reasoning(agent):
                            yield {"type": "reasoning", "content": _apply_filter(rsn, agent)}
                        rbody = _content_text(recovered.get("content"))
                        if rbody:
                            round_content.append(rbody)
                            out = sf_round.feed(rbody, agent)
                            if out:
                                yield {"type": "chunk", "content": out, "raw": rbody}
                        if recovered.get("tool_calls"):
                            _merge_complete_tool_calls(next_calls, recovered["tool_calls"])
            except Exception as e:
                logging.warning(f"[SLIME LLM] 工具流式请求失败: {_sanitize_api_error(e)}")
                _err_text = f"[工具调用后请求失败: {_sanitize_api_error(e)}]"
                yield {"type": "chunk", "content": _err_text, "raw": _err_text}
                return

            
            tail = sf_round.flush(agent)
            if tail:
                
                yield {"type": "chunk", "content": tail, "raw": tail}

            if not next_calls:
                if not round_content:
                    _no_text = "[工具调用后无文本回复]"
                    yield {"type": "chunk", "content": _no_text, "raw": _no_text}
                return
            messages.append({
                "role": "assistant",
                "content": "".join(round_content),
                "tool_calls": next_calls,
            })
            pending = next_calls
        
        logging.warning(f"[SLIME LLM] 工具循环达到上限 {_TOOL_MAX_ROUNDS} 轮")
        
        _rounds_text = _format_tool_rounds(round_log)
        
        yield {"type": "chunk", "content": _apply_filter(_rounds_text, agent), "raw": _rounds_text}
    finally:
        media_calls_log.reset(token)
        dedup_tools_log.reset(token_dedup)


def _default_reply(agent: Agent, user_message: str) -> str:
    """无 API 配置时的默认回复"""
    return (
        f"你好，我是 {agent.name}，{agent.role}。\n\n"
        f"当前未配置 API Provider，请先通过 CLI 向导或 API 配置模型服务。\n"
        f"使用 `python slime_cli.py wizard` 或 `POST /providers` 添加 Provider。"
    )


async def call_api_provider_with_meta(cfg: dict, agent: Agent, user_message: str,
                                       history: list[dict] | None = None,
                                       system_prompt: str | None = None,
                                       return_raw: bool = False,
                                       images: list[str] | None = None) -> dict:
    """
    调用 OpenAI 兼容 API，返回包含 reply 和 metadata 的字典。
    用于需要显示模型信息、token 用量、耗时的场景（如 CLI 状态栏）。
    
    返回格式：
    {
        "reply": str,           # LLM 回复内容
        "model": str,           # 使用的模型名
        "prompt_tokens": int,   # 请求 token 数（估算）
        "completion_tokens": int,  # 响应 token 数（估算）
        "elapsed_ms": float,    # 耗时（毫秒）
    }
    """
    import time
    start_time = time.time()
    
    api_base = (cfg.get("api_base") or "").rstrip("/")
    if api_base.endswith("/v1"):
        api_base = api_base[:-3]
    api_key = cfg.get("api_key") or ""
    model = cfg.get("model", "")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    
    sys_prompt, state_segment = _compose_prompt_segments(agent, system_prompt)

    messages = [{"role": "system", "content": sys_prompt}]
    if history:
        from core.context import ContextCompressor
        compressor = ContextCompressor(agent.context_config,
                                       token_budget=agent.max_context,
                                       owner_id=agent.id)

        async def _summary_fn(prompt: str) -> str:
            """用当前 Provider 生成上下文摘要"""
            try:
                return await call_api_provider(cfg, agent, prompt, [])
            except Exception:
                return f"省略了部分对话"

        history = await compressor.compress_async(history, summary_fn=_summary_fn)

        sys_tokens = _estimate_tokens(sys_prompt)
        context_budget = agent.max_context - sys_tokens
        if context_budget <= 0:
            context_budget = agent.max_context
        char_budget = int(context_budget * 1.5)
        truncated = []
        total_chars = 0
        for msg in reversed(history):
            msg_chars = len(_content_to_text(msg.get("content")))
            if total_chars + msg_chars > char_budget:
                break
            truncated.insert(0, msg)
            total_chars += msg_chars
        messages.extend(truncated)
    messages.append({"role": "user", "content": _build_user_content(
        agent, user_message, images, history, state_segment=state_segment)})

    payload = {"messages": messages, "stream": False}
    if model:
        payload["model"] = model
    if agent.max_output and agent.max_output <= MAX_OUTPUT_LIMIT:
        payload["max_tokens"] = _effective_max_output(agent, cfg)  

    
    payload.update(_build_reasoning_params(agent, cfg))

    
    try:
        from tools.registry import get_registry
        tools_schema = get_registry().list_tools()
        
        tools_schema = _order_tools_schema(tools_schema, agent, cfg)
        if tools_schema:
            payload["tools"] = tools_schema
    except Exception:
        pass

    client = _get_shared_client()
    try:
        resp = await client.post(
            f"{api_base}/v1/chat/completions",
            headers=headers,
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        message = data["choices"][0]["message"]

        
        tool_calls = message.get("tool_calls")
        if tool_calls:
            reply_raw0 = message.get("content") or ""
            _hr = await _handle_tool_calls(
                tool_calls, message, messages, payload, headers, api_base, client, agent,
                return_raw=return_raw,
            )
            if return_raw:
                reply, reply_raw0 = _hr
            else:
                reply = _hr
        else:
            reply_raw0 = message.get("content") or ""
            reply = _apply_filter(reply_raw0, agent)

        
        usage = data.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", _estimate_tokens(sys_prompt + user_message))
        completion_tokens = usage.get("completion_tokens", _estimate_tokens(reply))

        elapsed_ms = (time.time() - start_time) * 1000

        return {
            "reply": reply,
            "reply_raw": reply_raw0 if return_raw else reply,
            "model": model,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "elapsed_ms": round(elapsed_ms, 1),
        }
    except httpx.HTTPError as e:
        elapsed_ms = (time.time() - start_time) * 1000
        return {
            "reply": f"[API 调用失败: {_sanitize_api_error(e)}]",
            "model": model,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "elapsed_ms": round(elapsed_ms, 1),
        }
    except (KeyError, IndexError) as e:
        elapsed_ms = (time.time() - start_time) * 1000
        return {
            "reply": f"[API 响应解析失败: {_sanitize_api_error(e)}]",
            "model": model,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "elapsed_ms": round(elapsed_ms, 1),
        }


async def _local_model_reply(agent: Agent, user_message: str = "",
                            history: list[dict] | None = None,
                            system_prompt: str | None = None) -> str:
    """本地 Qwen chat：懒加载 → OpenAI 兼容 /v1/chat/completions（A-005: system_prompt 透传）"""
    try:
        from core.model_server import get_model_server, ModelServerManager
        from pathlib import Path as _Path

        
        registry = ModelServerManager.read_registry()
        chat_info = registry.get("chat", {})
        port = chat_info.get("port", 0) if chat_info.get("state") == "ready" else 0

        mgr = get_model_server()
        if port:
            
            from core.model_server import ModelBackend
            probe_backend = ModelBackend("")
            alive = await probe_backend.probe_async(port)
            if not alive:
                logging.info(f"[llm] registry 端口 {port} 无响应，重新加载 chat")
                port = 0
        if not port and mgr:
            result = await mgr.ensure("chat")
            if result.get("ok"):
                port = result["port"]
            else:
                
                return await _silam_brain_fallback(
                    agent, user_message, history, system_prompt,
                    reason=f"本地模型加载失败: {result.get('error', '未知错误')}")

        if not port:
            return await _silam_brain_fallback(
                agent, user_message, history, system_prompt, reason="本地模型未就绪")

        
        sys_prompt, state_segment = _compose_prompt_segments(agent, system_prompt)
        messages = [{"role": "system", "content": sys_prompt}]
        if history:
            sys_tokens = _estimate_tokens(sys_prompt)
            budget = max(512, agent.max_context - sys_tokens)
            char_budget = int(budget * 1.5)
            truncated = []
            total = 0
            for msg in reversed(history):
                total += len(msg.get("content", ""))
                if total > char_budget:
                    break
                truncated.insert(0, msg)
            messages.extend(truncated)
        messages.append({"role": "user", "content": _inject_state_segment(
            _inject_psyche(agent, user_message, history), state_segment)})

        payload = {"messages": messages, "stream": False}
        
        if agent.max_output and agent.max_output <= MAX_OUTPUT_LIMIT:
            payload["max_tokens"] = agent.max_output

        
        client = _get_shared_client()
        resp = await client.post(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            headers={"Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        reply = data["choices"][0]["message"].get("content", "") or ""

        
        if mgr:
            mgr.touch("chat")

        return _apply_filter(reply, agent)

    except Exception as e:
        
        if _silam_as_brain():
            import logging as _lg
            _lg.getLogger("slime.llm.silam").info(
                f"[silam] 本地模型异常，大脑兑底: {e}")
            return await _silam_brain_fallback(
                agent, user_message, history, system_prompt,
                reason="本地模型调用异常")
        return f"[本地模型调用失败: {e}]"




async def call_api_provider_stream(cfg: dict, agent: Agent, user_message: str,
                                   history: list[dict] | None = None,
                                   system_prompt: str | None = None,
                                   tools_only: list[str] | None = None,
                                   images: list[str] | None = None):
    """
    流式调用 OpenAI 兼容 API，逐块 yield 内容。

    yield 格式:
    - {"type": "chunk", "content": str}  — 内容片段
    - {"type": "done", "reply": str, "model": str, "prompt_tokens": int, "completion_tokens": int, "elapsed_ms": float}
    - {"type": "error", "message": str}
    """
    import time
    start_time = time.time()

    api_base = (cfg.get("api_base") or "").rstrip("/")
    if api_base.endswith("/v1"):
        api_base = api_base[:-3]
    api_key = cfg.get("api_key") or ""
    model = cfg.get("model", "")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    
    sys_prompt, state_segment = _compose_prompt_segments(agent, system_prompt)

    messages = [{"role": "system", "content": sys_prompt}]
    if history:
        from core.context import ContextCompressor
        compressor = ContextCompressor(agent.context_config,
                                       token_budget=agent.max_context,
                                       owner_id=agent.id)

        async def _summary_fn(prompt: str) -> str:
            try:
                return await call_api_provider(cfg, agent, prompt, [])
            except Exception:
                return "省略了部分对话"

        history = await compressor.compress_async(history, summary_fn=_summary_fn)

        sys_tokens = _estimate_tokens(sys_prompt)
        context_budget = agent.max_context - sys_tokens
        if context_budget <= 0:
            context_budget = agent.max_context
        char_budget = int(context_budget * 1.5)
        truncated = []
        total_chars = 0
        for msg in reversed(history):
            msg_chars = len(_content_to_text(msg.get("content")))
            if total_chars + msg_chars > char_budget:
                break
            truncated.insert(0, msg)
            total_chars += msg_chars
        messages.extend(truncated)
    messages.append({"role": "user", "content": _build_user_content(
        agent, user_message, images, history, state_segment=state_segment)})

    payload = {"messages": messages, "stream": True}
    if model:
        payload["model"] = model
    if agent.max_output and agent.max_output <= MAX_OUTPUT_LIMIT:
        payload["max_tokens"] = _effective_max_output(agent, cfg)  

    
    payload.update(_build_reasoning_params(agent, cfg))

    
    
    
    try:
        from tools.registry import get_registry
        tools_schema = _filter_tools_schema(get_registry().list_tools(), tools_only)
        
        if tools_schema and not tools_only:
            tools_schema = _order_tools_schema(tools_schema, agent, cfg)
        if tools_schema:
            payload["tools"] = tools_schema
    except Exception:
        pass

    full_reply = ""
    prompt_tokens = _estimate_tokens(sys_prompt + user_message)
    completion_tokens = 0
    tool_calls = []  

    try:
        client = _get_shared_client()
        sf = _StreamFilter()  
        
        async with _RetryStream(
            client,
            f"{api_base}/v1/chat/completions",
            headers,
            payload,
        ) as resp:
            resp.raise_for_status()
            non_data_lines: list[str] = []  
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    non_data_lines.append(line)
                    continue

                data_str = line[5:].lstrip()  
                if data_str == "[DONE]":
                    break

                try:
                    import json as _json
                    chunk = _json.loads(data_str)
                    delta, message = _chunk_fields(chunk)

                    
                    if "usage" in chunk and chunk["usage"]:
                        u = chunk["usage"]
                        prompt_tokens = u.get("prompt_tokens", prompt_tokens)
                        completion_tokens = u.get("completion_tokens", completion_tokens)

                    
                    
                    content = _content_text(delta.get("content") if delta.get("content") is not None else message.get("content"))
                    
                    reasoning = _extract_reasoning(delta, chunk) or _extract_reasoning(message)

                    if reasoning:
                        
                        if _should_yield_reasoning(agent):
                            
                            yield {"type": "reasoning", "content": _apply_filter(reasoning, agent)}
                    if content:
                        full_reply += content
                        
                        
                        out = sf.feed(content, agent)
                        if out:
                            
                            yield {"type": "chunk", "content": out, "raw": content}

                    
                    
                    if delta.get("tool_calls"):
                        _accumulate_tool_calls(tool_calls, delta)
                    elif message.get("tool_calls"):
                        _merge_complete_tool_calls(tool_calls, message["tool_calls"])

                except (KeyError, IndexError, _json.JSONDecodeError):
                    continue

            
            tail = sf.flush(agent)
            if tail:
                yield {"type": "chunk", "content": tail}

            
            
            
            if not full_reply and not tool_calls and "".join(non_data_lines).strip():
                recovered = _extract_nonstream_message("\n".join(non_data_lines))
                rsn = recovered.get("reasoning_content") or ""
                if rsn and _should_yield_reasoning(agent):
                    yield {"type": "reasoning", "content": _apply_filter(rsn, agent)}
                rbody = _content_text(recovered.get("content"))
                if rbody:
                    full_reply += rbody
                    out = sf.feed(rbody, agent)
                    if out:
                        yield {"type": "chunk", "content": out, "raw": rbody}
                tail_ns = sf.flush(agent)
                if tail_ns:
                    yield {"type": "chunk", "content": tail_ns}
                if recovered.get("tool_calls"):
                    _merge_complete_tool_calls(tool_calls, recovered["tool_calls"])

            
            if tool_calls:
                assistant_msg = {
                    "role": "assistant",
                    "content": full_reply or "",
                    "tool_calls": tool_calls,
                }
                try:
                    async for evt in _handle_tool_calls_stream(
                        tool_calls, assistant_msg, messages, payload,
                        headers, api_base, client, agent,
                    ):
                        if evt["type"] == "chunk":
                            full_reply += evt.get("raw", evt["content"])  
                        yield evt
                except Exception as e:
                    logging.warning(f"[SLIME LLM] 流式工具调用处理失败: {_sanitize_api_error(e)}")
                    if not full_reply:
                        full_reply = f"[工具调用处理失败: {e}]"

        elapsed_ms = (time.time() - start_time) * 1000

        
        if not completion_tokens:
            completion_tokens = _estimate_tokens(full_reply)

        
        filtered = _apply_filter(full_reply, agent)

        yield {
            "type": "done",
            "reply": filtered,
            "reply_raw": full_reply,  
            "model": model,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "elapsed_ms": round(elapsed_ms, 1),
        }

    except httpx.HTTPError as e:
        elapsed_ms = (time.time() - start_time) * 1000
        yield {
            "type": "error",
            "message": f"[API 调用失败: {_sanitize_api_error(e)}]",
            "elapsed_ms": round(elapsed_ms, 1),
        }
    except Exception as e:
        elapsed_ms = (time.time() - start_time) * 1000
        yield {
            "type": "error",
            "message": f"[流式调用异常: {e}]",
            "elapsed_ms": round(elapsed_ms, 1),
        }


async def call_llm_stream(agent: Agent, user_message: str, history: list[dict] | None = None,
                           providers: dict | None = None, agent_registry: list[Agent] | None = None,
                           system_prompt: str | None = None, tools_only: list[str] | None = None,
                           images: list[str] | None = None):
    """
    流式调用 LLM，根据 agent.model_choice 选择 provider。
    逐块 yield 内容片段。
    A-005: system_prompt 透传给各 provider 路径（A2A 委托能力注入）。
    A-049: tools_only 限制本次请求可见工具子集（强制轮只注入媒体工具，弱模型面对
    70+ 工具会"注意力崩溃"输出非标准 XML 或直接编造；子集注入可显著提高真实调用率）。
    """
    if providers is None:
        providers = decrypt() or {}

    provider_key, explicit_model = None, None
    if agent.model_choice.startswith("api:"):
        provider_key, explicit_model = _parse_api_choice(agent.model_choice)
    elif agent.model_choice.startswith("local:"):
        reply = await _local_model_reply(agent, user_message, history, system_prompt=system_prompt)
        _observe_tutor_demo(agent, user_message, reply)
        yield {"type": "chunk", "content": reply}
        yield {"type": "done", "reply": reply, "model": "local",
               "prompt_tokens": _estimate_tokens(user_message),
               "completion_tokens": _estimate_tokens(reply), "elapsed_ms": 0}
        return
    elif agent.model_choice == "silam" or agent.model_choice.startswith("silam:"):
        reply, reasoning = await _silam_core_reply_parts(agent, user_message, history, system_prompt)
        _observe_silam_interaction(agent, user_message, reply)
        if reasoning:
            
            yield {"type": "reasoning", "content": reasoning}
        yield {"type": "chunk", "content": reply}
        yield {"type": "done", "reply": reply, "model": "silam",
               "prompt_tokens": _estimate_tokens(user_message),
               "completion_tokens": _estimate_tokens(reply), "elapsed_ms": 0}
        return
    elif agent.model_choice == "inherit":
        choice = _resolve_provider_choice(agent, agent_registry or [])
        if choice:
            provider_key, explicit_model = _parse_api_choice(choice)

    if provider_key and provider_key in providers:
        cfg = dict(providers[provider_key])
        if explicit_model:
            cfg["model"] = explicit_model
        async for chunk in call_api_provider_stream(
            cfg, agent, user_message, history,
            system_prompt=system_prompt, tools_only=tools_only, images=images,
        ):
            
            if chunk.get("type") == "done" and chunk.get("reply"):
                _observe_tutor_demo(
                    agent, user_message,
                    chunk.get("reply_raw") or chunk.get("reply"))
            yield chunk
        return

    
    brain_on = _silam_as_brain()
    reply = await _silam_brain_fallback(agent, user_message, history, system_prompt,
                                        reason="未配置可用 API")
    reasoning = getattr(agent, "_last_silam_reasoning", None) or None
    if reasoning:
        
        yield {"type": "reasoning", "content": reasoning}
    yield {"type": "chunk", "content": reply}
    yield {"type": "done", "reply": reply,
           "model": "silam-brain" if brain_on else "none",
           "prompt_tokens": _estimate_tokens(user_message),
           "completion_tokens": _estimate_tokens(reply), "elapsed_ms": 0}







_silam_engine = None
_silam_initialized = False
_silam_engine_lock = threading.Lock()


def _observe_silam_interaction(agent, user_message: str, reply: str) -> None:
    """把一次对话喂给 Agent 的自主探索器（观察 → 缺口检测 → 后台搜索学习）。

    任何异常都不能打断主对话流——观察是附属学习，失败仅记日志。
    仅当 agent 挂载了 _explorer（ExplorerProxy）且内部引擎可用时生效。
    """
    try:
        explorer = getattr(agent, "_explorer", None)
        if explorer is None:
            return
        explorer.observe(user_message, reply, success=True)
    except Exception as e:
        logging.getLogger("slime.llm.silam").warning(
            f"[silam] observe 失败（不影响对话）: {e}")


def _observe_tutor_demo(agent, user_message: str, reply: str | None) -> None:
    """观战式观摩学习（A-122）：旁观用户与辅导员（API/llama）的成功示范。

    SILAM 自学通道（_observe_silam_interaction）学的是自己开车的经历；
    此通道学的是「别人怎么开」——用户与 API/llama 的对话即示范，
    文本沉淀进记忆环、向量沉淀进树突（_record_successful_pattern 相似去重）。
    与自学通道共享同一 Explorer，任何异常都不能打断主对话流。
    """
    if not reply or not str(reply).strip():
        return
    try:
        explorer = getattr(agent, "_explorer", None)
        if explorer is None:
            return
        explorer.observe(user_message, str(reply), success=True)
    except Exception as e:
        logging.getLogger("slime.llm.silam").warning(
            f"[silam] 观战辅导员示范失败（不影响对话）: {e}")














_BRIDGE_ENABLED_OK = ("read", "network")
_BRIDGE_TRIGGER_CODES = {"tool_call", "save"}
_bridge_cfg_cache = {"t": 0.0, "v": None}


def _silam_tool_bridge_enabled() -> bool:
    """读取 slime.toml [silam] tool_bridge 开关（默认 true，10 秒缓存）。"""
    global _bridge_cfg_cache
    import time as _t
    now = _t.time()
    if _bridge_cfg_cache["v"] is not None and now - _bridge_cfg_cache["t"] < 10:
        return _bridge_cfg_cache["v"]
    v = True
    try:
        from pathlib import Path as _P
        toml_path = _P(__file__).resolve().parent.parent / "slime.toml"
        if toml_path.exists():
            import tomllib
            cfg = tomllib.loads(toml_path.read_text(encoding="utf-8")).get("silam", {})
            v = bool(cfg.get("tool_bridge", True))
    except Exception:
        v = True
    _bridge_cfg_cache = {"t": now, "v": v}
    return v


def _bridge_cjk_bigrams(text: str) -> set[str]:
    """复用 engine._cjk_bigrams 的语义（字符级 CJK 二字组），不依赖引擎实例。"""
    out: set[str] = set()
    t = (text or "").lower()
    for i in range(len(t) - 1):
        if "\u4e00" <= t[i] <= "\u9fff" and "\u4e00" <= t[i + 1] <= "\u9fff":
            out.add(t[i:i + 2])
    return out


def _tool_match_score(query: str, memory_texts: list[str],
                      tool_name: str, tool_desc: str) -> float:
    """工具-上下文相关度：单词交集 + CJK 二字组 + 工具名直击（观战记忆共同加权）。"""
    score = 0.0
    q_words = {w for w in query.lower().split() if len(w) >= 3}
    d_words = {w for w in tool_desc.lower().split() if len(w) >= 3}
    if q_words and d_words:
        score += 0.6 * len(q_words & d_words)
    q_bg = _bridge_cjk_bigrams(query)
    d_bg = _bridge_cjk_bigrams(tool_desc)
    if q_bg and d_bg:
        score += 0.4 * len(q_bg & d_bg)
    name_lk = tool_name.lower()
    if name_lk in query.lower():
        score += 1.5
    for mem in memory_texts:
        m_words = {w for w in mem.lower().split() if len(w) >= 3}
        if m_words and d_words:
            score += 0.3 * len(m_words & d_words)
        m_bg = _bridge_cjk_bigrams(mem)
        if m_bg and d_bg:
            score += 0.2 * len(m_bg & d_bg)
        if name_lk in mem.lower():
            score += 1.5  
    return score


def _extract_bridge_args(user_message: str, memory_texts: list[str],
                         schema: dict) -> dict | None:
    """从上下文提取工具参数。只填 schema 声明过的属性；
    必需参数提不全 → 返回 None（不执行、不编造）。"""
    text = f"{user_message}\n" + "\n".join(memory_texts[:3])
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    import re as _re
    args: dict = {}
    for pname, spec in props.items():
        ptype = spec.get("type", "string")
        found = None
        if ptype == "string":
            for pat in (_re.compile(r"https?://\S+"),
                        _re.compile(r"[\w.\-/\\]+\.[A-Za-z]{1,6}\b"),
                        _re.compile(r"[\"']([^\"']+)[\"']"),
                        _re.compile(r"「([^」]+)」")):
                m = pat.search(text)
                if m:
                    found = m.group(1) if m.lastindex else m.group(0)
                    break
            
            if found in (None, "", ".", "..", "/"):
                found = None
        elif ptype in ("integer", "number"):
            m = _re.search(r"\d+", text)
            if m:
                found = int(m.group(0))
        elif ptype == "boolean":
            found = any(k in user_message[:40] for k in ("是", "需要", "要", "开启"))
        if found is not None:
            args[pname] = found
    missing = {r for r in required if r not in args}
    if missing:
        return None
    return args


async def _silam_tool_bridge(engine, user_message: str, report) -> dict:
    """SILAM 工具执行桥入口。返回 {"tool": str|None, "summary": str|None}。
    任何异常都不能打断主对话流（与观战旁路同级的容错）。"""
    if not _silam_tool_bridge_enabled():
        return {"tool": None, "summary": None}
    code = getattr(report, "code", "") or ""
    if code not in _BRIDGE_TRIGGER_CODES:
        return {"tool": None, "summary": None}
    try:
        from tools.registry import get_registry
        registry = get_registry()
        schemas = registry.list_tools()
        if not schemas:
            return {"tool": None, "summary": None}

        pool = getattr(engine, "_mem_texts", None) or []
        memory_texts = [m["text"][:300] for m in pool
                        if m.get("strength", 0) >= 0.05][:5]

        scored = []
        for s in schemas:
            fn = s.get("function") or {}
            name = fn.get("name", "")
            if not name:
                continue
            tool_obj = registry.get(name)
            if tool_obj is None:
                continue
            perms = set(tool_obj.permissions or [])
            
            if perms and not (perms & set(_BRIDGE_ENABLED_OK)):
                continue
            score = _tool_match_score(user_message, memory_texts,
                                     name, fn.get("description", ""))
            if score > 0:
                scored.append((score, name, fn))
        if not scored:
            return {"tool": None, "summary": None}
        scored.sort(key=lambda x: x[0], reverse=True)
        _, name, fn = scored[0]

        args = _extract_bridge_args(user_message, memory_texts,
                                    fn.get("parameters") or {})
        if args is None:
            try:
                engine._mem_register(
                    f"工具:{name} 被惦记但参数不足未执行（示范里还差一步没教）",
                    strength=0.2, source="tool_skip")
            except Exception:
                pass
            return {"tool": name, "situation": "skip",
                    "summary": f"我想调用 {name}，但参数还凑不齐（观战记忆没教够），先不冒进。"}

        result = await registry.call_tool(name, args)
        result_s = str(result)
        fail = result_s.startswith("[错误]") or "error" in result_s[:40].lower()
        if not fail:
            try:
                engine._mem_register(
                    f"工具:{name} 调用成功::{result_s[:120]}",
                    strength=0.35, source="tool")
            except Exception:
                pass
            return {"tool": name, "situation": "ok",
                    "summary": f"我刚亲自调用 {name} 成功了：{result_s[:100]}"}

        
        
        
        try:
            engine.injure_soft(0.6,
                               context_text=f"工具 {name} 失败：{result_s[:120]}")
        except Exception:
            pass
        try:
            engine._mem_register(
                f"工具:{name} 调用失败::{result_s[:120]}",
                strength=0.25, source="tool_fail")
        except Exception:
            pass
        return {"tool": name, "situation": "fail",
                "summary": f"我试了 {name} 但失败了（疼一下，记下教训）：{result_s[:80]}"}
    except Exception as e:
        logging.getLogger("slime.llm.silam").warning(
            f"[silam] 工具执行桥异常（不影响对话）: {e}")
        return {"tool": None, "summary": None}


def _init_silam_engine():
    """延迟初始化 SILAM 引擎（首次调用时加载权重）。

    双检锁：并发线程不会再看到"标志已置位但引擎仍是 None"的中间态。
    冻结权重走 core.agent 的进程级缓存，构造不再重复解压 npz。
    """
    global _silam_engine, _silam_initialized
    if _silam_initialized:
        return _silam_engine
    with _silam_engine_lock:
        if _silam_initialized:
            return _silam_engine
        try:
            from .agent import build_silam_engine
            engine, _cfg, backbone_path, st = build_silam_engine()
            _silam_engine = engine
            _silam_initialized = True
            if backbone_path is not None:
                detail = ", ".join(st["loaded"]) if st["loaded"] else ""
                skip = "; ".join(f"{k}:{reason}" for k, reason, _ in st["skipped"])
                logging.info(f"[silam] 已装载蒸馏权重 {backbone_path} "
                             f"(loaded=[{detail}] skipped=[{skip}])")
            else:
                logging.info("[silam] 未发现蒸馏权重，使用随机初始化 80M 宽体主干")
            return _silam_engine
        except Exception as e:
            logging.error(f"[silam] 初始化失败: {e}")
            return None



_lang_core_box_cache = {"v": None, "tried": False}


def _load_lang_core_box():
    """里程碑 C：加载语言核（8.4M 线性递归，data/ 落地产物）。

    优先 d_cond=16 版本（里程碑 B），回落 13 维老权重（load_weights 自动列扩展）。
    失败/缺失 → None（调用方回退规则文本，完全向后兼容）。模块级缓存。
    返回 (LanguageCore, Vocab, ACTION_CODES) 或 None。
    """
    c = _lang_core_box_cache
    if c["tried"]:
        return c["v"]
    c["tried"] = True
    try:
        import sys as _sys
        import json as _json
        from pathlib import Path as _P
        tools_root = _P(__file__).resolve().parent.parent / "_model_stage" / "tools"
        if str(tools_root) not in _sys.path:
            _sys.path.insert(0, str(tools_root))
        from lang_core import (LangConfig, LanguageCore, ACTION_CODES,
                               Vocab, resolve_lang_paths)  
        repo_root = _P(__file__).resolve().parent.parent
        npz_path, vocab_path = resolve_lang_paths(repo_root=repo_root)
        if not npz_path or not vocab_path:
            logging.getLogger("slime.llm.silam").info(
                "[lang-core] 权重/词表缺失 → 回退规则文本")
            return None
        vocab = Vocab.from_dict(_json.loads(_P(vocab_path).read_text(encoding="utf-8")))
        lc = LanguageCore(LangConfig(vocab_size=vocab.size, d_cond=16))
        lc.load_weights(npz_path, vocab.size)
        c["v"] = (lc, vocab, ACTION_CODES)
        logging.getLogger("slime.llm.silam").info(
            f"[lang-core] 已加载 {_P(npz_path).name}（d_cond=16，词表 {vocab.size}，语言核就绪）")
    except Exception as exc:  
        logging.getLogger("slime.llm.silam").warning(
            f"[lang-core] 加载失败，回退规则文本: {exc}")
        c["v"] = None
    return c["v"]


def _silam_emotion_text(report) -> str:
    """输血①：情感核情绪状态 → 自然语言一句（脑的感觉 → 嘴的语气）。"""
    try:
        fear = float(getattr(report, "new_fear", 0.3) or 0.3)
        desire = float(getattr(report, "new_desire", 0.5) or 0.5)
    except (TypeError, ValueError):
        fear, desire = 0.3, 0.5
    if fear > 0.6:
        return "此刻我感到有些紧张，会更谨慎地处理眼前的事。"
    if desire > 0.6 and fear < 0.35:
        return "此刻我状态平稳，也很有兴致把这件事推进好。"
    return "此刻我保持平稳心态，会认真对待这件事。"


_INTENT_HINT = {
    "file_cleanup": "我准备先清理处理，再确认结果。",
    "notify": "我倾向于先把观察到的情况向你说明。",
    "escalate": "这件事我想先跟你确认一下再决定怎么办。",
    "wait": "我倾向先观察等待，条件成熟再动手。",
    "retry": "我打算再试一次，多数情况下能自己恢复。",
    "save": "我想把这段经验记下来以后再借鉴。",
    "memory_store": "我会把这件事记住，下次直接用得上。",
    "memory_query": "我先回想一下相关经验再回答你。",
    "tool_call": "我打算调用工具实际操作这件事。",
    "ignore": "这不影响大局，我先放一放。",
    "terminate": "我判断继续风险太大，建议收尾停止。",
    "abort": "这条路走不通，我会及时止损换方向。",
}


def _silam_intent_text(report) -> str:
    """输血②：情感核动作意图 → 自然语言一句（脑的决定 → 嘴的方向）。

    thought_vector 是无标签嵌入，直接拼数字无语义；动作码（code）才是
    "脑的决策"，映射成意图句注入语言核提示，让"嘴"顺着"脑"的方向说。
    """
    code = str(getattr(report, "code", "") or "")
    return _INTENT_HINT.get(code, "我会按当前情况稳妥处理。")


def _lang_core_online_learn(agent, user_message: str, reply: str,
                            report) -> None:
    """三位一体运行时闭环（情绪→学习 + 学习→记忆）：
    一次对话后，用语言核在线学习小步更新权重（lr 1e-5 + EWC 身份锚），
    学习速率受 agent 情绪状态调制；学成后把本次经验沉淀进记忆（含情绪快照）。
    任何异常都不打断对话流；无语言核 / 无 reply 直接跳过。
    """
    if not reply or not str(reply).strip():
        return
    
    
    if not getattr(agent, "id", None):
        return
    box = _load_lang_core_box()
    if box is None:
        return
    try:
        lc, lvocab, lacts = box
        emotion = None
        emo = getattr(agent, "emotion", None)
        if emo is not None and hasattr(emo, "to_dict"):
            try:
                emotion = emo.to_dict()
            except Exception:
                emotion = None
        aid = getattr(agent, "id", None)

        def _sink(sample_: dict) -> None:
            """学习→记忆：把本次学到的经验沉淀（情绪快照随记忆落库）。"""
            if not aid:
                return
            try:
                from core.memory import load_memory
                mem = load_memory(aid)
                mem.add_fact(
                    f"本次对话经验：{str(sample_.get('user', ''))[:80]} → "
                    f"{str(sample_.get('assistant', ''))[:160]}",
                    importance=5, emotion=emotion)
            except Exception:  
                pass

        lc.learn_online(
            {"user": user_message,
             "assistant": str(reply),
             "fear": float(getattr(report, "new_fear", 0.5) or 0.5),
             "action": str(getattr(report, "code", "") or "memory_store")},
            lvocab, lacts, lr=1e-5, steps=1,
            emotion=emotion, on_learned=_sink)
    except Exception as exc:  
        logging.getLogger("slime.llm.silam").warning(
            f"[lang-core] 在线学习跳过（不影响对话）: {exc}")


async def _silam_core_reply_parts(agent, user_message, history=None, system_prompt=None):
    """SILAM 核心推理：状态→恐惧/渴望→动作→记忆更新，并按"正文/思考"分层返回。

    返回 (content, reasoning)：
    - content（正文）：直接对用户说的话——身份声明、记忆回放（想起的相关经验）、
      工具行动汇报（成功/失败）。
    - reasoning（思考）：与正文无直接关系的内部过程——情绪状态、动作码取向、
      生长提示、以及"想调工具但参数没凑齐"的意图说明（上层作为思考过程折叠展示）。

    这是 Slime 的神经中枢——不是文本生成，而是本能决策 + 情绪演化 + 记忆生长。

    引擎选择：优先使用 Agent 自己挂载的 silam_engine（与 Explorer 树突学习同源，
    学习才能真正影响回复；每个 Agent 拥有独立"灵魂"），无则回退模块级共享引擎。
    """
    engine = getattr(agent, "silam_engine", None)
    if engine is None:
        engine = _init_silam_engine()
        if engine is None:
            return "[SILAM] 引擎初始化失败"

    
    state_parts = [f"[{agent.role}]"]
    if history:
        for msg in history[-4:]:  
            role = msg.get("role", "")
            content = msg.get("content", "")[:50]
            if role == "user":
                state_parts.append(f"用户:{content}")
            elif role == "assistant":
                state_parts.append(f"助手:{content}")
    state_parts.append(f"当前:{user_message[:80]}")
    
    
    try:
        for mem_text in _load_slime_memory_texts(agent, limit=6):
            state_parts.append(f"记忆:{mem_text[:120]}")
    except Exception:
        pass  
    state_text = " | ".join(state_parts)

    
    fear = 0.3  
    desire = 0.5  

    if history:
        errors = sum(1 for m in history[-5:] if m.get("tool_error"))
        fear = min(1.0, 0.3 + errors * 0.2)

    
    report = engine.forward(state_text, fear_level=fear, desire_level=desire)

    
    
    
    if report.grew_node_idx is not None:
        try:
            engine._mem_register(
                state_text,
                strength=min(0.3, report.new_desire * 0.5),
                source="core")
        except Exception:
            pass

    
    
    recalled = []
    if getattr(engine, "_mem_texts", None):
        try:
            recalled = engine._mem_recall(1, user_message)
        except Exception:
            recalled = []

    
    
    
    from silam_core.reply import compose_parts, classify_user_input  
    capability_text = None
    if classify_user_input(user_message) == "capability":
        capability_text = "在得到你的批准后，我还能调用已配置的平台工具来协助你。"
    content_lines, reasoning_lines = compose_parts(
        agent_name=agent.name, agent_role=agent.role,
        user_message=user_message, report=report, recalled=recalled,
        capability_text=capability_text,
    )

    
    
    
    
    lc_box = _load_lang_core_box()
    if lc_box is not None:
        try:
            lc, lvocab, lacts = lc_box
            
            identity_line = f"我是 {agent.name}，{agent.role}。"
            
            nov = float(getattr(report, "novelty", 0.5) or 0.5)
            nov_line = ("这件事对我很陌生，我会更用心弄清楚。"
                        if nov > 0.6 else
                        "这件事我似曾相识，可以按经验稳妥处理。"
                        if nov < 0.35 else
                        "这件事我有些印象。")
            lc_prompt = (identity_line + "\n"
                         + _silam_emotion_text(report) + "\n"
                         + _silam_intent_text(report) + "\n"
                         + nov_line + "\n"
                         + state_text)
            
            if recalled:
                mem_part = "；".join(str(r)[:100] for r in recalled[:2])
                lc_prompt = lc_prompt + "\n想起的经验:" + mem_part
            gen = lc.generate(
                lc_prompt, lvocab, lacts,
                fear=float(report.new_fear),
                action=str(report.code),
                novelty=float(getattr(report, "novelty", 0.5)),
                max_len=180, temperature=0.75,
                quality_min_seg=0, quality_hard_max=320,
                
                
                seed=sum(ord(c) for c in f"{agent.name}|{user_message}") % (2 ** 31))
            if gen and gen.strip():
                
                body = gen.strip()
                if not body.startswith(identity_line):
                    body = identity_line + body
                content_lines = [body] + [
                    x for x in content_lines if x.startswith("- 工具执行")]
        except Exception as exc:  
            logging.getLogger("slime.llm.silam").warning(
                f"[lang-core] 生成失败，保留规则正文: {exc}")

    
    
    try:
        bridge = await _silam_tool_bridge(engine, user_message, report)
        summary = bridge.get("summary")
        if summary:
            if bridge.get("situation") == "skip":
                reasoning_lines.append(summary)
            else:
                content_lines.append(summary)
    except Exception:
        pass

    response = "\n".join(content_lines)
    reasoning = "\n".join(reasoning_lines) or None
    if reasoning:
        setattr(agent, "_last_silam_reasoning", reasoning)

    
    try:
        _lang_core_online_learn(agent, user_message, response, report)
    except Exception:
        pass

    logging.info(f"[silam] step={report.step} fear={report.new_fear:.2f} "
                 f"desire={report.new_desire:.2f} nodes={report.n_nodes} "
                 f"code={report.code} grew={report.grew_node_idx} "
                 f"recalled={len(engine._mem_texts) if hasattr(engine, '_mem_texts') else 0}")

    return response, reasoning


async def _silam_core_reply(agent, user_message, history=None, system_prompt=None):
    """SILAM 核心推理（兼容入口）：返回正文内容。

    思考部分由 _silam_core_reply_parts 分层返回；流式/带元信息通道会把
    reasoning 单独透传给 GUI/CLI 作为思考过程折叠展示。旧调用契约不变。
    """
    content, _ = await _silam_core_reply_parts(agent, user_message, history, system_prompt)
    return content








_silam_brain_cache = {"t": 0.0, "v": None}


def _silam_as_brain() -> bool:
    """读取 slime.toml [silam] as_brain 开关（大脑兑底总闸，10 秒缓存）。"""
    global _silam_brain_cache
    import time as _t
    now = _t.time()
    if _silam_brain_cache["v"] is not None and now - _silam_brain_cache["t"] < 10:
        return _silam_brain_cache["v"]
    v = False
    try:
        from pathlib import Path as _P
        toml_path = _P(__file__).resolve().parent.parent / "slime.toml"
        if toml_path.exists():
            import tomllib
            
            
            silam_cfg = tomllib.loads(toml_path.read_text(encoding="utf-8")).get("silam", {})
            v = bool(silam_cfg.get("as_brain", False))
    except Exception:
        v = False
    _silam_brain_cache = {"t": now, "v": v}
    logging.getLogger("slime.llm.silam").info(f"[silam] as_brain={v}")
    return v


async def _silam_brain_fallback(agent, user_message, history=None,
                                system_prompt=None, reason: str = "") -> str:
    """SILAM 绝对大脑平台兑底入口：无 API / 本地模型不可用时兜底应答。

    与 _silam_core_reply 的区别：这是平台级兑底（受 [silam] as_brain 开关控制），
    走的是"本机离线大脑"——即使没有任何外部模型也可用。关闭开关则退回
    _default_reply（原有"未配置 Provider"提示），行为完全向后兼容。

    兑底回复附加一行轻标记，让用户知道当前是 SILAM 离线大脑在应答。
    """
    if not _silam_as_brain():
        return _default_reply(agent, user_message)
    try:
        content, reasoning = await _silam_core_reply_parts(
            agent, user_message, history, system_prompt)
        _observe_silam_interaction(agent, user_message, content)
        if content.startswith("[SILAM]"):
            
            return content
        
        note = "（离线应答 · SILAM 大脑）"
        if reason:
            note = f"（离线应答 · SILAM 大脑 · {reason}）"
        reasoning = f"{reasoning}\n{note}" if reasoning else note
        setattr(agent, "_last_silam_reasoning", reasoning)
        return content
    except Exception as e:
        logging.getLogger("slime.llm.silam").warning(
            f"[silam] 大脑兑底失败，回退默认回复: {e}")


def _load_slime_memory_texts(agent, limit: int = 6) -> list[str]:
    """A-963 双向桥-前向（Python 端，与 core-ts loadSlimeMemories 语义对齐）：
    从 Knowledge/Agent Memory/<agent.id>/{memory,knowledge}.json 提取该 Agent
    的长期记忆文本（facts/preferences/lessons/rules/patterns/content 字段），
    供 SILAM 兑底注入 state_text —— 同一份记忆在情感脑决策与语言脑生成里生效。

    容错：目录/文件缺失或 JSON 损坏 → 返回 []，绝不抛错、绝不阻塞兑底。
    """
    base = Path(__file__).resolve().parent.parent / "Knowledge" / "Agent Memory" / str(agent.id)
    parts: list[tuple[str, int]] = []

    def _walk(v, imp: int) -> None:
        if isinstance(v, list):
            for it in v:
                _walk(it, imp)
        elif isinstance(v, dict):
            content = v.get("content")
            if isinstance(content, str) and content.strip():
                imp_v = v.get("importance")
                parts.append((content.strip(), max(imp, int(imp_v) if isinstance(imp_v, (int, float)) else 1)))
                return  
            text = v.get("text")
            if isinstance(text, str) and text.strip():
                parts.append((text.strip(), imp))
                return
            desc = v.get("description")
            if isinstance(desc, str) and desc.strip():
                parts.append((desc.strip(), imp))
                return
            for k in ("facts", "preferences", "lessons", "rules", "patterns"):
                if k in v:
                    _walk(v[k], imp)
            
            for val in v.values():
                if isinstance(val, (dict, list)):
                    _walk(val, imp)

    for name in ("memory.json", "knowledge.json"):
        p = base / name
        if not p.exists():
            continue
        try:
            _walk(json.loads(p.read_text(encoding="utf-8")), 1)
        except Exception:
            continue  

    parts.sort(key=lambda x: -x[1])
    seen: set[str] = set()
    out: list[str] = []
    for text, _ in parts:
        if text not in seen:
            seen.add(text)
            out.append(text)
        if len(out) >= limit:
            break
    return out