
"""Python 侧上下文压缩 / 系统提示前缀缓存 的等价性回归（D9 + D10）。

D9：Python 侧压缩与 GUI 侧不等价——按条数触发、非 turn 对齐、head+摘要会造出
    连续同角色（Anthropic 系直接 400）；且每轮重跑压缩 ⇒ 每轮多发一次摘要请求。
D10：易变的情绪状态 / 行为模式 / 技能清单塞在 system（第 0 条消息）末段，
    任一变化都作废整段前缀缓存。
"""
import asyncio
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from core.agent import Agent
from core.behavior import BehaviorStore
from core.emotion import EmotionalState
from core.context import (
    ContextCompressor,
    align_roles,
    compress_history,
    count_turns,
    estimate_history_tokens,
    reset_summary_memo,
    trim_turn_aligned,
)
from core.llm import _compose_prompt_segments, call_api_provider


def _alternating(n, start=0):
    return [{"role": "user" if i % 2 == 0 else "assistant",
             "content": f"m{i}-{'user' if i % 2 == 0 else 'assistant'}"}
            for i in range(start, start + n)]


def _same_role_runs(messages):
    out = []
    prev = None
    for m in messages:
        role = m.get("role")
        if role == "system":
            prev = None
            continue
        if role == prev:
            out.append(role)
        prev = role
    return out


def _run(coro):
    return asyncio.run(coro)


async def _fake_summary(prompt):
    return "摘要:" + prompt[:20]


def _agent(**kw):
    base = dict(name="T", role="t", model_choice="api:x", max_context=4096)
    base.update(kw)
    a = Agent(**base)
    a.emotion = EmotionalState()
    a.behavior = BehaviorStore()
    return a


def _cfg():
    return {"api_base": "https://example.invalid/v1", "api_key": "k", "model": "m"}


class _FakeResp:
    def raise_for_status(self):
        pass

    def json(self):
        return {"choices": [{"message": {"content": "ok"}}]}


class _PayloadProbe:
    """抓 call_api_provider 实际发出的 payload（不发网络请求）。"""

    def __init__(self):
        self.payloads = []

    def __enter__(self):
        self._stack = ExitStack()
        self._stack.enter_context(
            patch("core.llm._inject_psyche",
                  side_effect=lambda a, m, h, memory_agent_id=None: m))
        self._stack.enter_context(
            patch("core.llm._filter_tools_schema", return_value=[]))

        async def _post(url, headers=None, json=None):
            self.payloads.append(json)
            return _FakeResp()

        client = MagicMock()
        client.post = _post
        self._stack.enter_context(patch("core.llm._get_shared_client", return_value=client))
        return self

    def __exit__(self, *a):
        self._stack.__exit__(*a)

    def system_texts(self):
        return [p["messages"][0]["content"] for p in self.payloads]


class TestNoConsecutiveSameRole:
    """D9 连续同角色：除 system 外不允许出现相邻同角色（Anthropic 400 的直接成因）。"""

    def setup_method(self):
        reset_summary_memo()

    def test_async_compress_output_has_no_same_role_run(self):
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="nr-async")
        out = _run(c.compress_async(_alternating(40), summary_fn=_fake_summary))
        assert _same_role_runs(out) == []
        assert out[0]["role"] == "user"
        assert len(out) < 40

    def test_sync_compress_output_has_no_same_role_run(self):
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30})
        out = c.compress(_alternating(40))
        assert _same_role_runs(out) == []
        assert out[0]["role"] == "user"

    def test_convenience_helper_output_has_no_same_role_run(self):
        out = compress_history(_alternating(64), {"head": 3, "tail": 10, "window": 30})
        assert _same_role_runs(out) == []

    def test_summary_lands_as_a_complete_turn_pair(self):
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="nr-pair")
        out = _run(c.compress_async(_alternating(40), summary_fn=_fake_summary))
        idx = next(i for i, m in enumerate(out) if "上下文压缩" in m["content"])
        assert out[idx]["role"] == "user"
        assert out[idx + 1]["role"] == "assistant"
        assert out[idx - 1]["role"] == "assistant"

    def test_odd_history_length_still_alternates(self):
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="nr-odd")
        for n in (31, 33, 40, 41, 57, 64):
            out = _run(c.compress_async(_alternating(n), summary_fn=_fake_summary))
            assert _same_role_runs(out) == [], f"n={n} 出现连续同角色"

    def test_align_roles_merges_instead_of_dropping(self):
        merged = align_roles([{"role": "user", "content": "甲"},
                              {"role": "user", "content": "乙"},
                              {"role": "assistant", "content": "丙"}])
        assert [m["role"] for m in merged] == ["user", "assistant"]
        assert merged[0]["content"] == "甲\n\n乙"

    def test_align_roles_strips_embedded_system(self):
        out = align_roles([{"role": "assistant", "content": "x"},
                           {"role": "system", "content": "y"},
                           {"role": "user", "content": "z"}])
        assert [m["role"] for m in out] == ["user"]
        assert out[0]["content"] == "z"


class TestTurnAlignment:
    """D9 turn 对齐：head 收尾到 assistant，tail 起始到 user（对齐 core-ts trimTurnAligned）。"""

    def test_trim_turn_aligned_starts_at_user_and_respects_keep(self):
        hist = _alternating(21)
        out = trim_turn_aligned(hist, 10)
        assert out[0]["role"] == "user"
        assert len(out) <= 10
        assert out == hist[12:]

    def test_trim_turn_aligned_keeps_whole_history_when_short(self):
        hist = _alternating(4)
        assert trim_turn_aligned(hist, 10) == hist

    def test_count_turns_counts_user_messages(self):
        assert count_turns(_alternating(10)) == 5

    def test_compressed_head_ends_on_assistant(self):
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="ta-head")
        out = _run(c.compress_async(_alternating(40), summary_fn=_fake_summary))
        head_end = next(i for i, m in enumerate(out) if "上下文压缩" in m["content"])
        assert out[head_end - 1]["role"] == "assistant"


class TestCompressionTrigger:
    """D9 触发口径：补 token 口径（对齐 GUI needsCompress），条数口径保留。"""

    def test_token_budget_fires_before_message_window(self):
        fat = [{"role": "user" if i % 2 == 0 else "assistant", "content": "很长的中文内容" * 200}
               for i in range(20)]
        assert len(fat) <= 30
        assert estimate_history_tokens(fat) > 2000
        with_budget = ContextCompressor({}, token_budget=2000, owner_id="tg-a")
        without = ContextCompressor({}, owner_id="tg-b")
        assert with_budget.needs_compression(fat) is True
        assert without.needs_compression(fat) is False

    def test_count_window_still_fires_without_token_budget(self):
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="tg-c")
        assert c.needs_compression(_alternating(31)) is True
        assert c.needs_compression(_alternating(30)) is False

    def test_no_trigger_when_nothing_can_be_dropped(self):
        c = ContextCompressor({"head": 3, "tail": 10, "window": 1},
                              token_budget=1, owner_id="tg-d")
        assert c.needs_compression(_alternating(8)) is False

    def test_token_ratio_is_clamped_to_gui_range(self):
        fat = [{"role": "user" if i % 2 == 0 else "assistant", "content": "内容" * 10}
               for i in range(14)]
        assert 500 <= estimate_history_tokens(fat) < 970
        hot = ContextCompressor({"token_ratio": 0.99}, token_budget=1000, owner_id="tg-e")
        cold = ContextCompressor({"token_ratio": 0.05}, token_budget=1000, owner_id="tg-f")
        assert hot.effective_token_ratio() == 0.97
        assert cold.effective_token_ratio() == 0.5
        assert hot.needs_compression(fat) is False
        assert cold.needs_compression(fat) is True

    def test_broken_token_ratio_falls_back_to_default(self):
        c = ContextCompressor({"token_ratio": "不是数字"}, token_budget=1000, owner_id="tg-g")
        assert c.effective_token_ratio() == 0.85


class TestNoMessageDuplication:
    """head + tail 之和超过历史长度时，旧实现会把同一条消息拼两遍。"""

    def test_short_history_is_not_duplicated(self):
        hist = _alternating(8)
        c = ContextCompressor({"head": 3, "tail": 10, "window": 1},
                              token_budget=1, owner_id="dup-a")
        out = c.compress(hist)
        bodies = [m["content"] for m in out]
        assert len(bodies) == len(set(bodies))

    def test_normal_history_keeps_both_ends_without_overlap(self):
        hist = _alternating(40)
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="dup-b")
        out = _run(c.compress_async(hist, summary_fn=_fake_summary))
        bodies = [m["content"] for m in out]
        assert len(bodies) == len(set(bodies))
        assert "m0-user" in bodies
        assert "m39-assistant" in bodies


class TestSummaryMemo:
    """D9 成本缺陷：同一段历史不该每轮重发摘要请求。"""

    def setup_method(self):
        reset_summary_memo()

    def test_unchanged_middle_is_not_resummarized(self):
        calls = []

        async def summary_fn(prompt):
            calls.append(prompt)
            return f"摘要{len(calls)}"

        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="memo-a")
        hist = _alternating(40)
        first = _run(c.compress_async(hist, summary_fn=summary_fn))
        second = _run(c.compress_async(hist, summary_fn=summary_fn))
        assert len(calls) == 1
        assert [m["content"] for m in first] == [m["content"] for m in second]

    def test_growth_only_resummarizes_the_new_turns(self):
        calls = []

        async def summary_fn(prompt):
            calls.append(prompt)
            return f"增量{len(calls)}"

        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="memo-b")
        _run(c.compress_async(_alternating(40), summary_fn=summary_fn))
        assert len(calls) == 1
        first_prompt = calls[0]
        assert "m6-user" in first_prompt

        out = _run(c.compress_async(_alternating(42), summary_fn=summary_fn))
        assert len(calls) == 2
        second_prompt = calls[1]
        assert "增量1" in second_prompt
        assert "m6-user" not in second_prompt
        assert len(second_prompt) < len(first_prompt)

        summary_text = next(m["content"] for m in out if "上下文压缩" in m["content"])
        assert "增量1" in summary_text
        assert "增量2" in summary_text

    def test_unrelated_history_is_fully_resummarized(self):
        calls = []

        async def summary_fn(prompt):
            calls.append(prompt)
            return f"摘要{len(calls)}"

        c = ContextCompressor({"head": 3, "tail": 10, "window": 30}, owner_id="memo-c")
        _run(c.compress_async(_alternating(40), summary_fn=summary_fn))
        other = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"other{i}"}
                 for i in range(40)]
        _run(c.compress_async(other, summary_fn=summary_fn))
        assert len(calls) == 2
        assert calls[0] != calls[1]
        assert "m6-user" in calls[0]
        assert "m6-user" not in calls[1]
        assert "other6" in calls[1]

    def test_memo_is_scoped_per_owner(self):
        calls = []

        async def summary_fn(prompt):
            calls.append(prompt)
            return "摘要"

        hist = _alternating(40)
        _run(ContextCompressor({"head": 3, "tail": 10, "window": 30},
                               owner_id="memo-x").compress_async(hist, summary_fn=summary_fn))
        _run(ContextCompressor({"head": 3, "tail": 10, "window": 30},
                               owner_id="memo-y").compress_async(hist, summary_fn=summary_fn))
        assert len(calls) == 2

    def test_without_owner_id_each_call_is_summarized(self):
        calls = []

        async def summary_fn(prompt):
            calls.append(prompt)
            return "摘要"

        c = ContextCompressor({"head": 3, "tail": 10, "window": 30})
        hist = _alternating(40)
        _run(c.compress_async(hist, summary_fn=summary_fn))
        _run(c.compress_async(hist, summary_fn=summary_fn))
        assert len(calls) == 2


class TestStableSystemPrefix:
    """D10：易变内容搬离 system 第 0 条消息后，稳定前缀必须逐字节不变。"""

    def test_stable_prefix_unchanged_after_emotion_updates(self):
        a = _agent()
        stable_before, volatile_before = a.get_system_prompt_segments()
        full_before = a.get_system_prompt()
        for _ in range(4):
            a.emotion.update(success=False, failure_type="task")
        stable_after, volatile_after = a.get_system_prompt_segments()

        assert stable_after.encode("utf-8") == stable_before.encode("utf-8")
        assert volatile_after != volatile_before
        assert a.get_system_prompt() != full_before

    def test_stable_prefix_unchanged_when_skill_list_changes(self):
        class _FakeSkills:
            def __init__(self, descs):
                self._descs = descs
                self.is_loaded = True

            def load_skills(self):
                pass

            def list_skill_descriptions(self):
                return list(self._descs)

        a = _agent()
        with patch("core.skill_engine.get_registry", return_value=_FakeSkills(["技能甲"])):
            stable_a, volatile_a = a.get_system_prompt_segments()
        with patch("core.skill_engine.get_registry",
                   return_value=_FakeSkills(["技能甲", "技能乙"])):
            stable_b, volatile_b = a.get_system_prompt_segments()

        assert stable_b.encode("utf-8") == stable_a.encode("utf-8")
        assert "技能甲" not in stable_a
        assert "技能甲" in volatile_a
        assert "技能乙" in volatile_b

    def test_stable_prefix_unchanged_when_behavior_archive_hits(self):
        a = _agent()
        for _ in range(6):
            a.behavior.reinforce("排障", ["读日志", "改配置"], rationale="先读后改")
        stable_a, volatile_a = a.get_system_prompt_segments()
        assert "排障" in volatile_a
        assert "排障" not in stable_a

        a.behavior.reconsolidate("排障", ["读日志", "改配置", "回归"], archived_confidence=1.0)
        for _ in range(6):
            a.behavior.reinforce("写文档", ["读代码", "补文档"], rationale="文档先行")
        stable_b, volatile_b = a.get_system_prompt_segments()

        assert stable_b.encode("utf-8") == stable_a.encode("utf-8")
        assert "写文档" in volatile_b
        assert "写文档" not in volatile_a
        assert "回归" in volatile_b

    def test_caution_hint_moves_out_of_stable_prefix(self):
        a = _agent()
        a.emotion.mood = "angry"
        stable, volatile = _compose_prompt_segments(a)
        assert "行为承诺" not in stable
        assert "行为承诺" in volatile
        neutral = _agent()
        n_stable, n_volatile = _compose_prompt_segments(neutral)
        assert "行为承诺" not in n_volatile

    def test_custom_base_prompt_is_not_split(self):
        a = _agent()
        stable, volatile = _compose_prompt_segments(a, "自定义 system")
        assert stable == "自定义 system"
        assert volatile == ""

    def test_segments_still_carry_every_injected_segment(self):
        a = _agent()
        a.persona.preferences = ["喜欢简洁"]
        stable, volatile = a.get_system_prompt_segments()
        joined = stable + volatile
        for marker in ("身份铁律", "诚实与验证铁律", "偏好", "当前状态"):
            assert marker in joined, marker


class TestRequestPrefixStability:
    """D10 端到端：真实请求里 system（第 0 条）逐字节稳定，易变段落在末段 user。"""

    def test_system_message_bytes_stable_across_turns(self):
        agent = _agent()
        hist = [{"role": "user", "content": "第一轮"},
                {"role": "assistant", "content": "第一轮回答"}]
        with _PayloadProbe() as probe:
            _run(call_api_provider(_cfg(), agent, "问题一", hist))
            agent.emotion.update(success=False, failure_type="task")
            agent.emotion.update(success=True, praise=True)
            _run(call_api_provider(_cfg(), agent, "问题二", hist))

        first_sys, second_sys = probe.system_texts()
        assert second_sys.encode("utf-8") == first_sys.encode("utf-8")
        assert "当前状态" not in second_sys
        assert "当前状态" in probe.payloads[1]["messages"][-1]["content"]
        assert "身份铁律" in second_sys

    def test_system_message_stable_across_skill_directory_change(self):
        class _FakeSkills:
            def __init__(self, descs):
                self._descs = descs
                self.is_loaded = True

            def load_skills(self):
                pass

            def list_skill_descriptions(self):
                return list(self._descs)

        agent = _agent()
        hist = [{"role": "user", "content": "第一轮"},
                {"role": "assistant", "content": "第一轮回答"}]
        with _PayloadProbe() as probe:
            with patch("core.skill_engine.get_registry", return_value=_FakeSkills(["技能甲"])):
                _run(call_api_provider(_cfg(), agent, "问题一", hist))
            with patch("core.skill_engine.get_registry",
                       return_value=_FakeSkills(["技能甲", "技能乙"])):
                _run(call_api_provider(_cfg(), agent, "问题二", hist))

        first_sys, second_sys = probe.system_texts()
        assert second_sys.encode("utf-8") == first_sys.encode("utf-8")
        assert "技能甲" in probe.payloads[0]["messages"][-1]["content"]
        assert "技能乙" in probe.payloads[1]["messages"][-1]["content"]
        assert "技能甲" not in second_sys

    def test_state_segment_lands_after_psyche_and_before_user_text(self):
        from core.llm import _inject_state_segment
        text = _inject_state_segment("用户原文", "## 当前状态\nx")
        assert text.startswith("## 当前状态\nx")
        assert text.endswith("用户原文")

    def test_empty_state_segment_is_a_noop(self):
        from core.llm import _inject_state_segment
        assert _inject_state_segment("用户原文", "") == "用户原文"
