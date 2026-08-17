"""测试史莱姆渲染"""
from rich.console import Console
from rich.text import Text

console = Console()

SLIME_PIXEL_GRID = [
    # 椭圆主体(宽16×高7) + 右侧3只分裂小史莱姆（形成向右凸出的弧线）
    # 渐变：天蓝(a) → 青蓝(b) → 淡紫(c)，黑眼(e)，白眼珠(p)，微笑(m)
    # 小史莱姆弧线：小1(右上，4格)→小2(右中，6格最远)→小3(右下，4格) → 形成柔和右凸弧度
    "                                        ",  #  0
    "                                        ",  #  1
    "    aaaaaaaaaaaaaaaa    aa              ",  #  2 顶+小1(右上，4格间距)
    "    aaaeeeeaaaaaaeeaaa                  ",  #  3 眼
    "    aaaeppeaaaaaaeppeaaa      bbb       ",  #  4 珠+小2(右中，6格间距，弧度顶点)
    "    aaaaaaaammmmaaaaaa                  ",  #  5 嘴
    "    aaabbbbbbbbbbbbbba    aa            ",  #  6 过渡+小3(右下，4格间距)
    "    aaaccccbbbbbbcccca                  ",  #  7 渐变
    "    aaaaaaaaaaaaaaaaaa                  ",  #  8 底
    "                                        ",  #  9
]

SLIME_STYLE_MAP = {
    'a': "bold cyan",
    'b': "cyan",
    'c': "bright_blue",
    'e': "bright_black",
    'p': "white",
    'm': "bright_black",
    ' ': None,
}

for row in SLIME_PIXEL_GRID:
    text = Text()
    for ch in row:
        style = SLIME_STYLE_MAP.get(ch)
        if style is None:
            text.append(" ")
        else:
            text.append("░", style=style)
    console.print(text)


# ── A-015: Swarm 分析回复解析（显式降级标记） ─────────────────


class TestSwarmAnalysisParsing:
    """_parse_swarm_analysis：整体 JSON → 正则兜底 → 显式降级"""

    def test_valid_json_dict(self):
        from slime_server import _parse_swarm_analysis
        r = _parse_swarm_analysis('{"action": "swarm", "subtasks": ["查资料", "写文档"], "reason": "多类型任务"}')
        assert r["action"] == "swarm"
        assert r["subtasks"] == ["查资料", "写文档"]
        assert r["parse_ok"] is True

    def test_json_non_dict_fallback(self):
        """回复是合法 JSON 但不是 dict（list/str）→ 降级 chat 且 parse_ok=False（此前 500）"""
        from slime_server import _parse_swarm_analysis
        for bad in ('["chat"]', '"chat"', '123'):
            r = _parse_swarm_analysis(bad)
            assert r["action"] == "chat"
            assert r["parse_ok"] is False

    def test_regex_fallback_with_noise(self):
        """整体 JSON 失败 → 正则兜底（容忍前后杂讯）"""
        from slime_server import _parse_swarm_analysis
        reply = '分析结果如下：{"action": "fork", "subtasks": ["编译", "测试"]}，以上。'
        r = _parse_swarm_analysis(reply)
        assert r["action"] == "fork"
        assert r["subtasks"] == ["编译", "测试"]
        assert r["parse_ok"] is True

    def test_unparseable_degrades_explicitly(self):
        from slime_server import _parse_swarm_analysis
        r = _parse_swarm_analysis("抱歉，我无法分析。")
        assert r["action"] == "chat"
        assert r["subtasks"] == []
        assert r["parse_ok"] is False

    def test_invalid_action_normalized(self):
        from slime_server import _parse_swarm_analysis
        r = _parse_swarm_analysis('{"action": "teleport", "subtasks": ["a"]}')
        assert r["action"] == "chat"
        assert r["parse_ok"] is False

    def test_subtasks_sanitized_and_capped(self):
        """非列表 → 空；非字符串元素剔除；截断 8 条"""
        from slime_server import _parse_swarm_analysis
        r = _parse_swarm_analysis('{"action": "swarm", "subtasks": "不是列表"}')
        assert r["subtasks"] == []
        assert r["parse_ok"] is False
        many = ["t" + str(i) for i in range(12)]
        import json
        r2 = _parse_swarm_analysis(json.dumps({"action": "swarm", "subtasks": many + [123]}))
        assert len(r2["subtasks"]) == 8
        assert all(isinstance(s, str) for s in r2["subtasks"])
        assert r2["parse_ok"] is True

    def test_none_reply(self):
        from slime_server import _parse_swarm_analysis
        r = _parse_swarm_analysis(None)
        assert r["action"] == "chat"
        assert r["parse_ok"] is False
