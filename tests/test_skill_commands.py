# -*- coding: utf-8 -*-
"""A-094: 动态命令注册测试（技能/MCP → /<名> 斜杠命令）"""
import io
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, ".")


class TestDynamicCommands:
    """A-094: _register_dynamic_commands 注册技能/MCP 斜杠命令"""

    def _mk_skills(self, tmp_path, names):
        for n in names:
            d = tmp_path / n
            d.mkdir(parents=True, exist_ok=True)
            (d / "SKILL.md").write_text(f"# {n}\n", encoding="utf-8")
        return str(tmp_path)

    def _run(self, skills_dir, mcp_names=None):
        from slime_cli import _register_dynamic_commands
        handlers, specs, pending = {}, {}, []
        _register_dynamic_commands(handlers, specs, pending, skills_dir=skills_dir,
                                   mcp_names=mcp_names)
        return handlers, specs, pending

    def test_skill_registered(self, tmp_path):
        sd = self._mk_skills(tmp_path, ["ponytail", "banner-design"])
        handlers, specs, pending = self._run(sd)
        assert "/ponytail" in handlers and "/banner-design" in handlers
        assert specs["/ponytail"]["group"] == "技能"
        # 无参数 → 引导不注入 pending
        handlers["/ponytail"]("")
        assert pending == []
        # 有参数 → 包装消息注入 pending
        handlers["/ponytail"]("写一个读文件的小函数")
        assert "使用技能 ponytail 处理：写一个读文件的小函数" in pending[0]

    def test_mcp_registered(self, tmp_path):
        sd = self._mk_skills(tmp_path, ["x-skill"])
        handlers, specs, pending = self._run(sd, mcp_names=["browser", "context7"])
        assert "/browser" in handlers and "/context7" in handlers
        assert specs["/browser"]["group"] == "MCP"
        handlers["/context7"]("查 fastapi 用法")
        assert "使用 MCP 服务器 context7 的工具处理：查 fastapi 用法" in pending[0]

    def test_conflict_skipped(self, tmp_path):
        sd = self._mk_skills(tmp_path, ["skills", "think", "help", "my-custom-skill"])
        handlers, specs, pending = self._run(sd)
        # "help"/"skills"/"think" 是内置命令（_CMD_SPECS 冲突）→ 动态不注册、不覆盖
        for k in ("/help", "/skills", "/think"):
            assert k not in handlers, f"{k} 不应被动态注册"
        # 非冲突技能正常注册
        assert "/my-custom-skill" in handlers

    def test_no_skill_md_skipped(self, tmp_path):
        (tmp_path / "no-skill-md").mkdir()
        sd = self._mk_skills(tmp_path, ["real-skill"])
        handlers, specs, pending = self._run(sd)
        assert "/no-skill-md" not in handlers
        assert "/real-skill" in handlers

    def test_empty_sources(self, tmp_path):
        empty = tmp_path / "empty"
        empty.mkdir()
        handlers, specs, pending = self._run(str(empty), mcp_names=[])
        assert handlers == {} and specs == {}

    def test_mcp_from_real_toml_any_cwd(self, tmp_path):
        """A-095: MCP 命令从真实 slime.toml 注册（绝对路径锚定项目根，任意 cwd 生效）
        注意：run_tests.py 不注入 monkeypatch fixture——用 os.chdir + try/finally 恢复"""
        import os
        from slime_cli import _register_dynamic_commands
        empty = tmp_path / "no-skills"
        empty.mkdir()
        # 模拟项目外 cwd（无 slime.toml 的临时目录）
        old_cwd = os.getcwd()
        try:
            os.chdir(str(tmp_path))
            assert not (tmp_path / "slime.toml").exists()
            handlers, specs, pending = {}, {}, []
            _register_dynamic_commands(handlers, specs, pending, skills_dir=str(empty), mcp_names=None)
            # 真实 slime.toml（browser/context7）应被读到
            assert "/browser" in handlers and "/context7" in handlers, "项目外 cwd 也应注册 MCP 命令"
            assert specs["/browser"]["group"] == "MCP"
        finally:
            os.chdir(old_cwd)

    def test_pending_consumed_by_loop(self):
        """动态命令包装消息被主循环消费（模拟 dispatch 后 pending 注入）"""
        pending = ["使用技能 ponytail 处理：任务X"]
        user_input = pending.pop(0)
        assert user_input.startswith("使用技能")
        assert pending == []
