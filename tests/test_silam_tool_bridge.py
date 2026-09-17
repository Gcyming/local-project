"""SILAM 工具执行桥（A-123）测试：观战记忆驱动选工具 → 真调用 → 学习回路。

覆盖 4 条路径：
1. 成功：记忆提过工具名 → 选中、真调、登记"调用成功"学习记忆
2. 失败：工具返回错误 → 疼痛学习路径触发、登记 tool_fail 教训
3. 护栏：write/terminal 权限工具不被自动执行（SILAM 还没学够不开车）
4. 缺参：必需参数提不全 → 不执行、不编造参数，登记 tool_skip

注入假工具用唯一命名（silam_*），不 reset_registry
（保 conftest 兜底的内置工具在场），teardown 注销。
"""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

SILAM_ROOT = Path(__file__).resolve().parent.parent / "_model_stage"
if str(SILAM_ROOT) not in sys.path:
    sys.path.append(str(SILAM_ROOT))

from tools.registry import Tool, get_registry  # noqa: E402

from silam_core.config import SilamConfig  # noqa: E402
from silam_core.engine import SILAMEngine  # noqa: E402

from core import llm as llm_mod  # noqa: E402


def _mk_tool(name, desc, execute_fn, permissions=("read",),
             props=None, required=("path",)):
    """构造带调用计数的假工具。"""
    state = {"calls": 0}

    async def _fn(args):
        state["calls"] += 1
        return execute_fn(args)

    tool = Tool(
        name=name,
        description=desc,
        parameters={
            "type": "object",
            "properties": props or {"path": {"type": "string"}},
            "required": list(required),
        },
        execute_fn=_fn,
        permissions=list(permissions),
    )
    return tool, state


def _report(code="tool_call"):
    return SimpleNamespace(code=code)


class TestSilamToolBridge:
    _TOOL_NAMES = ("silam_echo_r", "silam_boom_r",
                   "silam_write_guard", "silam_need_both")

    def _clear_tools(self):
        """幂等清理：无论上一轮 teardown 是否执行，都保证无残留。"""
        for n in self._TOOL_NAMES:
            try:
                self.reg.unregister(n)
            except Exception:
                pass

    def setup_method(self):
        self.reg = get_registry()
        # 先清理（run_tests 下断言失败可能跳过 teardown → 残留 → 覆盖拒绝）
        self._clear_tools()
        # 1) 只读“读文件”假工具（会被选中）
        self.echo, self.echo_state = _mk_tool(
            "silam_echo_r",
            "读取本地文件内容的事实性工具。",
            lambda args: f"读到内容：{dict(args)}")
        self.reg.register(self.echo)
        # 2) 只读但执行必报错（失败学习路径）
        self.boom, self.boom_state = _mk_tool(
            "silam_boom_r",
            "读取目标文件存在性的事实性工具。",
            lambda args: "[错误] 目标文件不存在")
        self.reg.register(self.boom)
        # 3) write 权限（护栏必须挡住）
        self.guard, self.guard_state = _mk_tool(
            "silam_write_guard",
            "把内容写入文件的事实性工具。",
            lambda args: "已写入", permissions=("write",))
        self.reg.register(self.guard)
        # 4) 双必需参数（缺参 → 不执行）
        self.need_both, self.need_state = _mk_tool(
            "silam_need_both",
            "需要两个事实参数的认知工具。",
            lambda args: "双参工具 OK",
            props={"alpha": {"type": "string"},
                   "beta": {"type": "string"}},
            required=("alpha", "beta"))

        self.reg.register(self.need_both)
        self.engine = SILAMEngine(cfg=SilamConfig())
        self.engine._mem_register(
            "辅导员的示范：读文件要用 silam_echo_r",
            strength=0.5, source="observe")
        # 复位开关缓存，保证读取真实 slime.toml 配置
        llm_mod._bridge_cfg_cache = {"t": 0.0, "v": None}

    def teardown_method(self):
        self._clear_tools()

    def test_success_path(self):
        """观战记忆提到工具名 → 选中并真调 → 成功学习记忆登记。"""
        res = asyncio.run(llm_mod._silam_tool_bridge(
            self.engine, "读取一下 data/note.txt 的内容", _report()))
        assert res["tool"] == "silam_echo_r", f"应选中 silam_echo_r，实得 {res}"
        assert "成功" in res["summary"]
        assert self.echo_state["calls"] == 1
        tips = [m for m in self.engine._mem_texts if m.get("source") == "tool"]
        assert tips and "silam_echo_r" in tips[-1]["text"], "应登记调用成功学习记忆"

    def test_failure_path(self):
        """工具报错 → 疼痛学习路径 + tool_fail 教训记忆。"""
        self.engine._mem_register(
            "辅导员的示范：silam_boom_r 曾经失败过", strength=0.5,
            source="observe")
        res = asyncio.run(llm_mod._silam_tool_bridge(
            self.engine, "用 silam_boom_r 读取一下 missing.txt", _report()))
        assert res["tool"] == "silam_boom_r", f"应选中 silam_boom_r，实得 {res}"
        assert "失败" in res["summary"]
        assert self.boom_state["calls"] == 1
        tips = [m for m in self.engine._mem_texts if m.get("source") == "tool_fail"]
        assert tips and "silam_boom_r" in tips[-1]["text"], "应登记失败教训记忆"

    def test_write_guard(self):
        """write 权限工具：护栏拦截，绝不自动执行。"""
        self.engine._mem_register(
            "辅导员的示范：写文件要用 silam_write_guard", strength=0.5,
            source="observe")
        res = asyncio.run(llm_mod._silam_tool_bridge(
            self.engine, "把 result.txt 的内容写进文件", _report()))
        assert res["tool"] != "silam_write_guard", \
            f"write 工具不应被自动执行，实得 {res}"
        assert self.guard_state["calls"] == 0

    def test_missing_args_not_invented(self):
        """必需参数凑不齐 → 不执行不编造，登记 tool_skip。"""
        self.engine._mem_register(
            "辅导员的示范：复杂任务要用 silam_need_both", strength=0.5,
            source="observe")
        res = asyncio.run(llm_mod._silam_tool_bridge(
            self.engine, "帮我用 silam_need_both 处理一下", _report()))
        assert res["tool"] == "silam_need_both", f"应盯上 need_both，实得 {res}"
        assert "先不冒进" in res["summary"] or "凑不齐" in res["summary"]
        assert self.need_state["calls"] == 0, "缺参时绝不能真调用"
        tips = [m for m in self.engine._mem_texts if m.get("source") == "tool_skip"]
        assert tips, "应登记 tool_skip 记忆"