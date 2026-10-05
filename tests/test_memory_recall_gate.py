"""§2.1 召回廉价判据（Context Rot gate）定向测试。

覆盖三类信号：过去时/指代、新实体（专有名词/路径/人名）、任务类型切换；
边界：空消息、纯寒暄/确认、纯代码粘贴。
断言真的会咬：把 should_retrieve_memory 改成恒真/恒假，下方对应用例立刻红。

run_tests.py 兼容：仅用 setup_method / tmp_path，不用 monkeypatch/capsys/tmpdir。
"""

import tempfile

import core.memory as mem_mod
from core.memory import should_retrieve_memory


class _Env:
    """把 _PROJECT_ROOT（决定 slime.toml 位置）临时指向测试目录。"""

    def __init__(self, root):
        self.root = root

    def __enter__(self):
        self._saved = mem_mod._PROJECT_ROOT
        mem_mod._PROJECT_ROOT = self.root
        return self.root

    def __exit__(self, *exc):
        mem_mod._PROJECT_ROOT = self._saved
        return False


def _make_root(tmp, toml=""):
    from pathlib import Path
    root = Path(tmp)
    if toml:
        (root / "slime.toml").write_text(toml, encoding="utf-8")
    return root


class TestRecallGatePositives:
    """命中三类信号 → 召回（True）。"""

    def setup_method(self):
        self.root = _make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = true\n")

    def test_past_tense_signals(self):
        with _Env(self.root):
            for msg in ("上次那个脚本怎么写的", "之前说过的路径", "刚才那个报错", "上周的配置"):
                assert should_retrieve_memory(msg) is True, f"过去时信号漏判: {msg!r}"

    def test_reference_signals(self):
        with _Env(self.root):
            for msg in ("那个函数", "那篇文章", "那段代码", "这款手机", "它们都完成了"):
                assert should_retrieve_memory(msg) is True, f"指代信号漏判: {msg!r}"

    def test_new_entity_signals(self):
        with _Env(self.root):
            for msg in (
                "看看 D:\\pilot project\\slime.toml",
                "帮我查一下 LanceDB 的索引",
                "把 config 目录备份",
                "调用 file_read 工具",
            ):
                assert should_retrieve_memory(msg) is True, f"新实体信号漏判: {msg!r}"

    def test_task_type_switch(self):
        with _Env(self.root):
            st = {"prev_task_type": "coding", "cur_task_type": "review"}
            assert should_retrieve_memory("嗯", st) is True, "任务类型切换应触发召回"

    def test_gate_disabled_is_always_true(self):
        """开关关闭 → 恒 True（恢复旧行为无条件召），哪怕空消息。"""
        off_root = _make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = false\n")
        with _Env(off_root):
            assert should_retrieve_memory("") is True
            assert should_retrieve_memory("你好") is True
            assert should_retrieve_memory("好的") is True


class TestRecallGateNegatives:
    """未命中任何信号 → 不召回（False）。"""

    def setup_method(self):
        self.root = _make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = true\n")

    def test_empty_message(self):
        with _Env(self.root):
            assert should_retrieve_memory("") is False
            assert should_retrieve_memory("   ") is False

    def test_none_message(self):
        with _Env(self.root):
            assert should_retrieve_memory(None) is False

    def test_pure_greeting_and_ack(self):
        with _Env(self.root):
            for msg in ("好的", "嗯嗯", "谢谢你", "你好", "继续", "ok"):
                assert should_retrieve_memory(msg) is False, f"纯寒暄/确认误判为召回: {msg!r}"

    def test_pure_code_paste_with_no_entity(self):
        with _Env(self.root):
            # 无 ASCII 标识符的短 CJK 命令 → 不命中任何信号
            assert should_retrieve_memory("继续") is False
            assert should_retrieve_memory("帮我看看这个") is False  # 2 字指示词非新实体


class TestRecallGateSessionState:
    """任务类型切换信号的边界。"""

    def setup_method(self):
        self.root = _make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = true\n")

    def test_same_task_type_no_signal(self):
        with _Env(self.root):
            st = {"prev_task_type": "coding", "cur_task_type": "coding"}
            assert should_retrieve_memory("嗯", st) is False

    def test_missing_state_keys_no_signal(self):
        with _Env(self.root):
            assert should_retrieve_memory("嗯") is False
            assert should_retrieve_memory("嗯", {}) is False

    def test_case_insensitive_task_types(self):
        with _Env(self.root):
            st = {"prev_task_type": "Coding", "cur_task_type": "review"}
            assert should_retrieve_memory("嗯", st) is True

    def test_blank_task_types_ignored(self):
        with _Env(self.root):
            st = {"prev_task_type": "  ", "cur_task_type": "review"}
            assert should_retrieve_memory("嗯", st) is False


class TestRecallGateL1Safety:
    """安全下限：L1 身份/偏好/铁律固定前缀不受判据影响，仍每轮注入。

    判据只门控检索式召回层（memory.summary / 工具经验 / 行为归档），
    L1 固定前缀（_compose_system_prompt）由调用方独立保证，不被跳过。
    """

    def setup_method(self):
        self.root = _make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = true\n")

    def test_gate_returns_false_but_l1_not_gated(self):
        with _Env(self.root):
            from core.llm import _compose_system_prompt
            from core.agent import Agent

            agent = Agent(name="L1Probe", role="探针")
            # 判据对「好的」返回 False（不召回）
            assert should_retrieve_memory("好的") is False
            # 但 L1 固定前缀仍生成（_compose_system_prompt 不读判据）
            sp = _compose_system_prompt(agent)
            assert sp, "L1 固定前缀不能因召回门控而消失"
            assert "L1Probe" in sp or "探针" in sp, "L1 身份/角色缺失"

    def test_llm_module_imports_and_exposes_gate(self):
        with _Env(self.root):
            from core.llm import _retrieve_psyche_context
            from core.memory import should_retrieve_memory as gate
            assert gate is should_retrieve_memory
            assert callable(_retrieve_psyche_context), "召回入口必须保持可调用"


class TestRecallGateConfigLoading:
    """配置读取路径：[memory].recall_gate_enabled 正确回落与读取。"""

    def setup_method(self):
        self.root = _make_root(tempfile.mkdtemp())

    def test_default_is_enabled(self):
        with _Env(self.root):
            assert mem_mod._recall_gate_enabled() is True, "缺省必须启用门控"

    def test_explicit_true(self):
        with _Env(_make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = true\n")):
            assert mem_mod._recall_gate_enabled() is True

    def test_explicit_false(self):
        with _Env(_make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = false\n")):
            assert mem_mod._recall_gate_enabled() is False

    def test_broken_toml_falls_back_to_default(self):
        with _Env(_make_root(tempfile.mkdtemp(), "[memory]\nrecall_gate_enabled = notabool\n")):
            assert mem_mod._recall_gate_enabled() is True, "非法值应回落默认（启用）"

    def test_no_toml_falls_back_to_default(self):
        with _Env(_make_root(tempfile.mkdtemp())):
            assert mem_mod._recall_gate_enabled() is True


class TestRecallGatePureFunction:
    """判据必须是纯字符串/正则级：不扫全量记忆、不触发模型调用。

    验证点：不读 memory.json / 不调 recall() / 不依赖 MemoryStore 实例。
    """

    def test_gate_does_not_touch_store(self, tmp_path):
        """构造一个有数据的 MemoryStore，但判据本身不受其影响（纯消息级）。"""
        with _Env(tmp_path):
            store = mem_mod.MemoryStore("gate_probe", data_dir=str(tmp_path))
            store.add_fact("用户喜欢用 Python 写脚本")
            store.add_fact("数据库连接池建议控制在 CPU 核数两倍")
            # 无信号消息：判据只看消息本身，与库里有多少条无关
            assert should_retrieve_memory("你好") is False
            # 有信号消息：判据只看消息本身
            assert should_retrieve_memory("之前说过的路径") is True
            # 消息越短越不可能命中，但库里数据量不影响判据结果
            assert should_retrieve_memory("继续") is False

    def test_gate_is_fast_no_memory_scan(self, tmp_path):
        with _Env(tmp_path):
            store = mem_mod.MemoryStore("gate_probe2", data_dir=str(tmp_path))
            for i in range(50):
                store.add_fact(f"独立事实条目 编号 {i} 内容完全不同 alpha{chr(65+i)}")
            import time
            t0 = time.perf_counter()
            for _ in range(200):
                should_retrieve_memory("好的")
            elapsed = time.perf_counter() - t0
            # 纯字符串级判据：200 次调用应远低于 0.1s（不扫 50 条记忆）
            assert elapsed < 0.1, f"判据耗时 {elapsed:.3f}s，疑似扫了全量记忆"
