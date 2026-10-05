"""`core/memory_global.py` 的隔离缺口与 `rebuild()` 零守卫（本次修复的回归测试）。

背景：`.global/index.json` 是**这台机器上共享的一份文件**，而 `memory_global.py`
此前通篇没有隔离概念 —— `get_global_index` 只按 resolved base_dir 做 key，
`check`/`upsert`/`lookup`/`recall`/`stats`/`rebuild` 全部没有隔离参数，
唯一的开关在调用方（`core/memory.py` 的 `_global_index()`），
即「做写入的模块完全没有护栏，护栏全在外面」。`rebuild()` 更是零守卫：
扫全 base_dir 并**整体重写**索引，扫错目录会把一份好索引静默覆盖成空。

本文件咬的是**生产代码本身**，不重定向任何模块全局：
只用 `tmp_path` + 显式构造 `GlobalMemoryIndex` / `get_global_index`。

run_tests.py 兼容：只用 `setup_method` / `tmp_path`，无 monkeypatch / capsys / tmpdir。
"""

import json
import os
import shutil
from pathlib import Path

import core.memory_global as mg
from core.memory_global import (
    GlobalMemoryIndex,
    get_global_index,
    is_isolated,
    isolation_state,
    reset_isolation,
)

_FACT_A = "跨语言全局去重索引必须共用同一份记忆真相源 alpha"
_FACT_B = "本机全局索引里已经存在、隔离场景不允许被它去重掉的一条事实 beta"
_FACT_C = "回退路径本来就会跨 agent 去重、隔离态必须挡住它的一条事实 gamma"


def _seed_agent(root: Path, agent_id: str, content: str, category: str = "fact") -> None:
    """在 root 下造一个 agent 的 memory.json（真相源，不是索引）。"""
    d = root / agent_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "memory.json").write_text(
        json.dumps({"facts": [{"id": "m1", "content": content, "category": category,
                               "importance": 5, "timestamp": "2026-01-01T00:00:00+00:00"}]},
                   ensure_ascii=False),
        encoding="utf-8",
    )


class _Isolated:
    """进程级隔离开闩的上下文（测试夹具用；生产是 `SLIME_MEMORY_ISOLATED` / 标记文件）。"""

    def __init__(self, reason: str = "test"):
        self.reason = reason

    def __enter__(self):
        mg.set_isolation(True, self.reason)
        return self

    def __exit__(self, *exc):
        reset_isolation()
        mg._instances.clear()
        return False


class _EnvIsolated:
    """环境变量隔离（子进程 / 评测运行用；这是**外部**信号，闩锁顶不掉它）。"""

    def __init__(self, value: str = "1"):
        self.value = value

    def __enter__(self):
        self._saved = os.environ.get(mg.ISOLATION_ENV_VAR)
        os.environ[mg.ISOLATION_ENV_VAR] = self.value
        return self

    def __exit__(self, *exc):
        if self._saved is None:
            os.environ.pop(mg.ISOLATION_ENV_VAR, None)
        else:
            os.environ[mg.ISOLATION_ENV_VAR] = self._saved
        return False


class TestIsolationIsModuleOwned:
    """隔离必须是**模块自身的保证**，不是调用方自觉。"""

    def setup_method(self, method=None):
        import tempfile
        self.root = Path(tempfile.mkdtemp())
        mg._instances.clear()

    def test_isolated_instance_never_touches_disk(self, tmp_path):
        """隔离态下：upsert/check/lookup/recall/stats/rebuild 全部不落一个字节。

        这是本任务的核心断言 —— 目录里**连 `.global/` 都不该被建出来**。
        去掉任何一个入口的隔离闸门，`exists()` 立刻变 True。
        """
        root = Path(tmp_path)
        with _Isolated():
            idx = GlobalMemoryIndex(root)
            assert idx.isolated, "闩锁合上了，实例必须自报隔离"
            idx.upsert(_FACT_A, "iso_agent", "m1")
            assert idx.check(_FACT_A) is None
            assert idx.lookup(_FACT_A) is None
            assert idx.recall(_FACT_A, top_k=5) == []
            assert idx.note_retired(_FACT_A, "iso_agent") is None
            st = idx.stats()
            assert st["entries"] == 0 and st["isolated"] is True
            rb = idx.rebuild()
            assert rb["rebuilt"] is False and rb["refused"] == "isolated"
        assert not (root / ".global").exists(), \
            "隔离态下创建了 .global/ —— 隔离目录里不该有任何全局索引产物"
        assert list(root.iterdir()) == [], f"隔离态下写出了文件：{list(root.iterdir())}"

    def test_isolated_instance_does_not_read_existing_index(self, tmp_path):
        """隔离态连**读**都不许：盘上有一份好索引也不能被隔离实例看见。"""
        root = Path(tmp_path)
        _seed_agent(root, "iso_read_a", _FACT_A)
        live = get_global_index(root)
        live.upsert(_FACT_A, "iso_read_a", "m1")
        assert live.lookup(_FACT_A) is not None, "前置条件：非隔离时索引必须可读"

        with _Isolated():
            assert get_global_index(root) is None, "隔离时仍交出了索引对象"
            # 绕过工厂函数直接构造（审计脚本 / 运维工具会这么干）也必须被同一道门挡住
            bypassed = GlobalMemoryIndex(root)
            assert bypassed.isolated is True
            assert bypassed.lookup(_FACT_A) is None, "隔离实例读到了共享索引的内容"
            assert bypassed.recall(_FACT_A, top_k=5) == []
        assert get_global_index(root).lookup(_FACT_A) is not None, "解除隔离后必须立刻可读"

    def test_get_global_index_returns_none_when_isolated(self, tmp_path):
        """`get_global_index()` 在隔离根目录返回 None —— 调用方**拿不到**索引对象。"""
        root = Path(tmp_path)
        with _Isolated():
            assert get_global_index(root) is None
        with _EnvIsolated():
            assert get_global_index(root) is None
        assert get_global_index(root) is not None, "解除隔离后必须立刻拿回索引"

    def test_marker_file_isolates_a_single_root(self, tmp_path):
        """目录标记文件 `.memory-isolated`：只隔离这个根，不影响别的根。"""
        marked = Path(tmp_path) / "marked"
        plain = Path(tmp_path) / "plain"
        marked.mkdir()
        plain.mkdir()
        _seed_agent(marked, "mk_a", _FACT_A)
        _seed_agent(plain, "pl_a", _FACT_A)
        (marked / mg.ISOLATION_MARKER_NAME).write_text("isolated\n", encoding="utf-8")

        assert is_isolated(marked) is True
        assert is_isolated(plain) is False, "标记文件不得越界隔离别的记忆根"
        assert isolation_state(marked)["reason"] == f"marker:{mg.ISOLATION_MARKER_NAME}"
        assert get_global_index(marked) is None
        assert get_global_index(plain) is not None

    def test_latch_cannot_be_overridden_by_caller(self, tmp_path):
        """闩锁只能加严不能放宽：进程内调用方无法靠传参把隔离顶回「不隔离」。"""
        root = Path(tmp_path)
        with _Isolated("latched"):
            explicit_off = get_global_index(root, isolated=False)
            assert explicit_off is None, "调用方用 isolated=False 绕过了闩锁"
            assert isolation_state(root)["reason"] == "latched"
        assert get_global_index(root) is not None

    def test_isolation_is_off_by_default(self, tmp_path):
        """生产默认：任何信号都没有 → 不隔离，跨 agent 去重照常全速跑。"""
        root = Path(tmp_path)
        assert is_isolated(root) is False
        _seed_agent(root, "prod_a", _FACT_A)
        _seed_agent(root, "prod_b", _FACT_A)
        idx = get_global_index(root, ttl_s=0.001)
        hit = idx.check(_FACT_A, exclude_agent="prod_b")
        assert hit is not None and hit["agent"] == "prod_a", \
            "默认不隔离时跨 agent 去重必须仍然生效（本次修复不得削弱生产特性）"
        assert (root / ".global" / "index.json").exists()


class TestRebuildGuards:
    """`rebuild()` 是唯一会**整体重写**索引的入口，必须有守卫。"""

    def setup_method(self, method=None):
        import tempfile
        mg._instances.clear()
        self.root = Path(tempfile.mkdtemp())

    @staticmethod
    def _index_path(root: Path) -> Path:
        return root / ".global" / "index.json"

    def test_isolated_rebuild_is_refused(self, tmp_path):
        root = Path(tmp_path)
        with _Isolated():
            out = GlobalMemoryIndex(root).rebuild()
        assert out["rebuilt"] is False
        assert out["refused"] == "isolated"
        assert not (root / ".global").exists(), "被拒绝的 rebuild 仍然落了盘"

    def test_missing_base_dir_is_refused_and_creates_nothing(self, tmp_path):
        """base_dir 不存在（拼错/没建）→ 拒绝，**不许** mkdir 出一棵假的记忆根。"""
        missing = Path(tmp_path) / "typo" / "not-exist"
        out = GlobalMemoryIndex(missing).rebuild()
        assert out["rebuilt"] is False, "对不存在的目录重建成功了"
        assert out["refused"] == "base-dir-missing"
        assert not missing.exists(), "rebuild 把拼错的路径建了出来"

    def test_empty_scan_does_not_silently_wipe_a_populated_index(self, tmp_path):
        """扫不到任何 agent、但盘上索引本来有条目 → 拒绝覆盖（这是「扫错地方」的指纹）。

        这是 rebuild 最危险的一条：一个空扫描会把一份好索引**静默覆盖成空**，
        而索引自愈的下一步就是「再扫一次」—— 扫错了就永远回不来。
        """
        root = Path(tmp_path)
        index_path = self._index_path(root)
        _seed_agent(root, "wipe_a", _FACT_A)
        idx = get_global_index(root, ttl_s=0.001)
        idx.upsert(_FACT_A, "wipe_a", "m1")
        assert index_path.exists()
        before = json.loads(index_path.read_text(encoding="utf-8"))
        assert len(before["entries"]) > 0, "前置条件：索引必须先有内容"

        shutil.rmtree(root / "wipe_a")
        out = get_global_index(root, ttl_s=0.001).rebuild()

        assert out["rebuilt"] is False, "空扫描被当成「记忆真的删干净了」而照单全收"
        assert out["refused"] == "empty-scan-would-wipe-index"
        after = json.loads(index_path.read_text(encoding="utf-8"))
        assert after["entries"] == before["entries"], "索引被空扫描覆盖了"

    def test_force_overrides_only_the_empty_scan_guard(self, tmp_path):
        """`force=True` 放宽守卫 ③，但绝不放宽 ①②（隔离/目录不存在）。"""
        root = Path(tmp_path)
        index_path = self._index_path(root)
        _seed_agent(root, "force_a", _FACT_A)
        idx = get_global_index(root, ttl_s=0.001)
        idx.upsert(_FACT_A, "force_a", "m1")
        shutil.rmtree(root / "force_a")

        out = get_global_index(root, ttl_s=0.001).rebuild(force=True)
        assert out["rebuilt"] is True and out["refused"] == ""
        assert json.loads(index_path.read_text(encoding="utf-8"))["entries"] == {}

        with _Isolated():
            still = GlobalMemoryIndex(root).rebuild(force=True)
        assert still["rebuilt"] is False and still["refused"] == "isolated", \
            "force=True 顶开了隔离开门 —— 隔离必须是单向的"

        missing = Path(tmp_path) / "still-not-there"
        gone = GlobalMemoryIndex(missing).rebuild(force=True)
        assert gone["rebuilt"] is False and gone["refused"] == "base-dir-missing"

    def test_rebuild_still_self_heals_in_the_normal_case(self, tmp_path):
        """守卫不许误伤自愈路径：索引删掉/改坏后，rebuild 仍能从 memory.json 重建。"""
        root = Path(tmp_path)
        index_path = self._index_path(root)
        _seed_agent(root, "heal_a", _FACT_A)
        idx = get_global_index(root, ttl_s=0.001)
        idx.upsert(_FACT_A, "heal_a", "m1")

        index_path.unlink()
        out = get_global_index(root, ttl_s=0.001).rebuild()
        assert out["rebuilt"] is True and out["refused"] == ""
        assert get_global_index(root, ttl_s=0.001).lookup(_FACT_A) is not None

        index_path.write_text("{ 这不是合法 JSON", encoding="utf-8")
        out = get_global_index(root, ttl_s=0.001).rebuild()
        assert out["rebuilt"] is True, out
        assert get_global_index(root, ttl_s=0.001).lookup(_FACT_A) is not None


class TestIsolationThroughMemoryStore:
    """端到端：隔离开合时，写入链路的行为（写入绝不能因此停摆）。"""

    def setup_method(self, method=None):
        import tempfile
        self.root = Path(tempfile.mkdtemp())
        (self.root / "slime.toml").write_text(
            '[memory]\ncross_agent_dedup = true\n', encoding="utf-8")
        mg._instances.clear()
        import core.memory as mem_mod
        self._saved_root = mem_mod._PROJECT_ROOT
        mem_mod._PROJECT_ROOT = self.root

    def teardown_method(self, method=None):
        import core.memory as mem_mod
        mem_mod._PROJECT_ROOT = self._saved_root
        reset_isolation()
        mg._instances.clear()

    def _stores(self):
        from core.memory import MemoryStore
        return (MemoryStore("end_a", data_dir=str(self.root)),
                MemoryStore("end_b", data_dir=str(self.root)))

    def test_isolated_writes_succeed_without_touching_shared_index(self):
        with _Isolated():
            a, b = self._stores()
            a.add_fact("隔离场景下写入必须照常成功的一条事实")
            assert len(a.get_facts()) == 1
            b.add_fact("隔离场景下写入必须照常成功的一条事实")
            assert len(b.get_facts()) == 1, "隔离时不该跨 agent 去重（不读共享索引）"
            assert b.get_shared_refs() == []
        assert not (self.root / ".global").exists(), "隔离态下产生了共享索引文件"

    def test_closing_isolation_restores_cross_agent_dedup(self):
        """解除隔离后跨 agent 去重必须**恢复** —— 证明修复没有削弱生产特性。

        ⚠️ 必须**由 b 自己去写那条内容**才算数：共享指针只在「被去重的那一方发起写入」
        时产生（`_store_categorized_locked` ② 在 `self` 上调 `_add_shared_ref`），
        只让 a 写、然后断言 b 的 facts/指针，是两条恒真断言（b 连 memory.json 都没有）。
        """
        a, b = self._stores()
        calls = []
        _orig_ref = b._add_shared_ref
        _orig_scan = b._cross_agent_scan
        b._add_shared_ref = lambda *x, **k: (calls.append(("ref", x)), _orig_ref(*x, **k))[1]
        b._cross_agent_scan = lambda *x, **k: (calls.append(("scan",)), _orig_scan(*x, **k))[1]
        text = "解除隔离开关后跨 agent 去重必须立刻恢复的内容"
        a.add_fact(text)
        assert len(a.get_facts()) == 1
        b.add_fact(text)
        assert [c[0] for c in calls] == ["scan", "ref"], \
            f"b 的写入没走查重/留指针链路（{calls}）—— 下面的断言就是空转"
        assert len(b.get_facts()) == 0, "非隔离时本该跨 agent 去重"
        assert len(b.get_shared_refs()) == 1
        assert b.get_shared_refs()[0]["from_agent"] == "end_a"
        assert (self.root / ".global" / "index.json").exists()
