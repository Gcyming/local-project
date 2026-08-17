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

def _text_similarity(a: str, b: str) -> float:
    """简单文本相似度（Jaccard 词级）。ponytail: 够用，Add when 需要语义相似度。"""
    if not a or not b:
        return 0.0
    set_a = set(a.split())
    set_b = set(b.split())
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


def _mem_id(content: str) -> str:
    """记忆稳定 ID（content 哈希，幂等，用于双向链接）。"""
    return "mem_" + hashlib.md5(content.encode("utf-8")).hexdigest()[:8]


def _rank_by_relevance(items: list, context: str, content_key: str = "content") -> list:
    """按与上下文的词级相关性排序。"""
    if not context or not items:
        return items
    ctx_words = set(context.lower().split())
    if not ctx_words:
        return items

    def score(item):
        text = ""
        if isinstance(item, dict):
            text = item.get(content_key, "")
        else:
            text = str(item)
        item_words = set(text.lower().split())
        if not item_words:
            return 0
        # Jaccard + importance bonus
        relevance = len(ctx_words & item_words) / len(ctx_words | item_words)
        imp = item.get("importance", 5) if isinstance(item, dict) else 5
        return relevance * 10 + imp * 0.1

    return sorted(items, key=score, reverse=True)


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


def _embed(text: str) -> list[float]:
    """BGE-M3 向量（经 llama-server）；失败回退哈希。ponytail: 纯同步，2s 本地超时可接受。

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
    return _hash_embed(text)


def _hash_embed(text: str) -> list[float]:
    """字符级哈希占位向量（embedding 不可用时的降级方案）"""
    return [float(ord(c) % 256) / 256.0 for c in text[:_EMBED_DIM].ljust(_EMBED_DIM, " ")]


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
            table = db.create_table(
                table_name,
                data=[{"role": "", "content": "", "vector": [0.0] * _EMBED_DIM, "tags": ""}],
            )
        vec = _embed(content)
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
            try:
                self._data = json.loads(self._json_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as e:
                logging.warning(f"[memory] 加载 {self._json_path} 失败: {e}，使用空记忆")
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
        """保存记忆到 JSON（原子写入）"""
        self._data["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._json_path.parent.mkdir(parents=True, exist_ok=True)
        import os, tempfile, uuid
        data = json.dumps(self._data, ensure_ascii=False, indent=2)
        tmp_path = self._json_path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
        tmp_path.write_text(data, encoding="utf-8")
        os.replace(tmp_path, self._json_path)

    # ── 读写接口 ───────────────────────────────────────────

    def _store_categorized(self, category: str, content: str, tags: list | None = None,
                           importance: int = 5, extra: dict | None = None):
        """统一分类存储：去重 + JSON + LanceDB（含 per-agent 锁）"""
        with self._lock:
            self._store_categorized_locked(category, content, tags, importance, extra)

    async def _store_categorized_async(self, category: str, content: str,
                                       tags: list | None = None, importance: int = 5,
                                       extra: dict | None = None):
        """async 版本：用 to_thread 包裹同步存储，避免阻塞事件循环（N11-P2-8）"""
        await asyncio.to_thread(
            self._store_categorized, category, content, tags, importance, extra
        )

    def _store_categorized_locked(self, category: str, content: str, tags: list | None,
                                   importance: int = 5, extra: dict | None = None):
        """锁内实际写入逻辑。BUG-003: 写入时建立双向链接（tags 重叠自动关联）。"""
        tags = tags or []
        # 去重：检查同 category 内相似度 >75% 的事实（N11-P2-10）
        for existing in self._data.get("facts", []):
            if existing.get("category") != category:
                continue
            if _text_similarity(content.lower(), existing.get("content", "").lower()) > 0.75:
                existing["repeated"] = existing.get("repeated", 0) + 1
                self._save()
                return

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
            ) > 0.3:
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
        if self._lancedb_enabled:
            try:
                self._init_lancedb()
                if self._lance_table is not None:
                    vec = _embed(content)
                    self._lance_table.add([{
                        "role": category,
                        "content": content,
                        "vector": vec,
                        "tags": ",".join(tags),
                    }])
            except Exception as e:
                logging.warning(f"[memory] LanceDB store 失败: {e}")

    def add_fact(self, fact: str, importance: int = 5):
        """添加事实知识"""
        self._store_categorized("fact", fact, importance=importance)

    def add_preference(self, key: str, value: str):
        """添加/更新用户偏好（按 key 精确去重）"""
        with self._lock:
            content = f"{key}: {value}"
            for f in self._data.get("facts", []):
                if f.get("category") == "preference" and f.get("tags") and f["tags"][0] == key:
                    f["content"] = content
                    f["importance"] = max(f.get("importance", 5), 6)
                    f["timestamp"] = datetime.now(timezone.utc).isoformat()
                    self._save()
                    return
            self._store_categorized_locked("preference", content, tags=[key], importance=6)

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
                            f"[memory] 向量维度不匹配（表: {dim_attr}, 当前: {_EMBED_DIM}），"
                            f"重建表（记忆可再生，丢失可接受）"
                        )
                        db.drop_table(table_name)
                        self._lance_table = db.create_table(
                            table_name,
                            data=[{"role": "", "content": "", "vector": [0.0] * _EMBED_DIM, "tags": ""}],
                        )
                # V1: 检查已有表是否缺 tags 字段（旧 schema 无此列）
                field_names = {f.name for f in self._lance_table.schema}
                if "tags" not in field_names:
                    logging.warning(
                        f"[memory] 旧表缺 tags 字段，重建表"
                    )
                    db.drop_table(table_name)
                    self._lance_table = db.create_table(
                        table_name,
                        data=[{"role": "", "content": "", "vector": [0.0] * _EMBED_DIM, "tags": ""}],
                    )
            except Exception:
                self._lance_table = db.create_table(
                    table_name,
                    data=[{"role": "", "content": "", "vector": [0.0] * _EMBED_DIM, "tags": ""}],
                )
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