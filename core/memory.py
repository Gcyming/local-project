"""
slime 成长型记忆系统
- 只存"学到了什么"，不存原始对话
- 原始对话走 history.jsonl，成长摘要走 memory.json
- LanceDB 可选接口，默认关闭，fallback 到 JSON 存储
"""

import json
import logging
import asyncio
import math
import hashlib
import re
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DATA_DIR = _PROJECT_ROOT / "data"
_KNOWLEDGE_MEMORY_DIR = _PROJECT_ROOT / "Knowledge" / "Agent Memory"  


_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_agent_id(agent_id: str):
    """agent_id 格式校验：非法立即抛错，避免拼接路径逃逸出 agent 目录"""
    if agent_id and not _AGENT_ID_RE.match(agent_id):
        raise ValueError(f"[memory] 非法 agent_id: {agent_id!r}")





_CJK_RUN_RE = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+"
)


def _tokens(text: str) -> set:
    """把文本切成可比对的 token 集合（**单一产地**，相似度与排序共用）。

    A-1139：此前只有 `text.split()`。中文没有空格 ⇒ 整句被切成 1 个 token ⇒
    「用户喜欢用 Python 写脚本」vs「用户偏好使用 Python 编程」的 Jaccard 只有 0.20，
    够不着 0.75 去重阈值、也够不着建链阈值 ⇒ 去重/建链/相关性排序三处**全部空转**。
    实测后果：11658 条 lesson 里只有 25 条不同内容（99.8% 是重复）。

    这里对 CJK 段补 **字符 unigram + 字符 bigram**：
      · unigram 保召回（同义改写能命中共用的字）
      · bigram 保精度（区分「处理」与「处置」这类）
    拉丁文本仍按空白分词。实测（真实语料：15 组同模板对 / 285 组不同模板对）
    判别间隔 0.5195 → 0.5852，同模板均值 0.62 → 0.84。
    评测探针：temp_test_dir/probe_similarity_variants.py、probe_threshold_sweep.py
    """
    if not text:
        return set()
    low = text.lower()
    toks = {w for w in low.split() if w}
    for run in _CJK_RUN_RE.findall(low):
        toks.update(run)
        if len(run) > 1:
            toks.update(run[i:i + 2] for i in range(len(run) - 1))
    return toks


def _text_similarity(a: str, b: str) -> float:
    """文本相似度（Jaccard；token 化见 _tokens，对中文有效）。"""
    set_a = _tokens(a)
    set_b = _tokens(b)
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


from core.websearch.indexer import (
    BM25_B as _FTS_B,
    BM25_K1 as _FTS_K1,
    query_terms as _FTS_QUERY_TERMS,
    tokenize as _FTS_TOKENIZE,
)

_RRF_K = 60

_LINK_TRAVERSAL_RULES = (
    (
        "relation_exhaustive",
        re.compile(
            r"(?:\u6240\u6709|\u5168\u90e8|\u4e00\u5207|\u6bcf\u4e00\u4e2a|\u6bcf\u4e2a|\u6bcf\u6761|\u6709\u54ea\u4e9b|\u6709\u54ea\u51e0|\u90fd\u6709\u54ea\u4e9b"
            r"|\u5217\u4e3e|\u5217\u51fa|\u7f57\u5217|\u679a\u4e3e|\u6c47\u603b|\u68b3\u7406)"
            r".{0,24}(?:\u76f8\u5173|\u6709\u5173|\u5173\u8054|\u76f8\u8fde|\u6d89\u53ca|\u6709\u5173\u7cfb|\u5173\u7cfb)"
            r"|(?:\u76f8\u5173|\u6709\u5173|\u5173\u8054|\u76f8\u8fde|\u6d89\u53ca|\u6709\u5173\u7cfb|\u5173\u7cfb)"
            r".{0,24}(?:\u6240\u6709|\u5168\u90e8|\u4e00\u5207|\u6bcf\u4e00\u4e2a|\u6bcf\u4e2a|\u6bcf\u6761|\u6709\u54ea\u4e9b|\u6709\u54ea\u51e0|\u90fd\u6709\u54ea\u4e9b"
            r"|\u5217\u4e3e|\u5217\u51fa|\u7f57\u5217|\u679a\u4e3e|\u6c47\u603b|\u68b3\u7406)"
        ),
    ),
    (
        "explicit_multihop",
        re.compile(
            r"(?:\u591a\u8df3|\u8de8\u8df3|\u591a\u5c42\u7ea7|\u5173\u8054\u94fe\u8def|\u5173\u8054\u94fe|\u5173\u7cfb\u94fe"
            r"|\u5173\u7cfb\u56fe|\u56fe\u8c31|\u4e0a\u4e0b\u6e38|\u4f20\u9012\u4f9d\u8d56|\u95f4\u63a5\u5f71\u54cd"
            r"|\u95f4\u63a5\u4f9d\u8d56|\u5b8c\u6574\u8109\u7eb2|\u5168\u8c8c|\u94fe\u8def)"
            r"|(?:multi[- ]?hop|transitive)",
            re.IGNORECASE,
        ),
    ),
    (
        "exhaustive_related_en",
        re.compile(
            r"\b(?:all|every|everything|related|associated|connected)\b.{0,40}"
            r"\b(?:related|associated|connected|link|links)\b",
            re.IGNORECASE,
        ),
    ),
)


def link_traversal_requested(query: str) -> Optional[str]:
    if not isinstance(query, str):
        return None
    q = query.strip()
    if not q:
        return None
    for name, pattern in _LINK_TRAVERSAL_RULES:
        if pattern.search(q):
            return name
    return None


def fulltext_search(query: str, docs: list, top_k: int = 5) -> list:
    if not query or not query.strip() or top_k <= 0 or not docs:
        return []
    terms = _FTS_QUERY_TERMS(query)
    if not terms:
        return []
    counts = []
    lengths = []
    for doc in docs:
        tf: dict = {}
        for t in _FTS_TOKENIZE(doc or ""):
            tf[t] = tf.get(t, 0) + 1
        counts.append(tf)
        lengths.append(sum(tf.values()))
    n_docs = len(docs)
    avg_len = (sum(lengths) / n_docs) or 1.0
    df: dict = {}
    for tf in counts:
        for t in terms:
            if t in tf:
                df[t] = df.get(t, 0) + 1
    scored = []
    for i, tf in enumerate(counts):
        score = 0.0
        for t in terms:
            f = tf.get(t, 0)
            if not f:
                continue
            d = df.get(t, 0)
            idf = math.log(1.0 + (n_docs - d + 0.5) / (d + 0.5))
            denom = f + _FTS_K1 * (1.0 - _FTS_B + _FTS_B * (lengths[i] or 1) / avg_len)
            score += idf * (f * (_FTS_K1 + 1.0)) / denom
        if score > 0.0:
            scored.append((i, score))
    scored.sort(key=lambda kv: (-kv[1], kv[0]))
    return scored[:max(0, top_k)]


def _rrf_fuse(channels: list, k: int = _RRF_K) -> list:
    acc: dict = {}
    for channel in channels:
        for rank, key in enumerate(channel):
            if not key:
                continue
            acc[key] = acc.get(key, 0.0) + 1.0 / (k + rank + 1)
    return sorted(acc.items(), key=lambda kv: (-kv[1], kv[0]))


def link_walk(facts: list, seeds: list, max_hops: int) -> list:
    id_to_fact = {f.get("id"): f for f in facts if isinstance(f, dict) and f.get("id")}
    visited: set = set()
    frontier: list = []
    for seed in seeds:
        sid = seed.get("id") if isinstance(seed, dict) else None
        if sid and sid not in visited:
            visited.add(sid)
            frontier.append((sid, 0))
    while frontier:
        sid, depth = frontier.pop(0)
        if depth >= max_hops:
            continue
        fact = id_to_fact.get(sid)
        if fact is None:
            continue
        for link_id in list(fact.get("links") or []) + list(fact.get("backlinks") or []):
            if link_id in visited:
                continue
            linked = id_to_fact.get(link_id)
            if linked and (linked.get("content") or "").strip():
                visited.add(link_id)
                frontier.append((link_id, depth + 1))
    return [id_to_fact[sid] for sid in visited if sid in id_to_fact]


def _mem_id(content: str) -> str:
    """记忆稳定 ID（content 哈希，幂等，用于双向链接）。"""
    return "mem_" + hashlib.md5(content.encode("utf-8")).hexdigest()[:8]


def _emotion_importance(base: int, emotion: dict | None) -> int:
    """情绪调制记忆权重（三位一体·情绪→记忆）：
    情绪强烈（|valence| 与 arousal 高）的事件记得更牢（杏仁核→海马固化效应）。
    加权式：+2·|valence|·(0.5+arousal) → +0~3，clamp 到 [1,10]；无 emotion 时行为不变。
    """
    if not emotion:
        return base
    try:
        v = abs(float(emotion.get("valence", 0.0) or 0.0))   
        a = min(1.0, max(0.0, float(emotion.get("arousal", 0.0) or 0.0)))  
        boost = int(round(2.0 * v * (0.5 + a)))              
    except (TypeError, ValueError):
        return base
    return min(10, max(1, int(base) + boost))


def _rank_by_relevance(items: list, context: str, content_key: str = "content") -> list:
    """按与上下文的相关性排序（token 化复用 _tokens，中文同样有效）。"""
    if not context or not items:
        return items
    if not _tokens(context):
        return items

    def score(item):
        text = item.get(content_key, "") if isinstance(item, dict) else str(item)
        if not isinstance(text, str):
            text = str(text)
        
        relevance = _text_similarity(context, text)
        imp = item.get("importance", 5) if isinstance(item, dict) else 5
        return relevance * 10 + imp * 0.1

    return sorted(items, key=score, reverse=True)












_DEDUP_THRESHOLD = 0.75
_LINK_THRESHOLD = 0.70


_MERGE_THRESHOLD = 0.68
_MAX_ENTRIES = 2000
_ARCHIVE_LIMIT = 0
_CROSS_AGENT_DEDUP = True
_GLOBAL_INDEX_TTL_S = 30.0


_MEMORY_SETTING_KEYS = (
    "cross_agent_dedup", "global_index_ttl_s", "dedup_threshold", "link_threshold",
    "merge_threshold", "max_entries", "archive_limit", "recall_gate_enabled",
)
_memory_config_cache: dict = {}


def _memory_config() -> dict:
    """`slime.toml [memory]` 的写入治理参数（**可配置入口**，不写死魔法数字）。

    A-1139（§3.2 配套第 2 条）：单 agent 写入上限 / 跨 agent 去重 / 合并线全部从这里读，
    读取失败一律回落到模块默认值 —— 配置坏了不能让记忆写入停摆。
    ⚠️ `dedup_threshold` 默认 0.75 是校准过的，**不要往下调**（不同工具模板条目约 0.74）。

    查找顺序：记忆根目录（`[memory].dir` 指向它）→ 项目根（兼容旧布局 / 隔离运行）。
    """
    toml_path = None
    for base in (_KNOWLEDGE_MEMORY_DIR, _PROJECT_ROOT):
        candidate = Path(base) / "slime.toml"
        if candidate.exists():
            toml_path = candidate
            break
    if toml_path is None:
        return {}
    try:
        stat = toml_path.stat()
    except OSError:
        return {}
    cached = _memory_config_cache.get((str(toml_path), stat.st_mtime))
    if cached is not None:
        return cached
    cfg: dict = {}
    try:
        import tomllib
        raw = tomllib.loads(toml_path.read_text(encoding="utf-8")).get("memory", {})
        if isinstance(raw, dict):
            cfg = {k: raw[k] for k in _MEMORY_SETTING_KEYS if k in raw}
    except Exception as e:
        logging.warning(f"[memory] 读取 [memory] 配置失败，使用默认值: {e}")
        cfg = {}
    if len(_memory_config_cache) > 8:
        _memory_config_cache.clear()
    _memory_config_cache[(str(toml_path), stat.st_mtime)] = cfg
    return cfg


def _cfg_float(name: str, default: float) -> float:
    v = _memory_config().get(name, default)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f > 0 else default


def _cfg_int(name: str, default: int) -> int:
    v = _memory_config().get(name, default)
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def _cfg_bool(name: str, default: bool) -> bool:
    v = _memory_config().get(name, default)
    return v if isinstance(v, bool) else default


def _dedup_threshold() -> float:
    return _cfg_float("dedup_threshold", _DEDUP_THRESHOLD)


def _link_threshold() -> float:
    return _cfg_float("link_threshold", _LINK_THRESHOLD)


def _merge_threshold() -> float:
    """合并线：落在 [去重线, 去重线-0.10] 区间内，避免把「不同工具」的模板条目（实测约 0.74）误并。"""
    merge = _cfg_float("merge_threshold", _MERGE_THRESHOLD)
    dedup = _dedup_threshold()
    return min(merge, max(0.0, dedup - 0.01))


def _max_entries() -> int:
    return _cfg_int("max_entries", _MAX_ENTRIES)


def _archive_limit() -> int:
    """软归档区容量。**`0` = 永不回收**（维护者裁决 / 设计 §5.2）。

    §5.2 原文：「不要把遗忘做成到期物理删除 —— 无任何实证来源支持遗忘带来增益；
    而物理删除不可逆，误删代价高于留存成本」。归档区超额回收是全链路唯一的物理删除，
    所以默认关掉：`archived` 只增不减，被挤掉的条目永远可查回。

    ⚠️ 语义钉死（两侧一致，见 core-ts/src/memory/store.ts::MemoryConfig.archiveLimit）：
      · `0` = **不设上限 / 永不回收**，**不是**「立即删光」；
      · `> 0` = 归档区容量上限，超出才回收最旧的（此时容量不得小于 `max_entries`）；
      · 非法值（非数字 / 负数）一律回落到默认值 —— 默认值是 0，即**往「不删」的方向**兜底：
        配置写坏绝不会导致任何一条记忆被物理删除。
    """
    raw = _memory_config().get("archive_limit", _ARCHIVE_LIMIT)
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        return _ARCHIVE_LIMIT
    if limit <= 0:
        return 0
    return max(limit, _max_entries())


def _cross_agent_dedup_enabled() -> bool:
    return _cfg_bool("cross_agent_dedup", _CROSS_AGENT_DEDUP)


def _recall_gate_enabled() -> bool:
    """§2.1 召回廉价判据开关（纯字符串/正则级，不扫全量记忆；关闭则召回门控失效、旧行为无条件召）。"""
    return _cfg_bool("recall_gate_enabled", True)


_CONTEXT_ROT_SIGNALS = (
    ("past_tense", re.compile(r"(?i)(上次|上回|之前|刚才|刚|刚刚|当时|回头|那时|那时候|上周|上个月|last time|previously|earlier|that time|last week|last month)")),
    ("reference", re.compile(r"(那个|那篇|那段|这款|它们|\bthem\b|\bit\b|this one|that one|that thing|earlier|above)")),
    ("new_entity", re.compile(r"(?:[A-Za-z][\w.+\-]{2,40}|[A-Z_][\w_]{3,40})")),
    ("task_type", re.compile(r"(?i)(任务|作业|问题|故障|缺陷|bug|issue|task|job|problem|fix|debug|修复|报错|异常)")),
)


def should_retrieve_memory(message: str, session_state: dict | None = None) -> bool:
    """§2.1 召回廉价判据：本轮是否需要检索式召回。

    三类信号（任一命中即 True）：
      ① 过去时 / 指代 —— 「上次」「之前」「那个」「刚才」等；
      ② 新实体 —— 专有名词 / 路径 / 人名（ASCII 标识符 ≥3 字符）；
      ③ 任务类型切换 —— 会话状态里 prev_task_type ≠ cur_task_type。
    纯字符串 / 正则级，不引入模型调用、不扫全量记忆。
    空消息无信号可判，返回 False（调用方据此跳过本轮检索式召回，L1 固定前缀不受影响）。
    开关 `[memory].recall_gate_enabled` 缺省 True；关闭时恒 True（恢复无条件召）。
    """
    if not _recall_gate_enabled():
        return True

    if not isinstance(message, str):
        message = ""
    msg = message.strip()
    if not msg:
        return False

    state = session_state or {}
    prev_task = str(state.get("prev_task_type") or "").strip().lower()
    cur_task = str(state.get("cur_task_type") or "").strip().lower()
    if prev_task and cur_task and prev_task != cur_task:
        return True

    for _name, pattern in _CONTEXT_ROT_SIGNALS:
        if pattern.search(msg):
            return True

    return False


def _global_index_ttl_s() -> float:
    return _cfg_float("global_index_ttl_s", _GLOBAL_INDEX_TTL_S)


def _dedup_hit(items: list, content: str, category: str, threshold: float):
    """per-agent 去重判据（**单一产地**）：返回 (命中的条目, 相似度) 或 (None, 最高相似度)。

    同类别内比较；先用 token 集合的包含数做**充分剪枝**（Jaccard ≥ t ⇒ |A∩B| ≥ t·|A|），
    剪枝掉的对不会是真命中 —— 这是上限生效后仍能扛住条目增长的关键。
    """
    cand = _tokens(content.lower())
    if not cand:
        return None, 0.0
    need = int(len(cand) * threshold)
    best = 0.0
    for item in items:
        if item.get("category") != category:
            continue
        existing = item.get("content", "")
        other = _tokens(existing.lower()) if isinstance(existing, str) else set()
        if not other:
            continue
        inter = len(cand & other)
        if inter < need:
            continue
        score = inter / len(cand | other)
        if score > best:
            best = score
        if score > threshold:
            return item, score
    return None, best


def _merged_content(base: str, candidate: str) -> str:
    """合并后的正文 = 基准内容 + 「补充」行。

    合并是**有损的**（只保留一份正文），所以补充行的**原文必须留痕** ——
    调用方把 candidate 原文写进 `merge_trail`，正文本身只做追加，绝不重写既有事实。
    同义改写（candidate 的 token 已被 base 覆盖）不追加，避免正文被无意义撑大。
    """
    cand_tokens = _tokens(candidate.lower())
    base_tokens = _tokens(base.lower())
    if cand_tokens and cand_tokens <= base_tokens:
        return base
    if candidate.strip() in base:
        return base
    return f"{base}\n补充: {candidate.strip()}"


def _effective_value(item: dict, context: str = "") -> float:
    """条目价值 = 权重 × 置信度 ×（1+重复命中次数）。用于上限下的**被挤掉**排序。

    权重沿用 `_effective_weight`（遗忘因子 × 重要性）—— 复用同一个排序信号，
    不再另造一个「价值」公式，避免两套打分互相打架。
    """
    base = _effective_weight(item, context)
    conf = item.get("confidence")
    if isinstance(conf, (int, float)) and math.isfinite(conf):
        base *= max(0.0, min(1.0, float(conf)))
    return base * (1.0 + max(0, int(item.get("repeated", 0) or 0)))


def _list_agent_dirs(base) -> list:
    """列出记忆根目录下的 agent 目录（跳过 .global 这类隐藏目录）。

    只有**测试**会用 `data_dir` 指到一个临时目录，且那里通常只有一个 agent；
    生产环境（9799 个目录）由 `GlobalMemoryIndex` 自己按 TTL 缓存扫描，不走这里。
    """
    import os
    try:
        return [e.name for e in os.scandir(base)
                if e.is_dir() and not e.name.startswith(".")]
    except OSError:
        return []


def _read_agent_facts(base, agent_id: str) -> list:
    """读另一个 agent 的 facts（全局索引不可用时的精确回退路径）。"""
    from core.safe_io import read_json_safe
    data = read_json_safe(Path(base) / agent_id / "memory.json", default=None)
    if not isinstance(data, dict):
        return []
    return data.get("facts", []) or []


_EBBINGHAUS_TAU = 5.0  

def forgetting_factor(days_since_access: float, importance: int) -> float:
    """艾宾浩斯遗忘因子：时间衰减 × 重要性加权。返回 [0,1]。
    0=完全沉睡，1=完整记住。不用就忘，重要之事忘得慢。"""
    time_decay = math.exp(-days_since_access / _EBBINGHAUS_TAU)
    importance_weight = max(1, min(10, importance)) / 10.0
    return time_decay * importance_weight


def _effective_weight(item: dict, context: str = "") -> float:
    """记忆有效权重 = 遗忘因子 × (1 + 相关性)。用于 summary 排序。
    不删除记忆，只是让沉睡记忆排在后面（可被唤醒）。"""
    ts = item.get("last_accessed") or item.get("timestamp", "")
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(ts)).days
    except (ValueError, TypeError):
        age = 0.0
    ff = forgetting_factor(age, item.get("importance", 5))
    if context:
        return ff * (1.0 + _text_similarity(context, item.get("content", "")))
    return ff


_SUMMARY_TIME_UNKNOWN = "未知"
_SUMMARY_SOURCE_UNKNOWN = "未标注"


def _summary_item_line(item: dict | None, content: str, category: str = "",
                       channel: str = "", note: str = "") -> str:
    """summary() 的结构化条目行：category + 时间 + 来源（设计 §4.2 读取侧是一等公民）。
    与 TS 侧 core-ts/src/memory/store.ts 的 summaryItemLine 逐字段对齐。"""
    item = item or {}
    cat = category or item.get("category") or "fact"
    tag = f"[{cat}@{channel}]" if channel else f"[{cat}]"
    ts = item.get("timestamp") or item.get("last_accessed") or _SUMMARY_TIME_UNKNOWN
    src = item.get("source") or _SUMMARY_SOURCE_UNKNOWN
    if not note and isinstance(item.get("success"), bool):
        note = f"结果: {'成功' if item['success'] else '失败'}"
    extra = f" · {note}" if note else ""
    return f"- {tag} 时间: {ts} · 来源: {src}{extra} · {content}"



MEMORY_TEMPLATE = {
    "facts": [],           
    "preferences": [],     
    "skills_unlocked": [], 
    "lessons": [],         
    "created_at": None,
    "updated_at": None,
}



_LANCEDB_AVAILABLE = False
try:
    import lancedb
    _LANCEDB_AVAILABLE = True
except ImportError:
    pass

def _get_embed_dim() -> int:
    """从 slime.toml [model_server.embedding].dim 读取向量维度，默认 1024（BGE-M3）。
    BUG-025: 换 embedding 模型时维度可配置，避免硬编码导致 LanceDB drop_table 丢数据。"""
    try:
        toml_path = _PROJECT_ROOT / "slime.toml"
        if toml_path.exists():
            import tomllib
            dim = tomllib.load(toml_path).get("model_server", {}).get("embedding", {}).get("dim")
            if isinstance(dim, int) and dim > 0:
                return dim
    except Exception:
        pass
    return 1024



_EMBED_DIM = _get_embed_dim()


def _embed(text: str) -> Optional[list[float]]:
    """BGE-M3 向量（经 llama-server）；不可用时返回 **None**（显式失败）。

    A-1139：此前失败会 `return _hash_embed(text)`，而那个「降级向量」是伪嵌入 ——
    它的补位值是 `ord(' ')/256 = 0.125` 而非 0，于是短文本 99%+ 的维度是同一个常数，
    常数项支配了整个向量。实测：5 个语义完全无关的短中文文本两两余弦
    min=0.9659 / max=0.9920 / 均值=0.9835（真实嵌入应在 0.3~0.6），且超过 1024 字符的
    内容完全不可见。后果是**召回排序退化为随机，却因为「向量合法」而不报任何错** ——
    比直接失败更糟。现在返回 None，由调用方走既有的「无向量 → 回落关键词」分支。

    A-003: 端口来源优先级 —— ① 本进程 ModelServerManager 内存状态（权威）
    → ② registry 文件（供外部进程/降级）。manager 启动时会清空陈旧 registry，
    因此只有 manager 明确 READY 的端口才会被使用，假就绪（崩溃残留）不再误用。"""
    try:
        from core.model_server import ModelServerManager, get_model_server
        import urllib.request
        port = 0
        mgr = get_model_server()
        if mgr:
            port = mgr.get_port("embedding")
        if not port:
            registry = ModelServerManager.read_registry()
            emb_info = registry.get("embedding", {})
            if emb_info.get("state") == "ready":
                port = emb_info.get("port", 0)
        if port:
            req_body = json.dumps({"model": "bge-m3", "input": text}).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/v1/embeddings",
                data=req_body,
                headers={"Content-Type": "application/json"},
            )
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=2) as resp:
                data = json.loads(resp.read())
                return [float(v) for v in data["data"][0]["embedding"]]
    except Exception:
        pass
    
    
    
    return None


def _memory_table_schema():
    """记忆表 schema（**单一产地**，所有建表点共用）。

    A-1139：此前建表靠 `data=[{...零向量哨兵行...}]` 让 LanceDB 反推 schema，
    于是每张表都带一行 `vector=[0.0]*dim` 的哨兵。零向量是**退化查询的最近邻吸引子**，
    `recall()` 只过滤空 content 却照样收它，白占 top_k 名额。改为显式 schema 建空表。
    """
    import pyarrow as pa
    return pa.schema([
        pa.field("role", pa.string()),
        pa.field("content", pa.string()),
        pa.field("vector", pa.list_(pa.float32(), _EMBED_DIM)),
        pa.field("tags", pa.string()),
    ])


def vectorize_knowledge(agent_id: str, role: str, content: str,
                        lancedb_enabled: bool = False, lancedb_uri: str = "") -> bool:
    """将晋升产物（rule/skill/review）向量化存入 LanceDB，供语义召回。ponytail: 复用 _embed + _init_lancedb。"""
    if not lancedb_enabled or not _LANCEDB_AVAILABLE:
        return False
    try:
        uri = lancedb_uri or str(_DATA_DIR / agent_id / "lancedb")
        db = lancedb.connect(uri)
        table_name = f"memory_{agent_id}"
        try:
            table = db.open_table(table_name)
        except Exception:
            table = db.create_table(table_name, schema=_memory_table_schema())
        vec = _embed(content)
        if vec is None:
            
            return False
        table.add([{"role": role, "content": content, "vector": vec, "tags": ""}])
        return True
    except Exception as e:
        logging.warning(f"[memory] 知识向量化失败: {e}")
        return False


class MemoryStore:
    """Agent 成长型记忆存储"""

    def __init__(self, agent_id: str, lancedb_enabled: bool = False, lancedb_uri: str = "",
                 data_dir: str = "", global_index: str = "auto"):
        _validate_agent_id(agent_id)
        self.agent_id = agent_id
        
        base = Path(data_dir) if data_dir else _KNOWLEDGE_MEMORY_DIR
        if not base.is_absolute():
            base = _PROJECT_ROOT / base
        self._base_dir = base
        self._explicit_data_dir = bool(data_dir)
        self._json_path = base / agent_id / "memory.json"
        self._data: dict = {}
        self._lancedb_enabled = lancedb_enabled and _LANCEDB_AVAILABLE
        self._lancedb_uri = lancedb_uri or str(_DATA_DIR / agent_id / "lancedb")  
        self._lance_table = None
        
        
        
        
        
        self._index_stale = False
        import threading
        self._lock = threading.Lock()  
        # A-1139（§3.2 配套第 1 条）：跨 agent 全局去重索引。
        # "auto" = 跟随 [memory].cross_agent_dedup；"off" = 完全退回 per-agent 行为。
        self._global_mode = global_index
        self._global = None
        self._load()

    def _global_index(self):
        """惰性取跨 agent 全局索引；任何异常都降级为 None（**不阻断写入**）。

        索引是派生件：拿不到它只会让重复多写几条，绝不能让记忆写入失败。
        """
        if self._global is not None:
            return self._global
        if self._global_mode == "off" or not _cross_agent_dedup_enabled():
            return None
        try:
            from core.memory_global import get_global_index
            self._global = get_global_index(self._base_dir, ttl_s=_global_index_ttl_s())
        except Exception as e:
            logging.warning(f"[memory] 全局去重索引不可用（退回 per-agent 去重）: {e}")
            self._global = None
        return self._global

    def _cross_agent_scan(self, content: str, threshold: float):
        """跨 agent 查重：先查派生索引，索引不可用时退回「逐目录精确读另一个 agent 的 facts」。

        回退路径只在「调用方显式给了 `data_dir`」时启用（测试 / 隔离运行）——
        生产是 9799 个 agent 目录，每次写入都全量扫盘正是全局索引要消灭的东西。
        ⚠️ `_explicit_data_dir` 是**性能**守卫，不是隔离守卫：隔离由
        `memory_global` 单点判定（`get_global_index` 在隔离态交不出索引对象），
        本函数据此**不再**顺着往下走回退路径 —— 「索引拿不到」在隔离态是判定结果，
        不是「索引坏了，换条路继续去重」。与 TS 侧 `crossAgentScan` 的
        `if (idx.isolated) return null` 同一道门。
        """
        idx = self._global_index()
        if idx is not None:
            try:
                return idx.check(content, exclude_agent=self.agent_id, threshold=threshold)
            except Exception as e:
                logging.warning(f"[memory] 全局去重查询失败（本轮退回 per-agent）: {e}")
                return None
        try:
            from core.memory_global import is_isolated
            if is_isolated(self._base_dir):
                return None
        except Exception as e:
            logging.warning(f"[memory] 隔离判定失败（按非隔离继续）: {e}")
        if not self._explicit_data_dir:
            return None
        for other in _list_agent_dirs(self._base_dir):
            if other == self.agent_id:
                continue
            hit, score = _dedup_hit(_read_agent_facts(self._base_dir, other),
                                    content, "", threshold)
            if hit is not None:
                return {"agent": other, "mem_id": hit.get("id", ""),
                        "content": hit.get("content", ""),
                        "category": hit.get("category") or "fact",
                        "score": score, "key": ""}
        return None

    def _spill_to_archive(self, category: str, exclude_id: str = ""):
        """写入上限：把**价值最低**的条目软归档（替换），返回被挤掉的条目 dict。

        设计 §5.2：「不要把遗忘做成到期物理删除」—— 所以这里是**移动**不是删除：
        条目进 `archived`，保留 content / 原始时间 / 归档原因，`get_archived()` 可查回。
        活跃集腾出位置给新条目，条目总数不再无限增长。
        归档区本身默认 `archive_limit = 0` = **永不回收**（语义见 `_archive_limit()`）。
        """
        facts = self._data.get("facts", [])
        if not facts:
            return None
        victim = None
        victim_value = None
        for item in facts:
            if item.get("id") == exclude_id:
                continue
            value = _effective_value(item)
            if victim is None or value < victim_value:
                victim, victim_value = item, value
        if victim is None:
            return None
        facts.remove(victim)
        victim["status"] = f"archived:{category}"
        victim["archived_at"] = datetime.now(timezone.utc).isoformat()
        victim["archived_reason"] = f"超出单 agent 上限 {_max_entries()} 条，按最低有效价值替换"
        archived = self._data.setdefault("archived", [])
        archived.append(victim)
        limit = _archive_limit()
        if limit > 0 and len(archived) > limit:
            freed = len(archived) - limit
            # 全链路唯一一处真删：**归档区**的超额部分（活跃区永不物理删除）。
            # ⚠️ limit == 0（默认）= **永不回收**，本分支不进入：归档区只增不减。
            del archived[:freed]
            logging.info(f"[memory] 归档区超出 {limit} 条，回收最旧的 {freed} 条")
        try:
            idx = self._global_index()
            if idx is not None:
                idx.note_retired(victim.get("content", ""), self.agent_id)
        except Exception:
            pass
        return victim

    def _register_global(self, item: dict) -> None:
        """本地新条目登记进全局索引，让**同进程的下一次写入**立刻看得见它。"""
        idx = self._global_index()
        if idx is None:
            return
        try:
            idx.upsert(item.get("content", ""), self.agent_id, mem_id=item.get("id", ""),
                       category=item.get("category", ""), importance=item.get("importance", 5),
                       timestamp=item.get("timestamp", ""))
        except Exception as e:
            logging.warning(f"[memory] 全局索引登记失败: {e}")

    def _after_store(self, item: dict) -> None:
        """条目已落盘后的收尾，**必须在 per-agent 锁之外调用**。

        两件事：① 把新条目登记进全局索引；② 全局索引登记会顺带落盘，
        所以这里也是「谁先拿锁」的唯一顺序点 —— per-agent 锁先、全局索引锁后。
        """
        self._register_global(item)

    def _add_shared_ref(self, agent_id: str, mem_id: str, content: str, score: float,
                        category: str = "fact") -> bool:
        """跨 agent 去重命中 → 本地不新增内容，只留一条**指针**（去重不等于丢知识）。

        为什么不做成「直接 return，什么都不留」：那样 A 已经知道的事实，B 永远查不到，
        等于把知识**删除**了。指针不参与 JSON 真相源的内容语义（不在 facts 里、
        不进 summary、不建链），只让 `get_shared_refs()` / `global_recall()` 能把它找回来。
        `category` 跟着指针走：索引不在场时对外投影仍能如实标出「这是别人的哪类记忆」。
        """
        refs = self._data.setdefault("shared_refs", [])
        for ref in refs:
            if isinstance(ref, dict) and ref.get("mem_id") == mem_id and ref.get("from_agent") == agent_id:
                ref["hit_count"] = int(ref.get("hit_count", 0) or 0) + 1
                ref["last_hit_at"] = datetime.now(timezone.utc).isoformat()
                self._save()
                return True
        refs.append({
            "from_agent": agent_id,
            "mem_id": mem_id,
            "score": round(float(score), 4),
            "preview": content[:120],
            "category": category or "fact",
            "hit_count": 1,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": f"shared:{agent_id}:{mem_id}",
        })
        self._save()
        return True

    def get_shared_refs(self) -> list:
        """跨 agent 去重被我方「让位」的条目指针（可查回，不静默丢失）。"""
        return [r for r in self._data.get("shared_refs", []) if isinstance(r, dict)]

    def get_archived(self) -> list:
        """被写入上限挤出的条目（**软归档，非删除**）。可按 status/content 查回。"""
        return [a for a in self._data.get("archived", []) if isinstance(a, dict)]

    def _shared_refs_ranked(self, query: str, top_k: int) -> list:
        """本地 `shared_refs` 指针按 query 相关性排序（**不发散**：score ≤ 0 的丢掉）。

        `content` 用指针里的 preview（写入时截断 120 字）—— 派生索引能在场就由索引补全文。
        """
        q = (query or "").strip()
        if not q:
            return []
        ranked = []
        for ref in self.get_shared_refs():
            agent = ref.get("from_agent") or ""
            content = ref.get("preview")
            if not agent or not isinstance(content, str) or not content:
                continue
            score = _text_similarity(q, content)
            if score <= 0:
                continue
            ranked.append({
                "agent": agent,
                "mem_id": ref.get("mem_id", ""),
                "content": content,
                "category": ref.get("category") or "fact",
                "importance": 5,
                "timestamp": ref.get("timestamp", ""),
                "score": score,
                "source": f"shared:{agent}",
            })
        ranked.sort(key=lambda r: r["score"], reverse=True)
        return ranked[:max(0, top_k)]

    def global_recall(self, query: str, top_k: int = 5) -> list:
        """跨 agent 召回：把「因为别处已有而没写进本 agent」的内容找回来（去重 ≠ 删除）。

        两条来源合并，按 (agent, mem_id/content) 去重（索引命中优先 —— 它是**全文**，
        本地指针只有 120 字 preview）：
          ① 派生索引里别的 agent 的条目（原有语义）；
          ② 本地 `shared_refs` 指针 —— 索引关掉/坏掉/对方条目已被软归档时，指针仍然
             记得「这条内容曾经在谁那里」，是索引之外的兜底来源。

        每条都带 `source = "shared:<agent_id>"`：这是**别人的**记忆，不是本 agent 的。
        空 query → 返回空（与索引召回一致）：别人条目的 last_accessed / 热度是本 agent
        读不到的内部字段，无法给出与本地条目可比的「最近最常用」排序。
        """
        if not query or not query.strip() or top_k <= 0:
            return []
        merged: dict = {}
        idx = self._global_index()
        if idx is not None:
            try:
                for r in idx.recall(query, top_k=top_k, exclude_agent=self.agent_id):
                    agent = r.get("agent", "")
                    merged[(agent, r.get("mem_id") or r.get("content", ""))] = {
                        "agent": agent,
                        "mem_id": r.get("mem_id", ""),
                        "content": r.get("content", ""),
                        "category": r.get("category") or "fact",
                        "importance": r.get("importance", 5),
                        "timestamp": r.get("timestamp", ""),
                        "score": r.get("score", 0.0),
                        "source": f"shared:{agent}",
                    }
            except Exception as e:
                logging.warning(f"[memory] 跨 agent 召回失败: {e}")
        for ref in self._shared_refs_ranked(query, top_k):
            key = (ref["agent"], ref["mem_id"] or ref["content"])
            if key in merged:
                continue
            merged[key] = ref
        return sorted(merged.values(), key=lambda r: r.get("score", 0.0), reverse=True)[:top_k]

    def shared_pointer_items(self, query: str, top_k: int = 5) -> list:
        """共享指针的**对外投影**（模型看到的形状 / 记忆端点返回给调用方的形状）。

        隐私边界（维护者裁决：「允许可见，但标注来源」）：只给**内容 + 来源标识** ——
        别人的 links / backlinks / tags / system 等内部字段一律不出现。据此：
          · `source` = `shared:<agent_id>`，唯一且明确区分的来源标注；
          · `id` 恒为空串：本 agent 的 id 空间里没有这条，给上别人的 mem_id 反而会诱导
            memory_forget 去删**别人的**真相源（越权幻想）；
          · category / importance / timestamp 取自派生索引摘要（索引本来只有摘要字段）。
        """
        return [{
            "id": "",
            "content": r.get("content", ""),
            "category": r.get("category") or "fact",
            "importance": r.get("importance", 5),
            "timestamp": r.get("timestamp", ""),
            "source": r.get("source") or f"shared:{r.get('agent', '')}",
        } for r in self.global_recall(query, top_k=top_k)]

    def _indexed_facts(self) -> list:
        return [f for f in self._data.get("facts", [])
                if isinstance(f, dict) and isinstance(f.get("content"), str)
                and f["content"].strip()]

    def fulltext_recall(self, query: str, top_k: int = 5) -> list[dict]:
        if not query or not query.strip() or top_k <= 0:
            return []
        facts = self._indexed_facts()
        if not facts:
            return []
        return [dict(facts[i], channel="全文")
                for i, _score in fulltext_search(query, [f["content"] for f in facts], top_k)]

    def hybrid_recall(self, query: str, top_k: int = 5, graph: bool | None = None,
                      max_hops: int = 2) -> list[dict]:
        if not query or not query.strip() or top_k <= 0:
            return []
        vector: list[dict] = []
        if self._lancedb_enabled:
            try:
                vector = [dict(r, channel="向量") for r in self.recall(query, top_k=top_k)]
            except Exception:
                vector = []
        fulltext = self.fulltext_recall(query, top_k=top_k)
        by_content: dict = {}
        for r in vector + fulltext:
            by_content.setdefault(r.get("content", ""), r)
        fused = _rrf_fuse([
            [r.get("content", "") for r in vector],
            [r.get("content", "") for r in fulltext],
        ])
        out: list[dict] = []
        seen: set = set()
        for content, _score in fused:
            if not content or content in seen:
                continue
            seen.add(content)
            out.append(dict(by_content.get(content, {"content": content})))
        head = out[:top_k]
        want_graph = link_traversal_requested(query) is not None if graph is None else bool(graph)
        if want_graph:
            facts = self._indexed_facts()
            content_to_fact = {f["content"]: f for f in facts}
            seeds = [content_to_fact[c] for c in seen if c in content_to_fact]
            for f in link_walk(facts, seeds, max_hops)[:top_k]:
                content = f["content"]
                if content in seen:
                    continue
                seen.add(content)
                head.append(dict(f, channel="关联"))
        return head

    

    def _load(self):
        """从 JSON 加载记忆，优先新位置，自动从旧位置迁移"""
        new_path = self._json_path
        old_path = _DATA_DIR / self.agent_id / "memory.json"
        
        if old_path.exists() and not new_path.exists():
            try:
                new_path.parent.mkdir(parents=True, exist_ok=True)
                import shutil
                shutil.move(str(old_path), str(new_path))
                logging.info(f"[memory] 已从 {old_path} 迁移到 {new_path}")
            except OSError as e:
                logging.warning(f"[memory] 迁移失败: {e}")
        if new_path.exists():
            
            
            from core.safe_io import read_json_safe
            loaded = read_json_safe(self._json_path, default=None)
            if isinstance(loaded, dict):
                self._data = loaded
            else:
                logging.warning(f"[memory] 加载 {self._json_path} 失败（主文件与 .bak 均不可用），使用空记忆")
                import copy
                self._data = copy.deepcopy(MEMORY_TEMPLATE)
        else:
            import copy
            self._data = copy.deepcopy(MEMORY_TEMPLATE)
        
        for f in self._data.get("facts", []):
            if isinstance(f, dict) and "last_accessed" not in f:
                f["last_accessed"] = f.get("timestamp", "")
        if self._data.get("created_at") is None:
            self._data["created_at"] = datetime.now(timezone.utc).isoformat()

    def _save(self):
        """保存记忆到 JSON（A-989：崩溃安全写 —— tmp + fsync + replace + fsync(父目录) + .bak）

        此前只做 tmp+replace 而**没有 fsync**：rename 是元数据操作，可能先于数据落盘，
        断电/强杀后会留下"文件名在、内容空或半截"的记忆文件，重启时读它直接炸。
        """
        from core.safe_io import atomic_write_text
        self._data["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._json_path.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps(self._data, ensure_ascii=False, indent=2)
        atomic_write_text(self._json_path, data)

    

    def _store_categorized(self, category: str, content: str, tags: list | None = None,
                           importance: int = 5, extra: dict | None = None,
                           emotion: dict | None = None):
        """统一分类存储：去重 + JSON + 向量索引。

        emotion（可选，三位一体）：情绪调制记忆权重 + 快照落库。
        神经科学依据：情绪强烈的事件记得更牢（杏仁核→海马固化）；
        情绪快照供将来 mood-congruent 检索（Bower 1981）。None=旧行为不变。

        A-1139（D3）：**JSON 与向量拆成两段，锁只护前一段**。
        此前 `_embed`（同步 HTTP，timeout 2s）与 LanceDB 写入都在 per-agent 锁内 ——
        嵌入服务一慢，该 Agent 的记忆写入就被整个卡住。现在锁内只做纯内存 + JSON 落盘
        （微秒级），出锁后才做嵌入与索引；索引失败只丢索引，不影响已落盘的真相源。
        """
        with self._lock:
            stored = self._store_categorized_locked(
                category, content, tags,
                _emotion_importance(importance, emotion),
                {**(extra or {}),
                 **({"emotion": dict(emotion)} if emotion else {})})
        if stored:
            self._index_vector(category, content, tags or [])

    def _index_vector(self, category: str, content: str, tags: list) -> None:
        """把一条记忆写进 LanceDB 语义索引（**必须在锁外调用**）。

        A-1139（D3）：从 `_store_categorized_locked` 里抽出来。理由是嵌入是一次同步
        HTTP 往返，不能占着 per-agent 锁。语义同原来那段：best-effort，失败只丢索引
        （JSON 才是真相源）。
        """
        if not self._lancedb_enabled:
            return
        try:
            self._init_lancedb()
            if self._lance_table is None:
                return
            vec = _embed(content)
            
            if vec is None:
                return
            self._lance_table.add([{
                "role": category,
                "content": content,
                "vector": vec,
                "tags": ",".join(tags),
            }])
        except Exception as e:
            logging.warning(f"[memory] LanceDB store 失败: {e}")

    async def _store_categorized_async(self, category: str, content: str,
                                       tags: list | None = None, importance: int = 5,
                                       extra: dict | None = None,
                                       emotion: dict | None = None):
        """async 版本：用 to_thread 包裹同步存储，避免阻塞事件循环（N11-P2-8）"""
        await asyncio.to_thread(
            self._store_categorized, category, content, tags, importance, extra,
            emotion
        )

    def _store_categorized_locked(self, category: str, content: str, tags: list | None,
                                   importance: int = 5, extra: dict | None = None):
        """锁内实际写入逻辑（**只做 JSON**）。BUG-003: 写入时建立双向链接（tags 重叠自动关联）。

        A-1139（D3）：**向量索引已移出本函数**（嵌入是同步 HTTP，不能占着 per-agent 锁）。
        返回 True = 确实新增了一条（调用方应补写索引）；False = 去重命中，没有新条目。
        ⚠️ 直接调用本函数的路径（目前只有 `add_preference`）必须自己处理返回值并补索引。

        A-1139（设计 §3.2 配套两条）在此处落实：
          1. 写入前额外查一次**跨 agent 全局去重** —— 命中则本地不新增内容，只留指针
             （`shared_refs`），并把命中记进派生索引的 hits；
          2. **单 agent 写入上限** —— 条目达到 `[memory].max_entries` 后，新条目只能
             ① 与高相似旧条目**合并**，或 ② 把**价值最低**的旧条目**软归档**腾位置；
             活跃集永不物理删除，被挤掉的进 `archived` 可查回。
        """
        tags = tags or []
        dedup = _dedup_threshold()
        facts = self._data.setdefault("facts", [])
        new_extra = dict(extra or {})

        # ---- ① per-agent 去重（原有语义，判据抽到 _dedup_hit 以复用剪枝） ----
        hit, _score = _dedup_hit(facts, content, category, dedup)
        if hit is not None:
            hit["repeated"] = int(hit.get("repeated", 0) or 0) + 1
            self._save()
            return False

        # ---- ② 跨 agent 全局去重（本次新增；命中则本地只留指针，不新增内容） ----
        shared = self._cross_agent_scan(content, dedup)
        if shared is not None:
            self._add_shared_ref(shared.get("agent", ""), shared.get("mem_id", ""),
                                 shared.get("content", "") or content,
                                 float(shared.get("score", 0.0)),
                                 shared.get("category", "") or category)
            logging.info(
                f"[memory] 跨 agent 去重命中（agent={self.agent_id} ← {shared.get('agent')}"
                f" score={float(shared.get('score', 0.0)):.3f}），本地不新增：{content[:60]}")
            return False

        new_id = _mem_id(content)
        tag_set = set(tags)
        links = []

        # ---- ③ 上限之下的「合并」档：高相似但不达去重线 → 并进旧条目，不新增 ----
        # ⚠️ 带 tags 的条目**不参与合并**：tags 是调用方显式的「同族」信号，同族但内容不同
        # 的条目应当各自留着并靠 links 关联，合并会把不同事实揉成一条（信息损失 ≠ 去重）。
        merge_hit, merge_score = (None, 0.0) if tag_set else \
            _dedup_hit(facts, content, category, _merge_threshold())
        if merge_hit is not None:
            trail = merge_hit.setdefault("merge_trail", [])
            trail.append({"content": content, "score": round(merge_score, 4),
                          "at": datetime.now(timezone.utc).isoformat()})
            merge_hit["content"] = _merged_content(merge_hit.get("content", ""), content)
            merge_hit["importance"] = max(int(merge_hit.get("importance", 5)),
                                          max(1, min(10, importance)))
            merge_hit["timestamp"] = datetime.now(timezone.utc).isoformat()
            merge_hit["repeated"] = int(merge_hit.get("repeated", 0) or 0) + 1
            merge_hit["merged_from"] = int(merge_hit.get("merged_from", 0) or 0) + 1
            self._save()
            return False

        for existing in facts:
            if existing.get("id") == new_id:
                continue
            existing_tags = set(existing.get("tags", []))
            linked = False
            if tag_set and (tag_set & existing_tags):
                linked = True
            elif not tag_set and _text_similarity(
                content.lower(), existing.get("content", "").lower()
            ) > _link_threshold():
                linked = True
            if linked:
                links.append(existing["id"])
                existing.setdefault("backlinks", [])
                if new_id not in existing["backlinks"]:
                    existing["backlinks"].append(new_id)
                
                existing["last_accessed"] = datetime.now(timezone.utc).isoformat()

        # ---- ④ 上限：满了先「替换」腾位置，新条目才进得来 ----
        # 全局索引登记 / 跨 agent 指针 / 归档返回都给**调用方**在锁外做 ——
        # 锁内顺序恒为「先 per-agent 锁、后全局索引锁」，绝不在持有 per-agent 锁时
        # 去取全局索引锁（那会与另一条反向路径构成死锁）。
        extras: dict = {}
        limit = _max_entries()
        if len(facts) >= limit:
            freed = self._spill_to_archive(category)
            if freed is None:
                logging.warning(f"[memory] {self.agent_id} 已达上限 {limit} 条且无可替换条目，本次写入丢弃")
                return False
            extras["replaced"] = freed.get("id", "")

        item = {
            "id": new_id,
            "content": content,
            "category": category,
            "tags": tags,
            "importance": max(1, min(10, importance)),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "last_accessed": datetime.now(timezone.utc).isoformat(),  
            "links": links,        
            "backlinks": [],       
            "repeated": 0,
            **new_extra,
            **extras,
        }
        facts.append(item)
        self._save()
        self._after_store(item)
        return True

    def add_fact(self, fact: str, importance: int = 5,
                 emotion: dict | None = None):
        """添加事实知识（emotion 可选：情绪调制记忆权重，三位一体·情绪→记忆）"""
        self._store_categorized("fact", fact, importance=importance,
                                emotion=emotion)

    def add_preference(self, key: str, value: str):
        """添加/更新用户偏好（按 key 精确去重）"""
        content = f"{key}: {value}"
        tags = [key]
        with self._lock:
            for f in self._data.get("facts", []):
                if f.get("category") == "preference" and f.get("tags") and f["tags"][0] == key:
                    f["content"] = content
                    f["importance"] = max(f.get("importance", 5), 6)
                    f["timestamp"] = datetime.now(timezone.utc).isoformat()
                    self._save()
                    return
        self._store_categorized("preference", content, tags=tags, importance=6)

    def add_skill(self, skill_name: str):
        """记录解锁的技能"""
        with self._lock:
            skills = self._data.setdefault("skills_unlocked", [])
            if skill_name not in skills:
                skills.append(skill_name)
                self._save()

    def add_lesson(self, lesson: str, success: bool, importance: int = 5):
        """添加经验教训（委托 _store_categorized）"""
        self._store_categorized("lesson", lesson, importance=importance,
                                extra={"success": success})

    def get_facts(self, as_dicts: bool = True) -> list:
        """获取事实列表。返回完整 dict（含 category/tags/importance/timestamp）。"""
        return self._data.get("facts", [])

    def get_preferences(self) -> dict:
        """获取用户偏好（从统一 facts 中过滤 category=preference）"""
        prefs = {}
        for f in self._data.get("facts", []):
            if f.get("category") == "preference" and f.get("tags"):
                key = f["tags"][0] if f["tags"] else f["content"].split(":", 1)[0]
                val = f["content"].split(":", 1)[-1].strip() if ":" in f["content"] else f["content"]
                prefs[key] = val
        return prefs

    def get_skills(self) -> list:
        return self._data.get("skills_unlocked", [])

    def touch(self, content_prefix: str) -> int:
        """Soul-Plan 修正条 5：命中归档条目后刷新 last_accessed（越用越熟，
        艾宾浩斯半衰期仅 5 天——想起一次不刷新会再沉底）。按 content 包含前缀匹配。"""
        now = datetime.now(timezone.utc).isoformat()
        n = 0
        for f in self._data.get("facts", []):
            if "behavior_archive" in (f.get("tags") or []) and content_prefix \
                    and content_prefix in f.get("content", ""):
                f["last_accessed"] = now
                n += 1
        if n:
            self._save()
        return n

    def get_lessons(self, successful_only: bool = False, limit: int = 20) -> list:
        """获取经验教训（从统一 facts 中过滤 category=lesson）"""
        lessons = [f for f in self._data.get("facts", []) if f.get("category") == "lesson"]
        if successful_only:
            lessons = [l for l in lessons if l.get("success")]
        return lessons[-limit:]

    def summary(self, context: str = "", max_items: int = 10) -> str:
        """生成记忆摘要（JSON 关键词 + LanceDB 语义检索 + 图谱联想，合并去重）"""
        parts = []
        
        facts = [f for f in self.get_facts() if isinstance(f, dict) and isinstance(f.get("content"), str)]

        
        ranked = sorted(facts, key=lambda f: _effective_weight(f, context), reverse=True)
        selected = ranked[:max_items]
        # 设计 §5.1（富者愈富 bug）：summary() 被调用 ≠ 记忆被访问。这里**不再**刷新
        # last_accessed —— 否则每轮对话都把当前 top-N 继续抬到榜首，排名外的沉睡记忆
        # 永远追不上，「沉睡但可唤醒」在实现上不成立。
        # 衰减（_effective_weight）保留为排序信号；只有真正的检索命中（touch()）才算访问。

        content_to_fact = {f["content"]: f for f in facts}
        known = {f["content"] for f in facts}

        semantic_items = []
        graph_items = []
        if context:
            recalled = []
            try:
                recalled = self.hybrid_recall(context, top_k=max_items)
            except Exception:
                recalled = []
            hit_contents = []
            seen_hits = set()
            for r in recalled:
                c = r.get("content", "")
                if c and r.get("channel") != "关联" and c not in seen_hits:
                    seen_hits.add(c)
                    hit_contents.append(c)
            if hit_contents:
                rest = [f for f in ranked if f["content"] not in seen_hits]
                selected = ([content_to_fact[c] for c in hit_contents if c in content_to_fact]
                            + rest)[:max_items]
            semantic_items = [r for r in recalled if r.get("content", "") not in known]
            shown = {f["content"] for f in selected}
            graph_items = [r for r in recalled
                           if r.get("channel") == "关联"
                           and r.get("content", "") not in shown]

        if selected or semantic_items or graph_items:
            # 设计 §4.2：读取侧是一等公民 —— 每条都必须带 category / 时间 / 来源，不是一段散文。
            lines = [_summary_item_line(f, f["content"]) for f in selected]

            for gf in graph_items[:3]:
                lines.append(_summary_item_line(gf, gf["content"], channel="关联"))

            for item in semantic_items[:3]:
                lines.append(_summary_item_line(item, item.get("content", ""),
                                                category=item.get("role", ""), channel="语义"))
            parts.append("## 已知事实\n" + "\n".join(lines))
        prefs = self.get_preferences()
        pref_fact_by_key = {}
        for f in facts:
            if f.get("category") == "preference" and f.get("tags"):
                pref_fact_by_key[f["tags"][0]] = f
        pref_entries = list(prefs.items())[:max_items]
        if pref_entries:
            parts.append("## 用户偏好\n" + "\n".join(
                _summary_item_line(pref_fact_by_key.get(k), f"{k}: {v}", category="preference")
                for k, v in pref_entries))
        skills = self.get_skills()
        if skills:
            # skills_unlocked 是纯字符串数组，数据模型里没有时间/来源字段（两侧一致）。
            parts.append("## 已解锁技能\n" + "\n".join(f"- [skill] {s}" for s in skills[:max_items]))
        lessons = self.get_lessons(limit=max_items * 2)
        if lessons:
            ranked_lessons = sorted(lessons, key=lambda l: _effective_weight(l, context), reverse=True)
            parts.append("## 经验教训\n" + "\n".join(
                _summary_item_line(l, l.get("content", ""))
                for l in ranked_lessons[:max_items]
            ))
        return "\n\n".join(parts)

    def to_dict(self) -> dict:
        import copy
        return copy.deepcopy(self._data)  

    

    def _init_lancedb(self):
        """初始化 LanceDB 连接（表已存在时 open_table，维度不匹配则重建）"""
        if not self._lancedb_enabled:
            return
        try:
            uri = self._lancedb_uri or str(_DATA_DIR / self.agent_id / "lancedb")
            db = lancedb.connect(uri)
            table_name = f"memory_{self.agent_id}"
            try:
                self._lance_table = db.open_table(table_name)
                
                schema = self._lance_table.schema
                vec_field = next((f for f in schema if f.name == "vector"), None)
                if vec_field and hasattr(vec_field, 'type'):
                    dim_attr = (getattr(vec_field.type, 'list_size', None)  
                                or getattr(vec_field.type, 'dim', None)
                                or getattr(vec_field.type, 'dimension', None))
                    if dim_attr and dim_attr != _EMBED_DIM:
                        logging.warning(
                            f"[memory] 向量维度不匹配（表: {dim_attr}, 当前: {_EMBED_DIM}），重建空表。"
                            f"索引已标记为 stale —— 调 reindex() 可从 JSON 真相源回填"
                            f"（A-1139/D4：此前这里**没有**回填路径，注释却写「记忆可再生」，与代码不符）"
                        )
                        db.drop_table(table_name)
                        self._lance_table = db.create_table(table_name, schema=_memory_table_schema())
                        self._index_stale = True
                
                field_names = {f.name for f in self._lance_table.schema}
                if "tags" not in field_names:
                    logging.warning("[memory] 旧表缺 tags 字段，重建空表（索引已标记 stale，调 reindex() 回填）")
                    db.drop_table(table_name)
                    self._lance_table = db.create_table(table_name, schema=_memory_table_schema())
                    self._index_stale = True
            except Exception:
                self._lance_table = db.create_table(table_name, schema=_memory_table_schema())
        except Exception as e:
            logging.warning(f"[memory] LanceDB 初始化失败，降级到 JSON: {e}")
            self._lancedb_enabled = False

    def store(self, role: str, content: str, tags: str = "") -> bool:
        """LanceDB 存储（role=category, tags=逗号分隔标签）"""
        if not self._lancedb_enabled:
            return False
        if self._lance_table is None:
            self._init_lancedb()
        if self._lance_table is None:
            return False
        try:
            vec = _embed(content)
            if vec is None:
                return False  
            self._lance_table.add([{
                "role": role, "content": content, "vector": vec, "tags": tags,
            }])
            return True
        except Exception as e:
            logging.warning(f"[memory] LanceDB store 失败: {e}")
            return False

    def recall(self, query: str, top_k: int = 5, categories: list | None = None) -> list[dict]:
        """LanceDB 语义检索（可选 category 过滤）"""
        if not self._lancedb_enabled:
            return []
        
        
        
        if self._lance_table is None:
            self._init_lancedb()
        if self._lance_table is None:
            return []
        try:
            vec = _embed(query)
            
            
            if vec is None:
                logging.info("[memory] embedding 不可用，语义召回跳过（回落关键词）")
                return []
            q = self._lance_table.search(vec)
            if categories:
                
                safe_cats = [c.replace("'", "''") for c in categories]
                cat_filter = " OR ".join(f"role = '{c}'" for c in safe_cats)
                q = q.where(cat_filter)
            results = q.limit(top_k).to_list()
            return [{"role": r.get("role", ""), "content": r.get("content", ""),
                     "tags": r.get("tags", "")} for r in results
                    if r.get("content", "").strip()]  
        except Exception as e:
            logging.warning(f"[memory] LanceDB recall 失败: {e}")
            return []

    def reindex(self, batch_size: int = 64) -> dict:
        """从 JSON（**唯一真相源**）重建 LanceDB 语义索引，并返回对账结果。

        A-1139（D4）：这是「双写无对账」里**缺失的那条对账路径**。
        此前 JSON 与索引双写且互不校验 —— 索引写失败、进程被杀、或因维度/字段不匹配
        被 `drop_table` 之后，索引就**永久**少一截，而代码注释却写「记忆可再生，丢失可接受」，
        实现里根本没有重建入口（注释与代码矛盾）。本方法把它补上。

        安全性质（都针对「别把好索引换成坏索引」）：
          · **先探一次嵌入**：不可用就直接返回，**原样保留旧表** —— 绝不先清空再失败；
          · 逐条 best-effort：单条拿不到向量就跳过并计数，不中断整体；
          · `_index_stale` 只在**确实写完**（无跳过）时才摘掉，否则保持置位。

        返回 {"ok", "written", "skipped", "total", "error"?}。
        """
        if not self._lancedb_enabled or not _LANCEDB_AVAILABLE:
            return {"ok": False, "written": 0, "skipped": 0, "total": 0,
                    "error": "LanceDB 未启用或不可用"}

        facts = [f for f in self._data.get("facts", [])
                 if isinstance(f, dict) and isinstance(f.get("content"), str)
                 and f["content"].strip()]

        
        if facts and _embed("reindex-probe") is None:
            logging.warning("[memory] reindex 中止：embedding 不可用，旧索引保持原样")
            return {"ok": False, "written": 0, "skipped": 0, "total": len(facts),
                    "error": "embedding 不可用（旧索引未改动）"}

        try:
            uri = self._lancedb_uri or str(_DATA_DIR / self.agent_id / "lancedb")
            db = lancedb.connect(uri)
            table_name = f"memory_{self.agent_id}"
            try:
                db.drop_table(table_name)
            except Exception:
                pass  
            table = db.create_table(table_name, schema=_memory_table_schema())
            self._lance_table = table

            written = 0
            skipped = 0
            batch: list[dict] = []
            for f in facts:
                vec = _embed(f["content"])
                if vec is None:
                    skipped += 1
                    continue
                tags = f.get("tags")
                batch.append({
                    "role": f.get("category", ""),
                    "content": f["content"],
                    "vector": vec,
                    "tags": ",".join(tags) if isinstance(tags, list) else (tags or ""),
                })
                if len(batch) >= batch_size:
                    table.add(batch)
                    written += len(batch)
                    batch = []
            if batch:
                table.add(batch)
                written += len(batch)

            
            self._index_stale = skipped > 0
            logging.info(
                f"[memory] reindex 完成: 写入 {written} 条 / 跳过 {skipped} 条 / 共 {len(facts)} 条")
            return {"ok": True, "written": written, "skipped": skipped, "total": len(facts)}
        except Exception as e:
            
            self._index_stale = True
            logging.warning(f"[memory] reindex 失败: {e}")
            return {"ok": False, "written": 0, "skipped": 0, "total": len(facts),
                    "error": str(e)}




def load_memory(agent_id: str, lancedb_enabled: bool = False,
                lancedb_uri: str = "", data_dir: str = "") -> MemoryStore:
    """加载指定 Agent 的记忆存储"""
    return MemoryStore(agent_id, lancedb_enabled, lancedb_uri, data_dir)


async def extract_memories_from_chat(
    memory: MemoryStore,
    user_msg: str,
    ai_reply: str,
    success: bool,
    llm_call_fn=None,
) -> dict:
    """
    从对话中提取成长记忆（使用 LLM 分析）。
    llm_call_fn 须为 async 函数 async fn(prompt) -> str。
    返回 dict：
      count / trait_signals / user_sentiment / behavior_patterns
    """
    if llm_call_fn is None:
        return {
            "count": {"facts": 0, "preferences": 0, "lessons": 0, "traits": 0},
            "trait_signals": [],
            "user_sentiment": 0.0,
            "behavior_patterns": [],
        }

    
    categories = ["fact", "preference", "lesson", "rule", "skill", "insight", "user_profile"]
    try:
        toml_path = _PROJECT_ROOT / "slime.toml"
        if toml_path.exists():
            import tomllib
            cats = tomllib.load(toml_path).get("memory", {}).get("categories", [])
            if cats:
                categories = cats
    except Exception:
        pass

    prompt = f"""分析以下对话，提取可存入 Agent 长期记忆的内容、Agent 展现的人格特征、用户情绪、以及可沉淀的行为模式。

用户消息: {user_msg}

AI 回复: {ai_reply}

可用分类（category 必须是以下之一）：{json.dumps(categories)}

请以 JSON 格式返回（只返回 JSON，不要其他内容）：
{{
    "entries": [
        {{
            "content": "用户喜欢用 Python 写脚本",
            "category": "preference",
            "tags": ["tooling", "language"],
            "importance": 8
        }}
    ],
    "traits_observed": [
        {{"name": "特征名（如 耐心、严谨）", "signal": 1 | -1}}
    ],
    "user_sentiment": 0.3,
    "behavior_patterns": [
        {{"scenario": "Python GUI 开发", "steps": ["安装 PySide6", "创建 QApplication", "设计主窗口", "绑定信号槽"], "rationale": "先搭骨架再填充细节，避免返工"}}
    ]
}}

说明：
- category 必须从可用分类列表中选取，选最接近的。没有则用 "fact"
- tags 自由标签数组（可空），用于细化分类
- importance: 1=琐碎, 5=一般, 10=非常重要
- traits_observed: signal=1 强化，-1 弱化
- user_sentiment: 用户对本次交互的情绪，-1.0（极度不满）~ +1.0（极度满意），0=中性，根据用户消息语气判断
- behavior_patterns: 本次交互中 Agent 展现的、可复用的「做事方式」。scenario 是任务场景名，steps 是 3-5 个具体操作步骤，rationale 是"为什么这样决策"的一句话理由（可空）。仅当对话中确实有可复用的方法/流程时才填，闲聊/纯问答返回空数组
- 只返回有把握的内容，没有则返回空数组/对象。"""

    try:
        result = await llm_call_fn(prompt)
        result = result.strip()
        if result.startswith("```"):
            result = result.split("```")[1]
            if result.startswith("json"):
                result = result[4:]
        data = json.loads(result)

        count = {"facts": 0, "preferences": 0, "lessons": 0}
        trait_signals = []

        
        for entry in data.get("entries", []):
            content = entry.get("content", "")
            if not content:
                continue
            cat = entry.get("category", "fact")
            
            if cat not in categories:
                cat = "fact"
            tags = entry.get("tags", [])
            imp = entry.get("importance", 5)
            await memory._store_categorized_async(cat, content, tags=tags, importance=imp)
            count["facts"] = count.get("facts", 0) + 1

        
        for fact in data.get("facts", []):
            await memory._store_categorized_async("fact", str(fact))
            count["facts"] += 1
        for key, value in data.get("preferences", {}).items():
            await memory._store_categorized_async("preference", f"{key}: {value}", tags=[key])
            count["preferences"] += 1
        for lesson in data.get("lessons", []):
            content = lesson.get("content", "")
            if not content:
                continue
            await memory._store_categorized_async("lesson", content,
                                                  importance=lesson.get("importance", 5),
                                                  extra={"success": lesson.get("success", True)})
            count["lessons"] += 1
        for t in data.get("traits_observed", []):
            trait_signals.append({"name": t.get("name", ""), "signal": t.get("signal", 1)})
        count["traits"] = len(trait_signals)

        
        try:
            user_sentiment = float(data.get("user_sentiment", 0.0))
        except (ValueError, TypeError):
            user_sentiment = 0.0
        user_sentiment = max(-1.0, min(1.0, user_sentiment))

        
        behavior_patterns = []
        for bp in data.get("behavior_patterns", []):
            if not isinstance(bp, dict):
                continue
            scenario = bp.get("scenario", "").strip()
            steps = [s for s in (bp.get("steps", []) or []) if isinstance(s, str) and s.strip()]
            if scenario and steps:
                behavior_patterns.append({
                    "scenario": scenario,
                    "steps": steps,
                    "rationale": bp.get("rationale", "").strip()[:200],
                })

        return {
            "count": count,
            "trait_signals": trait_signals,
            "user_sentiment": user_sentiment,
            "behavior_patterns": behavior_patterns,
        }
    except Exception as e:
        logging.warning(f"[memory] 记忆提取失败: {e}")
        return {
            "count": {"facts": 0, "preferences": 0, "lessons": 0, "traits": 0},
            "trait_signals": [],
            "user_sentiment": 0.0,
            "behavior_patterns": [],
        }