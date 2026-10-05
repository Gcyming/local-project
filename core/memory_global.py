"""跨 agent 全局去重索引（设计 docs/slime-agent-loop-design.md §3.2 配套第 1 条）。

背景：写入去重此前是 **per-agent** 的 —— 每个 subagent 有自己的 `memory.json`，
跨 agent 永不收敛。实测（设计 §3.1）：9799 个 agent 目录 / 11796 条记忆，
11658 条 lesson 里只有 25 条不同内容（99.8% 是重复），最高频单条重复 2008 次。

## 这不是第二个真相源

真相源永远是各 agent 的 `memory.json`。本模块维护的是一个**派生索引**：
  · 结构上：只存摘要（agent / content / category / tokens），不存权威状态；
  · 行为上：`rebuild()` 可以从各 agent 的 memory.json 完整重建，坏掉不需要人工干预；
  · 读路径上：索引只用于「**抑制重复写入**」这一个判断，任何取不到索引的场景
    都退回 per-agent 去重（best-effort），不会因为索引丢失而拒绝写入。
    → 索引丢了的后果是「重复又多写了」，不是「记忆消失了」。

## 为什么不需要每次写入都全量扫盘

  · 索引落盘在 `<记忆根目录>/.global/index.json`，进程内**单例**缓存（按目录 key）；
  · 只有「TTL 到期（默认 30s）」或「顶层 agent 目录集合发生变化」才重新扫盘；
  · 期间的写入由 `upsert()` / `note_hit()` 增量维护内存态；
  · 跨进程的漏检**会自愈**：下一个 TTL 周期必然扫到别人的新文件。
    所以这里可以放心用「有界陈旧」换掉每次写入的全量 IO。
  · 扫描本身只对 (mtime, size) 变了的文件才真正读取（快路径只是一堆 stat）。

## 并发写怎么不出错

  · 进程内 `threading.Lock`（与 `MemoryStore._lock` 是**两把不同的锁**）：
    写路径的顺序恒为「先取 per-agent 锁、放掉，再取全局索引锁」，不存在反向顺序，
    所以不会死锁；
  · 「读-改-写」在锁内做，且写入前若发现文件 mtime 与自己上次落盘的不同，
    会重新载入磁盘内容再合并（避免把别的进程刚写的条目覆盖掉）；
  · 落盘走 `core.safe_io.atomic_write_text`（tmp + fsync + replace）：要么旧文件、
    要么新文件，永不半截；
  · 竞态窗口（两个进程同时写）容忍：极端并发下可能丢几条全局索引项，
    下一次 `_refresh()` 会从真相源扫回来。

## 参数（slime.toml [memory]，两侧同源）

    [memory]
    cross_agent_dedup = true    # 开关；关掉则完全退回 per-agent 行为
    global_index_ttl_s = 30     # 索引重新扫盘的间隔
    dedup_threshold = 0.75      # 去重判据（⚠️ 不能下调：不同工具模板条目约 0.74）
    merge_threshold = 0.60      # 达到此线但未到去重线 → 合并进已有条目
    max_entries = 2000          # 单 agent 活跃条目上限，超出走替换/合并

## 隔离（**模块自身的保证，不靠调用方自觉**）

`.global/index.json` 是**这台机器上共享的一份文件**。隔离场景（测试夹具、评测运行、
沙箱子进程、临时记忆根）一旦拿到它，就能读走生产条目、把隔离内容写进生产索引，
甚至 `rebuild()` 把整份索引按一个不该扫的目录重写掉。所以隔离判定**收进本模块**，
每个公开入口自己先过一遍 `_isolation_gate()`，再谈业务逻辑：

  · 判定的唯一产地是 `_resolve_isolation()`，优先级：
    显式入参 > 进程级闩锁（`set_isolation`）> 环境变量 `SLIME_MEMORY_ISOLATED`
    > 记忆根目录里的标记文件 `.memory-isolated`；
  · 全部不命中 → **不隔离**（生产默认，跨 agent 去重照常全速跑）；
  · 隔离态下：`get_global_index()` 直接返回 `None`（调用方根本拿不到索引对象，
    写入路径自然退回 per-agent 去重）；即使有人绕过它直接构造 `GlobalMemoryIndex`，
    `check`/`upsert`/`note_retired`/`lookup`/`recall`/`stats`/`rebuild` 全部惰性，
    `refresh`/`loadFile`/`persist` 也一律不碰磁盘 —— 「隔离目录里一个字节都不落」。
  · 单例 key **仍是** `str(Path(base_dir).resolve())`（与 TS 侧 `globalIndexKey()`
    逐字节相同）；隔离与否不参与 key，因为它由 `get_global_index` 在**取单例之前**
    就判定完了 —— 隔离开关一变，下次取到的就是另一回事，不会拿到旧单例的内存态。
  · 闩锁只能加严不能放宽：进程内调用方无法靠传参把隔离顶回「不隔离」。
"""

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DEDUP_THRESHOLD_DEFAULT = 0.75


GLOBAL_DIR_NAME = ".global"
GLOBAL_INDEX_FILE = "index.json"

GLOBAL_INDEX_VERSION = 1

DEFAULT_GLOBAL_INDEX_TTL_S = 30

RETIRED_PREFIX = "retired:"
SHARED_PREFIX = "shared:"

ISOLATION_ENV_VAR = "SLIME_MEMORY_ISOLATED"
ISOLATION_MARKER_NAME = ".memory-isolated"
_TRUTHY_ISOLATION = frozenset({"1", "true", "yes", "on"})

_token_cache: dict = {}
_TOKEN_CACHE_MAX = 20000

_isolation_lock = threading.Lock()
_isolation_latched = False
_isolation_reason = ""


def set_isolation(enabled: bool, reason: str = "") -> bool:
    """进程级隔离开闩。合上后本进程内**任何**记忆根目录都拿不到全局索引。

    返回 True 表示闩锁状态确实变了（重复设置同一个值不算变化）。
    闩锁只能由 `reset_isolation()` 打开 —— 隔离是「加严」方向的单向门，
    进程内任何一个调用方都无法靠传参把它顶回「不隔离」。
    """
    global _isolation_latched, _isolation_reason
    with _isolation_lock:
        changed = _isolation_latched != bool(enabled)
        _isolation_latched = bool(enabled)
        _isolation_reason = str(reason or "")
    return changed


def reset_isolation() -> bool:
    """松开进程级隔离开闩（**只清闩锁**，不碰环境变量 / 标记文件 —— 那不是本进程能替人决定的事）。"""
    return set_isolation(False)


def isolation_state(base_dir=None) -> dict:
    """隔离判定的**唯一产地**的可观测形式：`{"isolated": bool, "reason": str}`。

    优先级（先命中者生效）：进程级闩锁 > 环境变量 > 目录标记文件 > 显式入参。
    显式入参只能加严（`True`），`False` 等同于「声明默认」，顶不掉任何已生效的隔离。
    全部不命中 → 不隔离（生产默认）。
    """
    isolated, reason = _resolve_isolation(base_dir)
    return {"isolated": isolated, "reason": reason}


def is_isolated(base_dir=None) -> bool:
    return _resolve_isolation(base_dir)[0]


def _env_isolation() -> bool:
    return str(os.environ.get(ISOLATION_ENV_VAR, "")).strip().lower() in _TRUTHY_ISOLATION


def _resolve_isolation(base_dir, explicit: Optional[bool] = None) -> tuple[bool, str]:
    """隔离判定的唯一产地 —— 谁都不能绕过它直接去摸 `.global/index.json`。

    **单向棘轮**：显式参数只能把判定推向「隔离」，**不能**把已经在生效的隔离顶掉。
    也就是说 `explicit=False` 不是「解除隔离」，只是「声明默认」——
    否则调用方传一个 `isolated=False` 就能把闩锁 / 环境变量 / 标记文件全部作废，
    「模块自身的保证」当场退化成「调用方自觉」。
    """
    latched = False
    latch_reason = ""
    with _isolation_lock:
        latched = _isolation_latched
        latch_reason = _isolation_reason
    if latched:
        return True, latch_reason or "process-latch"
    if _env_isolation():
        return True, f"env:{ISOLATION_ENV_VAR}"
    try:
        if base_dir and (Path(base_dir) / ISOLATION_MARKER_NAME).exists():
            return True, f"marker:{ISOLATION_MARKER_NAME}"
    except OSError:
        pass
    if explicit:
        return True, "explicit"
    return False, ""


def _entry_key(content: str) -> str:
    """索引内条目键 = 内容哈希（与 memory.py 的 _mem_id 同源）。"""
    import hashlib
    return hashlib.md5(content.encode("utf-8")).hexdigest()[:12]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _entry_status(item: dict) -> str:
    """归档条目的去重状态：`retired` 可以重新写入；`shared` 是跨 agent 指针。"""
    return str(item.get("status") or "")


def _index_dir_for(base_dir) -> Path:
    """索引目录 = 记忆根目录下的 `.global/`（隐藏目录，不与 agent_id 目录抢名字）。"""
    return Path(base_dir) / GLOBAL_DIR_NAME


def _token_cache_get(content: str) -> Optional[set]:
    """按内容缓存 token 集合 —— 同一条内容在一次刷新里会被比较很多次。"""
    from core.memory import _tokens
    hit = _token_cache.get(content)
    if hit is not None:
        return hit
    toks = _tokens(content)
    if len(_token_cache) < _TOKEN_CACHE_MAX:
        _token_cache[content] = toks
    return toks


def _scan_memory_files(base_dir: Path) -> dict:
    """扫顶层 agent 目录，返回 {agent_id: (Path, mtime, size)}（只 stat，不读内容）。"""
    out: dict = {}
    try:
        children = list(os.scandir(base_dir))
    except OSError:
        return out
    for child in children:
        try:
            if not child.is_dir() or child.name.startswith("."):
                continue
        except OSError:
            continue
        mp = Path(child.path) / "memory.json"
        try:
            st = mp.stat()
        except OSError:
            continue
        out[child.name] = (mp, st.st_mtime, st.st_size)
    return out


class GlobalMemoryIndex:
    """派生索引：内容 → 归属 agent（用于跨 agent 去重判据）。"""

    def __init__(self, base_dir, ttl_s: float = DEFAULT_GLOBAL_INDEX_TTL_S,
                 isolated: Optional[bool] = None):
        self.base_dir = Path(base_dir)
        self.index_dir = _index_dir_for(self.base_dir)
        self.path = self.index_dir / GLOBAL_INDEX_FILE
        self.ttl_s = float(ttl_s)
        self._forced_isolated = None if isolated is None else bool(isolated)
        self._lock = threading.Lock()
        self._entries: dict = {}
        self._inverted: dict = {}
        self._files: dict = {}
        self._last_scan = 0.0
        self._last_write_mtime = 0.0
        self._loaded = False

    @property
    def isolated(self) -> bool:
        """实时判定（闩锁/环境变量/标记文件任一变化立刻生效，不靠重启进程）。"""
        return _resolve_isolation(self.base_dir, self._forced_isolated)[0]

    @property
    def isolation_reason(self) -> str:
        return _resolve_isolation(self.base_dir, self._forced_isolated)[1]

    def _isolation_gate(self) -> bool:
        """隔离态 → True。**每个**公开入口的第一行都必须是它。

        放在模块内部而不是只在 `get_global_index` 里判，是因为 `get_global_index`
        只是众多入口之一：审计脚本、运维工具、任何直接 `GlobalMemoryIndex(...)`
        构造的代码都必须被同一道门挡住，而不是靠调用方记得传参。
        """
        return self.isolated

    def _entry_tokens(self, entry: dict) -> set:
        toks = entry.get("_tokens")
        if toks is None:
            toks = _token_cache_get(entry.get("content", ""))
            entry["_tokens"] = toks
        return toks

    def _reindex(self) -> None:
        inv: dict = {}
        for key, entry in self._entries.items():
            for tok in self._entry_tokens(entry):
                inv.setdefault(tok, []).append(key)
        self._inverted = inv

    def _put(self, entry: dict) -> None:
        key = entry["key"]
        self._entries[key] = entry

    def _load_file(self) -> bool:
        """载入落盘的索引；坏文件/缺文件都只记 warning，返回 False（不是致命错误）。

        ⚠️ 载入失败时**不动** `self._entries`（调用方决定是清空重建还是保留现状）——
        否则「落盘前重新载入」这条路径会把刚刚算好的内存态清成空。
        """
        if not self.path.exists():
            return False
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            logging.warning(f"[memory] 全局索引不可读（将从各 agent memory.json 重建）: {e}")
            return False
        if not isinstance(raw, dict) or raw.get("version") != GLOBAL_INDEX_VERSION:
            return False
        entries = raw.get("entries")
        if not isinstance(entries, dict):
            return False
        loaded: dict = {}
        for key, entry in entries.items():
            if isinstance(entry, dict) and isinstance(entry.get("content"), str):
                entry["key"] = key
                entry["_tokens"] = None
                loaded[key] = entry
        self._entries = loaded
        try:
            self._last_write_mtime = self.path.stat().st_mtime
        except OSError:
            self._last_write_mtime = 0.0
        self._reindex()
        return True

    def _reload_if_changed(self) -> None:
        """锁内调用：只有「磁盘上的索引比自己上次写的更新」才重新载入。

        载入失败（文件损坏）时**清掉指纹缓存**，让下一次 `_refresh` 从各 agent 的
        memory.json 重扫 —— 这正是「派生索引坏掉要能自愈」的那一步。
        """
        try:
            disk_mtime = self.path.stat().st_mtime
        except OSError:
            return
        if disk_mtime <= self._last_write_mtime:
            return
        if not self._load_file():
            self._files = {}
            self._reindex()

    def _ingest_agent(self, agent_id: str, mtime: float, size: int, path: Path,
                      changed_only: bool = True) -> None:
        stamp = self._files.get(agent_id)
        if changed_only and stamp == (mtime, size):
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            logging.warning(f"[memory] 全局索引跳过 {path}（读不动）: {e}")
            return
        if not isinstance(raw, dict):
            return

        for key, entry in list(self._entries.items()):
            if entry.get("agent") == agent_id:
                self._entries.pop(key, None)

        for item in raw.get("facts", []):
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            status = _entry_status(item)
            if status.startswith(RETIRED_PREFIX) or status.startswith(SHARED_PREFIX):
                continue
            key = _entry_key(content)
            prev = self._entries.get(key)
            if prev is not None:
                prev["hits"] = int(prev.get("hits", 0)) + 1
                continue
            self._entries[key] = {
                "key": key,
                "agent": agent_id,
                "mem_id": item.get("id") or "",
                "content": content,
                "category": item.get("category") or "fact",
                "importance": item.get("importance", 5),
                "timestamp": item.get("timestamp") or "",
                "hits": int(item.get("repeated", 0) or 0),
                "_tokens": None,
            }
        self._files[agent_id] = (mtime, size)

    def _refresh(self, force: bool = False) -> None:
        """有界陈旧的核心：TTL 内 + agent 目录集合没变 → 直接返回，不扫盘。"""
        import time
        if self._isolation_gate():
            return
        now = time.monotonic()
        if not force and self._loaded and (now - self._last_scan) < self.ttl_s:
            return
        if not self._loaded:
            self._load_file()
            self._loaded = True

        files = _scan_memory_files(self.base_dir)
        if set(files) == set(self._files):
            for agent_id, (path, mtime, size) in files.items():
                self._ingest_agent(agent_id, mtime, size, path)
        else:
            removed = set(self._files) - set(files)
            for agent_id in removed:
                for key, entry in list(self._entries.items()):
                    if entry.get("agent") == agent_id:
                        self._entries.pop(key, None)
                self._files.pop(agent_id, None)
            for agent_id, (path, mtime, size) in files.items():
                self._ingest_agent(agent_id, mtime, size, path)

        self._reindex()
        self._last_scan = now

    def _persist_locked(self) -> bool:
        """锁内落盘（原子写 + 先合并磁盘上的新内容，避免覆盖别的进程刚写的条目）。"""
        if self._isolation_gate():
            return False
        self._reload_if_changed()
        payload = {
            "version": GLOBAL_INDEX_VERSION,
            "updated_at": _now_iso(),
            "derived": True,
            "note": "派生索引，真相源是各 agent 的 memory.json；删掉本文件可自动重建。",
            "entries": {
                key: {k: v for k, v in entry.items() if not k.startswith("_")}
                for key, entry in self._entries.items()
            },
        }
        try:
            self.index_dir.mkdir(parents=True, exist_ok=True)
            from core.safe_io import atomic_write_text
            atomic_write_text(self.path, json.dumps(payload, ensure_ascii=False, indent=1))
        except Exception as e:
            logging.warning(f"[memory] 全局索引落盘失败（不影响写入，下次重建）: {e}")
            return False
        try:
            self._last_write_mtime = self.path.stat().st_mtime
        except OSError:
            self._last_write_mtime = 0.0
        return True

    # ---- 公开接口 -------------------------------------------------------

    def check(self, content: str, exclude_agent: str = "", threshold: float = DEDUP_THRESHOLD_DEFAULT) -> Optional[dict]:
        """跨 agent 查重：命中返回 {agent, mem_id, content, score, key}，否则 None。

        用倒排索引剪枝：Jaccard = |A∩B| / |A∪B| ≥ t 蕴含 |A∩B| ≥ t·|A|
        （因为 |A∪B| ≥ |A|），所以只比较「与候选共享 token 数 ≥ t·|A|」的条目 ——
        这是**充分**剪枝，不会漏掉真命中。

        隔离态直接返回 None（不去读那份共享索引）—— 调用方拿不到命中就自然退回
        per-agent 去重，写入照常成功，只是「多写几条重复」，绝不会读串生产数据。
        """
        if self._isolation_gate():
            return None
        if not content or not content.strip():
            return None
        cand = _token_cache_get(content)
        if not cand:
            return None
        need = int(len(cand) * threshold)

        with self._lock:
            self._refresh()
            counter: dict = {}
            for tok in cand:
                for key in self._inverted.get(tok, ()):
                    counter[key] = counter.get(key, 0) + 1
            best = None
            for key, hits in counter.items():
                if hits < need:
                    continue
                entry = self._entries.get(key)
                if entry is None or entry.get("agent") == exclude_agent:
                    continue
                other = self._entry_tokens(entry)
                if not other:
                    continue
                inter = len(cand & other)
                if inter < need:
                    continue
                union = len(cand) + len(other) - inter
                if union <= 0:
                    continue
                score = inter / union
                if score > threshold and (best is None or score > best["score"]):
                    best = {"agent": entry.get("agent", ""), "mem_id": entry.get("mem_id", ""),
                            "content": entry.get("content", ""),
                            "category": entry.get("category") or "fact",
                            "score": score, "key": key}
            if best is not None:
                entry = self._entries.get(best["key"])
                if entry is not None:
                    entry["hits"] = int(entry.get("hits", 0)) + 1
                    entry["last_hit"] = _now_iso()
                    self._persist_locked()
            return best

    def upsert(self, content: str, agent_id: str, mem_id: str = "", category: str = "fact",
               importance: int = 5, timestamp: str = "") -> None:
        """本地新写入的条目立即登记（不等下一次扫盘，否则同进程连续写会互相看不见）。"""
        if self._isolation_gate():
            return
        if not content or not content.strip():
            return
        key = _entry_key(content)
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = {
                    "key": key, "agent": agent_id, "mem_id": mem_id, "content": content,
                    "category": category, "importance": importance,
                    "timestamp": timestamp or _now_iso(), "hits": 0, "_tokens": None,
                }
                self._entries[key] = entry
                for tok in self._entry_tokens(entry):
                    self._inverted.setdefault(tok, []).append(key)
            else:
                entry["agent"] = agent_id
                entry["mem_id"] = mem_id or entry.get("mem_id", "")
            self._persist_locked()

    def note_retired(self, content: str, agent_id: str) -> None:
        """某条内容被**软归档**（挤到 archived，仍可查）→ 从活跃索引摘掉。

        这样「同一个 agent 归档后重新写入同一条」不会被自己的历史条目误判为跨 agent 重复。
        """
        if self._isolation_gate():
            return
        key = _entry_key(content)
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry.get("agent") != agent_id:
                return
            if int(entry.get("hits", 0)) > 0:
                entry["status"] = RETIRED_PREFIX + agent_id
                self._persist_locked()
                return
            self._entries.pop(key, None)
            self._reindex()
            self._persist_locked()

    def lookup(self, content: str) -> Optional[dict]:
        """按内容精确查归属（审计/调试用）。"""
        if self._isolation_gate():
            return None
        key = _entry_key(content)
        with self._lock:
            self._refresh()
            entry = self._entries.get(key)
            if entry is None:
                return None
            return {"agent": entry.get("agent", ""), "mem_id": entry.get("mem_id", ""),
                    "content": entry.get("content", "")}

    def recall(self, query: str, top_k: int = 5, exclude_agent: str = "") -> list:
        """跨 agent 召回（按 _text_similarity 排序）—— 让「被去重掉的条目」仍然可达。"""
        from core.memory import _text_similarity
        if self._isolation_gate():
            return []
        if not query or not query.strip():
            return []
        with self._lock:
            self._refresh()
            items = [e for e in self._entries.values()
                     if e.get("agent") != exclude_agent and not str(e.get("status") or "").startswith(RETIRED_PREFIX)]
            scored = sorted(
                ((_text_similarity(query, e.get("content", "")), e) for e in items),
                key=lambda pair: pair[0], reverse=True)
            out = []
            for score, entry in scored[:max(0, top_k)]:
                if score <= 0:
                    continue
                out.append({"agent": entry.get("agent", ""), "mem_id": entry.get("mem_id", ""),
                            "content": entry.get("content", ""), "category": entry.get("category", ""),
                            "importance": entry.get("importance", 5),
                            "timestamp": entry.get("timestamp", ""),
                            "score": score})
            return out

    def _stats_locked(self) -> dict:
        """锁内计算（`threading.Lock` **不可重入**，所以 rebuild 不能回头调 `stats()`）。"""
        agents = {e.get("agent", "") for e in self._entries.values()}
        return {"entries": len(self._entries), "agents": len(agents),
                "index_path": str(self.path), "ttl_s": self.ttl_s,
                "isolated": self.isolated}

    def stats(self) -> dict:
        """隔离态下**不扫盘**：报零条目 + `isolated: True`，绝不为了统计去碰共享文件。"""
        if self._isolation_gate():
            return {"entries": 0, "agents": 0, "index_path": str(self.path),
                    "ttl_s": self.ttl_s, "isolated": True}
        with self._lock:
            self._refresh()
            return self._stats_locked()

    def _disk_entry_count(self) -> int:
        """**只读**地数盘上索引有多少条目（不碰进程内任何状态）—— rebuild 守卫要用。"""
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return 0
        if not isinstance(raw, dict) or raw.get("version") != GLOBAL_INDEX_VERSION:
            return 0
        entries = raw.get("entries")
        return len(entries) if isinstance(entries, dict) else 0

    def _rebuild_refusal(self, force: bool = False) -> str:
        """`rebuild()` 的守卫：返回非空字符串 = 拒绝执行（空串 = 放行）。

        为什么 `rebuild()` 必须有守卫：它是**唯一**会整体重写索引的入口 —— 清空内存态、
        扫全 base_dir、把结果整份盖回 `.global/index.json`。扫错目录（拼错的路径、
        没挂上的盘、权限被拒的目录）在 `_scan_memory_files` 里都表现为「一个目录都没有」，
        于是一份好好的索引会被**静默覆盖成空**。索引自愈的下一步是
        「再扫一次」，扫不到就永远回不来 —— 所以宁可拒绝，不猜。

          ① isolated —— 隔离场景压根不该碰这台机器的共享索引；
          ② base-dir-missing —— base_dir 不是现成的目录（拼错/没建），
             不许顺手 `mkdir -p` 出一棵假的记忆根再往里写索引；
          ③ empty-scan-would-wipe-index —— 扫不到任何 agent，但盘上索引本来是有条目的。
             这是「扫错地方」的典型指纹，不是「记忆真的被删干净了」。
             真要清空请显式 `force=True`（那是有意为之，不再是意外）。
        """
        if self._isolation_gate():
            return "isolated"
        try:
            if not self.base_dir.is_dir():
                return "base-dir-missing"
        except OSError:
            return "base-dir-missing"
        if force:
            return ""
        if _scan_memory_files(self.base_dir):
            return ""
        if self._disk_entry_count() > 0:
            return "empty-scan-would-wipe-index"
        return ""

    def rebuild(self, force: bool = False) -> dict:
        """从各 agent 的 memory.json 完整重建（派生索引的自愈路径）。

        `force=True` 只放宽守卫 ③（明知扫不到还要按扫到的结果重写），
        ①② 永远不放宽 —— 隔离就是隔离，目录不存在就是不存在。

        结果**只**来自这一次全量扫描，**不与盘上那份旧索引合并**：`rebuild` 的全部
        意义就是「按真相源重新算一遍」，中途再把旧文件载回来等于没重建 ——
        守卫 ③ 拦的正是「空扫描把好索引覆盖成空」，若旧条目总能复活，
        `force=True` 与不放行将毫无区别，守卫的名字（wipe）也会变成一句谎话。
        已删除的 agent（memory.json 不在了）在重建后不再留在索引里。

        返回值在原 `stats()` 形状上追加 `rebuilt` / `refused`：被守卫挡下时
        `rebuilt=False`、`refused` 是原因串，调用方能**观察到**拒绝而不是以为重建过了。
        """
        with self._lock:
            refusal = self._rebuild_refusal(force)
            if refusal:
                out = self._stats_locked()
                out.update({"rebuilt": False, "refused": refusal})
                return out
            _token_cache.clear()
            self._entries = {}
            self._inverted = {}
            self._files = {}
            self._loaded = True
            self._refresh(force=True)
            self._persist_locked()
            out = self._stats_locked()
            out.update({"rebuilt": True, "refused": ""})
            return out


_instances: dict = {}
_instances_lock = threading.Lock()


def get_global_index(base_dir, ttl_s: float = DEFAULT_GLOBAL_INDEX_TTL_S,
                     isolated: Optional[bool] = None) -> Optional[GlobalMemoryIndex]:
    """按记忆根目录取索引单例（进程内）；**隔离根目录直接返回 `None`**。

    返回 `None` 是这套设计的关键：调用方（哪怕完全不知道「隔离」这两个字）根本拿不到
    索引对象，于是写入路径自然退回 per-agent 去重 —— 隔离是**模块自身的保证**，
    不是「调用方记得别在隔离目录里用全局索引」这种自觉。

    单例 key 仍是 `str(Path(base_dir).resolve())`（与 TS 侧 `globalIndexKey()` 逐字节相同）；
    隔离不参与 key，因为它在**取单例之前**就判完了 —— 闩锁一合，下次取到的直接是 `None`，
    不存在「拿到隔离前的旧单例、继续用它的内存态」这条缝。
    """
    if not base_dir:
        return None
    if _resolve_isolation(base_dir, isolated)[0]:
        return None
    key = str(Path(base_dir).resolve())
    with _instances_lock:
        inst = _instances.get(key)
        if inst is None:
            inst = GlobalMemoryIndex(base_dir, ttl_s=ttl_s)
            _instances[key] = inst
        return inst
