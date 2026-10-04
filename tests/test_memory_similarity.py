"""A-1139：中文相似度与阈值回归测试。

背景：`_text_similarity` 原实现用 `set(a.split())`。中文没有空格 ⇒ 整句被切成
1 个 token ⇒「用户喜欢用 Python 写脚本」vs「用户偏好使用 Python 编程」的 Jaccard
只有 0.20，够不着 0.75 去重阈值、也够不着建链阈值 ⇒ 去重 / 建链 / 相关性排序
三处**全部空转**。实测后果：11658 条 lesson 里只有 25 条不同内容（99.8% 重复）。

阈值依据（temp_test_dir/probe_threshold_sweep.py，真实语料
15 组「同模板应合并」对 / 285 组「不同模板不应合并」对）：
  · 去重 0.75 → 召回 0.867 / 误判 9/285（3.2%）
  · 建链 0.70 → 误链率 16%（原值 0.3 在中文下从未生效，换 V3 后会误链 42%）

⚠️ 本文件锁定的是**数值行为**。若有人改动 `_tokens` 的实现或阈值，
这些用例会立刻失败 —— 这是刻意的：阈值的依据在上面那行探针里，改之前先重跑探针。
"""


class TestTokenization:
    """token 化：CJK 补字符 unigram + bigram，拉丁仍按空白分词"""

    def test_cjk_gets_char_unigrams_and_bigrams(self):
        from core.memory import _tokens
        toks = _tokens("数据库")
        assert "数" in toks, "缺 CJK 单字（保召回）"
        assert "数据" in toks, "缺 CJK 双字（保精度）"
        assert "据库" in toks

    def test_single_cjk_char_has_no_bigram(self):
        from core.memory import _tokens
        assert _tokens("好") == {"好"}

    def test_latin_still_word_split(self):
        from core.memory import _tokens
        toks = _tokens("user prefers python")
        assert "user" in toks and "python" in toks

    def test_mixed_script(self):
        from core.memory import _tokens
        toks = _tokens("用户用 Python 写脚本")
        assert "python" in toks
        assert "用户" in toks
        assert "写脚" in toks

    def test_empty_returns_empty_set(self):
        from core.memory import _tokens
        assert _tokens("") == set()


class TestChineseSimilarity:
    """中文必须能被词法相似度区分（旧实现除「完全相同」外恒失效）"""

    def test_identical_is_one(self):
        from core.memory import _text_similarity
        s = "用户喜欢用 Python 写脚本"
        assert _text_similarity(s, s) == 1.0

    def test_unrelated_chinese_is_zero(self):
        from core.memory import _text_similarity
        assert _text_similarity("用户喜欢用 Python 写脚本", "今天北京天气晴朗适合出门") == 0.0
        assert _text_similarity("数据库连接池配置", "红烧肉的做法步骤详解") == 0.0

    def test_chinese_paraphrase_beats_unrelated(self):
        from core.memory import _text_similarity
        para = _text_similarity("用户喜欢用 Python 写脚本", "用户偏好使用 Python 编程")
        unrel = _text_similarity("用户喜欢用 Python 写脚本", "今天北京天气晴朗适合出门")
        assert para > unrel

    def test_old_implementation_would_have_failed(self):
        """回归护栏：旧实现（纯空白分词）在中文同义改写上只有 0.20。

        这里断言新实现**确实改变了**这个数值 —— 如果哪天有人把 `_text_similarity`
        改回 `set(a.split())`，本用例会失败。
        """
        from core.memory import _text_similarity, _tokens
        para = _text_similarity("用户喜欢用 Python 写脚本", "用户偏好使用 Python 编程")
        # 旧口径（纯词级）复算，用于对比
        old_tokens = lambda t: {w for w in t.lower().split() if w}  # noqa: E731
        a_old, b_old = old_tokens("用户喜欢用 Python 写脚本"), old_tokens("用户偏好使用 Python 编程")
        old = len(a_old & b_old) / len(a_old | b_old)
        assert old == 0.2, "旧口径基线变了，本护栏需重新校准"
        assert para != old, "新实现与旧实现给出相同结果 —— 可能已被改回空白分词"
        # 新实现必须真的用上了 CJK n-gram
        assert len(_tokens("用户喜欢用")) > 1

    def test_english_behaviour_unchanged(self):
        from core.memory import _text_similarity
        assert _text_similarity("user prefers python scripting",
                                "user likes python scripting") > 0.5
        assert _text_similarity("user prefers python scripting",
                                "the weather is nice today") == 0.0


class TestRealCorpusThresholds:
    """用真实语料（Agent Memory 的 lesson 模板）锁定阈值行为"""

    def test_same_tool_different_args_dedups(self):
        """同工具、仅参数不同 → 必须触发去重（这正是 99.8% 重复的来源）"""
        from core.memory import _text_similarity, _DEDUP_THRESHOLD
        a = '用 file_read 处理{"path": "x"} 类请求成功'
        b = '用 file_read 处理{"path": "y"} 类请求成功'
        v = _text_similarity(a, b)
        assert v >= _DEDUP_THRESHOLD, f"同工具异参未去重：{v:.4f} < {_DEDUP_THRESHOLD}"

    def test_different_tool_not_deduped(self):
        """不同工具 → 不得误判为重复。⚠️ 实测此值约 0.74，距 0.75 阈值仅 ~0.01 余量，
        所以去重阈值**不能再往下调**（调到 0.70 就会把不同工具的错误合并）。"""
        from core.memory import _text_similarity, _DEDUP_THRESHOLD
        a = '用 file_read 处理{"path": "x"} 类请求成功'
        b = "用 agnes_generate_video 处理{} 类请求成功"
        v = _text_similarity(a, b)
        assert v < _DEDUP_THRESHOLD, f"不同工具被误判为重复：{v:.4f} >= {_DEDUP_THRESHOLD}"

    def test_success_and_failure_are_distinct(self):
        """成功/失败是同一条经验的两个面，不应被合并成一条"""
        from core.memory import _text_similarity, _DEDUP_THRESHOLD
        a = '用 file_read 处理{"path": "x"} 类请求成功'
        b = '用 file_read 处理{"path": "x"} 类请求失败'
        assert _text_similarity(a, b) < _DEDUP_THRESHOLD


class TestThresholdInvariants:
    """阈值之间必须保持的不变式"""

    def test_link_not_above_dedup(self):
        """建链阈值高于去重阈值没有意义：达到去重线的条目早就是同一条了"""
        from core.memory import _LINK_THRESHOLD, _DEDUP_THRESHOLD
        assert 0.0 < _LINK_THRESHOLD <= _DEDUP_THRESHOLD

    def test_unrelated_below_link_threshold(self):
        from core.memory import _text_similarity, _LINK_THRESHOLD
        assert _text_similarity("数据库连接池配置", "红烧肉的做法步骤详解") < _LINK_THRESHOLD
        assert _text_similarity("今天的天气如何", "帮我重构这个模块") < _LINK_THRESHOLD

    def test_full_source_is_first(self):
        """`_text_similarity(x, x) == 1.0` 是去重/建链的自反前提"""
        from core.memory import _text_similarity
        for s in ("abc", "中文内容", "混合 mixed 内容"):
            assert _text_similarity(s, s) == 1.0
