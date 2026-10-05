"""召回路径必须与写入路径共用同一个 data_dir（core/llm.py 召回不再回落到生产目录）。

缺陷背景：`core/llm.py` 的 `_retrieve_archived_behavior` / `_retrieve_tool_experience`
各自又调了一次**不带 `data_dir`** 的 `load_memory(mem_owner_id)` —— 写入侧已支持显式
`data_dir`，召回侧却写死读默认（生产）目录，于是「写进隔离目录的条目永远召回不到」。

本文件**不重定向任何模块全局**（不碰 `_KNOWLEDGE_MEMORY_DIR` / `_PROJECT_ROOT`），
只靠显式 `data_dir` 参数定位目录，因此它咬的是生产代码本身，而不是测试夹具。

run_tests.py 兼容：只用 tmp_path，无 monkeypatch / capsys / tmpdir。
"""

import core.memory as mem_mod
from core.agent import Agent
from core.llm import (
    _retrieve_archived_behavior,
    _retrieve_psyche_context,
    _retrieve_tool_experience,
)
from core.memory import load_memory

_ARCHIVE_TEXT = "行为归档：场景「处理批量文件」的步骤 file_read file_write（现已不是习惯）"
_LESSON_TEXT = "用 web_search 处理 查询类请求成功"


def _prod_memory_file(agent_id: str):
    return mem_mod._KNOWLEDGE_MEMORY_DIR / agent_id / "memory.json"


class TestRecallDataDirMatchesWriteDir:
    """只传 data_dir：写入隔离目录 → 立即召回，必须命中同一个目录。"""

    def test_archived_behavior_recall_reads_data_dir(self, tmp_path):
        agent = Agent(name="RecallDirA", role="r")
        store = load_memory(agent.id, data_dir=str(tmp_path))
        store._store_categorized(
            "lesson", _ARCHIVE_TEXT,
            tags=["behavior_archive"], importance=6, extra={"success": True},
        )
        written = load_memory(agent.id, data_dir=str(tmp_path)).get_facts()
        assert any("处理批量文件" in (f.get("content") or "") for f in written), \
            "归档条目必须真的落进隔离目录，否则本用例是空转"
        before = {f["content"]: f.get("last_accessed") for f in written}

        r = _retrieve_archived_behavior(
            agent, "上次帮我处理批量文件", data_dir=str(tmp_path))

        assert "曾经的行为模式" in (r or ""), \
            f"召回未命中写入目录（data_dir 被丢弃，退回生产目录读了）：{r!r}"
        assert "处理批量文件" in (r or "")
        after = {f["content"]: f.get("last_accessed")
                 for f in load_memory(agent.id, data_dir=str(tmp_path)).get_facts()}
        assert after[_ARCHIVE_TEXT] != before[_ARCHIVE_TEXT], \
            "命中后的 last_accessed 刷新必须写回同一个 data_dir"
        assert not _prod_memory_file(agent.id).exists(), \
            "显式 data_dir 的召回落了生产目录，污染了默认记忆库"

    def test_tool_experience_recall_reads_data_dir(self, tmp_path):
        agent = Agent(name="RecallDirB", role="r")
        store = load_memory(agent.id, data_dir=str(tmp_path))
        store.add_lesson(_LESSON_TEXT, True, importance=4)
        written = load_memory(agent.id, data_dir=str(tmp_path)).get_lessons(limit=100)
        assert any("查询类请求" in (lv.get("content") or "") for lv in written), \
            "经验条目必须真的落进隔离目录，否则本用例是空转"

        r = _retrieve_tool_experience(
            agent, "帮我查询天气", data_dir=str(tmp_path))

        assert "工具经验" in (r or ""), \
            f"召回未命中写入目录（data_dir 被丢弃，退回生产目录读了）：{r!r}"
        assert "查询类请求" in (r or "")
        assert not _prod_memory_file(agent.id).exists(), \
            "显式 data_dir 的召回落了生产目录，污染了默认记忆库"

    def test_psyche_context_threads_data_dir_into_recall(self, tmp_path):
        """生产入口整链：_retrieve_psyche_context 解析出的目录必须一路透传到两个召回器。"""
        agent = Agent(name="RecallDirC", role="r")
        store = load_memory(agent.id, data_dir=str(tmp_path))
        store._store_categorized(
            "lesson", _ARCHIVE_TEXT,
            tags=["behavior_archive"], importance=6, extra={"success": True},
        )
        store.add_lesson(_LESSON_TEXT, True, importance=4)

        ctx = _retrieve_psyche_context(
            agent, "上次帮我处理批量文件并查询天气", data_dir=str(tmp_path))

        assert "曾经的行为模式" in (ctx or ""), \
            f"召回链未透传 data_dir：{ctx!r}"
        assert "工具经验" in (ctx or ""), \
            f"召回链未透传 data_dir：{ctx!r}"
        assert not _prod_memory_file(agent.id).exists(), \
            "显式 data_dir 的召回落了生产目录，污染了默认记忆库"

    def test_default_call_still_reads_production_dir(self, tmp_path):
        """不传 data_dir（生产绝大多数调用方）时行为不变：仍读默认记忆目录。"""
        agent = Agent(name="RecallDirD", role="r")
        load_memory(agent.id, data_dir=str(tmp_path))._store_categorized(
            "lesson", _ARCHIVE_TEXT,
            tags=["behavior_archive"], importance=6, extra={"success": True},
        )
        assert not _retrieve_archived_behavior(agent, "上次帮我处理批量文件"), \
            "未指定 data_dir 时必须读默认记忆目录（隔离目录里的条目不该被读到）"
