"""A-110 命令检索层测试：固化 _SlashCompleter / _SlashAutoSuggest / 匹配策略行为。

覆盖设计不变式 R1-R5：
  R1 任何 / 输入状态下候选集合非空（菜单永不静默消失）
  R2 Enter 应用候选不破坏已有参数（空格分支空文本、fuzzy 只替换命令词）
  R4 动态命令（技能/MCP 注入 _CMD_SPECS）自动纳入所有检索层
"""

import pytest
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import Completion
from prompt_toolkit.document import Document

import slime_cli


def _cands(text):
    """收集 get_completions 全部候选（模拟 prompt_toolkit 输入位置在末尾）"""
    doc = Document(text=text, cursor_position=len(text))
    return list(slime_cli._SlashCompleter().get_completions(doc, None))


def _cand_texts(text):
    return [c.text for c in _cands(text)]


@pytest.fixture
def dyn_command():
    """注入模拟技能命令（R4），用例后清理"""
    slime_cli._CMD_SPECS["/testskill"] = {
        "desc": "测试技能", "group": "技能", "usage": "/testskill <参数>",
    }
    yield "/testskill"
    del slime_cli._CMD_SPECS["/testskill"]


# ── R1：菜单永不消失 ─────────────────────────────

def test_empty_slash_lists_all():
    texts = _cand_texts("/")
    assert len(texts) == len(slime_cli._CMD_SPECS)
    assert "/help" in texts and "/provider" in texts


def test_exact_full_name_keeps_menu():
    """完整命令名：单候选无新增内容会被 prompt_toolkit 丢弃 → 必须补装饰候选"""
    cands = _cands("/provider")
    assert len(cands) >= 2
    assert cands[0].text == "/provider"
    assert cands[1].text == ""  # 装饰候选


def test_space_after_command_keeps_menu():
    cands = _cands("/provider ")
    assert len(cands) >= 2
    assert all(c.text == "" for c in cands)  # 装饰候选，Enter 无副作用（R2）


def test_typo_keeps_menu():
    cands = _cands("/prrovider")
    assert cands, "拼错必须仍有候选（fuzzy 兜底）"
    assert any(c.text == "/provider" for c in cands)


def test_typo_with_space_keeps_menu():
    cands = _cands("/prrovider ")
    assert any(c.text.startswith("/provider") for c in cands)


# ── 前缀 / fuzzy 匹配 ────────────────────────────

def test_prefix_match():
    texts = _cand_texts("/prov")
    assert texts == ["/provider"]


def test_fuzzy_help_typo():
    cands = _cands("/hlep")
    assert any(c.text == "/help" for c in cands)


def test_plain_text_no_completions():
    assert _cand_texts("hello world") == []


# ── R2：候选不破坏输入 ───────────────────────────

def test_typo_space_fix_preserves_args():
    """拼错+空格：修正候选整行替换（start_position=-len(text)），参数拼入候选文本，
    应用后 = 修正命令 + 原参数（A-110 修正 A-109 的 start_position 错位 bug）"""
    doc = Document(text="/prrovider 生图", cursor_position=len("/prrovider 生图"))
    cands = list(slime_cli._SlashCompleter().get_completions(doc, None))
    fix = next(c for c in cands if c.text.startswith("/provider"))
    replaced = doc.text_before_cursor[len(doc.text_before_cursor) + fix.start_position:]
    assert replaced == "/prrovider 生图"  # 替换全部输入
    assert fix.text == "/provider 生图"    # 应用后 = 修正命令 + 参数保留


# ── R4：动态命令纳入检索层 ───────────────────────

def test_dynamic_command_in_completion(dyn_command):
    texts = _cand_texts("/tes")
    assert "/testskill" in texts


def test_dynamic_command_in_suggest(dyn_command):
    """动态命令参与幽灵建议（唯一前缀匹配）"""
    doc = Document(text="/test", cursor_position=len("/test"))
    buf = Buffer(completer=slime_cli._SlashCompleter())
    sug = slime_cli._SlashAutoSuggest(AutoSuggestFromHistory()).get_suggestion(buf, doc)
    assert sug is not None
    assert sug.text == "skill"


# ── 幽灵建议（AutoSuggest）───────────────────────

def test_suggest_unique_prefix():
    doc = Document(text="/prov", cursor_position=len("/prov"))
    buf = Buffer(completer=slime_cli._SlashCompleter())
    sug = slime_cli._SlashAutoSuggest(AutoSuggestFromHistory()).get_suggestion(buf, doc)
    assert sug is not None and sug.text == "ider"


def test_suggest_none_when_ambiguous():
    doc = Document(text="/p", cursor_position=len("/p"))
    buf = Buffer(completer=slime_cli._SlashCompleter())
    sug = slime_cli._SlashAutoSuggest(AutoSuggestFromHistory()).get_suggestion(buf, doc)
    assert sug is None  # 多候选不幽灵


def test_suggest_none_when_exact():
    doc = Document(text="/provider", cursor_position=len("/provider"))
    buf = Buffer(completer=slime_cli._SlashCompleter())
    sug = slime_cli._SlashAutoSuggest(AutoSuggestFromHistory()).get_suggestion(buf, doc)
    assert sug is None


def test_suggest_none_on_bare_slash():
    doc = Document(text="/", cursor_position=1)
    buf = Buffer(completer=slime_cli._SlashCompleter())
    sug = slime_cli._SlashAutoSuggest(AutoSuggestFromHistory()).get_suggestion(buf, doc)
    assert sug is None


def test_suggest_history_fallback(tmp_path):
    """普通文本：回退历史前缀匹配（Hermes 同款 AutoSuggestFromHistory）"""
    from prompt_toolkit.history import FileHistory
    hist = FileHistory(str(tmp_path / "hist"))
    hist.append_string("show me the status")
    buf = Buffer(completer=slime_cli._SlashCompleter(), history=hist)
    doc = Document(text="sh", cursor_position=len("sh"))
    sug = slime_cli._SlashAutoSuggest(AutoSuggestFromHistory()).get_suggestion(buf, doc)
    assert sug is not None
    assert sug.text.startswith("ow")


def test_suggest_ignores_space_after_cmd():
    """命令后空格：不参与命令幽灵（参数区），回退历史"""
    doc = Document(text="/provider ", cursor_position=len("/provider "))
    buf = Buffer(completer=slime_cli._SlashCompleter())
    sug = slime_cli._SlashAutoSuggest(AutoSuggestFromHistory()).get_suggestion(buf, doc)
    assert sug is None or not sug.text.startswith("provider")


# ── A-111：艾宾浩斯遗忘曲线联动排序 ──────────────────

def _mk_usage_file(tmp_path, records):
    """构造使用记录文件：records = [(cmd, 距今秒数, 次数)]"""
    import json as _json
    import time as _time
    p = tmp_path / "usage.jsonl"
    now = _time.time()
    lines = []
    for cmd, age, count in records:
        for _ in range(count):
            lines.append(_json.dumps({"cmd": cmd, "ts": now - age}))
    p.write_text("\n".join(lines), encoding="utf-8")
    return p


def test_usage_rank_high_frequency_first(tmp_path):
    """高频命令优先（同前缀 /m：memory 用 5 次 > model 1 次）"""
    f = _mk_usage_file(tmp_path, [("/memory", 1000, 5), ("/model", 1000, 1)])
    scores = slime_cli._usage_scores(f)
    assert scores["/memory"] > scores["/model"]
    matched = slime_cli._rank_by_usage(slime_cli._match_prefix("m"), scores)
    assert [c for c, _ in matched if c.startswith("/m")][0] == "/memory"


def test_usage_rank_decay_old_usage(tmp_path):
    """艾宾浩斯衰减：20 天前 10 次 < 今天 1 次（exp(-20/5)≈0.018）"""
    f = _mk_usage_file(tmp_path, [("/review", 20 * 86400, 10), ("/talk", 60, 1)])
    scores = slime_cli._usage_scores(f)
    assert scores["/talk"] > scores["/review"]


def test_usage_rank_no_data_fallback_order():
    """无使用记录：稳定排序保持声明序（降级行为）"""
    matched = slime_cli._rank_by_usage(slime_cli._match_prefix("m"), {})
    names = [c for c, _ in matched]
    assert names == [c for c, _ in slime_cli._match_prefix("m")]


def test_usage_rank_empty_items():
    assert slime_cli._rank_by_usage([], {}) == []


def test_record_usage_appends(tmp_path):
    """记录器：追加一行 {cmd, ts}"""
    f = tmp_path / "usage.jsonl"
    slime_cli._record_usage("/memory", file=f)
    slime_cli._record_usage("/memory", file=f)
    lines = f.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    scores = slime_cli._usage_scores(f)
    assert "/memory" in scores


def test_completer_uses_usage_ranking(tmp_path):
    """补全器整体接入：注入使用记录后 /m 前缀 memory 排最前（模块变量覆盖，兼容 run_tests）"""
    f = _mk_usage_file(tmp_path, [("/memory", 500, 5)])
    old = slime_cli._USAGE_FILE_OVERRIDE
    slime_cli._USAGE_FILE_OVERRIDE = f
    try:
        texts = _cand_texts("/m")
        assert texts[0] == "/memory"
    finally:
        slime_cli._USAGE_FILE_OVERRIDE = old