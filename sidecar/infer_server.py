"""
sidecar/infer_server.py — Python sidecar 推理服务（OpenAI 兼容）。

端点：
- GET  /health                    心跳（Node 超时即判死）
- POST /chat/completions          流式/非流式，转发 llama-server（OpenAI 兼容透传）
- POST /embeddings                BGE-M3 嵌入（OpenAI 格式）
- GET  /stats                     显存/实例状态（直供 UI 监控面板）
- POST /models/load               加载推理/嵌入实例
- POST /models/unload             卸载推理实例（persistent 拒绝）
- POST /v1/retrieve               四阶段检索（见 sidecar/retrieve_api.py）

端口：INFER_PORT 环境变量（Node 启动时探测空闲端口下发），默认 19100。
"""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import tomllib
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from sidecar.logger import get_logger
from sidecar.retrieve_api import router as retrieve_router, _MEMORY_CFG

logger = get_logger("infer")

INFER_PORT = int(os.environ.get("INFER_PORT", "19100"))

_CHAT_FORWARD_KEYS = ("messages", "stream", "max_tokens", "temperature",
                      "top_p", "stop", "presence_penalty", "frequency_penalty")


def _load_model_server_config() -> dict:
    """读 slime.toml [model_server] 段。"""
    toml_path = _PROJECT_ROOT / "slime.toml"
    if not toml_path.exists():
        return {}
    try:
        with toml_path.open("rb") as f:
            data = tomllib.load(f)
        return data.get("model_server", {}) or {}
    except Exception as e:
        logger.warning(f"[infer] 读取 slime.toml 失败: {e}")
        return {}


def _load_memory_config() -> dict:
    """读 slime.toml [memory] 段（检索数据根）。"""
    toml_path = _PROJECT_ROOT / "slime.toml"
    if not toml_path.exists():
        return {}
    try:
        with toml_path.open("rb") as f:
            data = tomllib.load(f)
        memory = data.get("memory", {}) or {}
        lancedb = data.get("memory", {}).get("lancedb", {}) or {}
        return {
            "dir": memory.get("dir", "Knowledge/Agent Memory"),
            "lancedb_enabled": bool(lancedb.get("enabled", False)),
            "lancedb_uri": str(lancedb.get("uri", "") or ""),
        }
    except Exception as e:
        logger.warning(f"[infer] 读取 slime.toml [memory] 失败: {e}")
        return {"dir": "Knowledge/Agent Memory", "lancedb_enabled": False, "lancedb_uri": ""}


# ── 可注入点（测试替换）──────────────────────────────────────
_manager = None
_forward_chat = None
_forward_embed = None


def _default_manager():
    from core.model_server import ModelServerManager
    return ModelServerManager(_load_model_server_config())


async def _default_forward_chat(port: int, payload: dict) -> httpx.Response:
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            headers={"Content-Type": "application/json"},
            json=payload,
        )
        return resp


async def _default_forward_embed(port: int, payload: dict) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"http://127.0.0.1:{port}/v1/embeddings",
            headers={"Content-Type": "application/json"},
            json=payload,
        )
        return resp


def get_manager():
    global _manager
    if _manager is None:
        _manager = _default_manager()
    return _manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    _MEMORY_CFG.update(_load_memory_config())
    manager = get_manager()
    await manager.startup()
    try:
        yield
    finally:
        await manager.shutdown()


app = FastAPI(title="slime-infer-sidecar", lifespan=lifespan)
app.include_router(retrieve_router)


@app.get("/health")
async def health():
    from core.model_server import VRAMMonitor
    manager = get_manager()
    instances = []
    try:
        instances = manager.status()
    except Exception as e:
        logger.warning(f"[infer] status 读取失败: {e}")
    return {
        "status": "ok",
        "service": "slime-infer-sidecar",
        "port": INFER_PORT,
        "vram": VRAMMonitor().sample(),
        "instances": instances,
    }


@app.post("/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    forward = _forward_chat or _default_forward_chat
    payload = {k: body[k] for k in _CHAT_FORWARD_KEYS if k in body}
    payload.setdefault("stream", False)
    manager = get_manager()
    result = await manager.ensure("chat")
    if not result.get("ok"):
        return JSONResponse(
            status_code=503,
            content={"error": {"message": result.get("error", "chat 模型不可用"), "type": "local_model_error"}},
        )
    port = result["port"]
    try:
        resp = await forward(port, payload)
    except Exception as e:
        logger.error(f"[infer] chat 转发失败: {e}")
        return JSONResponse(
            status_code=502,
            content={"error": {"message": str(e), "type": "upstream_error"}},
        )
    if payload.get("stream"):
        manager.touch("chat")
        return StreamingResponse(
            _stream_sse(forward, port, payload, resp),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )
    if resp.status_code >= 400:
        return JSONResponse(
            status_code=resp.status_code,
            content={"error": {"message": f"llama-server: {resp.status_code}", "type": "upstream_error"}},
        )
    try:
        return JSONResponse(resp.json())
    except Exception:
        return JSONResponse(
            status_code=502,
            content={"error": {"message": "llama-server 响应非 JSON", "type": "upstream_error"}},
        )


async def _stream_sse(forward, port: int, payload: dict, resp: httpx.Response) -> AsyncIterator[str]:
    """流式透传：优先复用已发起的响应，失败则重发请求。"""
    if resp.status_code != 200:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", f"http://127.0.0.1:{port}/v1/chat/completions",
                                     json=payload) as s:
                async for chunk in s.aiter_bytes():
                    yield chunk
        return
    try:
        async for chunk in resp.aiter_bytes():
            yield chunk
    except Exception as e:
        logger.warning(f"[infer] 流式中断: {e}")


@app.post("/embeddings")
async def embeddings(request: Request):
    body = await request.json()
    inputs = body.get("input")
    if isinstance(inputs, str):
        inputs = [inputs]
    if not isinstance(inputs, list) or not inputs:
        return JSONResponse(status_code=400, content={"error": {"message": "input 必填", "type": "bad_request"}})
    model = body.get("model", "bge-m3")
    forward = _forward_embed or _default_forward_embed
    manager = get_manager()
    result = await manager.ensure("embedding")
    if not result.get("ok"):
        return JSONResponse(
            status_code=503,
            content={"error": {"message": result.get("error", "embedding 模型不可用"), "type": "local_model_error"}},
        )
    port = result["port"]
    try:
        resp = await forward(port, {"model": model, "input": inputs})
    except Exception as e:
        logger.error(f"[infer] embedding 转发失败: {e}")
        return JSONResponse(
            status_code=502,
            content={"error": {"message": str(e), "type": "upstream_error"}},
        )
    if resp.status_code >= 400:
        return JSONResponse(
            status_code=resp.status_code,
            content={"error": {"message": f"llama-server: {resp.status_code}", "type": "upstream_error"}},
        )
    try:
        return JSONResponse(resp.json())
    except Exception:
        return JSONResponse(
            status_code=502,
            content={"error": {"message": "llama-server 响应非 JSON", "type": "upstream_error"}},
        )


@app.get("/stats")
async def stats():
    from core.model_server import VRAMMonitor
    manager = get_manager()
    instances = []
    try:
        instances = manager.status()
    except Exception as e:
        logger.warning(f"[infer] status 读取失败: {e}")
    return {
        "vram": VRAMMonitor().sample(),
        "instances": instances,
        "memory": _load_memory_config(),
    }


@app.post("/models/load")
async def models_load(request: Request):
    body = await request.json()
    role = str(body.get("role", "chat"))
    if role not in ("chat", "embedding"):
        return JSONResponse(status_code=400, content={"error": {"message": f"未知 role: {role}", "type": "bad_request"}})
    manager = get_manager()
    result = await manager.ensure(role)
    return result


@app.post("/models/unload")
async def models_unload(request: Request):
    body = await request.json()
    role = str(body.get("role", "chat"))
    manager = get_manager()
    result = manager.release(role)
    return result


def main():
    import uvicorn
    logger.info(f"[infer] sidecar 启动，端口 {INFER_PORT}")
    uvicorn.run(app, host="127.0.0.1", port=INFER_PORT, log_level="warning")


if __name__ == "__main__":
    main()