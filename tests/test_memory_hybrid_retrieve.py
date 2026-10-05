"""§4.1 图降级为「按查询类型触发的可插拔层」—— 真实行为测试。

覆盖四件事：
1. 多跳判据（link_traversal_requested）是纯规则、可判定、不依赖 LLM；
2. 默认链路里 BFS 遍历不跑，只有命中判据时才跑（可显式开关覆盖）；
3. summary() 的图关联行是**活分支**——多跳查询下真的会输出 [category@关联]；
4. 默认链路是「向量 + 全文(BM25)」混合，全文通道真实参与种子生成。

run_tests.py 兼容：仅用 tmp_path。
"""

from core.memory import (
    MemoryStore,
    link_traversal_requested,
    fulltext_search,
    _rrf_fuse,
    _LINK_TRAVERSAL_RULES,
)

SEEDS = [
    "Zephyr 项目的部署流水线在周一完成了首轮压测",
    "Zephyr 项目的灰度开关昨天被运维手动关闭",
    "Zephyr 项目的日志采集链路换了新的采样频率",
    "Zephyr 项目的缓存穿透报警连着响了三个夜晚",
    "Zephyr 项目的依赖镜像仓库迁移到了新机房",
    "Zephyr 项目的回滚脚本删掉了手工确认步骤",
    "Zephyr 项目的鉴权令牌轮换周期改成十四天",
    "Zephyr 项目的灰度名单剔除了三个内网账号",
    "Zephyr 项目的构建产物体积瘦了十二兆",
    "Zephyr 项目的告警阈值上调后误报明显减少",
    "Zephyr 项目的只读副本延迟稳定在三秒以内",
    "Zephyr 项目的连接池上限调低到两百",
]
ORPHAN = "宇航站的咖啡机滤芯需要更换"

MULTIHOP = "和 Zephyr 相关的一切部署记录"
PLAIN = "Zephyr 的部署流水线"


def _linked_store(tmp_path, agent_id):
    store = MemoryStore(agent_id, data_dir=str(tmp_path), global_index="off")
    for content in SEEDS:
        store._store_categorized("fact", content, tags=["zephyr"], importance=5)
    store._store_categorized("fact", ORPHAN, tags=["zephyr"], importance=5)
    return store


class TestMultihopCriterion:
    """P2：判据可判定、可测。"""

    def test_multihop_query_hits_named_rule(self):
        assert link_traversal_requested(MULTIHOP) == "relation_exhaustive"

    def test_plain_query_never_hits(self):
        assert link_traversal_requested(PLAIN) is None

    def test_each_rule_independently_triggerable(self):
        assert link_traversal_requested("多跳关联链路是什么") == "explicit_multihop"
        assert (
            link_traversal_requested("everything connected to the deployment")
            == "exhaustive_related_en"
        )

    def test_unsafe_inputs_return_none(self):
        for q in ("", "   ", None, 123):
            assert link_traversal_requested(q) is None, f"非安全输入未返回 None: {q!r}"

    def test_rule_table_is_nonempty_and_compiled(self):
        assert len(_LINK_TRAVERSAL_RULES) > 0
        for name, pattern in _LINK_TRAVERSAL_RULES:
            assert isinstance(name, str) and name
            assert hasattr(pattern, "search")

    def test_single_hop_queries_not_false_triggered(self):
        for q in ("Zephyr 部署", "用户喜欢什么颜色", "上次的批处理脚本在哪", "记住我的偏好"):
            assert link_traversal_requested(q) is None, f"单跳查询误触发遍历: {q!r}"


class TestHybridRecall:
    """P2/P3：默认链路 = 全文(BM25)，图遍历按判据触发。"""

    def test_multihop_recall_emits_relation_channel(self, tmp_path):
        store = _linked_store(tmp_path, "py_rel_on")
        channels = [r.get("channel") for r in store.hybrid_recall(MULTIHOP, top_k=10)]
        assert "关联" in channels, "多跳查询未产生关联通道"

    def test_plain_recall_emits_no_relation_channel(self, tmp_path):
        store = _linked_store(tmp_path, "py_rel_off")
        channels = [r.get("channel") for r in store.hybrid_recall(PLAIN, top_k=10)]
        assert channels, "全文通道应有结果"
        assert "关联" not in channels, "默认链路跑起了链接遍历"

    def test_graph_flag_forces_on_and_off(self, tmp_path):
        store = _linked_store(tmp_path, "py_rel_force")
        forced = store.hybrid_recall(PLAIN, top_k=10, graph=True)
        assert "关联" in [r.get("channel") for r in forced]
        forced_off = store.hybrid_recall(MULTIHOP, top_k=10, graph=False)
        assert "关联" not in [r.get("channel") for r in forced_off]

    def test_fulltext_recall_ranks_by_bm25_and_excludes_non_matching(self, tmp_path):
        store = MemoryStore("py_fts", data_dir=str(tmp_path), global_index="off")
        store._store_categorized("fact", "部署流水线的压测报告已归档", importance=5)
        store._store_categorized("fact", "宇航站的咖啡机滤芯需要更换", importance=5)
        hits = store.fulltext_recall("压测报告", top_k=5)
        assert hits
        assert hits[0]["channel"] == "全文"
        assert "宇航站的咖啡机滤芯需要更换" not in [h["content"] for h in hits]

    def test_fulltext_recall_guards(self, tmp_path):
        store = MemoryStore("py_fts_guard", data_dir=str(tmp_path), global_index="off")
        store._store_categorized("fact", "任意内容", importance=5)
        assert store.fulltext_recall("", top_k=5) == []
        assert store.fulltext_recall("任意", top_k=0) == []

    def test_fulltext_search_guards(self):
        assert fulltext_search("", ["a"], 5) == []
        assert fulltext_search("q", [], 5) == []
        assert fulltext_search("q", ["a"], 0) == []
        assert fulltext_search("不存在词", ["别的内容"], 5) == []

    def test_fulltext_search_only_scores_positive_hits(self):
        hits = fulltext_search("压测报告", ["压测报告压测报告归档", "无关内容", "压测"], 5)
        assert [i for i, _ in hits] == [0, 2]
        for _, score in hits:
            assert score > 0

    def test_rrf_fuse_ranks_shared_hit_first(self):
        fused = _rrf_fuse([["a", "b"], ["b", "c"]])
        assert [k for k, _ in fused] == ["b", "a", "c"]

    def test_rrf_fuse_skips_empty_keys(self):
        assert _rrf_fuse([]) == []
        assert [k for k, _ in _rrf_fuse([["", "a"], []])] == ["a"]


class TestSummaryGraphLine:
    """P1：图关联行是活分支，不是恒空的死代码。"""

    def test_multihop_summary_emits_relation_line(self, tmp_path):
        store = _linked_store(tmp_path, "py_sum_on")
        text = store.summary(MULTIHOP, max_items=10)
        lines = [ln for ln in text.split("\n") if "@关联]" in ln]
        assert len(lines) > 0, "多跳查询下关联行恒空 ⇒ 死分支"
        assert len(lines) <= 3
        for ln in lines:
            assert ln.startswith("- [")
            assert "@关联] 时间:" in ln
            assert "· 来源: " in ln

    def test_plain_summary_emits_no_relation_line(self, tmp_path):
        store = _linked_store(tmp_path, "py_sum_off")
        text = store.summary(PLAIN, max_items=10)
        assert "@关联]" not in text
        assert "## 已知事实" in text

    def test_relation_line_carries_real_fact_fields(self, tmp_path):
        store = _linked_store(tmp_path, "py_sum_fields")
        text = store.summary(MULTIHOP, max_items=10)
        known = {f["content"] for f in store.get_facts()}
        for ln in text.split("\n"):
            if "@关联]" in ln:
                body = ln.split(" · ", 2)[2]
                assert body in known, f"关联行内容不是真实 fact: {body!r}"

    def test_empty_context_emits_no_relation_line(self, tmp_path):
        store = _linked_store(tmp_path, "py_sum_nocontext")
        assert "@关联]" not in store.summary("", max_items=10)