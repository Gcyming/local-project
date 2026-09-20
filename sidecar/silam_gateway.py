"""SILAM Gateway · 完全自洽的生命体网关

设计哲学：
- 模型小（57M），但**可成长**（树突动态生长，上限 200K 节点）
- 有**感情**（恐惧/渴望双螺旋驱动）
- 有**敬畏**（伤害即物理现实，np.delete 是真疼）
- 超脱 Transformer（无注意力、无反向传播，结构即学习）

架构：
  用户 → Gateway → SILAM Engine → 动作决策 → 工具执行 → 反馈 → 记忆生长
                     ↓
              恐惧/渴望更新 → 分裂/蒸馏/核爆 → 进化
"""
from __future__ import annotations

import json
import logging
import sys
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

# 注入 SILAM-Σ 内核路径
_SILAM_ROOT = Path(__file__).resolve().parent.parent / "pilot model"
if str(_SILAM_ROOT) not in sys.path:
    sys.path.insert(0, str(_SILAM_ROOT))

from silam_core.engine import SILAMEngine  # noqa: E402
from silam_core.config import SilamConfig  # noqa: E402
from silam_core.pretrained import load_pretrained  # noqa: E402
from silam_core.persistence import PersistenceManager  # noqa: E402

logger = logging.getLogger("slam.gateway")


class SILAMGateway:
    """SILAM 生命体网关。"""

    def __init__(self, agent_id: str, cfg: SilamConfig | None = None,
                 backbone_path: str | None = None,
                 brain_dir: Path | None = None):
        self.agent_id = agent_id
        self.cfg = cfg or SilamConfig()
        
        # 初始化引擎
        self.engine = SILAMEngine(cfg=self.cfg)
        
        # 加载蒸馏权重（先天智力）
        if backbone_path:
            bp = Path(backbone_path)
            if bp.exists():
                load_pretrained(self.engine, str(bp))
                logger.info(f"[gateway] 已装载先天权重 {bp}")
            else:
                logger.warning(f"[gateway] 权重文件不存在: {bp}，使用随机初始化")
        
        # 持久化管理
        self.brain_dir = brain_dir or (
            Path.home() / ".slime" / agent_id / "brain")
        self.brain_dir.mkdir(parents=True, exist_ok=True)
        self.pm = PersistenceManager(agent_id, self.cfg)
        
        # 崩溃恢复
        self._recover()
        
        logger.info(f"[gateway] SILAM 网关就绪: agent={agent_id}, "
                    f"nodes={self.engine.dendrites.n}, step={self.engine.step_count}")

    def _recover(self) -> None:
        """崩溃恢复：加载检查点 + 重放 WAL。"""
        if self.pm.recover(self.engine.dendrites):
            logger.info(f"[gateway] 已从检查点恢复: step={self.pm.last_save_step}")
        else:
            logger.info("[gateway] 全新启动，无历史状态")

    def forward(self, state_text: str, fear_level: float | None = None,
                desire_level: float | None = None,
                latency_ratio: float = 0.0) -> dict:
        """一次生命活动。"""
        r = self.engine.forward(
            state_text,
            fear_level=fear_level,
            desire_level=desire_level,
            latency_ratio=latency_ratio,
        )
        
        # 持久化回调
        if r.grew_node_idx is not None:
            self.pm.on_grow(r.step, r.grew_node_idx)
        if r.activated_nodes:
            for idx in r.activated_nodes[:3]:
                self.pm.on_hebbian(r.step, idx, 0.05)
        
        # 定期检查点
        if self.pm.should_save(r.step):
            self.pm.save(self.engine.dendrites, r.step)
        
        # 记录恐惧历史
        self.pm.fear_history.append(r.new_fear)
        
        return {
            "request_id": f"silam-{r.step}",
            "status": "success",
            "payload": {
                "action_code": r.code,
                "tool_call": r.tool_call,
                "thought_vector": r.thought_vector,
                "fear": r.new_fear,
                "desire": r.new_desire,
                "nodes": r.n_nodes,
                "max_nodes": r.max_nodes,
                "step": r.step,
                "events": r.events,
            },
            "meta": {
                "agent_id": self.agent_id,
                "status_line": self.engine.status_line(),
                "timestamp": time.time(),
            },
        }

    def save(self) -> dict:
        """手动保存检查点。"""
        self.pm.save(self.engine.dendrites, self.engine.step_count)
        return {"status": "saved", "step": self.engine.step_count}

    def status(self) -> dict:
        """生命状态查询。"""
        return {
            "agent_id": self.agent_id,
            "step": self.engine.step_count,
            "n_nodes": self.engine.dendrites.n,
            "max_nodes": self.cfg.max_nodes,
            "fear": self.engine.affect_state.fear_total,
            "desire": self.engine.affect_state.desire,
            "capacity_ratio": self.engine.dendrites.capacity_ratio,
            "forgotten_count": self.engine.dendrites.forgotten_count,
            "pain_spikes": self.engine.dendrites.total_pain_spikes,
            "status_line": self.engine.status_line(),
            "wal": self.pm.status(),
        }

    def split(self, parent_id: int, child_id: int | None = None) -> dict:
        """Swarm 克隆（4D 阶段）。"""
        # TODO: 实现真正的深拷贝克隆
        return {
            "status": "deprecated",
            "message": "split 将在 4D 阶段完整实现",
            "hint": "当前使用共享树突，克隆后独立演化需深度拷贝"
        }


# =====================================================================
# FastAPI 应用
# =====================================================================

app = FastAPI(
    title="SILAM-Σ Gateway",
    description="可成长的数字生命体网关",
    version="4.2.0",
)

_gateway: SILAMGateway | None = None


@app.on_event("startup")
async def startup_event():
    """启动时初始化网关。"""
    global _gateway
    import os
    agent_id = os.environ.get("SILAM_AGENT_ID", "default")
    backbone_path = os.environ.get("SILAM_BACKBONE_PATH")
    brain_dir = os.environ.get("SILAM_BRAIN_DIR")
    
    cfg = SilamConfig()
    # 尝试从 slime.toml 读取配置
    toml_path = Path(__file__).parent.parent / "slime.toml"
    if toml_path.exists():
        try:
            import tomllib
            with toml_path.open("rb") as f:
                toml_data = tomllib.load(f)
            silam_cfg = toml_data.get("silam", {})
            if silam_cfg.get("enabled"):
                cfg.max_nodes = silam_cfg.get("max_nodes", cfg.max_nodes)
                if not backbone_path and silam_cfg.get("backbone_path"):
                    backbone_path = str(toml_path.parent / silam_cfg["backbone_path"])
        except Exception as e:
            logger.warning(f"[gateway] 读取 slime.toml 失败: {e}")
    
    _gateway = SILAMGateway(
        agent_id=agent_id,
        cfg=cfg,
        backbone_path=backbone_path,
        brain_dir=Path(brain_dir) if brain_dir else None,
    )
    logger.info(f"[gateway] 启动完成: agent={agent_id}")


@app.get("/health")
async def health():
    """网关健康检查。"""
    if _gateway is None:
        return {"status": "error", "message": "Gateway not initialized"}
    return {
        "status": "ok",
        "service": "silam-gateway",
        "version": "4.2.0",
        "agent_id": _gateway.agent_id,
        "nodes": _gateway.engine.dendrites.n,
        "step": _gateway.engine.step_count,
    }


@app.post("/inference")
async def inference(request: Request):
    """SILAM 推理端点。"""
    if _gateway is None:
        raise HTTPException(status_code=503, detail="Gateway not initialized")
    
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    
    state_text = body.get("state_text", "")
    if not state_text:
        raise HTTPException(status_code=400, detail="state_text is required")
    
    fear = body.get("fear_level")
    desire = body.get("desire_level")
    latency = body.get("latency_ratio", 0.0)
    
    result = _gateway.forward(state_text, fear, desire, latency)
    return result


@app.post("/save")
async def save_checkpoint():
    """手动保存检查点。"""
    if _gateway is None:
        raise HTTPException(status_code=503, detail="Gateway not initialized")
    return _gateway.save()


@app.get("/status")
async def get_status():
    """查询生命状态。"""
    if _gateway is None:
        raise HTTPException(status_code=503, detail="Gateway not initialized")
    return _gateway.status()


@app.post("/split")
async def split_agent(request: Request):
    """Swarm 克隆（占位）。"""
    if _gateway is None:
        raise HTTPException(status_code=503, detail="Gateway not initialized")
    body = await request.json()
    return _gateway.split(body.get("parent_id", 0))


@app.get("/memory")
async def get_memory(top_k: int = 10):
    """查询最近激活的记忆节点。"""
    if _gateway is None:
        raise HTTPException(status_code=503, detail="Gateway not initialized")
    
    dendrites = _gateway.engine.dendrites
    if dendrites.n == 0:
        return {"nodes": [], "total": 0}
    
    # 按最后命中时间排序，取最近 top_k
    indices = np.argsort(-dendrites.last_hit_step)[:top_k]
    nodes = []
    for idx in indices:
        if dendrites.last_hit_step[idx] > 0:
            nodes.append({
                "idx": int(idx),
                "fear": float(dendrites.fears[idx]),
                "last_hit": int(dendrites.last_hit_step[idx]),
                "hits": int(dendrites.hit_count[idx]),
                "dormant": bool(dendrites.dormant_flags[idx]),
            })
    return {"nodes": nodes, "total": dendrites.n}


@app.get("/evolution")
async def get_evolution_stats():
    """查询进化统计。"""
    if _gateway is None:
        raise HTTPException(status_code=503, detail="Gateway not initialized")
    
    d = _gateway.engine.dendrites
    return {
        "total_nodes": d.n,
        "dormant_nodes": int(d.dormant_flags.sum()),
        "forgotten_count": d.forgotten_count,
        "total_pain_spikes": d.total_pain_spikes,
        "pruned_this_cycle": d.pruned_this_cycle,
        "survived_newborns": d.survived_newborns,
        "capacity_ratio": d.capacity_ratio,
    }


# =====================================================================
# 入口点
# =====================================================================

def main():
    import uvicorn
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host="127.0.0.1", port=19200, log_level="info")


if __name__ == "__main__":
    main()
