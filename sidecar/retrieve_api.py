"""
sidecar/retrieve_api.py — 四阶段检索 API（全链路在 sidecar 闭环）。

阶段：① 向量种子 → ② 链接遍历（N 跳）→ ③ 标签过滤 → ④ 艾宾浩斯权重排序。
Node 只发查询、收结果；禁止退化为纯向量 topK（§6.4）。
"""

from __future__ import annotations

import sys
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from sidecar.logger import get_logger

logger = get_logger("retrieve")

router = APIRouter(prefix="/v1", tags=["retrieve"])

_TAG_FILTER_SEP = ","

# 记忆数据根配置（infer_server lifespan 从 slime.toml 同步；测试可替换）
_MEMORY_CFG = {
    "dir": "Knowledge/Agent Memory",
    "lancedb_enabled": False,
    "lancedb_uri": "",
}


def _load_memory_store(agent_id: str):
    """加载 MemoryStore；非法 agent_id 抛 HTTPException。"""
    from core.memory import load_memory
    try:
        return load_memory(
            agent_id,
            lancedb_enabled=_MEMORY_CFG.get("lancedb_enabled", False),
            lancedb_uri=_MEMORY_CFG.get("lancedb_uri", ""),
            data_dir=_MEMORY_CFG.get("dir", ""),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _stage1_seeds(store, query: str, top_k: int) -> list[dict]:
    """向量种子：LanceDB 语义召回；未启用时用 ranked 前 3（与 memory.summary 一致）。"""
    from core.memory import _effective_weight
    facts = [f for f in store.get_facts()
             if isinstance(f, dict) and isinstance(f.get("content"), str)]
    recalled = []
    if query and store._lancedb_enabled:
        try:
            recalled = store.recall(query, top_k=max(top_k, 5))
        except Exception as e:
            logger.warning(f"[retrieve] LanceDB 召回失败: {e}")
        if recalled:
            id_to_fact = {f.get("id"): f for f in facts if f.get("id")}
            content_to_fact = {f.get("content"): f for f in facts}
            resolved = []
            for r in recalled:
                f = id_to_fact.get(r.get("id")) or content_to_fact.get(r.get("content"))
                if f:
                    resolved.append(f)
            if resolved:
                return resolved
    if not facts:
        return []
    ranked = sorted(facts, key=lambda f: _effective_weight(f, query), reverse=True)
    return ranked[:3]


def _stage2_link_walk(store, seeds: list[dict], max_hops: int,
                      max_items: int) -> list[dict]:
    """链接遍历：从种子沿 links/backlinks BFS 展开 max_hops 跳，去重。"""
    facts = [f for f in store.get_facts()
             if isinstance(f, dict) and isinstance(f.get("content"), str)]
    id_to_fact = {f.get("id"): f for f in facts if f.get("id")}
    visited: set[str] = set()
    frontier: deque[tuple[str, int]] = deque()
    for seed in seeds:
        sid = seed.get("id")
        if sid and sid not in visited:
            visited.add(sid)
            frontier.append((sid, 0))
    while frontier:
        sid, depth = frontier.popleft()
        if depth >= max_hops:
            continue
        fact = id_to_fact.get(sid)
        if not fact:
            continue
        for link_id in fact.get("links", []) + fact.get("backlinks", []):
            if link_id in visited:
                continue
            linked = id_to_fact.get(link_id)
            if linked and linked.get("content", "").strip():
                visited.add(link_id)
                frontier.append((link_id, depth + 1))
    return [id_to_fact[sid] for sid in visited
            if sid in id_to_fact and len(id_to_fact[sid].get("content", "").strip())]


def _stage3_tag_filter(items: list[dict], tags_filter: list[str] | None) -> list[dict]:
    """标签过滤：要求条目 tags 与过滤集有交集。"""
    if not tags_filter:
        return items
    wanted = {t.strip() for t in tags_filter if t.strip()}
    if not wanted:
        return items
    return [f for f in items if wanted & set(f.get("tags", []))]


def _stage4_weight_sort(items: list[dict], query: str, max_items: int) -> list[dict]:
    """艾宾浩斯有效权重排序（沉睡记忆沉底但可唤醒）。"""
    from core.memory import _effective_weight
    ranked = sorted(items, key=lambda f: _effective_weight(f, query), reverse=True)
    return ranked[:max_items]


@router.post("/retrieve")
async def retrieve(body: dict[str, Any]):
    """四阶段检索：{agent_id, query, top_k?, max_hops?, tags?} → items"""
    agent_id = str(body.get("agent_id", ""))
    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id 必填")
    query = str(body.get("query", ""))
    top_k = int(body.get("top_k", 10))
    max_hops = int(body.get("max_hops", 2))
    tags_raw = body.get("tags")
    tags_filter = None
    if isinstance(tags_raw, str) and tags_raw.strip():
        tags_filter = [t.strip() for t in tags_raw.split(_TAG_FILTER_SEP) if t.strip()]
    elif isinstance(tags_raw, list):
        tags_filter = [str(t) for t in tags_raw]

    store = _load_memory_store(agent_id)
    seeds = _stage1_seeds(store, query, top_k)
    walked = _stage2_link_walk(store, seeds, max_hops, max_items=top_k * 3)
    filtered = _stage3_tag_filter(walked, tags_filter)
    ranked = _stage4_weight_sort(filtered, query, top_k)

    from core.memory import _effective_weight
    items = []
    for f in ranked:
        items.append({
            "id": f.get("id", ""),
            "content": f.get("content", ""),
            "category": f.get("category", "fact"),
            "tags": f.get("tags", []),
            "importance": f.get("importance", 5),
            "links": f.get("links", []),
            "backlinks": f.get("backlinks", []),
            "weight": round(_effective_weight(f, query), 4),
        })
    return {
        "agent_id": agent_id,
        "query": query,
        "count": len(items),
        "stages": {
            "seeds": len(seeds),
            "link_walked": len(walked),
            "tag_filtered": len(filtered),
            "ranked": len(ranked),
        },
        "items": items,
    }