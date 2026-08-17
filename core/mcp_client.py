"""
slime MCP 客户端 — 连接外部 MCP Server，工具/资源/提示桥接到 ToolRegistry。

传输层：stdio（子进程）+ Streamable HTTP（远程）。
能力层：tools / resources / prompts。
授权层：OAuth 2.1（P2-5，远程 HTTP，见 core/mcp_oauth.py）。
"""

import asyncio
import base64
import hashlib
import json
import logging

# A-096: 重连上限 10 次（退避 1→60s，约 10 分钟；达上限放弃，/mcp start 手动拉起）
_MCP_MAX_RECONNECT = 10
import os
import re
import subprocess
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from core.mcp_oauth import OAuthFlow, OAuthManager

_PROJECT_ROOT = Path(__file__).resolve().parent.parent

# MCP JSON-RPC 版本
_JSONRPC = "2.0"
# 协议版本：2025-11-25 为最新（新 SDK LATEST），旧 server 会经 SUPPORTED_PROTOCOL_VERSIONS 协商下调
_PROTOCOL_VERSION = "2025-11-25"

# 安全限制
_MAX_HEADER_BYTES = 16 * 1024           # Content-Length 头最大 16KB（N10-M10）
_MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 响应体最大 10MB（N10-H3）
_MAX_MEDIA_BYTES = 10 * 1024 * 1024      # 单文件媒体落盘上限（P0-4）
_REQUEST_TIMEOUT = 30.0                 # 单次 RPC 超时（N10-L3）
_MAX_BRIDGED = 64                       # 每个 Server 最多桥接的资源/提示数

# image/audio/video content 落盘时的中文标签
_MEDIA_LABEL = {"image": "图片", "audio": "音频", "video": "视频"}

# 合法工具权限值（与 tools/registry.py:32 一致）
_VALID_PERMISSIONS = {"read", "write", "terminal", "network"}


# ── 传输抽象 ──────────────────────────────────────────────


class _Transport(ABC):
    """MCP 传输层抽象：stdio / Streamable HTTP。"""

    @abstractmethod
    async def start(self) -> bool: ...

    @abstractmethod
    async def close(self): ...

    @property
    @abstractmethod
    def running(self) -> bool: ...

    @abstractmethod
    async def request(self, payload: str, req_id: int, timeout: float = _REQUEST_TIMEOUT) -> dict | None:
        """发送 JSON-RPC request（payload 为已序列化的 JSON 字符串），返回响应 dict。"""

    @abstractmethod
    async def notify(self, payload: str):
        """发送 JSON-RPC notification（无响应）。"""


class _StdioTransport(_Transport):
    """stdio 子进程传输（JSONL / Content-Length 双帧格式，后台 reader 循环）。"""

    # A-113: MCP 子进程环境白名单——不继承完整父环境（防本地恶意 MCP server 窃取
    # 父进程里的 API keys 等敏感变量）；slime.toml 的 env 字段可显式补充所需变量
    _ENV_ALLOWLIST = {
        "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
        "TEMP", "TMP", "USERNAME", "USERPROFILE", "HOME",
        "LANG", "LC_ALL", "LANGUAGE", "APPDATA", "LOCALAPPDATA",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "no_proxy",
        "VIRTUAL_ENV", "PYTHONIOENCODING",
    }

    def __init__(self, command: str, args: list[str], env: dict | None, name: str,
                 framing: str = "jsonl"):
        self.command = command
        self.args = args
        self.env = env
        self.name = name
        self._proc: subprocess.Popen | None = None
        self._lock = asyncio.Lock()  # 写 stdin 统一锁（request + notify 共用）
        # stdio 帧格式：jsonl（MCP 2025+，`{json}\n`）| content_length（MCP 2024，LSP 风格）
        self._framing = "jsonl" if framing == "jsonl" else "content_length"
        # 后台 reader 循环：req_id → 待决 Future（单线程独占读，无读竞争）
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._on_notification: Callable[[dict], Awaitable[None]] | None = None  # 通知回调（P1-3）
        self._on_close: Callable[[], Awaitable[None]] | None = None  # 自然死亡回调（P2-1）

    async def start(self) -> bool:
        if self._proc is not None:
            return True
        try:
            # A-113: 白名单继承基础环境变量，self.env 显式补充（不再全量 os.environ）
            merged_env = {k: v for k, v in os.environ.items() if k in _StdioTransport._ENV_ALLOWLIST}
            if self.env:
                merged_env.update(self.env)
            self._proc = subprocess.Popen(
                [self.command] + self.args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=merged_env,
                text=False,
            )
            # 后台 reader + stderr drain（P0-1 / P0-2）
            self._reader_task = asyncio.create_task(self._reader_loop())
            self._stderr_task = asyncio.create_task(self._stderr_drain())
            return True
        except Exception as e:
            logging.warning(f"[mcp] {self.name} 启动失败: {e}")
            return False

    async def close(self):
        proc, self._proc = self._proc, None
        # 先终止进程树（关闭 stdout/stderr，让阻塞的 reader/stderr 读返回 EOF）
        if proc:
            self._terminate_tree(proc)
        # 再取消后台任务 + 清空 pending
        for task in (self._reader_task, self._stderr_task):
            if task and not task.done():
                task.cancel()
        self._reader_task = None
        self._stderr_task = None
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result(None)
        self._pending.clear()

    @staticmethod
    def _terminate_tree(proc: subprocess.Popen):
        """终止子进程及其整棵进程树。

        Windows：uvx/npx/cmd 包装器启动的孙进程（如 uvx → serena-agent.exe）在
        terminate 直接子进程后会成孤儿并继续持有管道 → reader 线程永久阻塞。
        用 taskkill /T /F 杀整棵树（先于 terminate 执行，父进程存活时树遍历有效）；
        失败回退 terminate → kill。
        """
        if os.name == "nt" and proc.poll() is None:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True, timeout=10,
                )
            except Exception:
                pass
        if proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
            except Exception:
                pass

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def request(self, payload: str, req_id: int,
                      timeout: float = _REQUEST_TIMEOUT) -> dict | None:
        if not self.running:
            return None
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending[req_id] = fut
        try:
            async with self._lock:
                self._proc.stdin.write(self._serialize(payload))
                self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            self._pending.pop(req_id, None)
            logging.warning(f"[mcp] {self.name} 通信失败: {e}")
            return None
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            # 超时不 kill 进程（P1-1 缓解）：只丢弃本次 pending，reader 循环继续
            self._pending.pop(req_id, None)
            logging.warning(f"[mcp] {self.name}: 请求超时 (id={req_id})")
            return None

    async def _reader_loop(self):
        """后台独占读循环：读帧 → 分发（匹配响应 / 通知回调 / 丢弃迟到响应）。"""
        while self.running:
            try:
                frame = await asyncio.to_thread(self._read_frame)
            except Exception as e:
                logging.warning(f"[mcp] {self.name}: reader 异常: {e}")
                break
            if frame is None:
                break  # EOF / 进程退出
            self._dispatch(frame)
        # 进程退出：清空所有 pending，让在途 request 返回 None
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result(None)
        self._pending.clear()
        # 自然死亡（非 close()：close 先置 _proc=None 再取消任务，此处不会命中）
        # → 置 running=False 防后续 request 写死 stdin，并触发重连（P2-1，审查发现 5）
        if self._proc is not None:
            self._proc = None
            if self._on_close:
                try:
                    asyncio.create_task(self._on_close())
                except Exception:
                    logging.exception(f"[mcp] {self.name}: on_close 回调异常")

    async def _stderr_drain(self):
        """消费 stderr 管道，防写满 64KB 缓冲阻塞子进程（P0-2）。"""
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        stderr = proc.stderr
        while True:
            try:
                line = await asyncio.to_thread(stderr.readline)
            except Exception:
                break
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                logging.debug(f"[mcp] {self.name} stderr: {text}")

    def _dispatch(self, frame: dict):
        rid = frame.get("id")
        if rid is not None:
            fut = self._pending.pop(rid, None)
            if fut is not None and not fut.done():
                fut.set_result(frame)
            else:
                logging.warning(f"[mcp] {self.name}: 迟到/未知响应 id={rid} 丢弃")
        else:
            # notification（无 id）：日志 + 异步分发回调（P1-3，审查发现 3：回调异步化不卡读循环）
            logging.info(f"[mcp] {self.name}: notification {frame.get('method', '')}")
            if self._on_notification:
                try:
                    asyncio.create_task(self._on_notification(frame))
                except Exception:
                    logging.exception(f"[mcp] {self.name}: 通知回调异常")

    def _serialize(self, payload: str) -> bytes:
        """按当前帧格式序列化：jsonl = `{json}\n`，content_length = LSP 风格。"""
        if self._framing == "jsonl":
            return (payload + "\n").encode("utf-8")
        return f"Content-Length: {len(payload.encode('utf-8'))}\r\n\r\n{payload}".encode("utf-8")

    def flip_framing(self) -> bool:
        """切换帧格式（stdio 握手探测失败时用），返回 True。"""
        self._framing = "content_length" if self._framing == "jsonl" else "jsonl"
        return True

    def _read_frame(self) -> dict | None:
        """同步读取一个响应帧（后台 reader 线程内调用）。按首字节嗅探帧格式。"""
        proc = self._proc
        if proc is None:
            return None
        first = proc.stdout.read(1)
        if not first:
            return None
        if first == b"{":
            return self._read_jsonl(first)
        return self._read_content_length(first)

    def _read_jsonl(self, first: bytes) -> dict | None:
        """读取换行分隔 JSON（`{json}\n`）。超限排空该行后返回 None（保持流对齐）。"""
        line = first
        while not line.endswith(b"\n"):
            chunk = self._proc.stdout.read(1)
            if not chunk:
                return None
            line += chunk
            if len(line) > _MAX_RESPONSE_BYTES:
                logging.warning(f"[mcp] {self.name}: JSONL 行超 {_MAX_RESPONSE_BYTES}B，排空跳过")
                self._drain_jsonl_line(line)
                return None
        try:
            return json.loads(line.decode("utf-8"))
        except (json.JSONDecodeError, ValueError):
            return None

    def _drain_jsonl_line(self, partial: bytes):
        """排空当前 JSONL 行剩余字节（超限帧，防流错位）。读满 2× 上限仍无换行则放弃。"""
        cap = _MAX_RESPONSE_BYTES
        while not partial.endswith(b"\n") and cap > 0:
            chunk = self._proc.stdout.read(1)
            if not chunk:
                return
            partial += chunk
            cap -= 1

    def _read_content_length(self, first: bytes) -> dict | None:
        """读取 LSP 风格 Content-Length 帧。超限排空 body 后返回 None。"""
        header = first
        while not header.endswith(b"\r\n\r\n"):
            chunk = self._proc.stdout.read(1)
            if not chunk:
                return None
            header += chunk
            if len(header) > _MAX_HEADER_BYTES:
                logging.warning(f"[mcp] {self.name}: Content-Length 头超大")
                return None
        cl_line = header.decode("utf-8").split("\r\n")[0]
        try:
            content_len = int(cl_line.split(":")[1].strip())
        except (IndexError, ValueError):
            return None
        if content_len > _MAX_RESPONSE_BYTES or content_len < 0:
            logging.warning(f"[mcp] {self.name}: 响应体过大 {content_len}B，排空跳过")
            self._drain_bytes(content_len)
            return None
        body = self._proc.stdout.read(content_len)
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def _drain_bytes(self, n: int):
        """读并丢弃 n 字节（超限帧，防流错位）。EOF 提前返回。"""
        remaining = n
        while remaining > 0:
            chunk = self._proc.stdout.read(min(65536, remaining))
            if not chunk:
                return
            remaining -= len(chunk)

    async def notify(self, payload: str):
        if not self.running:
            return
        try:
            async with self._lock:
                self._proc.stdin.write(self._serialize(payload))
                self._proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass


class _HTTPTransport(_Transport):
    """Streamable HTTP 传输（MCP 2025 规范）。"""

    def __init__(self, url: str, headers: dict | None, name: str,
                 oauth: OAuthManager | None = None):
        self.url = url.rstrip("/")
        self.extra_headers = headers or {}
        self.name = name
        self._session_id: str | None = None
        self._oauth = oauth  # P2-5: OAuth 2.1 管理器（None = 不启用）
        self._client = httpx.AsyncClient(timeout=_REQUEST_TIMEOUT)

    async def start(self) -> bool:
        # HTTP 无状态，连通性由 initialize 握手验证；
        # close() 后重开 client（P2-5：warmup 失败关闭 transport 后仍可 start_one 重试）
        if self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=_REQUEST_TIMEOUT)
        return True

    async def close(self):
        self._session_id = None
        await self._client.aclose()

    @property
    def running(self) -> bool:
        return not self._client.is_closed

    def _headers(self) -> dict:
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        # P2-5 优先级：静态 headers 有显式 Authorization → 跳过 OAuth（用户静态 token 意图明确）
        static_auth = self.extra_headers and any(
            k.lower() == "authorization" for k in self.extra_headers)
        if self._oauth and not static_auth:
            h.update(self._oauth.get_auth_header())
        h.update(self.extra_headers)
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    async def request(self, payload: str, req_id: int,
                      timeout: float = _REQUEST_TIMEOUT) -> dict | None:
        data, status, www_auth = await self._request_once(
            payload, req_id, timeout, retryable_401=self._oauth is not None)
        if data is None and status == 401 and self._oauth is not None:
            # P2-5: 401 → 快速确保 token（refresh <5s 或后台授权单飞）→ 重试最多 1 次
            try:
                token = await asyncio.wait_for(
                    self._oauth.ensure_token(www_auth), timeout=timeout)
            except asyncio.TimeoutError:
                # 慢授权（浏览器）超出本次请求窗口：任务靠 shield 独立存活，下次请求即成功
                logging.warning(f"[mcp] {self.name}: OAuth 授权等待超时（后台授权继续）")
                token = None
            if token:
                data, _, _ = await self._request_once(
                    payload, req_id, timeout, retryable_401=False)
        return data

    async def _request_once(self, payload: str, req_id: int, timeout: float,
                            retryable_401: bool) -> tuple[dict | None, int, str | None]:
        """单次 POST。返回 (响应 dict | None, HTTP status, WWW-Authenticate | None)。

        retryable_401=True 时 401 返回 (None, 401, header) 供上层重试；
        False（无 oauth / 重试后仍 401）保持旧语义：body 解析后经 _MCPServerError 透出细节。
        """
        try:
            # 用 stream 逐行读 SSE（P0-3 简单档）：content-type 是 event-stream 时命中 id 即返回，
            # 不等完整 body；否则按普通 JSON 读完解析。
            async with self._client.stream(
                "POST", self.url, content=payload, headers=self._headers(), timeout=timeout
            ) as resp:
                sid = resp.headers.get("Mcp-Session-Id")
                if sid:
                    self._session_id = sid
                if resp.status_code == 401 and retryable_401:
                    logging.warning(f"[mcp] {self.name}: HTTP 401 未授权，尝试 OAuth")
                    return None, 401, resp.headers.get("WWW-Authenticate")
                ctype = resp.headers.get("content-type", "")
                if "text/event-stream" in ctype:
                    # 问题1：server 定期发 keep-alive ping 时 httpx read 超时不会触发，
                    # 必须用 wait_for 兜底（超时返回 None，与 stdio 语义一致）
                    try:
                        return await asyncio.wait_for(
                            self._read_sse_stream(resp, req_id), timeout=timeout
                        ), resp.status_code, None
                    except asyncio.TimeoutError:
                        logging.warning(f"[mcp] {self.name}: SSE 流超时 (id={req_id})")
                        return None, resp.status_code, None
                return resp.json(), resp.status_code, None
        except httpx.HTTPError as e:
            logging.warning(f"[mcp] {self.name} HTTP 请求失败: {e}")
            return None, 0, None
        except (json.JSONDecodeError, ValueError):
            return None, 0, None

    async def _read_sse_stream(self, resp, req_id: int) -> dict | None:
        """逐行读 SSE，命中 req_id 即返回；流结束未命中返回 None。"""
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == req_id:
                return msg
        return None

    @staticmethod
    def _parse_sse(text: str, req_id: int) -> dict | None:
        """从 SSE 流中提取匹配 req_id 的 JSON-RPC 响应。"""
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                msg = json.loads(data)
                if msg.get("id") == req_id:
                    return msg
            except json.JSONDecodeError:
                continue
        return None

    async def notify(self, payload: str):
        try:
            await self._client.post(self.url, content=payload, headers=self._headers())
        except httpx.HTTPError:
            pass


# ── MCP Server 连接 ───────────────────────────────────────


class _MCPServerError(Exception):
    """MCP RPC 错误（server 明确返回 error，与传输层失败/超时区分）。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class _MCPServer:
    """单个 MCP Server 连接（transport 无关）。"""

    def __init__(self, name: str, transport: _Transport, timeout: float = _REQUEST_TIMEOUT,
                 tool_permissions: dict[str, list[str]] | None = None,
                 oauth: OAuthManager | None = None):
        self.name = name
        self._transport = transport
        self._timeout = timeout
        self.tool_permissions = tool_permissions or {}
        self._oauth = oauth  # P2-5: OAuth 管理器（仅 HTTP 远程 server 配置）
        self.last_error: str | None = None  # P2-1: 最近一次断连/重连错误
        self._next_id = 0
        self._refresh_lock = asyncio.Lock()  # list_changed 并发刷新串行化（收尾观察项 2）
        self.tools: list[dict] = []
        self.resources: list[dict] = []
        self.prompts: list[dict] = []

    # ── 生命周期 ──────────────────────────────────────

    async def start(self) -> bool:
        if not await self._transport.start():
            return False
        try:
            # P2-5: HTTP + OAuth → 预热授权（长窗口，浏览器授权不落在请求超时窗口内）。
            # 失败 = 用户取消/发现失败 → 关闭 transport 返回 False（server 不启动），
            # 可经 start_one 重试；status() 显示 pending/expired，工具调用提示"未授权"。
            if self._oauth is not None:
                logging.info(f"[mcp] {self.name}: 等待 OAuth 授权（请在浏览器完成授权）")
                if not await self._oauth.warmup():
                    self.last_error = f"OAuth 授权未完成（{self._oauth.last_error or '用户取消/失败'}）"
                    logging.warning(f"[mcp] {self.name}: {self.last_error}")
                    await self._transport.close()
                    return False
            params = {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
                "clientInfo": {"name": "slime", "version": "0.3.0"},
            }
            flip = getattr(self._transport, "flip_framing", None)
            # stdio 握手探测：帧格式不符时用短超时快速失败 → 切换帧格式 → 重启子进程重试。
            # 实测补充（2026-08-14）：Python MCP server（serena/headroom，JSONL）冷启动 4-8s，
            # 会越过 5s 探测窗口 → 误 flip 到 Content-Length → 必失败。探测超时但进程仍存活
            # 多半是启动慢，先同帧格式重试一次（全超时）；帧错配的 server 通常直接退出，
            # 此时才走 flip（EOF 会立即触发，不额外等待）。
            init = await self._request("initialize", params, timeout=5.0 if flip else None)
            if init is None and flip is not None:
                if self._transport.running:
                    logging.info(f"[mcp] {self.name}: 握手探测超时但进程存活，先同帧格式重试")
                    init = await self._request("initialize", params)
                if init is None and flip():
                    logging.info(f"[mcp] {self.name}: 切换 stdio 帧格式重试握手")
                    await self._transport.close()
                    if await self._transport.start():
                        init = await self._request("initialize", params)
            if init is None:
                await self._transport.close()
                return False
            await self._notify("notifications/initialized", {})
            await self._discover()
            return True
        except Exception as e:
            logging.warning(f"[mcp] {self.name} 启动失败: {e}")
            await self._transport.close()
            return False

    async def stop(self):
        self.tools = []
        self.resources = []
        self.prompts = []
        await self._transport.close()

    @property
    def running(self) -> bool:
        return self._transport.running

    # ── 能力发现 ──────────────────────────────────────

    async def _discover(self):
        # 每个能力独立容错：不支持的 Server 返回 error（Method not found）即跳过
        r = await self._list_capability("tools/list")
        if r and isinstance(r, dict):
            self.tools = [t for t in r.get("tools", []) if isinstance(t, dict)]
        r = await self._list_capability("resources/list")
        if r and isinstance(r, dict):
            self.resources = [x for x in r.get("resources", []) if isinstance(x, dict)][:_MAX_BRIDGED]
        r = await self._list_capability("prompts/list")
        if r and isinstance(r, dict):
            self.prompts = [p for p in r.get("prompts", []) if isinstance(p, dict)][:_MAX_BRIDGED]
        logging.info(
            f"[mcp] {self.name}: {len(self.tools)} tools / "
            f"{len(self.resources)} resources / {len(self.prompts)} prompts"
        )

    async def _list_capability(self, method: str) -> Any | None:
        """列出能力；server 返回 error（如 Method not found）时跳过，非传输失败。"""
        try:
            return await self._request(method, {})
        except _MCPServerError as e:
            logging.info(f"[mcp] {self.name}: {method} 不可用: {e.message}")
            return None

    # ── JSON-RPC ──────────────────────────────────────

    def _next_request_id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def _request(self, method: str, params: dict, timeout: float | None = None) -> Any | None:
        req_id = self._next_request_id()
        payload = json.dumps({"jsonrpc": _JSONRPC, "id": req_id, "method": method, "params": params})
        resp = await self._transport.request(
            payload, req_id, timeout=timeout if timeout is not None else self._timeout
        )
        if resp is None:
            return None
        if resp.get("id") != req_id:
            logging.warning(f"[mcp] {self.name}: 响应 ID 不匹配 {resp.get('id')} != {req_id}")
            return None
        if "error" in resp:
            err = resp["error"]
            raise _MCPServerError(err.get("code", -1), err.get("message", str(err)))
        return resp.get("result")

    async def _notify(self, method: str, params: dict):
        payload = json.dumps({"jsonrpc": _JSONRPC, "method": method, "params": params})
        await self._transport.notify(payload)

    # ── 能力调用 ──────────────────────────────────────

    async def call_tool(self, tool_name: str, args: dict) -> str:
        try:
            result = await self._request("tools/call", {"name": tool_name, "arguments": args})
        except _MCPServerError as e:
            # A-042: 失败统一 [错误] 前缀（与内置工具/技能引擎一致），
            # 反幻觉协议以 "[错误] 开头 = 失败" 为识别信号
            return f"[错误] MCP 工具 '{tool_name}' 调用失败: {e.message} (code={e.code})"
        if result is None:
            return f"[错误] MCP 工具 '{tool_name}' 调用失败：服务无响应"
        return self._content_to_text(result.get("content", []))

    async def read_resource(self, uri: str) -> str:
        try:
            result = await self._request("resources/read", {"uri": uri})
        except _MCPServerError as e:
            return f"[错误] MCP 资源 '{uri}' 读取失败: {e.message} (code={e.code})"
        if result is None:
            return f"[错误] MCP 资源 '{uri}' 读取失败：服务无响应"
        contents = result.get("contents", [])
        parts = []
        for c in contents:
            if not isinstance(c, dict):
                continue
            if "text" in c:
                parts.append(c["text"])
            elif "blob" in c:
                parts.append(f"[二进制资源: {c.get('mimeType', 'unknown')}, {c.get('uri', '')}]")
        return "\n".join(parts) if parts else "[MCP 空资源]"

    async def get_prompt(self, name: str, arguments: dict | None = None) -> str:
        try:
            result = await self._request("prompts/get", {"name": name, "arguments": arguments or {}})
        except _MCPServerError as e:
            return f"[错误] MCP 提示 '{name}' 获取失败: {e.message} (code={e.code})"
        if result is None:
            return f"[错误] MCP 提示 '{name}' 获取失败：服务无响应"
        parts = []
        if isinstance(result, dict) and result.get("description"):
            parts.append(result["description"])
        for m in result.get("messages", []) if isinstance(result, dict) else []:
            if not isinstance(m, dict):
                continue
            content = m.get("content")
            if isinstance(content, dict) and content.get("type") == "text":
                parts.append(content.get("text", ""))
        return "\n\n".join(parts) if parts else "[MCP 空提示]"

    def _content_to_text(self, content: list) -> str:
        """MCP content 数组 → 文本；image/audio/video 落盘回传路径（P0-4）。"""
        if not isinstance(content, list):
            return json.dumps(content, ensure_ascii=False)
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            t = item.get("type")
            if t == "text":
                parts.append(item.get("text", ""))
            elif t == "resource":
                parts.append(f"[资源: {item.get('resource', {})}]")
            elif t in ("image", "audio", "video"):
                label = _MEDIA_LABEL.get(t, t)
                data = item.get("data", "") or ""
                try:
                    raw = base64.b64decode(data) if data else b""
                except (ValueError, TypeError):
                    raw = b""
                if not raw:
                    parts.append(f"[{label}: 无数据]")
                    continue
                path = self._save_media(raw, item.get("mimeType", ""), t)
                parts.append(f"[{label}已保存: {path}]" if path else f"[{label}过大，已跳过]")
        return "\n".join(parts) if parts else "[MCP 空响应]"

    def _save_media(self, data: bytes, mime: str, kind: str) -> str | None:
        """二进制内容落盘到 data/mcp/{server}/，返回绝对路径；超限/写失败返回 None。"""
        if len(data) > _MAX_MEDIA_BYTES:
            logging.warning(f"[mcp] {self.name}: {kind} 超 {_MAX_MEDIA_BYTES}B，跳过落盘")
            return None
        # mimeType → 扩展名；缺失时按类型默认（image→png / audio、video→bin）
        ext = ""
        if mime and "/" in mime:
            ext = mime.rsplit("/", 1)[1].split(";")[0].split("+")[0].lower()
            ext = f".{ext}" if ext.isalnum() else ""
        if not ext:
            ext = {"image": ".png", "audio": ".bin", "video": ".bin"}.get(kind, ".bin")
        digest = hashlib.sha256(data).hexdigest()[:16]
        # 目录段 sanitize（审查发现 2）：server name 只保留 [A-Za-z0-9_-]，防 `..` 路径逃逸
        safe_name = re.sub(r"[^A-Za-z0-9_-]", "_", self.name)
        d = _PROJECT_ROOT / "data" / "mcp" / safe_name
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{digest}{ext}"
        if not path.exists():  # 同内容自动去重
            try:
                path.write_bytes(data)
            except OSError as e:
                logging.warning(f"[mcp] {self.name}: 落盘失败: {e}")
                return None
        return str(path)


# ── MCP 客户端管理器 ──────────────────────────────────────


class MCPClient:
    """MCP 客户端管理器。单例，管理多个 MCP Server 连接并桥接到 ToolRegistry。"""

    def __init__(self):
        self._servers: dict[str, _MCPServer] = {}
        # slime_tool_name → (server_name, kind, mcp_name_or_uri)
        self._tool_map: dict[str, tuple[str, str, str]] = {}
        self._reconnect_tasks: dict[str, asyncio.Task] = {}  # P2-1: server_name → 重连任务

    # ── 服务器管理 ────────────────────────────────────

    def add_server(self, name: str, command: str = "", args: list[str] | None = None,
                   env: dict | None = None, url: str = "", headers: dict | None = None,
                   timeout: float | None = None, tool_permissions: dict[str, list[str]] | None = None,
                   oauth: bool = False, oauth_scopes: list[str] | None = None,
                   oauth_client_id: str | None = None,
                   oauth_redirect_port: int | None = None):
        """注册 MCP Server 配置（不立即启动）。command 与 url 二选一。timeout=None 用默认。

        tool_permissions（P2-3）：{"default": ["read"]} 或按工具名 {"screenshot": ["read"]}；
        缺省时 MCP 工具默认 ["network"]，resources/prompts 固定 ["read"]。

        oauth（P2-5）：仅 url 型 server 有效。oauth=True 且 headers 无静态 Authorization 时，
        自动走 OAuth 2.1（发现 → DCR 或 oauth_client_id → 浏览器授权 PKCE → token 缓存）。
        oauth_scopes 不填则用 AS 默认 scope；oauth_redirect_port 默认 18091（固定端口）。
        """
        oauth_mgr = None
        if oauth:
            if not url:
                logging.warning(f"[mcp] Server '{name}': oauth=true 仅对 url 型（HTTP）server 有效，已忽略")
            else:
                oauth_mgr = OAuthManager(
                    server_name=name,
                    server_url=url,
                    scopes=oauth_scopes,
                    client_id=oauth_client_id,
                    redirect_port=oauth_redirect_port or OAuthFlow.DEFAULT_PORT,
                )
        if command:
            transport = _StdioTransport(command, args or [], env, name)
        elif url:
            transport = _HTTPTransport(url, headers, name, oauth=oauth_mgr)
        else:
            raise ValueError(f"MCP Server '{name}' 缺少 command 或 url")
        self._servers[name] = _MCPServer(
            name, transport, timeout=timeout or _REQUEST_TIMEOUT,
            tool_permissions=tool_permissions, oauth=oauth_mgr,
        )

    async def start_all(self) -> dict[str, bool]:
        names = list(self._servers.keys())
        # P2-2: 并发启动，每 server 独立超时，单 server 卡死不拖累全部；
        # P2-5: oauth server 放宽至 360s（warmup 浏览器授权最长 ~300s），非 oauth 保持 60s
        results = await asyncio.gather(
            *(asyncio.wait_for(
                self._servers[n].start(),
                timeout=360.0 if self._servers[n]._oauth is not None else 60.0,
            ) for n in names),
            return_exceptions=True,
        )
        out = {}
        for name, r in zip(names, results):
            if isinstance(r, BaseException):
                logging.warning(f"[mcp] {name}: 启动失败/超时: {r}")
                r = False
            out[name] = bool(r)
            if out[name]:
                self._wire_server(name, self._servers[name])
                self._register_capabilities(name, self._servers[name])
        return out

    async def start_one(self, name: str) -> bool:
        server = self._servers.get(name)
        if not server:
            return False
        # P2-5: oauth server 放宽外壳超时至 360s（warmup 浏览器授权最长 ~300s）；非 oauth 不加外壳
        if server._oauth is not None:
            try:
                ok = await asyncio.wait_for(server.start(), timeout=360.0)
            except asyncio.TimeoutError:
                logging.warning(f"[mcp] {name}: 启动超时（360s，OAuth 授权窗口）")
                ok = False
        else:
            ok = await server.start()
        if ok:
            self._wire_server(name, server)
            self._register_capabilities(name, server)
        return ok

    async def stop_all(self):
        # 取消在途重连任务（P2-1）
        for task in self._reconnect_tasks.values():
            if not task.done():
                task.cancel()
        self._reconnect_tasks.clear()
        for server in self._servers.values():
            await server.stop()
        # 先摘 registry（此时 _tool_map 仍有内容），再清空映射
        self._unregister_all_tools()
        self._tool_map.clear()

    async def stop_one(self, name: str) -> bool:
        server = self._servers.get(name)
        if not server:
            return False
        task = self._reconnect_tasks.pop(name, None)
        if task and not task.done():
            task.cancel()
        self._unregister_server_tools(name)
        await server.stop()
        return True

    def status(self) -> list[dict]:
        return [
            {
                "name": name,
                "running": srv.running,
                "tools": len(srv.tools),
                "resources": len(srv.resources),
                "prompts": len(srv.prompts),
                "last_error": srv.last_error,
                # P2-5: pending / authorized / expired / none（未配置 oauth 恒为 none）
                "oauth": srv._oauth.status() if srv._oauth is not None else "none",
            }
            for name, srv in self._servers.items()
        ]

    # ── 能力调用路由 ──────────────────────────────────

    async def call_tool(self, slime_name: str, args: dict) -> str:
        entry = self._tool_map.get(slime_name)
        if not entry:
            return f"[错误] MCP 未找到工具 '{slime_name}'"
        server_name, kind, orig = entry
        server = self._servers.get(server_name)
        if not server or not server.running:
            # P2-5: 区分"未授权"与"服务无响应"——oauth server 未授权时给出可行动的提示
            if server is not None and server._oauth is not None and server._oauth.status() != "authorized":
                return f"[错误] MCP Server '{server_name}' 未授权（请完成浏览器授权后重试）"
            return f"[错误] MCP Server '{server_name}' 未运行"
        if kind == "tool":
            return await server.call_tool(orig, args)
        if kind == "resource":
            return await server.read_resource(orig)
        return await server.get_prompt(orig, args)

    # ── 桥接 ─────────────────────────────────────────

    def _register_capabilities(self, server_name: str, server: _MCPServer):
        from tools.registry import Tool, get_registry
        registry = get_registry()

        # tools → 按 per-server 权限映射（P2-3），缺省 network
        for t in server.tools:
            name = t.get("name", "")
            if not name:
                continue
            slime_name = self._unique_slime_name(f"mcp_{name}")
            self._tool_map[slime_name] = (server_name, "tool", name)
            registry.register(Tool(
                name=slime_name,
                description=t.get("description", f"MCP 工具: {name}"),
                parameters=t.get("inputSchema", {"type": "object", "properties": {}, "required": []}),
                execute_fn=self._make_executor(slime_name),
                permissions=self._resolve_tool_permissions(server, name),
            ))

        # resources → read 级（只读数据）
        for i, r in enumerate(server.resources):
            uri = r.get("uri", "")
            if not uri:
                continue
            name = r.get("name", "") or f"resource_{i}"
            slime_name = self._unique_slime_name(f"mcp_res_{name}")
            self._tool_map[slime_name] = (server_name, "resource", uri)
            registry.register(Tool(
                name=slime_name,
                description=r.get("description", f"MCP 资源: {name}"),
                parameters={"type": "object", "properties": {}, "required": []},
                execute_fn=self._make_executor(slime_name),
                permissions=["read"],
            ))

        # prompts → read 级（只读提示）
        for p in server.prompts:
            name = p.get("name", "")
            if not name:
                continue
            slime_name = self._unique_slime_name(f"mcp_prompt_{name}")
            self._tool_map[slime_name] = (server_name, "prompt", name)
            registry.register(Tool(
                name=slime_name,
                description=p.get("description", f"MCP 提示: {name}"),
                parameters=self._prompt_args_to_schema(p.get("arguments", [])),
                execute_fn=self._make_executor(slime_name),
                permissions=["read"],
            ))

    def _unique_slime_name(self, base: str) -> str:
        """桥接名去重（P2-4）：`_tool_map` 已有该名则后缀 _2/_3/...。"""
        name, i = base, 2
        while name in self._tool_map:
            logging.warning(f"[mcp] 工具名 '{base}' 冲突，改用 '{base}_{i}'")
            name = f"{base}_{i}"
            i += 1
        return name

    def _resolve_tool_permissions(self, server: _MCPServer, tool_name: str) -> list[str]:
        """P2-3：按工具名/默认键解析权限，非法值回退 network。"""
        cfg = getattr(server, "tool_permissions", {}) or {}
        perms = cfg.get(tool_name, cfg.get("default", ["network"]))
        if isinstance(perms, str):
            perms = [perms]
        if not isinstance(perms, (list, tuple)):
            logging.warning(f"[mcp] {server.name}: 工具 '{tool_name}' 权限配置类型非法，回退 network")
            return ["network"]
        perms = [p for p in perms if isinstance(p, str)]
        if not perms:
            return ["network"]
        if any(p not in _VALID_PERMISSIONS for p in perms):
            logging.warning(f"[mcp] {server.name}: 工具 '{tool_name}' 权限 {perms} 含非法值，回退 network")
            return ["network"]
        return perms

    @staticmethod
    def _prompt_args_to_schema(arguments: list) -> dict:
        props, required = {}, []
        for a in arguments:
            if not isinstance(a, dict):
                continue
            n = a.get("name", "")
            if not n:
                continue
            props[n] = {"type": "string", "description": a.get("description", "")}
            if a.get("required"):
                required.append(n)
        return {"type": "object", "properties": props, "required": required}

    def _make_executor(self, slime_name: str):
        async def _exec(args: dict) -> str:
            return await self.call_tool(slime_name, args)
        return _exec

    def _unregister_all_tools(self):
        self._unregister_tools(list(self._tool_map.keys()))

    def _unregister_tools(self, names: list[str]):
        from tools.registry import get_registry
        registry = get_registry()
        for n in names:
            registry.unregister(n)

    def _unregister_server_tools(self, name: str):
        """摘除某 server 桥接的全部工具（P1-3 刷新 / P2-1 重连共用）。"""
        to_remove = [t for t, (s, _, _) in self._tool_map.items() if s == name]
        for t in to_remove:
            self._tool_map.pop(t, None)
        self._unregister_tools(to_remove)

    # ── 通知 / 重连接线（P1-3 / P2-1）─────────────────────

    def _wire_server(self, name: str, server: _MCPServer):
        """给 stdio 传输挂通知回调与断连回调（HTTP 无 reader 循环，跳过）。"""
        transport = server._transport
        if not isinstance(transport, _StdioTransport):
            return
        transport._on_notification = self._make_notification_handler(name)
        transport._on_close = self._make_close_handler(name)

    def _make_notification_handler(self, name: str):
        async def handler(frame: dict):
            # 包 try/except（收尾观察项 1）：_refresh_server_tools 若抛非 _MCPServerError
            # 异常（如传输层意外），在此吞掉，否则 create_task 的任务异常无人 retrieve
            try:
                if frame.get("method") == "notifications/tools/list_changed":
                    await self._refresh_server_tools(name)
            except Exception:
                logging.exception(f"[mcp] {name}: 通知处理异常")
        return handler

    def _make_close_handler(self, name: str):
        async def handler():
            await self._schedule_reconnect(name)
        return handler

    async def _refresh_server_tools(self, name: str):
        """list_changed → 重新发现 + 重注册（先摘旧再挂新，P1-3）。"""
        server = self._servers.get(name)
        if not server or not server.running:
            return
        # per-server 刷新锁（收尾观察项 2）：防并发 list_changed 交错 _unregister/_register 重复注册
        async with server._refresh_lock:
            if not server.running:
                return
            await server._discover()
            self._unregister_server_tools(name)
            self._register_capabilities(name, server)
            logging.info(f"[mcp] {name}: tools/list_changed 已刷新")

    async def _schedule_reconnect(self, name: str):
        """断连后摘除已死工具并调度指数退避重连（P2-1）。"""
        task = self._reconnect_tasks.get(name)
        if task and not task.done():
            return
        server = self._servers.get(name)
        if not server:
            return
        if server.last_error is None:
            server.last_error = "传输断开"
        self._unregister_server_tools(name)
        self._reconnect_tasks[name] = asyncio.create_task(self._reconnect_loop(name))

    async def _reconnect_loop(self, name: str):
        """A-096（漏洞清单 M1/P1-17）：重连加上限——最多 _MCP_MAX_RECONNECT 次
        （约 10 分钟退避），达到上限后放弃并标记 last_error（/mcp start 手动拉起；
        后续请求失败仍会重新触发 _schedule_reconnect，幂等不冲突）。"""
        backoff = 1.0
        attempt = 0
        while attempt < _MCP_MAX_RECONNECT:
            server = self._servers.get(name)
            if not server:
                return
            await asyncio.sleep(backoff)
            try:
                ok = await server.start()
            except Exception as e:
                ok = False
                server.last_error = str(e)
            if ok:
                self._register_capabilities(name, server)
                server.last_error = None
                logging.info(f"[mcp] {name}: 重连成功")
                return
            attempt += 1
            backoff = min(backoff * 2, 60.0)
            server.last_error = f"重连失败（{attempt}/{_MCP_MAX_RECONNECT}），{backoff}s 后重试"
        server.last_error = f"重连放弃（{_MCP_MAX_RECONNECT} 次），请用 /mcp start 手动拉起"
        logging.warning(f"[mcp] {name}: 重连放弃（{_MCP_MAX_RECONNECT} 次）")


# ── 全局单例 ────────────────────────────────────────────

_client: MCPClient | None = None


def get_mcp_client() -> MCPClient:
    global _client
    if _client is None:
        _client = MCPClient()
    return _client


def reset_mcp_client():
    global _client
    _client = None
