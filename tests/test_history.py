"""core.history 持久化测试（A-019：pop_last 换行收尾防 JSONL 拼接数据损坏）"""

import json
from unittest.mock import patch


class TestHistory:
    def test_append_and_load_roundtrip(self, tmp_path):
        from core import history
        with patch.object(history, "_HISTORY_PATH", tmp_path / "h.jsonl"):
            history.append("a1", "你好", "回复1")
            history.append("a1", "问题2", "回复2")
            records = history.load(agent_id="a1")
            assert len(records) == 2
            assert records[0]["user"] == "你好"
            assert records[1]["ai"] == "回复2"

    def test_pop_last_then_append_no_corruption(self, tmp_path):
        """A-019 回归：pop_last 后继续 append，行不拼接、记录不丢"""
        from core import history
        path = tmp_path / "h.jsonl"
        with patch.object(history, "_HISTORY_PATH", path):
            history.append("a1", "u1", "r1")
            history.append("a1", "u2", "r2")
            assert history.pop_last("a1") is True
            history.append("a1", "u3", "r3")  # 修复前：与 r1 拼成 "}{" 行 → 双双丢失
            records = history.load(agent_id="a1")
            assert [r["user"] for r in records] == ["u1", "u3"]
            # 文件每行都必须是合法 JSON（无拼接行）
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    json.loads(line)

    def test_pop_last_other_agent_noop(self, tmp_path):
        from core import history
        with patch.object(history, "_HISTORY_PATH", tmp_path / "h.jsonl"):
            history.append("a1", "u1", "r1")
            assert history.pop_last("a2") is False
            assert len(history.load()) == 1

    def test_rotate_keeps_recent_records(self, tmp_path):
        from core import history
        with patch.object(history, "_HISTORY_PATH", tmp_path / "h.jsonl"):
            with patch.object(history, "_MAX_HISTORY_BYTES", 10), \
                 patch.object(history, "_KEEP_RECORDS", 3):
                for i in range(6):
                    history.append("a1", f"u{i}", f"r{i}")
                records = history.load()
                assert [r["user"] for r in records] == ["u3", "u4", "u5"]

    def test_load_bad_lines_skipped(self, tmp_path):
        """损坏行跳过不中断整体加载"""
        from core import history
        path = tmp_path / "h.jsonl"
        path.write_text('{"agent_id":"a1","user":"ok"}\nNOT-JSON\n{"agent_id":"a1","user":"ok2"}\n',
                        encoding="utf-8")
        with patch.object(history, "_HISTORY_PATH", path):
            records = history.load(agent_id="a1")
            assert len(records) == 2
            assert records[0]["user"] == "ok"
            assert records[1]["user"] == "ok2"

    def test_remove_agent_only_its_records(self, tmp_path):
        """A-025: remove_agent 只删目标 Agent；后续 append 不拼接不丢"""
        from core import history
        path = tmp_path / "h.jsonl"
        with patch.object(history, "_HISTORY_PATH", path):
            history.append("a1", "u1", "r1")
            history.append("a2", "u2", "r2")
            history.append("a1", "u3", "r3")
            removed = history.remove_agent("a1")
            assert removed == 2
            records = history.load()
            assert len(records) == 1
            assert records[0]["agent_id"] == "a2"
            history.append("a2", "u4", "r4")  # 锁内读改写后的继续追加
            assert len(history.load()) == 2

    def test_remove_agent_preserves_bad_lines(self, tmp_path):
        from core import history
        path = tmp_path / "h.jsonl"
        path.write_text('{"agent_id":"a1","user":"x"}\nBAD-LINE\n{"agent_id":"a2","user":"y"}\n',
                        encoding="utf-8")
        with patch.object(history, "_HISTORY_PATH", path):
            removed = history.remove_agent("a1")
            assert removed == 1
            records = history.load()
            assert len(records) == 1
            assert records[0]["agent_id"] == "a2"
            assert "BAD-LINE" in path.read_text(encoding="utf-8")  # 坏行保留原文

    def test_remove_agent_nonexistent_file(self, tmp_path):
        from core import history
        with patch.object(history, "_HISTORY_PATH", tmp_path / "nope.jsonl"):
            assert history.remove_agent("a1") == 0


class TestMemoryRecallLazyInit:
    """A-027: recall 对未初始化 LanceDB 表的懒初始化（此前语义召回恒空）"""

    def test_recall_lazy_inits_table(self, tmp_path):
        from core import memory as mem
        from unittest.mock import patch
        store = mem.MemoryStore(agent_id="t1", lancedb_enabled=True, data_dir=str(tmp_path))
        assert store._lance_table is None  # 新 store 未初始化表
        with patch.object(store, "_init_lancedb") as m:
            r = store.recall("任意查询")
        m.assert_called_once()  # 懒初始化被触发
        assert r == []  # 表未真正初始化（mock），但路径正确返回空而非异常

    def test_recall_disabled_returns_empty_without_init(self, tmp_path):
        from core import memory as mem
        from unittest.mock import patch
        store = mem.MemoryStore(agent_id="t2", lancedb_enabled=False, data_dir=str(tmp_path))
        with patch.object(store, "_init_lancedb") as m:
            assert store.recall("q") == []
        m.assert_not_called()  # 未启用时不初始化
