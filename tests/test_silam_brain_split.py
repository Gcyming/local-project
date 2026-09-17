"""SILAM 正文/思考分离（A-124）测试：_silam_core_reply_parts 返回 (content, reasoning)。

白盒验证分层逻辑（正文=对用户说的话；思考=内部过程），用假 forward 固定
情绪/动作码以保证确定性（真引擎 forward 的 new_fear 依赖内部随机衰减，
不能用于断言具体思考行）。工具执行桥在 setup 时关闭，排除干扰。

断言：
1. parts 返回二元组 (content, reasoning)
2. content 含身份声明（正文区）
3. 恐惧推高 → 情绪思考行进 reasoning 而非 content
4. 生长提示进 reasoning（与正文无关的元信息）
5. 兼容入口 _silam_core_reply 返回单字符串，等于 parts 的 content
6. reasoning 非空时回填 agent._last_silam_reasoning
"""
import asyncio
import sys
import time
from pathlib import Path
from types import SimpleNamespace

SILAM_ROOT = Path(__file__).resolve().parent.parent / "_model_stage"
if str(SILAM_ROOT) not in sys.path:
    sys.path.append(str(SILAM_ROOT))

from silam_core.config import SilamConfig  # noqa: E402
from silam_core.engine import SILAMEngine  # noqa: E402

from core import llm as llm_mod  # noqa: E402


def _fake_forward(state_text, fear_level=0.3, desire_level=0.5):
    """固定 StepReport：恐惧推高 + 生长触发，保证思考区必有内容。"""
    return SimpleNamespace(
        code="save",
        new_fear=fear_level,       # 测试方传入 0.8 → "此刻我有些紧张" 分支
        new_desire=desire_level,   # 0.6 → "我愿意投入精力" 分支
        n_nodes=6,
        max_nodes=50,
        grew_node_idx=3,           # 触发生长登记 + 生长提示
        step=1,
    )


def _mk_agent(name="测试员", role="AI 助手"):
    engine = SILAMEngine(cfg=SilamConfig())
    engine.forward = _fake_forward  # 实例属性覆盖方法：固定情绪/动作码
    engine._mem_register("辅导员的示范：先想清楚再动手", strength=0.5,
                         source="observe")
    return SimpleNamespace(name=name, role=role, silam_engine=engine)


class TestSilamBrainSplit:
    def setup_method(self):
        # 关闭工具执行桥（隔离：只验证正文/思考分层结构）
        llm_mod._bridge_cfg_cache = {"t": time.time(), "v": False}

    def test_returns_parts_pair(self):
        agent = _mk_agent()
        content, reasoning = asyncio.run(
            llm_mod._silam_core_reply_parts(agent, "你好"))
        assert isinstance(content, str) and content
        assert reasoning is None or isinstance(reasoning, str)
        # 正文与思考是分离的（不同内容）
        assert content != (reasoning or "")

    def test_content_has_identity_declaration(self):
        agent = _mk_agent(name="小蓝", role="探索型助手")
        content, _ = asyncio.run(
            llm_mod._silam_core_reply_parts(agent, "你好"))
        assert content.startswith("我是 小蓝，探索型助手。")

    def test_fear_reasoning_not_in_content(self):
        """恐惧/情绪思考只进思考区，不污染正文。"""
        agent = _mk_agent()
        content, reasoning = asyncio.run(
            llm_mod._silam_core_reply_parts(
                agent, "你好", [{"role": "user", "content": "报错了吗"},
                                {"role": "assistant", "content": "重试",
                                 "tool_error": True}]))
        assert reasoning, "恐惧推高 → 思考区必须有内容"
        assert "紧张" in reasoning or "谨慎" in reasoning
        # 情绪行绝不混进正文
        assert "紧张" not in content and "谨慎" not in content

    def test_growth_hint_goes_to_reasoning(self):
        """生长提示（元信息）进思考区，正文不包含。"""
        agent = _mk_agent()
        content, reasoning = asyncio.run(
            llm_mod._silam_core_reply_parts(agent, "你好"))
        assert reasoning, "grew_node_idx 触发 → 思考区有生长提示"
        assert "记下了一点新经验" in reasoning
        assert "记下了一点新经验" not in content

    def test_compat_entry_returns_string(self):
        agent = _mk_agent()
        reply = asyncio.run(llm_mod._silam_core_reply(agent, "你好"))
        assert isinstance(reply, str)
        content, _ = asyncio.run(
            llm_mod._silam_core_reply_parts(agent, "你好"))
        assert reply == content

    def test_last_silam_reasoning_attached(self):
        agent = _mk_agent()
        _, reasoning = asyncio.run(
            llm_mod._silam_core_reply_parts(agent, "你好"))
        assert reasoning
        assert getattr(agent, "_last_silam_reasoning", None) == reasoning