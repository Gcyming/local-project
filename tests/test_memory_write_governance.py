"""A-1139 §3.2 配套两条的回归测试（Python 侧）。

覆盖：
  1. **跨 agent 全局去重** —— 同一内容已在别的 agent 记忆里 → 本地不新增内容（只留指针）
  2. **单 agent 写入上限** —— 达阈值后新条目只能「合并」或「替换」（软归档）进入，
     活跃集永不物理删除；被挤掉的条目在 `archived` 里可查回
  3. **派生索引** —— `.global/index.json` 删掉能自动重建（它不是第二个真相源）
  4. **降级** —— 索引损坏 / 关闭时退回 per-agent 去重，写入照常成功

⚠️ 这几个断言是**真的会咬**：把 `_cross_agent_scan` 的调用去掉、把上限判断的
`>= limit` 改成 `> 10**9`、或把软归档换成 `facts.remove(...)` 不落 archived，
对应用例立刻红。
"""

import json
from pathlib import Path

import core.memory as mem_mod
from core.memory import MemoryStore


def _make_root(tmp, toml: str = "") -> Path:
    root = Path(tmp)
    if toml:
        (root / "slime.toml").write_text(toml, encoding="utf-8")
    return root


class _Env:
    """把 `_PROJECT_ROOT`（决定 slime.toml 位置）临时指向测试目录。"""

    def __init__(self, root: Path):
        self.root = root

    def __enter__(self):
        self._saved = mem_mod._PROJECT_ROOT
        mem_mod._PROJECT_ROOT = self.root
        return self.root

    def __exit__(self, *exc):
        mem_mod._PROJECT_ROOT = self._saved
        from core.memory_global import _instances
        _instances.clear()
        return False


class TestCrossAgentDedup:
    """写入前额外查一次**跨 agent** 全局去重。"""

    def setup_method(self, method=None):
        import tempfile
        self.root = _make_root(tempfile.mkdtemp(),
                               '[memory]\ncross_agent_dedup = true\n')

    def test_second_agent_does_not_add_duplicate(self):
        with _Env(self.root):
            a = MemoryStore("gx_agent_a", data_dir=str(self.root))
            b = MemoryStore("gx_agent_b", data_dir=str(self.root))
            a.add_fact("用户喜欢用 Python 写脚本")
            assert len(a.get_facts()) == 1
            b.add_fact("用户喜欢用 Python 写脚本")
            assert len(b.get_facts()) == 0, "跨 agent 重复仍然被写进了本地 facts"
            refs = b.get_shared_refs()
            assert len(refs) == 1, "去重命中必须留下可查回的指针（去重 ≠ 丢知识）"
            assert refs[0]["from_agent"] == "gx_agent_a"
            assert refs[0]["content" if "content" in refs[0] else "preview"] == "用户喜欢用 Python 写脚本"
            assert refs[0]["score"] > 0.75

    def test_repeat_hits_increment_not_append(self):
        with _Env(self.root):
            a = MemoryStore("gx_agent_a", data_dir=str(self.root))
            b = MemoryStore("gx_agent_b", data_dir=str(self.root))
            a.add_fact("用户喜欢用 Python 写脚本")
            for _ in range(5):
                b.add_fact("用户喜欢用 Python 写脚本")
            assert len(b.get_facts()) == 0
            assert len(b.get_shared_refs()) == 1, "重复命中应累加 hit_count，不是追加新指针"
            assert b.get_shared_refs()[0]["hit_count"] == 5
            assert len(a.get_facts()) == 1, "去重不能改动别人的真相源"

    def test_different_content_still_written(self):
        with _Env(self.root):
            a = MemoryStore("gx_agent_a", data_dir=str(self.root))
            b = MemoryStore("gx_agent_b", data_dir=str(self.root))
            a.add_fact("用户喜欢用 Python 写脚本")
            b.add_fact("数据库连接池的配置要点")
            assert len(b.get_facts()) == 1, "不应把无关内容误判为跨 agent 重复"

    def test_cross_agent_recall_keeps_knowledge_reachable(self):
        """被去重掉的条目必须还能被找回来（否则去重等于删除）。"""
        with _Env(self.root):
            a = MemoryStore("gx_agent_a", data_dir=str(self.root))
            b = MemoryStore("gx_agent_b", data_dir=str(self.root))
            a.add_fact("项目约定 用 TypeScript 写测试")
            b.add_fact("项目约定 用 TypeScript 写测试")
            hits = b.global_recall("TypeScript 写测试", top_k=5)
            assert hits, "跨 agent 召回为空 —— 被去重的知识不可达"
            assert hits[0]["agent"] == "gx_agent_a"
            assert "TypeScript" in hits[0]["content"]

    def test_global_index_is_derived_and_rebuildable(self):
        """派生索引删掉/改坏都能从各 agent 的 memory.json 重建 —— 它不是第二个真相源。"""
        with _Env(self.root):
            a = MemoryStore("gx_agent_a", data_dir=str(self.root))
            a.add_fact("可重建的事实条目")
            idx_path = self.root / ".global" / "index.json"
            assert idx_path.exists(), "全局索引未落盘"

            idx_path.unlink()
            from core.memory_global import get_global_index
            idx = get_global_index(self.root, ttl_s=0.001)
            idx.rebuild()
            assert idx.lookup("可重建的事实条目") is not None, "索引未能从 memory.json 重建"

            idx_path.write_text("{ 这不是合法 JSON", encoding="utf-8")
            idx = get_global_index(self.root, ttl_s=0.001)
            idx.rebuild()
            assert idx.lookup("可重建的事实条目") is not None, "索引损坏后未能自愈"

    def test_global_index_stores_no_authority(self):
        """索引里只有摘要（agent/content/键），没有 facts 的权威结构。"""
        with _Env(self.root):
            a = MemoryStore("gx_agent_a", data_dir=str(self.root))
            a.add_fact("某条事实")
            raw = json.loads((self.root / ".global" / "index.json").read_text(encoding="utf-8"))
            assert raw.get("derived") is True
            entry = next(iter(raw["entries"].values()))
            assert set(entry) <= {"key", "agent", "mem_id", "content", "category",
                                  "importance", "timestamp", "hits", "last_hit", "status"}
            assert "links" not in entry and "backlinks" not in entry
            assert "memory.json" in raw["note"]

    def test_externally_corrupted_index_self_heals_on_next_write(self):
        """索引文件在运行期**被别的进程改坏**后，本进程不能把自己的内存态也一起清空。

        这是「写前若发现磁盘索引更新就重新载入」那条路径的护栏：重载失败时必须
        保留内存态并作废指纹缓存（于是下次扫盘重建），否则去重查询会直接变成 0 条 ——
        跨 agent 去重**静默失效**，而不是报错。
        """
        import time
        with _Env(self.root):
            a = MemoryStore("gx_agent_a", data_dir=str(self.root))
            b = MemoryStore("gx_agent_b", data_dir=str(self.root))
            a.add_fact("第一条内容")
            b.add_fact("第二条内容")   # 触发一次全局索引落盘
            idx = b._global_index()
            assert idx is not None and idx.lookup("第一条内容") is not None

            idx_path = self.root / ".global" / "index.json"
            hits = None
            for _ in range(40):        # 容忍「同一时钟刻度」——重写索引直到它真的更新
                time.sleep(0.01)
                idx_path.write_text("!!corrupt!!", encoding="utf-8")
                b.add_fact(f"触发写入 {len(b.get_facts())}")
                hits = idx.recall("第一条内容", top_k=5)
                if not hits:
                    break
            assert hits, "索引被改坏后本进程内存态被清空（跨 agent 去重静默失效）"


class TestWriteCap:
    """单 agent 写入上限：新条目只能通过替换/合并进入。"""

    # 语义互不相关、token 也不重叠的条目 —— 否则会被「合并档」正当吸收，
    # 测不到上限（合并先于上限生效，这是刻意的优先级）。
    DISJOINT = [
        "红烧肉需要小火慢炖两小时", "数据库连接池建议控制在 CPU 核数两倍",
        "今天的天气预报说有雷阵雨", "光合作用把光能转成化学能",
        "长城的砖块尺寸各地并不统一", "股票分红除权日会调整开盘参考价",
        "量子纠缠不能用来超光速通信", "核糖体负责把信使翻译成蛋白质",
        "钢琴调律一般按标准音高定音", "驼峰航线当年飞越喜马拉雅山脉",
        "青铜器的锡铅配比影响硬度", "潮汐锁定让月球始终同一面朝地球",
    ]

    def setup_method(self, method=None):
        import tempfile
        self.root = _make_root(tempfile.mkdtemp(),
                               '[memory]\nmax_entries = 3\narchive_limit = 5\n')

    def test_active_set_never_exceeds_cap(self):
        with _Env(self.root):
            m = MemoryStore("cap_agent", data_dir=str(self.root))
            for text in self.DISJOINT:
                m.add_fact(text)
            assert len(m.get_facts()) == 3, "活跃条目突破了上限"
            assert m.get_facts()[-1]["content"] == self.DISJOINT[-1]

    def test_eviction_is_soft_archive_not_delete(self):
        """被挤掉的条目必须留在 archived 里可查回（设计 §5.2：不做物理删除）。"""
        with _Env(self.root):
            m = MemoryStore("cap_agent", data_dir=str(self.root))
            for text in self.DISJOINT[:4]:
                m.add_fact(text)
            archived = m.get_archived()
            assert len(archived) == 1
            victim = archived[0]
            assert victim["content"] == self.DISJOINT[0]
            assert victim["status"] == "archived:fact"
            assert victim["archived_reason"]
            assert victim["archived_at"]

            raw = json.loads((self.root / "cap_agent" / "memory.json").read_text(encoding="utf-8"))
            all_content = [f["content"] for f in raw["archived"]]
            assert self.DISJOINT[0] in all_content, "被挤掉的条目在盘上也不见了（= 物理删除）"

    def test_lowest_value_entry_is_evicted_first(self):
        with _Env(self.root):
            m = MemoryStore("cap_agent", data_dir=str(self.root))
            m.add_fact(self.DISJOINT[0], importance=1)
            m.add_fact(self.DISJOINT[1], importance=5)
            m.add_fact(self.DISJOINT[2], importance=10)
            m.add_fact(self.DISJOINT[3], importance=9)
            assert [f["content"] for f in m.get_facts()] == \
                [self.DISJOINT[1], self.DISJOINT[2], self.DISJOINT[3]]
            assert [a["content"] for a in m.get_archived()] == [self.DISJOINT[0]]

    def test_merge_path_absorbs_near_duplicate(self):
        """合并档：相似但不达去重线 → 并进旧条目（且原文留痕），活跃集不增长。"""
        with _Env(self.root):
            m = MemoryStore("merge_agent", data_dir=str(self.root))
            m.add_lesson("用 file_read 处理路径参数时报错，原因是相对路径基准不对", True)
            before = len(m.get_facts())
            m.add_lesson("用 file_read 处理路径参数时报错，原因是相对路径的基准目录不对", True)
            assert len(m.get_facts()) == before, "近似条目被当成新条目追加了"
            merged = m.get_facts()[0]
            assert merged["merged_from"] == 1
            assert merged["merge_trail"], "合并有损，被并入的原文必须留痕"
            assert "基准目录不对" in merged["merge_trail"][0]["content"]
            assert "补充:" in merged["content"]

    def test_exact_duplicate_still_dedups_before_cap(self):
        with _Env(self.root):
            m = MemoryStore("cap_agent", data_dir=str(self.root))
            m.add_fact("同一条内容")
            m.add_fact("同一条内容")
            assert len(m.get_facts()) == 1
            assert m.get_facts()[0]["repeated"] == 1
            assert not m.get_archived(), "去重命中不该触发归档"

    def test_archive_region_is_bounded(self):
        with _Env(self.root):
            m = MemoryStore("cap_agent", data_dir=str(self.root))
            for text in self.DISJOINT:
                m.add_fact(text)
            for i in range(len(self.DISJOINT), 30):
                m.add_fact(f"probe{i} ref{i * 7919}")
            assert len(m.get_facts()) == 3
            assert len(m.get_archived()) <= 5, "归档区无上限 —— 只是把无限增长挪了个地方"


class TestArchiveNeverRecycled:
    """维护者裁决 / 设计 §5.2：归档区**永不回收**。

    `archive_limit = 0` = 永不回收（**不是**「立即删光」，也不是「无限制的另一种说法」）；
    只有显式正整数才是「容量上限，超出回收最旧的」。归档区是全链路唯一一处物理删除，
    默认必须关掉它。

    ⚠️ 断言真的会咬：去掉 `_spill_to_archive` 的 `limit > 0` 判断、把 0 当成非法值
    回落到 2×max_entries、或把 `_archive_limit()` 的 `limit <= 0 → 0` 改回
    `max(limit, _max_entries())`，下面的「一条都不许丢」立刻红。
    """

    # ⚠️ 补充条目必须**语义互不重叠**：`补充条目编号 12 的独立内容` 这种模板在
    # CJK unigram+bigram 下两两相似度 ≈0.91 → 会被去重/合并正常吸收，
    # 「反复超限写入」根本写不进去，断言就测不到归档区。
    SPILL_SEEDS = TestWriteCap.DISJOINT + [f"probe{i} ref{i * 7919}" for i in range(40)]

    def _root(self, toml: str):
        import tempfile
        return _make_root(tempfile.mkdtemp(), toml)

    def _overflow(self, agent: str, seeds: list) -> MemoryStore:
        m = MemoryStore(agent, data_dir=str(self.root))
        for s in seeds:
            m.add_fact(s)
        return m

    def test_default_is_never_recycle(self):
        self.root = self._root('[memory]\nmax_entries = 3\n')
        with _Env(self.root):
            assert mem_mod._archive_limit() == 0, "代码默认值必须就是「永不回收」"
            m = self._overflow("keep_agent", self.SPILL_SEEDS)
            assert len(m.get_facts()) == 3
            archived = m.get_archived()
            assert len(archived) == len(self.SPILL_SEEDS) - 3, \
                "归档区丢了条目（= 物理删除回归）"
            kept = {f["content"] for f in m.get_facts()} | {a["content"] for a in archived}
            for s in self.SPILL_SEEDS:
                assert s in kept, f"条目 {s} 既不在活跃集也不在归档区"
            raw = json.loads((self.root / "keep_agent" / "memory.json").read_text(encoding="utf-8"))
            assert len(raw["archived"]) == len(self.SPILL_SEEDS) - 3, "盘上的归档区少了条目"

    def test_explicit_zero_is_never_recycle(self):
        """显式写 0 与不写等价 —— 0 不是非法值（不能被 `_cfg_int` 的 n>0 规则悄悄回落）。"""
        self.root = self._root('[memory]\nmax_entries = 3\narchive_limit = 0\n')
        with _Env(self.root):
            assert mem_mod._archive_limit() == 0
            m = self._overflow("zero_agent", self.SPILL_SEEDS)
            assert len(m.get_archived()) == len(self.SPILL_SEEDS) - 3

    def test_broken_config_falls_back_to_never_delete(self):
        """配置写坏一律往「不删」方向兜底：绝不因配置错误物理删除。

        `-5` / `"abc"` 是**合法 TOML 但语义非法**的值（走 `_archive_limit()` 的 int 转换
        与 `<= 0` 分支，`max_entries=3` 仍然生效）；整份 TOML 语法坏掉时 `[memory]` 段
        整体回落默认值，默认值同样是 0 —— 两条路径都指向「不删」。
        """
        for bad in ("-5", '"abc"'):
            self.root = self._root(f'[memory]\nmax_entries = 3\narchive_limit = {bad}\n')
            with _Env(self.root):
                assert mem_mod._archive_limit() == 0, f"archive_limit={bad} 应回落到 0"
                m = self._overflow("bad_agent", self.SPILL_SEEDS[:10])
                assert len(m.get_archived()) == 7
        self.root = self._root('[memory]\nmax_entries = 3\narchive_limit = abc\n')
        with _Env(self.root):
            assert mem_mod._archive_limit() == 0, "整份 TOML 语法坏掉也必须往「不删」兜底"

    def test_explicit_positive_limit_still_bounds(self):
        """显式正整数才算容量上限（老行为不变：超出回收最旧的）。"""
        self.root = self._root('[memory]\nmax_entries = 3\narchive_limit = 6\n')
        with _Env(self.root):
            assert mem_mod._archive_limit() == 6
            m = self._overflow("cap2_agent", self.SPILL_SEEDS[:12])
            assert len(m.get_archived()) == 6
            kept = [a["content"] for a in m.get_archived()]
            assert self.SPILL_SEEDS[0] not in kept, "回收的应是最旧的"
            assert self.SPILL_SEEDS[8] in kept, "最新被挤掉的条目不该被回收"


class TestSharedPointerRecall:
    """任务 A：跨 agent 共享指针接进召回输出，且**必须标注来源**（维护者裁决：允许可见，但标注来源）。

    A 已知的事实如果 B 永远查不到，等于把知识删了（设计 §5.2 精神）。
    隐私边界：只暴露**内容 + 来源标识**，别人的 links/backlinks/tags/system 一律不出现。
    """

    def setup_method(self, method=None):
        import tempfile
        self.root = _make_root(tempfile.mkdtemp(), '[memory]\ncross_agent_dedup = true\n')

    def _seed(self, content: str, lesson: bool = False):
        """在测试根下造出「A 已有 → B 只留指针」的局面（b 的构造已完成、可拿到 _Env 外使用）。"""
        with _Env(self.root):
            a = MemoryStore("sp_agent_a", data_dir=str(self.root))
            b = MemoryStore("sp_agent_b", data_dir=str(self.root))
            if lesson:
                a.add_lesson(content, True)
                b.add_lesson(content, True)
            else:
                a.add_fact(content)
                b.add_fact(content)
            assert len(b.get_facts()) == 0 and len(b.get_shared_refs()) == 1
        return b

    def test_recall_marks_source(self):
        b = self._seed("项目约定 用 TypeScript 写测试")
        # 召回同样要在测试配置根下（`_PROJECT_ROOT` 决定 cross_agent_dedup 等旋钮）
        with _Env(self.root):
            hits = b.global_recall("TypeScript 写测试", top_k=5)
        assert hits, "共享指针没有出现在召回结果里"
        assert hits[0]["source"] == "shared:sp_agent_a", "来源标注缺失/格式不对"
        assert hits[0]["agent"] == "sp_agent_a"
        assert hits[0]["content"] == "项目约定 用 TypeScript 写测试"

    def test_projection_shape_and_privacy(self):
        """对外投影与 memory_recall 工具同形；且不含别人的内部字段。"""
        b = self._seed("用户偏好深色主题")
        with _Env(self.root):
            items = b.shared_pointer_items("深色主题", top_k=5)
        assert len(items) == 1
        assert set(items[0]) == {"id", "content", "category", "importance", "timestamp", "source"}
        assert items[0]["id"] == "", "别人的 mem_id 不能进本 agent 的 id 空间"
        assert items[0]["source"] == "shared:sp_agent_a"
        for bad in ("links", "backlinks", "tags", "system", "mem_id", "confidence", "merge_trail"):
            assert bad not in items[0], f"共享指针泄漏了别人的内部字段 {bad}"

    def test_empty_query_returns_nothing(self):
        b = self._seed("空 query 不该发散出别人的条目")
        with _Env(self.root):
            assert b.global_recall("", top_k=5) == []
            assert b.shared_pointer_items("  ", top_k=5) == []

    def test_shared_refs_fallback_when_index_absent(self):
        """索引不在场（global_index="off"）时，本地 shared_refs 兜底仍给出共享指针。"""
        b = self._seed("ghost 共享指针内容 alpha probe")
        with _Env(self.root):
            off = MemoryStore("sp_agent_b", data_dir=str(self.root), global_index="off")
            assert off.get_facts() == []
            hits = off.global_recall("ghost 共享指针内容 alpha probe", top_k=5)
        assert len(hits) == 1
        assert hits[0]["source"] == "shared:sp_agent_a"
        assert "共享指针内容" in hits[0]["content"]

    def test_category_filter_is_truthful(self):
        """指针的 category 跟着命中条目走（不是硬编码 fact）。"""
        b = self._seed("用 file_read 处理路径参数要小心相对路径基准", lesson=True)
        with _Env(self.root):
            assert b.shared_pointer_items("file_read 相对路径", top_k=5)[0]["category"] == "lesson"

    def test_disabled_switch_gives_no_pointers(self):
        with _Env(_make_root(self.root, '[memory]\ncross_agent_dedup = false\n')):
            a = MemoryStore("sp_agent_a", data_dir=str(self.root))
            b = MemoryStore("sp_agent_b", data_dir=str(self.root))
            a.add_fact("同一条内容")
            b.add_fact("同一条内容")
            assert b.get_shared_refs() == []
            assert b.global_recall("同一条内容", top_k=5) == []


class TestDegradation:
    """索引是派生件：坏了/关了都不能让写入停摆。"""

    def setup_method(self, method=None):
        import tempfile
        self.root = _make_root(tempfile.mkdtemp(), '[memory]\nmax_entries = 5\n')

    def test_disabled_switch_falls_back_to_per_agent(self):
        with _Env(_make_root(self.root, '[memory]\ncross_agent_dedup = false\nmax_entries = 5\n')):
            a = MemoryStore("off_agent_a", data_dir=str(self.root))
            b = MemoryStore("off_agent_b", data_dir=str(self.root))
            a.add_fact("同一条内容")
            b.add_fact("同一条内容")
            assert len(a.get_facts()) == 1
            assert len(b.get_facts()) == 1, "关掉开关后应完全退回 per-agent 行为"
            assert b.get_shared_refs() == []

    def test_off_mode_leaves_single_agent_dedup_intact(self):
        with _Env(self.root):
            m = MemoryStore("off_mode_agent", data_dir=str(self.root), global_index="off")
            m.add_fact("用户非常喜欢使用 Python 语言")
            m.add_fact("用户非常喜欢使用 Python 语言")
            assert len(m.get_facts()) == 1
            assert m.get_facts()[0]["repeated"] == 1

    def test_corrupt_index_does_not_break_writes(self):
        with _Env(self.root):
            (self.root / ".global").mkdir(exist_ok=True)
            (self.root / ".global" / "index.json").write_text("!!not json!!", encoding="utf-8")
            m = MemoryStore("corrupt_agent", data_dir=str(self.root))
            m.add_fact("索引坏了也要能写进去")
            assert len(m.get_facts()) == 1

    def test_unwritable_index_does_not_break_writes(self):
        """索引目录是个文件（无法创建目录）→ 写入必须照常成功。"""
        with _Env(self.root):
            (self.root / ".global").write_text("我不是目录", encoding="utf-8")
            m = MemoryStore("blocked_agent", data_dir=str(self.root))
            m.add_fact("索引目录不可用也要能写进去")
            assert len(m.get_facts()) == 1
