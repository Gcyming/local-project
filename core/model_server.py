"""
slime 本地模型管理 — llama-server 生命周期 + VRAM 感知
- VRAMMonitor: nvidia-smi 采样
- ModelBackend: llama-server 进程封装（start / wait_ready / stop / probe）
- ModelServerManager: 实例管理 + 预算检查 + 空闲计时 + registry 落盘
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_REGISTRY_PATH = _PROJECT_ROOT / "data" / "model_servers.json"

IS_WINDOWS = platform.system() == "Windows"

# ── VRAM 监控 ──────────────────────────────────────────────


class VRAMMonitor:
    """nvidia-smi 采样；失败/无 GPU 返回 None（调用方跳过预算检查）"""

    def sample(self) -> dict | None:
        """N10-M5: shutil.which 校验绝对路径，防 PATH 劫持。"""
        nvidia_smi = shutil.which("nvidia-smi")
        if not nvidia_smi:
            return None
        try:
            result = subprocess.run(
                [
                    nvidia_smi,
                    "--query-gpu=memory.total,memory.used,memory.free",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True, text=True, timeout=5,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WINDOWS else {}),
            )
            if result.returncode != 0 or not result.stdout.strip():
                return None
            parts = result.stdout.strip().split(",")
            if len(parts) < 3:
                return None
            return {
                "total_gb": round(float(parts[0].strip()) / 1024, 2),
                "used_gb": round(float(parts[1].strip()) / 1024, 2),
                "free_gb": round(float(parts[2].strip()) / 1024, 2),
            }
        except Exception:
            return None


# ── 状态模型 ────────────────────────────────────────────────


class ServerState:
    IDLE = "idle"
    LOADING = "loading"
    READY = "ready"
    UNLOADING = "unloading"


# ── ModelBackend ────────────────────────────────────────────


class ModelBackend:
    """llama-server 进程封装。只管理自己 Popen 的进程。"""

    def __init__(self, llama_bin: str):
        self._llama_bin = llama_bin
        self._process: subprocess.Popen | None = None
        self._pid: int | None = None
        self._port: int = 0

    @property
    def pid(self) -> int | None:
        return self._pid

    def start(self, model_path: str, port: int, gpu_layers: int,
              ctx_len: int, embedding: bool = False) -> bool:
        """启动 llama-server 子进程。返回 True 表示进程已拉起。"""
        if not Path(self._llama_bin).exists():
            logger.error(f"[model_server] llama-server 不存在: {self._llama_bin}")
            return False
        if not Path(model_path).exists():
            logger.error(f"[model_server] 模型文件不存在: {model_path}")
            return False

        args = [
            self._llama_bin,
            "-m", model_path,
            "--port", str(port),
            "-ngl", str(gpu_layers),
            "-c", str(ctx_len),
        ]
        if embedding:
            args.append("--embedding")

        try:
            kwargs = dict(
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if IS_WINDOWS:
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                kwargs["preexec_fn"] = os.setpgrp

            self._process = subprocess.Popen(args, **kwargs)
            self._pid = self._process.pid
            self._port = port
            logger.info(f"[model_server] 启动 llama-server (PID {self._pid}, port {port}): {Path(model_path).name}")
            return True
        except Exception as e:
            logger.error(f"[model_server] 启动失败: {e}")
            return False

    async def wait_ready(self, timeout: float = 60) -> bool:
        """轮询 /health 等待就绪"""
        if not self._port:
            return False
        deadline = time.time() + timeout
        async with httpx.AsyncClient() as client:
            while time.time() < deadline:
                try:
                    resp = await client.get(
                        f"http://127.0.0.1:{self._port}/health",
                        timeout=2.0,
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        if data.get("status") == "ok":
                            return True
                except Exception:
                    pass
                await asyncio.sleep(0.5)
        return False

    def stop(self):
        """停止自己拉起的进程。N10-M7: taskkill 前校验命令行含 llama-server，防 PID 复用误杀。"""
        if self._process is None or self._pid is None:
            return
        # 校验 PID 对应进程确实是 llama-server
        if IS_WINDOWS and not self._verify_pid_is_llama_server():
            logger.warning(f"[model_server] PID {self._pid} 非 llama-server，跳过 taskkill")
            self._process = None
            self._pid = None
            return
        try:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/PID", str(self._pid), "/T", "/F"],
                    capture_output=True,
                    **({"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WINDOWS else {}),
                )
            else:
                os.killpg(os.getpgid(self._pid), signal.SIGTERM)
            self._process.wait(timeout=5)
            logger.info(f"[model_server] 已停止 PID {self._pid} (port {self._port})")
        except Exception as e:
            logger.warning(f"[model_server] 停止 PID {self._pid} 失败: {e}")
            try:
                self._process.kill()
            except Exception:
                pass
        finally:
            self._process = None
            self._pid = None

    def _verify_pid_is_llama_server(self) -> bool:
        """N10-M7: 检查 PID 命令行是否含 llama-server（实例方法委托静态版）"""
        return _verify_llama_server_pid(self._pid)

    def probe(self, port: int) -> bool:
        """探测端口是否已有可用的 llama-server 实例（同步，供 startup 用）"""
        try:
            import urllib.request
            req = urllib.request.Request(f"http://127.0.0.1:{port}/health")
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read())
                    return data.get("status") == "ok"
        except Exception:
            pass
        return False

    async def probe_async(self, port: int) -> bool:
        """异步探测"""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"http://127.0.0.1:{port}/health",
                    timeout=2.0,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data.get("status") == "ok"
        except Exception:
            pass
        return False

    def is_running(self) -> bool:
        """PID 存活 + /health ok 双确认"""
        if self._pid is None:
            return False
        if IS_WINDOWS:
            try:
                result = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {self._pid}"],
                    capture_output=True, text=True,
                    **({"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WINDOWS else {}),
                )
                if str(self._pid) not in result.stdout:
                    return False
            except Exception:
                return False
        else:
            try:
                os.kill(self._pid, 0)
            except OSError:
                return False
        return self.probe(self._port)


# ── ModelServerManager ──────────────────────────────────────


@dataclass
class _Instance:
    role: str
    model_path: str = ""
    model_name: str = ""
    port: int = 0
    state: str = ServerState.IDLE
    persistent: bool = False
    gpu_layers: int = 99
    ctx_len: int = 2048
    external: bool = False  # probe 发现的已有实例


class ModelServerManager:
    """本地模型服务器管理器：启动/确保/释放/关闭 + VRAM 预算 + 空闲计时 + registry"""

    def __init__(self, config: dict):
        self._cfg = config
        self._llama_bin = config.get("llama_bin", "")
        self._startup_timeout = config.get("startup_timeout", 60)
        self._vram_budget_gb = config.get("vram_budget_gb", 7.0)
        self._chat_est_gb = config.get("chat_est_gb", 4.0)
        self._embed_cfg = config.get("embedding", {})
        self._chat_cfg = config.get("chat", {})

        self._vram = VRAMMonitor()
        self._instances: dict[str, _Instance] = {}
        self._backends: dict[str, ModelBackend] = {}
        self._idle_tasks: dict[str, asyncio.Task] = {}
        self._startup_task: asyncio.Task | None = None
        self._ensure_lock = asyncio.Lock()  # H2: 防止并发双启动

    # ── 生命周期 ───────────────────────────────────────────

    async def startup(self):
        """后台启动 persistent 实例（不阻塞 server）。失败记日志。"""
        # H1/A-003: 启动即清空 registry —— 上次崩溃残留的 ready 条目会让外部读者
        # （memory._embed / _local_model_reply 的 registry 回退路径）读到假就绪端口。
        # 本进程管理的内存状态才是权威，registry 只反映当前进程的实例。
        self._write_registry()
        if self._embed_cfg.get("persistent"):
            async def _bg_init():
                try:
                    vram = self._vram.sample()
                    if vram and vram["free_gb"] < 2.5:
                        logger.warning(
                            f"[model_server] 显存不足，跳过 embedding 预加载 "
                            f"(free {vram['free_gb']:.1f}GB < 2.5GB)"
                        )
                        return
                    result = await self.ensure("embedding",
                                               self._embed_cfg.get("model_path", ""),
                                               "bge-m3")
                    if result.get("ok"):
                        logger.info("[model_server] embedding 已就绪")
                    else:
                        logger.warning(f"[model_server] embedding 启动失败: {result.get('error')}")
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.error(f"[model_server] embedding 后台启动异常: {e}", exc_info=True)
            self._startup_task = asyncio.create_task(_bg_init())

    async def ensure(self, role: str, model_path: str = "",
                     model_name: str = "") -> dict:
        """确保实例就绪。已 ready → 复用；未启动 → 预算检查 + 启动 + wait_ready。"""
        cfg = self._embed_cfg if role == "embedding" else self._chat_cfg

        # 1. 快速路径：已 ready → 直接复用（无锁）
        inst = self._instances.get(role)
        if inst and inst.state == ServerState.READY:
            backend = self._backends.get(role)
            if backend and backend.is_running():
                self.touch(role)
                return {"ok": True, "port": inst.port, "state": "reused"}

        # 2. 关键段加锁（H2：防止并发双启动）
        async with self._ensure_lock:
            # 2a. 双检：锁内再查一次
            inst = self._instances.get(role)
            if inst and inst.state == ServerState.READY:
                backend = self._backends.get(role)
                if backend and backend.is_running():
                    self.touch(role)
                    return {"ok": True, "port": inst.port, "state": "reused"}

            return await self._ensure_locked(role, model_path, model_name, cfg)

    async def _probe_live(self, role: str, cfg: dict) -> tuple[int, int] | None:
        """探测已存在的活实例（A-017/L2）：
        embedding 查配置固定端口；chat 从 port_start 起扫描 100 个端口。
        返回 (port, pid)；pid 解析失败返回 (port, 0)。
        修复 Plan.md L2「chat 外部实例复用分支不可达」死分支——chat 现可从
        port_start 起探测活跃实例直接复用，而非只找空闲端口。"""
        backend = ModelBackend(self._llama_bin)
        if role == "embedding":
            port = cfg.get("port", 8999)
            if await backend.probe_async(port):
                return port, _pid_for_port(port) or 0
            return None
        port_start = cfg.get("port_start", 18082)
        for port in range(port_start, port_start + 100):
            if await backend.probe_async(port):
                return port, _pid_for_port(port) or 0
        return None

    async def _ensure_locked(self, role: str, model_path: str, model_name: str, cfg: dict) -> dict:
        """锁内执行的实际 ensure 逻辑。"""
        # 1. 探测已存在的活实例（A-017：孤儿回收；外部实例复用不误杀）
        live = await self._probe_live(role, cfg)
        if live:
            port, pid = live
            if pid and _is_orphan(pid) and _kill_pid(pid):
                # 崩溃残留的孤儿 → 回收后走下方全新启动（find_free_port 会复用该端口）
                logger.info(
                    f"[model_server] 检测到崩溃残留孤儿 llama-server 已回收"
                    f" (PID {pid}, port {port})，将重新拉起"
                )
                self._write_registry()
            else:
                backend = self._backends.get(role, ModelBackend(self._llama_bin))
                inst = _Instance(
                    role=role, model_path=model_path or cfg.get("model_path", ""),
                    model_name=model_name, port=port, state=ServerState.READY,
                    persistent=cfg.get("persistent", False),
                    gpu_layers=cfg.get("gpu_layers", 99),
                    ctx_len=cfg.get("ctx_len", 2048), external=True,
                )
                self._instances[role] = inst
                self._backends[role] = backend
                self._write_registry()
                self.touch(role)
                return {"ok": True, "port": port, "state": "external"}

        # 2. VRAM 预算检查（非 persistent 角色）
        if role == "chat":
            vram = self._vram.sample()
            if vram and vram["free_gb"] - self._chat_est_gb < 1.0:
                return {"ok": False, "error": f"显存不足（空闲 {vram['free_gb']:.1f}GB，需要 ~{self._chat_est_gb:.1f}GB，保留 1GB 余量）"}

        # 3. 解析模型路径
        model_path = model_path or cfg.get("model_path", "")
        if role == "chat" and not model_path:
            models_dir = Path(cfg.get("models_dir", ""))
            if models_dir.exists():
                ggufs = sorted(models_dir.glob("*.gguf"))
                if ggufs:
                    model_path = str(ggufs[0])
                    model_name = model_name or ggufs[0].stem
        if not model_path:
            return {"ok": False, "error": f"未指定模型路径（role={role}）"}

        # 4. 找空端口并启动（N10-M6: 端口冲突时重试 3 次）
        # A-003: 角色感知端口基址 —— embedding 用固定配置端口（8999），chat 用 port_start。
        # 修复前 embedding 也走 chat 的 port_start，导致 embedding 落在 18082 且与配置不符。
        base_port = _base_port_for(role, cfg, self._chat_cfg)
        max_retries = 3
        for attempt in range(max_retries):
            port = self._find_free_port(base_port, start_offset=attempt)
            if not port:
                continue
            backend = self._backends.get(role, ModelBackend(self._llama_bin))
            inst = _Instance(
                role=role, model_path=model_path, model_name=model_name,
                port=port, state=ServerState.LOADING,
                persistent=cfg.get("persistent", False),
                gpu_layers=cfg.get("gpu_layers", 99),
                ctx_len=cfg.get("ctx_len", 2048),
            )
            if not backend.start(model_path, port, inst.gpu_layers, inst.ctx_len,
                                 embedding=(role == "embedding")):
                inst.state = ServerState.IDLE
                if attempt < max_retries - 1:
                    logger.warning(f"[model_server] 端口 {port} 启动失败，重试 (attempt {attempt + 1}/{max_retries})")
                    continue
                return {"ok": False, "error": f"llama-server 启动失败（{model_path}）"}

            self._instances[role] = inst
            self._backends[role] = backend
            self._write_registry()

            # 5. 等待就绪
            ready = await backend.wait_ready(self._startup_timeout)
            if ready:
                inst.state = ServerState.READY
                self._write_registry()
                self.touch(role)
                return {"ok": True, "port": port, "state": "ready"}
            else:
                backend.stop()
                inst.state = ServerState.IDLE
                self._write_registry()
                if attempt < max_retries - 1:
                    continue
                return {"ok": False, "error": f"llama-server 启动超时（{self._startup_timeout}s）"}

        return {"ok": False, "error": "端口分配失败"}

    def release(self, role: str) -> dict:
        """卸载实例（persistent/LOADING 拒绝）"""
        inst = self._instances.get(role)
        if not inst:
            return {"ok": False, "error": f"实例不存在: {role}"}
        if inst.persistent:
            return {"ok": False, "error": f"{role} 是常驻实例，不允许手动卸载"}
        if inst.state == ServerState.LOADING:
            return {"ok": False, "error": f"{role} 正在加载中，无法卸载"}
        if role in self._idle_tasks:
            self._idle_tasks[role].cancel()
            self._idle_tasks.pop(role, None)
        backend = self._backends.get(role)
        if backend:
            inst.state = ServerState.UNLOADING
            backend.stop()
        inst.state = ServerState.IDLE
        self._write_registry()
        return {"ok": True, "state": "idle"}

    async def shutdown(self):
        """停止全部自己拉起的实例"""
        if hasattr(self, '_startup_task'):
            self._startup_task.cancel()
        for task in self._idle_tasks.values():
            task.cancel()
        self._idle_tasks.clear()
        for role, backend in self._backends.items():
            if not self._instances.get(role, _Instance(role="")).external:
                backend.stop()
        self._instances.clear()
        self._backends.clear()
        self._write_registry()
        logger.info("[model_server] 全部本地模型已停止")

    def touch(self, role: str):
        """活跃请求：重置空闲计时器"""
        cfg = self._chat_cfg if role == "chat" else self._embed_cfg
        idle_min = cfg.get("idle_unload_min", 0)
        if idle_min <= 0 or role == "embedding":
            return
        # 取消旧计时 → 创建新计时
        if role in self._idle_tasks:
            self._idle_tasks[role].cancel()
        self._idle_tasks[role] = asyncio.create_task(self._idle_timer(role, idle_min * 60))

    async def _idle_timer(self, role: str, seconds: float):
        """空闲计时到点 → release"""
        try:
            await asyncio.sleep(seconds)
            logger.info(f"[model_server] {role} 空闲 {seconds / 60:.0f} 分钟，自动卸载")
            self.release(role)
        except asyncio.CancelledError:
            pass

    # ── 查询 ───────────────────────────────────────────────

    def status(self) -> list[dict]:
        """返回所有实例状态"""
        vram = self._vram.sample()
        result = []
        for role, inst in self._instances.items():
            backend = self._backends.get(role)
            result.append({
                "role": role,
                "model": inst.model_name or Path(inst.model_path).stem if inst.model_path else "",
                "port": inst.port,
                "pid": backend.pid if backend else None,
                "state": inst.state,
                "persistent": inst.persistent,
                "external": inst.external,
                "vram_gb": vram,
            })
        return result

    def get_port(self, role: str) -> int:
        """获取实例端口（process_worker 等直接查询 registry 使用）"""
        inst = self._instances.get(role)
        return inst.port if inst and inst.state == ServerState.READY else 0

    # ── Registry ────────────────────────────────────────────

    def _write_registry(self):
        """原子写入 registry（防多进程读半截）"""
        data = {}
        for role, inst in self._instances.items():
            data[role] = {
                "model": inst.model_name or Path(inst.model_path).stem if inst.model_path else "",
                "port": inst.port,
                "pid": self._backends.get(role).pid if role in self._backends else None,
                "state": inst.state,
            }
        _REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(data, ensure_ascii=False, indent=2)
        tmp = _REGISTRY_PATH.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_text(raw, encoding="utf-8")
        os.replace(tmp, _REGISTRY_PATH)

    @staticmethod
    def read_registry() -> dict:
        """读取 registry（供外部进程使用）"""
        if not _REGISTRY_PATH.exists():
            return {}
        try:
            return json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}

    # ── 内部 ───────────────────────────────────────────────

    def _find_free_port(self, base_port: int, start_offset: int = 0) -> int:
        """从 base_port 起顺序找空闲端口（TCP 连接探测）。"""
        port = base_port + start_offset
        import socket
        while port < base_port + 100:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.3)
            result = sock.connect_ex(("127.0.0.1", port))
            sock.close()
            if result != 0:  # 连接失败 = 端口空闲
                # 再用 HTTP 确认
                try:
                    import urllib.request
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5)
                    port += 1
                    continue
                except Exception:
                    return port
            port += 1
        return base_port


def _base_port_for(role: str, cfg: dict, chat_cfg: dict) -> int:
    """端口基址（A-003）：embedding 用固定配置端口，chat 用 port_start。"""
    if role == "embedding":
        return cfg.get("port", 8999)
    return chat_cfg.get("port_start", 18082)


# ── A-017: 崩溃残留孤儿 llama-server 的检测与回收 ────────────


def _verify_llama_server_pid(pid: int) -> bool:
    """检查 PID 对应进程是否为 llama-server（N10-M7，防 PID 复用误杀）。

    Windows 优先 wmic 命令行校验（老系统）；wmic 缺失（Win11 24H2+ 已移除）
    时回退 tasklist 镜像名校验。Unix 读 /proc/{pid}/cmdline。"""
    if not pid:
        return False
    try:
        if IS_WINDOWS:
            if shutil.which("wmic"):
                result = subprocess.run(
                    ["wmic", "process", "where", f"ProcessId={pid}", "get", "CommandLine"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                return "llama-server" in (result.stdout or "")
            # wmic 缺失回退：tasklist 镜像名校验
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            return "llama-server" in (result.stdout or "")
        else:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", errors="replace")
            return "llama-server" in cmdline
    except Exception:
        return False  # 无法确认时不杀


def _pid_for_port(port: int) -> int | None:
    """解析监听端口的进程 PID（Windows netstat / Unix lsof）。失败返回 None。"""
    import re as _re
    try:
        if IS_WINDOWS:
            out = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=5,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WINDOWS else {}),
            ).stdout
            for line in out.splitlines():
                if _re.search(rf":{port}\s", line) and "LISTENING" in line.upper():
                    parts = line.split()
                    if parts and parts[-1].isdigit():
                        return int(parts[-1])
        else:
            out = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}"],
                capture_output=True, text=True, timeout=5,
            ).stdout
            pids = [x for x in out.strip().splitlines() if x.isdigit()]
            if pids:
                return int(pids[0])
    except Exception:
        pass
    return None


def _parent_pid(pid: int) -> int | None:
    """查询父 PID。失败/非 Windows 返回 None（保守：不判定孤儿）。

    Windows 优先 wmic；wmic 缺失（Win11 24H2+）回退 PowerShell Get-CimInstance。"""
    if not IS_WINDOWS:
        return None
    try:
        if shutil.which("wmic"):
            out = subprocess.run(
                ["wmic", "process", "where", f"ProcessId={pid}", "get", "ParentProcessId"],
                capture_output=True, text=True, timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,
            ).stdout
        else:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                 f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').ParentProcessId"],
                capture_output=True, text=True, timeout=8,
                creationflags=subprocess.CREATE_NO_WINDOW,
            ).stdout
        nums = [int(x) for x in out.split() if x.isdigit()]
        return nums[0] if nums else None
    except Exception:
        return None


def _process_alive(pid: int) -> bool:
    """PID 是否存活。查询失败保守视为存活（不误判孤儿、不误杀）。"""
    if IS_WINDOWS:
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True, text=True, timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,
            ).stdout
            return str(pid) in out
        except Exception:
            return True
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def _is_orphan(pid: int) -> bool:
    """父进程已死 → 判定为崩溃残留孤儿。父查询失败保守 False（不误杀）。"""
    ppid = _parent_pid(pid)
    if ppid is None or ppid in (0, 1, 4):
        return False
    return not _process_alive(ppid)


def _kill_pid(pid: int) -> bool:
    """回收孤儿 llama-server：wmic 校验命令行含 llama-server 后 taskkill 进程树。"""
    if not _verify_llama_server_pid(pid):
        logger.warning(f"[model_server] PID {pid} 非 llama-server，拒绝回收")
        return False
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            os.kill(pid, 15)
        logger.info(f"[model_server] 已回收孤儿 llama-server (PID {pid})")
        return True
    except Exception as e:
        logger.warning(f"[model_server] 回收孤儿 PID {pid} 失败: {e}")
        return False


# ── 全局单例 ────────────────────────────────────────────────

_MODEL_SERVER: ModelServerManager | None = None


def get_model_server() -> ModelServerManager | None:
    return _MODEL_SERVER


def set_model_server(mgr: ModelServerManager):
    global _MODEL_SERVER
    _MODEL_SERVER = mgr
