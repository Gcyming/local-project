"""技能引擎测试（A-004：精简工具面 skill_search/skill_lookup）

对齐 run_tests.py 发现规则：仅 Test* 类 / test_* 方法 / tmp_path 参数。
每个用例 finally 恢复全局注册表（技能 + 工具），避免污染后续测试。
"""
import asyncio
import json


class TestSkillRegistry:
    """SkillRegistry 加载与检索"""

    def _cleanup(self):
        from core.skill_engine import reset_registry as reset_skill
        from tools.registry import reset_registry as reset_tool
        from tools.builtin import register_builtin_tools
        reset_skill()
        reset_tool()
        register_builtin_tools()

    def _make_skill(self, tmp_path, name, description, tags=None, body="# 指导\n\n1. 读代码 2. 给建议"):
        d = tmp_path / name
        d.mkdir()
        manifest = {
            "name": name,
            "version": "1.0",
            "description": description,
            "permissions": {"read": True},
            "tags": tags or [],
        }
        (d / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        (d / "SKILL.md").write_text(body, encoding="utf-8")
        return d

    def test_load_and_search(self, tmp_path):
        """加载两个技能：关键词检索命中、名称优先级、无匹配返回空"""
        try:
            self._make_skill(tmp_path, "demo_code_review", "审查代码质量并给出建议", tags=["code"])
            self._make_skill(tmp_path, "amazon_scraper", "抓取亚马逊商品数据", tags=["amazon"])
            from core.skill_engine import get_registry, reset_registry
            reset_registry()
            reg = get_registry()
            reg.skill_dir = tmp_path
            loaded = reg.load_skills()
            assert len(loaded) == 2

            hits = reg.search("审查")
            names = [h["name"] for h in hits]
            assert "demo_code_review" in names

            # 名称命中权重高于描述命中：amazon 同时是 scraper 的名称与 tag
            hits2 = reg.search("amazon")
            assert hits2[0]["name"] == "amazon_scraper"

            assert reg.search("不存在的关键词xyz") == []

            # 空查询列出全部（截断上限）
            all_hits = reg.search("", limit=1)
            assert len(all_hits) == 1
        finally:
            self._cleanup()

    def test_load_all_skills_registers_compact_tools(self, tmp_path):
        """load_all_skills 只注册 skill_search/skill_lookup，不注册 skill_<name>"""
        try:
            self._make_skill(tmp_path, "demo_code_review", "审查代码质量")
            from core.skill_engine import load_all_skills, reset_registry as reset_skill
            from tools.registry import get_registry as get_tool_registry, reset_registry as reset_tool
            reset_skill()
            reset_tool()

            loaded = load_all_skills(skill_dir=tmp_path)
            assert "demo_code_review" in loaded

            names = get_tool_registry().list_tool_names()
            assert "skill_search" in names
            assert "skill_lookup" in names
            assert "skill_demo_code_review" not in names  # A-004 核心断言
        finally:
            self._cleanup()

    def test_search_and_lookup_roundtrip(self, tmp_path):
        """工具闭环：skill_search → skill_lookup 返回 SKILL.md 正文；缺参报错"""
        try:
            self._make_skill(tmp_path, "demo_code_review", "审查代码质量")
            from core.skill_engine import load_all_skills, reset_registry as reset_skill
            from tools.registry import get_registry as get_tool_registry, reset_registry as reset_tool
            reset_skill()
            reset_tool()
            load_all_skills(skill_dir=tmp_path)

            reg = get_tool_registry()
            result = asyncio.run(reg.call_tool("skill_search", {"query": "代码"}))
            assert "demo_code_review" in result

            result2 = asyncio.run(reg.call_tool("skill_lookup", {"name": "demo_code_review"}))
            assert "读代码" in result2

            result3 = asyncio.run(reg.call_tool("skill_lookup", {}))
            assert "错误" in result3

            # 未加载技能名 → 报错不崩溃
            result4 = asyncio.run(reg.call_tool("skill_lookup", {"name": "nope"}))
            assert "未找到" in result4
        finally:
            self._cleanup()

    def test_hot_reload_idempotent(self, tmp_path):
        """热更新（重复 load_all_skills）不产生重复/报错，工具数稳定"""
        try:
            self._make_skill(tmp_path, "demo_code_review", "审查代码质量")
            from core.skill_engine import load_all_skills, reset_registry as reset_skill
            from tools.registry import get_registry as get_tool_registry, reset_registry as reset_tool
            reset_skill()
            reset_tool()

            load_all_skills(skill_dir=tmp_path)
            n1 = len(get_tool_registry().list_tool_names())
            load_all_skills(skill_dir=tmp_path)  # 模拟 /skills/load 热更新
            n2 = len(get_tool_registry().list_tool_names())
            assert n1 == n2
        finally:
            self._cleanup()

    def test_lookup_network_skill_returns_guidance(self, tmp_path):
        """A-038: 指导模式（无 execute_fn）不受 manifest 执行权限拦截——network 技能可读指导"""
        try:
            self._make_skill(tmp_path, "net_skill", "网络技能", tags=None)
            manifest = json.loads((tmp_path / "net_skill" / "manifest.json").read_text(encoding="utf-8"))
            manifest["permissions"] = {"read": True, "network": True}
            (tmp_path / "net_skill" / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

            from core.skill_engine import load_all_skills, reset_registry as reset_skill
            from tools.registry import get_registry as get_tool_registry, reset_registry as reset_tool
            reset_skill()
            reset_tool()
            load_all_skills(skill_dir=tmp_path)

            r = asyncio.run(get_tool_registry().call_tool("skill_lookup", {"name": "net_skill"}))
            assert "读代码" in r          # SKILL.md 正文正常返回
            assert "权限不足" not in r     # 不再被 network 权限拦截
        finally:
            self._cleanup()

    def test_empty_skill_dir_degrades_gracefully(self, tmp_path):
        """A-029 预验证：空技能目录（用户清空压测资产后的终态）系统保持健康"""
        try:
            from core.skill_engine import load_all_skills, reset_registry as reset_skill
            from tools.registry import get_registry as get_tool_registry, reset_registry as reset_tool
            reset_skill()
            reset_tool()

            loaded = load_all_skills(skill_dir=tmp_path)  # 空目录
            assert loaded == []
            names = get_tool_registry().list_tool_names()
            assert "skill_search" in names and "skill_lookup" in names

            r = asyncio.run(get_tool_registry().call_tool("skill_search", {"query": "任何词"}))
            assert "未找到" in r  # 空注册表友好提示

            # system prompt 在空技能集下不崩溃、不注入技能段（工具能力清单里出现
            # "检索可用技能"字样是 skill_search 工具描述，属正确行为，只断言段标题）
            from core.agent import Agent
            a = Agent(name="Slime", role="测试")
            prompt = a.get_system_prompt()
            assert "\n## 可用技能\n" not in prompt
        finally:
            self._cleanup()


class TestFrontmatterOnlySkill:
    """A-096: SKILL.md frontmatter-only 技能（无 manifest）零适配加载"""

    def _mk(self, tmp_path, name="ponytail", frontmatter=None, body=None):
        d = tmp_path / name
        d.mkdir(parents=True, exist_ok=True)
        if body is None:
            body = ("指导正文段落。" + chr(10)) * 400  # ~2800 字符（>2000 验证不截断）
        fm = frontmatter or (
            "---" + chr(10) + "name: ponytail" + chr(10) + "description: Forces the laziest solution that actually works" + chr(10)
            + "tags: [minimal, lazy]" + chr(10) + "---" + chr(10)
        )
        (d / "SKILL.md").write_text(fm + body, encoding="utf-8")
        return d

    def test_frontmatter_only_loaded(self, tmp_path):
        from core.skill_engine import SkillRegistry
        reg = SkillRegistry()
        s = reg._load_single_skill(self._mk(tmp_path))
        assert s is not None, "无 manifest 的技能应加载"
        assert s.name == "ponytail"
        assert "laziest solution" in (s.description or "")

    def test_frontmatter_name_defaults_to_dir(self, tmp_path):
        from core.skill_engine import SkillRegistry
        reg = SkillRegistry()
        fm = "---" + chr(10) + "description: some skill" + chr(10) + "---" + chr(10) + "# Body" + chr(10)
        d = self._mk(tmp_path, name="my-skill", frontmatter=fm)
        s = reg._load_single_skill(d)
        assert s is not None and s.name == "my-skill"

    def test_body_not_truncated_over_2000(self, tmp_path):
        from core.skill_engine import SkillRegistry
        reg = SkillRegistry()
        s = reg._load_single_skill(self._mk(tmp_path))
        assert s is not None
        assert len(s.body) > 2000, "指导正文不应被 2000 截断（A-096 上限 12000）"
        assert "指导正文段落。" in s.body[-200:]
