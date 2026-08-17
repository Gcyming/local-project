"""
scripts/smoke_sidecar.py — 阶段 1 sidecar 真实冒烟（持久工具，Windows 下 `py scripts/smoke_sidecar.py` 直跑）。

验证目标（规划 §9 阶段 1 验收）：
1. sidecar 独立启动（INFER_PORT=19100）→ /health 存活
2. /v1/retrieve 四阶段检索跑真实 Knowledge 数据（哈希降级路径，不依赖模型实例）
3. 真实模型产物验证（独立 llama-server 实例 19501/19502，绕过 manager 端口扫描，
   避免与原项目 7×24 实例串扰）：Qwen 2.5 3B 流式中文回复 + BGE-M3 1024 维嵌入
4. 汇总报告；若 8999/18082 空闲，则标注 manager.ensure 全链路可补跑

安全约定：本脚本只用 Python（subprocess/httpx），不碰 PowerShell 管道/引号。
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SIDECAR_PORT = int(os.environ.get("SMOKE_SIDECAR_PORT", "19100"))
LLAMA_CHAT_PORT = 19501
LLAMA_EMBED_PORT = 19502

LLAMA_BIN = Path(r"D:\tool\slime\llama.cpp\llama-server.exe")
CHAT_MODEL = Path(r"D:\tool\slime\Local model\qwen2.5-3b-instruct-q8_0.gguf")
EMBED_MODEL = Path(r"D:\tool\slime\BGE-M3\bge-m3-q8_0.gguf")

KNOWN_PORTS = (8999, 18082, 19100, 19501, 19502)

RESULTS: list[dict] = []


def _report(name: str, ok: bool, detail: str) -> None:
    RESULTS.append({"name": name, "ok": ok, "detail": detail})
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}: {detail}")


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _wait_http(url: str, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = httpx.get(url, timeout=2.0)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _spawn(args: list[str]) -> subprocess.Popen:
    kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(args, **kwargs)


def _kill(proc: subprocess.Popen) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            proc.terminate()
    except Exception:
        pass


# ── 步骤 1：端口探测 ──────────────────────────────────────
def step_probe() -> None:
    print("== 步骤 1：端口探测 ==")
    for p in KNOWN_PORTS:
        used = _port_in_use(p)
        print(f"    port {p}: {'占用' if used else '空闲'}")
    free_8999 = not _port_in_use(8999) and not _port_in_use(18082)
    RESULTS.append({"name": "manager.ensure 全链路前置条件", "ok": True,
                    "detail": "8999/18082 空闲，可补跑 ensure 真实链路" if free_8999
                    else "8999/18082 被占用（预期：原项目 7×24 在跑），本次独立实例验证模型产物"})


# ── 步骤 2：sidecar 启动 + /health ─────────────────────────
def step_sidecar() -> tuple[subprocess.Popen | None, bool]:
    print("== 步骤 2：sidecar 启动 + /health ==")
    if _port_in_use(SIDECAR_PORT):
        _report("sidecar /health", False, f"端口 {SIDECAR_PORT} 已被占用，未启动")
        return None, False
    env = dict(os.environ)
    env["INFER_PORT"] = str(SIDECAR_PORT)
    proc = _spawn([sys.executable, "sidecar/infer_server.py"])
    ok = _wait_http(f"http://127.0.0.1:{SIDECAR_PORT}/health", timeout=90)
    if not ok:
        _report("sidecar /health", False, "启动超时（90s）")
        _kill(proc)
        return None, False
    try:
        data = httpx.get(f"http://127.0.0.1:{SIDECAR_PORT}/health", timeout=5.0).json()
        detail = (f"status={data.get('status')} service={data.get('service')} "
                  f"port={data.get('port')}")
    except Exception as e:
        detail = f"health 响应解析失败: {e}"
    _report("sidecar /health", True, detail)
    return proc, True


# ── 步骤 3：/v1/retrieve 真实数据 ─────────────────────────
def step_retrieve() -> None:
    print("== 步骤 3：/v1/retrieve 真实 Knowledge 数据 ==")
    mem_dir = PROJECT_ROOT / "Knowledge" / "Agent Memory"
    agents = sorted(p.name for p in mem_dir.iterdir()
                    if p.is_dir() and p.name.startswith("agent_")) if mem_dir.is_dir() else []
    if not agents:
        _report("retrieve 真实数据", False, "Knowledge/Agent Memory 无 agent 目录")
        return
    agent_id = agents[0]
    print(f"    使用 agent: {agent_id}（共 {len(agents)} 个）")
    payload = {"agent_id": agent_id, "query": "最近学习和使用过的技能", "top_k": 10, "max_hops": 2}
    try:
        r = httpx.post(f"http://127.0.0.1:{SIDECAR_PORT}/v1/retrieve",
                       json=payload, timeout=30.0)
        if r.status_code != 200:
            _report("retrieve 真实数据", False, f"HTTP {r.status_code}: {r.text[:200]}")
            return
        data = r.json()
        stages = data.get("stages", {})
        items = data.get("items", [])
        detail = (f"count={data.get('count')} stages={stages} "
                  f"首条: {json.dumps(items[0], ensure_ascii=False)[:120] if items else '无'}")
        _report("retrieve 真实数据", True, detail)
    except Exception as e:
        _report("retrieve 真实数据", False, f"异常: {e}")


# ── 步骤 4：manager.ensure 真实全链路（Node 实际调用路径）─
def step_full_link() -> bool:
    print("== 步骤 4：manager.ensure 真实全链路（经 sidecar /models/load）==")
    if _port_in_use(8999) or _port_in_use(18082):
        _report("ensure 全链路", False, "8999/18082 被占用（原项目实例在跑），改为独立实例 fallback")
        return False
    try:
        for role in ("chat", "embedding"):
            r = httpx.post(f"http://127.0.0.1:{SIDECAR_PORT}/models/load",
                           json={"role": role}, timeout=300.0)
            if r.status_code != 200 or not r.json().get("ok"):
                _report(f"ensure {role}", False, f"{r.status_code}: {r.text[:200]}")
                return False
            detail = r.json().get("detail") or ""
            _report(f"ensure {role}", True, f"port={r.json().get('port')} {detail}")
        # 等待就绪（health 轮询由 manager 内部完成，此处确认 /stats）
        stats = httpx.get(f"http://127.0.0.1:{SIDECAR_PORT}/stats", timeout=5.0).json()
        inst = {i["role"]: i for i in stats.get("instances", [])}
        ready = all(inst.get(role, {}).get("state") == "ready" for role in ("chat", "embedding"))
        _report("实例 ready（/stats）", ready, json.dumps(inst, ensure_ascii=False)[:300])
        if not ready:
            return False
        ok_chat = _chat_stream_via(SIDECAR_PORT)
        ok_embed = _embed_via(SIDECAR_PORT)
        return ok_chat and ok_embed
    except Exception as e:
        _report("ensure 全链路", False, f"异常: {e}")
        return False


def _chat_stream_via(port: int) -> bool:
    payload = {
        "messages": [{"role": "user", "content": "用一句话介绍你自己，然后说：你好"}],
        "stream": True, "max_tokens": 200,
    }
    try:
        chunks, text = 0, []
        with httpx.Client(timeout=180.0) as client:
            with client.stream("POST", f"http://127.0.0.1:{port}/chat/completions",
                               json=payload) as r:
                if r.status_code != 200:
                    _report("chat 流式回复", False, f"HTTP {r.status_code}: {r.text[:200]}")
                    return False
                for line in r.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"].get("content", "")
                    except Exception:
                        continue
                    if delta:
                        chunks += 1
                        text.append(delta)
        full = "".join(text)
        ok = chunks > 0 and any("\u4e00" <= ch <= "\u9fff" for ch in full)
        _report("chat 流式回复", ok, f"chunks={chunks} 字符数={len(full)} 首段: {full[:40]}")
        return ok
    except Exception as e:
        _report("chat 流式回复", False, f"异常: {e}")
        return False


def _embed_via(port: int) -> bool:
    try:
        r = httpx.post(f"http://127.0.0.1:{port}/embeddings",
                       json={"model": "bge-m3", "input": ["你好，世界", "slime agent"]}, timeout=60.0)
        if r.status_code != 200:
            _report("embedding 嵌入", False, f"HTTP {r.status_code}: {r.text[:200]}")
            return False
        data = r.json()
        vecs = data.get("data", [])
        dims = {len(v.get("embedding", [])) for v in vecs}
        ok = len(vecs) == 2 and dims == {1024}
        _report("embedding 嵌入", ok, f"条数={len(vecs)} 维度={dims}")
        return ok
    except Exception as e:
        _report("embedding 嵌入", False, f"异常: {e}")
        return False


# ── 步骤 4b（fallback）：真实模型产物验证（独立实例）────────
def step_real_models() -> None:
    print("== 步骤 4：真实模型产物（独立 llama-server 19501/19502）==")
    if not LLAMA_BIN.exists():
        _report("模型资产存在性", False, f"llama-server 不存在: {LLAMA_BIN}")
        return
    if not CHAT_MODEL.exists() or not EMBED_MODEL.exists():
        _report("模型资产存在性", False, f"模型缺失: chat={CHAT_MODEL.exists()} embed={EMBED_MODEL.exists()}")
        return
    _report("模型资产存在性", True, "llama-server + chat + embed 齐备")

    chat_proc = _spawn([str(LLAMA_BIN), "-m", str(CHAT_MODEL), "--port", str(LLAMA_CHAT_PORT),
                        "-ngl", "999", "-c", "4096"])
    embed_proc = _spawn([str(LLAMA_BIN), "-m", str(EMBED_MODEL), "--port", str(LLAMA_EMBED_PORT),
                         "-ngl", "999", "-c", "8192", "--embedding"])
    try:
        chat_ok = _wait_http(f"http://127.0.0.1:{LLAMA_CHAT_PORT}/health", timeout=120)
        embed_ok = _wait_http(f"http://127.0.0.1:{LLAMA_EMBED_PORT}/health", timeout=120)
        if not chat_ok:
            _report("chat 实例就绪", False, "120s 超时（可能显存不足：原项目占用中）")
        else:
            _report("chat 实例就绪", True, f"port {LLAMA_CHAT_PORT} /health ok")
        if not embed_ok:
            _report("embed 实例就绪", False, "120s 超时")
        else:
            _report("embed 实例就绪", True, f"port {LLAMA_EMBED_PORT} /health ok")

        if chat_ok:
            step_chat_stream()
        if embed_ok:
            step_embedding()
    finally:
        _kill(chat_proc)
        _kill(embed_proc)


def step_chat_stream() -> None:
    payload = {
        "messages": [{"role": "user", "content": "用一句话介绍你自己，然后说：你好"}],
        "stream": True, "max_tokens": 200,
    }
    try:
        chunks, text = 0, []
        with httpx.Client(timeout=180.0) as client:
            with client.stream("POST", f"http://127.0.0.1:{LLAMA_CHAT_PORT}/v1/chat/completions",
                               json=payload) as r:
                if r.status_code != 200:
                    _report("chat 流式回复", False, f"HTTP {r.status_code}: {r.text[:200]}")
                    return
                for line in r.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"].get("content", "")
                    except Exception:
                        continue
                    if delta:
                        chunks += 1
                        text.append(delta)
        full = "".join(text)
        ok = chunks > 0 and any("\u4e00" <= ch <= "\u9fff" for ch in full)
        _report("chat 流式回复", ok,
                f"chunks={chunks} 字符数={len(full)} 首段: {full[:40]}")
    except Exception as e:
        _report("chat 流式回复", False, f"异常: {e}")


def step_embedding() -> None:
    try:
        r = httpx.post(f"http://127.0.0.1:{LLAMA_EMBED_PORT}/v1/embeddings",
                       json={"model": "bge-m3", "input": ["你好，世界", "slime agent"]}, timeout=60.0)
        if r.status_code != 200:
            _report("embedding 嵌入", False, f"HTTP {r.status_code}: {r.text[:200]}")
            return
        data = r.json()
        vecs = data.get("data", [])
        dims = {len(v.get("embedding", [])) for v in vecs}
        ok = len(vecs) == 2 and dims == {1024}
        _report("embedding 嵌入", ok, f"条数={len(vecs)} 维度={dims}")
    except Exception as e:
        _report("embedding 嵌入", False, f"异常: {e}")


# ── 主流程 ────────────────────────────────────────────────
def main() -> int:
    print(f"== sidecar 冒烟（项目根: {PROJECT_ROOT}）==")
    step_probe()
    proc, ok = step_sidecar()
    if ok:
        try:
            step_retrieve()
            if not step_full_link():
                step_real_models()
        finally:
            _kill(proc)
    print("== 汇总 ==")
    passed = sum(1 for r in RESULTS if r["ok"])
    for r in RESULTS:
        print(f"  {'PASS' if r['ok'] else 'FAIL'}  {r['name']}: {r['detail']}")
    print(f"== 结果: {passed}/{len(RESULTS)} 通过 ==")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main())