"""silam_core.reply 单元测试（A-125）：输入分类 / 回声过滤 / 正文与思考分层。

纯函数级测试，不启动引擎、不动注册表——对 run_tests.py / pytest 均可直跑
（不用 pytest 专属 fixture）。

断言契约（措辞与 test_silam_brain_split.py 逐字一致，改措辞必须同步两边）：
1. classify_user_input：问候 / 能力提问 / 一般 三类边界
2. is_echo_recall：带「当前:/用户:/助手:」前缀的状态拼接文本必为回声；
   与用户输入特征重叠 ≥0.45 的高重复文本也判回声
3. compose_parts：
   - 正文首行为身份声明
   - 恐惧 >0.6 进思考区（"此刻我有些紧张（恐惧 x.xx）…"），不进正文
   - 动作码有对应解释进思考区（"接下来：…"）
   - 生长提示进思考区（"这次交流我记下了一点新经验（记忆 x/y）。"）
   - 回声记忆不回显，有意义往事出现在正文"我记得："
   - offline_note 进思考区
"""
import sys
from pathlib import Path
from types import SimpleNamespace

SILAM_ROOT = Path(__file__).resolve().parent.parent / "_model_stage"
if str(SILAM_ROOT) not in sys.path:
    sys.path.append(str(SILAM_ROOT))

from silam_core.reply import (  # noqa: E402
    classify_user_input,
    compose_parts,
    is_echo_recall,
    text_overlap,
)


def _report(code="save", fear=0.3, desire=0.5, grew=None, n=6, m=50):
    return SimpleNamespace(
        code=code, new_fear=fear, new_desire=desire,
        grew_node_idx=grew, n_nodes=n, max_nodes=m)


class TestClassifyUserInput:
    def test_greeting(self):
        for t in ("你好", "您好，在吗", "hello", "早上好呀"):
            assert classify_user_input(t) == "greeting", t

    def test_capability(self):
        for t in ("你会干些什么？", "你能做什么", "会编码吗", "你有什么本领",
                  "都能干什么"):
            assert classify_user_input(t) == "capability", t

    def test_general(self):
        for t in ("今天天气怎么样", "帮我看看这个报错", "", "1+1=?"):
            assert classify_user_input(t) == "general", t

    def test_greeting_beats_capability_order(self):
        # "你好，你会什么" 先命中问候（规则顺序：问候在前）
        assert classify_user_input("你好，你会什么？") == "greeting"


class TestIsEchoRecall:
    def test_state_text_prefix_is_echo(self):
        assert is_echo_recall("[test] | 当前:你好", "你好") is True
        assert is_echo_recall("旧账 | 用户:帮我翻译", "帮我翻译") is True
        assert is_echo_recall("A | 助手:没问题", "没问题") is True

    def test_high_overlap_is_echo(self):
        assert is_echo_recall("用户刚刚问我：你会编码吗", "你会编码吗") is True

    def test_meaningful_memory_not_echo(self):
        assert is_echo_recall("辅导员的示范：遇到报错先读取日志文件",
                              "你会编码吗") is False

    def test_empty_not_echo(self):
        assert is_echo_recall("", "hi") is False


class TestTextOverlap:
    def test_bounds(self):
        assert text_overlap("ab", "cd") < 0.45
        assert text_overlap("你好世界", "你好世界") >= 0.99


class TestComposeParts:
    def test_identity_first_line(self):
        content, reasoning = compose_parts(
            agent_name="小蓝", agent_role="探索型助手",
            user_message="hello", report=_report())
        assert content[0] == "我是 小蓝，探索型助手。"

    def test_greeting_payload(self):
        content, _ = compose_parts(
            agent_name="a", agent_role="r", user_message="你好",
            report=_report())
        assert any("我在线" in c for c in content)

    def test_capability_with_capability_text(self):
        content, _ = compose_parts(
            agent_name="a", agent_role="r", user_message="你会什么",
            report=_report(), capability_text="我能调用平台工具。")
        joined = "\n".join(content)
        assert "我能调用平台工具" in joined

    def test_fear_goes_to_reasoning_only(self):
        content, reasoning = compose_parts(
            agent_name="a", agent_role="r", user_message="hi",
            report=_report(fear=0.85))
        cr = "\n".join(content)
        rr = "\n".join(reasoning)
        assert "此刻我有些紧张" in rr
        assert "紧张" not in cr and "恐惧" not in cr

    def test_action_code_explanation(self):
        _, reasoning = compose_parts(
            agent_name="a", agent_role="r", user_message="hi",
            report=_report(code="tool_call"))
        assert any("接下来：我将调用工具" in r for r in reasoning)

    def test_growth_prompt(self):
        _, reasoning = compose_parts(
            agent_name="a", agent_role="r", user_message="hi",
            report=_report(grew=3, n=7, m=50))
        assert any("记下了一点新经验" in r for r in reasoning)

    def test_echo_memory_filtered(self):
        content, _ = compose_parts(
            agent_name="a", agent_role="r", user_message="你好",
            report=_report(),
            recalled=["[test] | 当前:你好",
                      "辅导员的示范：先想清楚再动手"])
        joined = "\n".join(content)
        assert "当前:你好" not in joined
        assert "我记得：辅导员的示范" in joined

    def test_offline_note_to_reasoning(self):
        _, reasoning = compose_parts(
            agent_name="a", agent_role="r", user_message="hi",
            report=_report(), offline_note="（离线应答 · SILAM 大脑）")
        assert "（离线应答 · SILAM 大脑）" in reasoning

    def test_emotion_zero_no_noise(self):
        _, reasoning = compose_parts(
            agent_name="a", agent_role="r", user_message="hi",
            report=_report(fear=0.1, desire=0.2))
        assert not any("紧张" in r or "谨慎" in r for r in reasoning)