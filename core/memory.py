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
_KNOWLEDGE_MEMORY_DIR = _PROJECT_ROOT / "Knowledge" / "Agent Memory"  # 新默认：外置大脑

# A-112: agent_id 仅允许安全字符（防御路径遍历；空串放行 = global 语义）
_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_agent_id(agent_id: str):
    """agent_id 格式校验：非法立即抛错，避免拼接路径逃逸出 agent 目录"""
    if agent_id and not _AGENT_ID_RE.match(agent_id):
        raise ValueError(f"[memory] 非法 agent_id: {agent_id!r}")


# ── 辅助函数 ────────────────────────────────────────────────

# A-1139：CJK 连续段（中日韩）。中文没有空格，空白分词对中文恒为 1 个 token。
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
        v = abs(float(emotion.get("valence", 0.0) or 0.0))   # -1~1 → 0~1
        a = min(1.0, max(0.0, float(emotion.get("arousal", 0.0) or 0.0)))  # 0~1
        boost = int(round(2.0 * v * (0.5 + a)))              # 强度 → 0~3
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
        # Jaccard + importance bonus
        relevance = _text_similarity(context, text)
        imp = item.get("importance", 5) if isinstance(item, dict) else 5
        return relevance * 10 + imp * 0.1

    return sorted(items, key=score, reverse=True)


# ── 相似度阈值（A-1139 校准）──────────────────────────────
# 依据：真实语料 15 组「同模板应合并」对 / 285 组「不同模板不应合并」对，
# 对 _tokens 的 V3 方案做阈值扫描（temp_test_dir/probe_threshold_sweep.py）。
#   · 去重 0.75：召回 0.867 / 误判 9/285（F1 0.703）。**刻意保召回不保精度** ——
#     这个问题上的代价是不对称的：漏合并 = 垃圾永久累积（实测已累积 11658 条
#     lesson 而只有 25 条不同内容），误合并 = 少存一条。0.80 虽然 F1 更高（0.800）
#     但召回掉到 0.800，故不采用。
#   · 建链 0.70：原值 0.3 在中文下从未生效；换 V3 后 0.3 会误链 42%（120/285）。
#     0.70 把误链压到 16%，同时保住同模板族的连通。注意两分布**有重叠**
#     （不应合并 max=0.882 ≈ 同模板 max=0.889），不存在完美阈值。
_DEDUP_THRESHOLD = 0.75
_LINK_THRESHOLD = 0.70

# ── 艾宾浩斯遗忘 ──────────────────────────────────────────
_EBBINGHAUS_TAU = 5.0  # 遗忘半衰期（天）

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

# ── 成长型记忆结构 ────────────────────────────────────────

MEMORY_TEMPLATE = {
    "facts": [],           # 学到的事实知识
    "preferences": [],     # 用户偏好
    "skills_unlocked": [], # 解锁的技能
    "lessons": [],         # 经验教训
    "created_at": None,
    "updated_at": None,
}

# ── LanceDB（可选）─────────────────────────────────────────

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


# 简易向量维度（字符级哈希占位；从 slime.toml [model_server.embedding].dim 读取）
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
    # A-1139：**不再回退伪嵌入**。返回 None，让调用方显式走「无向量」分支
    # （跳过向量写入 / recall 返回空 → 回落 JSON 关键词）。原 _hash_embed 已删除：
    # 它产出的向量让任意两段无关文本余弦都在 0.94~0.99，等价于噪声，却伪装成成功。
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
            # A-1139：无向量可用（BGE-M3 不可达）→ 不写，让调用方知道没成功
            return False
        table.add([{"role": role, "content": content, "vector": vec, "tags": ""}])
        return True
    except Exception as e:
        logging.warning(f"[memory] 知识向量化失败: {e}")
        return False


class MemoryStore:
    """Agent 成长型记忆存储"""

    def __init__(self, agent_id: str, lancedb_enabled: bool = False, lancedb_uri: str = "",
                 data_dir: str = ""):
        _validate_agent_id(agent_id)
        self.agent_id = agent_id
        # 相对路径锚定项目根
        base = Path(data_dir) if data_dir else _KNOWLEDGE_MEMORY_DIR
        if not base.is_absolute():
            base = _PROJECT_ROOT / base
        self._json_path = base / agent_id / "memory.json"
        self._data: dict = {}
        self._lancedb_enabled = lancedb_enabled and _LANCEDB_AVAILABLE
        self._lancedb_uri = lancedb_uri or str(_DATA_DIR / agent_id / "lancedb")  # LanceDB 保持原位
        self._lance_table = None
        # A-1139（D4）：索引与 JSON 失配的标记。
        # JSON 是唯一真相源，LanceDB 只是**派生索引**；但此前二者是「双写且无对账」——
        # 索引写失败、进程被杀、或因维度/字段不匹配 drop_table 之后，索引就永久少一截，
        # 而**没有任何信号**告诉调用方「你现在的语义召回是残缺的」。
        # 本标记就是那个信号：置位 = 索引不完整，应调 `reindex()` 从 JSON 重灌。
        self._index_stale = False
        import threading
        self._lock = threading.Lock()  # N9-H9: per-agent 写锁防并发覆盖
        self._load()

    # ── JSON 存储 ──────────────────────────────────────────

    def _load(self):
        """从 JSON 加载记忆，优先新位置，自动从旧位置迁移"""
        new_path = self._json_path
        old_path = _DATA_DIR / self.agent_id / "memory.json"
        # 迁移：旧位置有数据但新位置没有 → 复制到新位置
        if old_path.exists() and not new_path.exists():
            try:
                new_path.parent.mkdir(parents=True, exist_ok=True)
                import shutil
                shutil.move(str(old_path), str(new_path))
                logging.info(f"[memory] 已从 {old_path} 迁移到 {new_path}")
            except OSError as e:
                logging.warning(f"[memory] 迁移失败: {e}")
        if new_path.exists():
            # A-989：主文件损坏时回退 .bak（上一份完好记忆），并把坏文件改名 .corrupt 留证。
            # 此前解析失败就直接换成空模板 = 静默丢掉用户全部记忆。
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
        # BUG-005: 老数据补填 last_accessed（fallback 到 timestamp）
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

    # ── 读写接口 ───────────────────────────────────────────

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
            # A-1139：无向量就只留 JSON（真相源），不往索引里塞半条
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
        """
        tags = tags or []
        # 去重：检查同 category 内相似度 >75% 的事实（N11-P2-10）
        for existing in self._data.get("facts", []):
            if existing.get("category") != category:
                continue
            if _text_similarity(content.lower(), existing.get("content", "").lower()) > _DEDUP_THRESHOLD:
                existing["repeated"] = existing.get("repeated", 0) + 1
                self._save()
                return False  # A-1139：去重命中 ⇒ 没有新条目，调用方不必写索引

        new_id = _mem_id(content)
        tag_set = set(tags)
        links = []
        # 自动关联：tags 重叠 OR 内容相似（BUG-011: 无 tags 时用内容相似度兜底）
        for existing in self._data.get("facts", []):
            if existing.get("id") == new_id:
                continue
            existing_tags = set(existing.get("tags", []))
            linked = False
            if tag_set and (tag_set & existing_tags):
                linked = True
            elif not tag_set and _text_similarity(
                content.lower(), existing.get("content", "").lower()
            ) > _LINK_THRESHOLD:
                linked = True
            if linked:
                links.append(existing["id"])
                existing.setdefault("backlinks", [])
                if new_id not in existing["backlinks"]:
                    existing["backlinks"].append(new_id)
                # BUG-014: 关联访问刷新旧记忆 last_accessed（越用越熟）
                existing["last_accessed"] = datetime.now(timezone.utc).isoformat()

        self._data.setdefault("facts", []).append({
            "id": new_id,
            "content": content,
            "category": category,
            "tags": tags,
            "importance": max(1, min(10, importance)),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "last_accessed": datetime.now(timezone.utc).isoformat(),  # 艾宾浩斯遗忘
            "links": links,        # 主动引用的记忆 ID（BUG-003）
            "backlinks": [],       # 被引用的记忆 ID（自动维护）
            "repeated": 0,
            **(extra or {}),
        })
        self._save()
        # A-1139（D3）：向量索引**不在这里做** —— 嵌入是同步 HTTP 往返（timeout 2s），
        # 不能占着 per-agent 锁。由调用方 `_store_categorized` 在出锁后经 `_index_vector` 补写。
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
            stored = self._store_categorized_locked("preference", content, tags=tags, importance=6)
        # A-1139（D3）：索引在**锁外**补写 —— 与 `_store_categorized` 同口径。
        # 本函数是唯一绕过 `_store_categorized` 直接调 `_store_categorized_locked` 的路径；
        # 向量写入随 D3 拆走后若不在这里补这一步，偏好就会永久不进语义索引
        #（静默失效：功能「在」，只是再也搜不到）。
        if stored:
            self._index_vector("preference", content, tags)

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
        # 过滤脏数据：只保留含 content 的 dict（提前过滤，供索引复用）
        facts = [f for f in self.get_facts() if isinstance(f, dict) and isinstance(f.get("content"), str)]

        # 艾宾浩斯：按有效权重排序（遗忘因子 × 相关性），沉睡记忆沉底但可唤醒
        ranked = sorted(facts, key=lambda f: _effective_weight(f, context), reverse=True)
        selected = ranked[:max_items]
        # 被访问的记忆更新 last_accessed（越用越熟）
        for f in selected:
            f["last_accessed"] = datetime.now(timezone.utc).isoformat()

        # 索引（BUG-009: 用 dict 索引替代 O(N²) 遍历）
        content_to_fact = {f["content"]: f for f in facts}
        id_to_fact = {f.get("id"): f for f in facts if f.get("id")}
        known = {f["content"] for f in facts}

        # LanceDB 语义检索（可选，补充关键词遗漏的条目）
        semantic_items = []
        seeds = []
        if context and self._lancedb_enabled:
            try:
                recalled = self.recall(context, top_k=max_items)
                semantic_items = [r for r in recalled if r.get("content", "") not in known]
                seeds = recalled
            except Exception:
                pass  # LanceDB 不可用时静默跳过，不影响主流程

        # 图谱联想（BUG-006: 不依赖 LanceDB；种子优先向量召回，fallback 到 ranked 前 3）
        graph_items = []
        if context:
            # BUG-012: 对 seeds 按 content 去重，避免重复 content 导致索引覆盖
            unique_seeds = []
            seen_seed_contents = set()
            for s in seeds:
                c = s.get("content", "")
                if c and c not in seen_seed_contents:
                    seen_seed_contents.add(c)
                    unique_seeds.append(s)
            seed_facts = [content_to_fact.get(s.get("content", "")) for s in unique_seeds]
            seed_facts = [f for f in seed_facts if f]
            if not seed_facts:
                seed_facts = selected[:3]
            seen = set()
            for seed_fact in seed_facts:
                for link_id in seed_fact.get("links", []) + seed_fact.get("backlinks", []):
                    linked = id_to_fact.get(link_id)
                    # BUG-007/008: content 非空且不在已知主 facts 中
                    if (linked and linked.get("id") not in seen
                            and linked.get("content", "") not in known):
                        seen.add(linked["id"])
                        graph_items.append(linked)

        if selected or semantic_items or graph_items:
            lines = [f"- [{f.get('category', 'fact')}] {f['content']}" for f in selected]
            # 追加图谱联想结果（带来源标记）
            for gf in graph_items[:3]:
                lines.append(f"- [关联] {gf['content']}")
            # 追加语义检索结果（带来源标记）
            for item in semantic_items[:3]:
                lines.append(f"- {item['content']}")
            parts.append("## 已知事实\n" + "\n".join(lines))
        prefs = self.get_preferences()
        if prefs:
            parts.append("## 用户偏好\n" + "\n".join(f"- {k}: {v}" for k, v in list(prefs.items())[:max_items]))
        skills = self.get_skills()
        if skills:
            parts.append("## 已解锁技能\n" + "\n".join(f"- {s}" for s in skills[:max_items]))
        lessons = self.get_lessons(limit=max_items * 2)
        if lessons:
            ranked_lessons = sorted(lessons, key=lambda l: _effective_weight(l, context), reverse=True)
            parts.append("## 经验教训\n" + "\n".join(
                f"- [{'成功' if l['success'] else '失败'}] {l['content']}"
                for l in ranked_lessons[:max_items]
            ))
        return "\n\n".join(parts)

    def to_dict(self) -> dict:
        import copy
        return copy.deepcopy(self._data)  # N11-P2-9: 深拷贝，防调用方篡改内部状态

    # ── LanceDB 接口（可选，默认关闭）──────────────────────

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
                # H3: 检查已有表的向量维度是否匹配当前 _EMBED_DIM
                schema = self._lance_table.schema
                vec_field = next((f for f in schema if f.name == "vector"), None)
                if vec_field and hasattr(vec_field, 'type'):
                    dim_attr = (getattr(vec_field.type, 'list_size', None)  # pyarrow FixedSizeListType
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
                # V1: 检查已有表是否缺 tags 字段（旧 schema 无此列）
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
                return False  # A-1139：无向量可用，不写半条
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
        # A-027: 新加载的 store 尚未初始化 LanceDB 表 —— 此前此处直接返回 []，
        # 导致 /memory/recall 与 summary() 的语义召回全链路静默失效
        # （API 每次请求都是新 store，仅剩词级回退，BGE-M3 向量形同虚设）
        if self._lance_table is None:
            self._init_lancedb()
        if self._lance_table is None:
            return []
        try:
            vec = _embed(query)
            # A-1139：查询向量拿不到 → 返回空，让调用方回落 JSON 关键词检索
            #（此前会拿伪嵌入去搜，返回一堆「看起来 98% 相似」的噪声且不报错）
            if vec is None:
                logging.info("[memory] embedding 不可用，语义召回跳过（回落关键词）")
                return []
            q = self._lance_table.search(vec)
            if categories:
                # 单引号转义防注入
                safe_cats = [c.replace("'", "''") for c in categories]
                cat_filter = " OR ".join(f"role = '{c}'" for c in safe_cats)
                q = q.where(cat_filter)
            results = q.limit(top_k).to_list()
            return [{"role": r.get("role", ""), "content": r.get("content", ""),
                     "tags": r.get("tags", "")} for r in results
                    if r.get("content", "").strip()]  # 过滤种子行
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

        # ① 探针：嵌入不可用就放弃，**不动旧表**（旧索引可能仍是好的）
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
                pass  # 原本就没有这张表
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

            # 有跳过 ⇒ 索引仍不完整，stale 标记保持置位（不谎报「已完全对上」）
            self._index_stale = skipped > 0
            logging.info(
                f"[memory] reindex 完成: 写入 {written} 条 / 跳过 {skipped} 条 / 共 {len(facts)} 条")
            return {"ok": True, "written": written, "skipped": skipped, "total": len(facts)}
        except Exception as e:
            # 失败时**如实置 stale** —— 索引此刻确实不可信
            self._index_stale = True
            logging.warning(f"[memory] reindex 失败: {e}")
            return {"ok": False, "written": 0, "skipped": 0, "total": len(facts),
                    "error": str(e)}


# ── 便捷函数 ──────────────────────────────────────────────

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

    # 读取分类枚举配置
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

        # 新格式 entries（优先）
        for entry in data.get("entries", []):
            content = entry.get("content", "")
            if not content:
                continue
            cat = entry.get("category", "fact")
            # 归一化：不在枚举内 → 兜底 fact
            if cat not in categories:
                cat = "fact"
            tags = entry.get("tags", [])
            imp = entry.get("importance", 5)
            await memory._store_categorized_async(cat, content, tags=tags, importance=imp)
            count["facts"] = count.get("facts", 0) + 1

        # 旧格式兼容：facts / preferences / lessons
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

        # 用户情绪（BUG-002）
        try:
            user_sentiment = float(data.get("user_sentiment", 0.0))
        except (ValueError, TypeError):
            user_sentiment = 0.0
        user_sentiment = max(-1.0, min(1.0, user_sentiment))

        # 行为模式（BUG-001/019）：只保留有有效步骤的，携带 decision_rationale
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