"""
slime MCP OAuth 2.1 客户端（P2-5）— 远程 HTTP MCP Server 授权。

规范：MCP 2025-11-25 授权规范 + RFC 9728（Protected Resource Metadata）、
RFC 8414（AS Metadata）、RFC 7591（DCR）、RFC 8707（resource 参数）、
RFC 8252（native app）、RFC 7636（PKCE S256）。
零新依赖：httpx + 标准库（回调服务器为手写 asyncio socket，仅解析一个 GET）。

生命周期（与 mcp_client.py 集成）：
  start() 预热  → warmup()：缓存 token → refresh → 浏览器授权码+PKCE（长窗口，<300s）
  request() 401 → ensure_token()：快速 refresh（<5s 路径）或后台授权任务（单飞）
token 落盘 data/mcp/{sanitized_name}/oauth.json，与 auth_token.json 同等级保护。
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

_PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 固定回调端口（DCR redirect_uri 与 authorize 必须完全一致，故不随机）
_DEFAULT_REDIRECT_PORT = 18091
# 浏览器授权等待上限（warmup 总时长 <300s；start_all 外壳放宽至 360s）
_AUTH_WAIT_TIMEOUT = 240.0
# token 提前失效余量（时钟偏差）
_EXPIRY_SKEW = 30.0
# OAuth 端点短请求超时（发现/DCR/token 交换）
_OAUTH_HTTP_TIMEOUT = 15.0

_CALLBACK_HTML = "<html><meta charset='utf-8'><body><h3>slime MCP OAuth</h3><p>{}</p></body></html>"


async def _http_json(method: str, url: str, *, data: dict | None = None,
                     payload: dict | None = None) -> dict | None:
    """OAuth 端点短请求 → JSON dict（或 None）。每次独立 client（OAuth 调用低频）。"""
    try:
        if data:
            data = {k: v for k, v in data.items() if v is not None}
        async with httpx.AsyncClient(timeout=_OAUTH_HTTP_TIMEOUT, follow_redirects=True) as client:
            resp = await client.request(method, url, data=data, json=payload)
        if resp.status_code not in (200, 201):
            return None
        out = resp.json()
        return out if isinstance(out, dict) else None
    except (httpx.HTTPError, ValueError):
        return None


class TokenStore:
    """token 持久化：data/mcp/{sanitized_name}/oauth.json。
    Windows 隐藏 + icacls / Unix 0o600，与 auth_token.json 安全策略一致。"""

    def __init__(self, server_name: str):
        # 路径 sanitize：仅保留 [A-Za-z0-9_-]，与 _save_media 规则一致（审查建议 7）
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", server_name)
        self._path = _PROJECT_ROOT / "data" / "mcp" / safe / "oauth.json"

    def load(self) -> dict | None:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, json.JSONDecodeError):
            return None

    def save(self, tokens: dict):
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # 原子写：临时文件 + os.replace（与 encryption.py passphrase 一致）
            tmp = self._path.with_suffix(f".{secrets.token_hex(4)}.tmp")
            tmp.write_text(json.dumps(tokens, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._path)
            self._protect(self._path)
        except OSError as e:
            logging.warning(f"[mcp-oauth] token 落盘失败: {e}")

    def clear(self):
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            pass

    @staticmethod
    def _protect(path: Path):
        """Windows：隐藏 + icacls 仅当前用户；Unix：0o600。失败不阻塞。"""
        if os.name == "nt":
            import ctypes
            ctypes.windll.kernel32.SetFileAttributesW(str(path), 2)  # FILE_ATTRIBUTE_HIDDEN
            try:
                subprocess.run(
                    ["icacls", str(path), "/inheritance:r", "/grant:r",
                     f"{os.environ.get('USERNAME', '')}:(R,W)"],
                    capture_output=True, timeout=5,
                )
            except Exception:
                pass  # icacls 失败不阻塞（与 encryption.py 一致）
        else:
            path.chmod(0o600)


class OAuthDiscovery:
    """两步发现（RFC 9728 + RFC 8414）：
    1. 401 WWW-Authenticate 头优先（resource_metadata="..."）→ 无则 GET
       /.well-known/oauth-protected-resource（RFC 9728）
    2. AS 元数据：authorization_servers[0] → /.well-known/oauth-authorization-server，
       失败 fallback OIDC（/.well-known/openid-configuration）
    """

    @staticmethod
    def parse_www_authenticate(header: str | None) -> str | None:
        """解析 RFC 9728 WWW-Authenticate 头的 resource_metadata="<url>"。"""
        if not header:
            return None
        m = re.search(r'resource_metadata\s*=\s*"([^"]+)"', header)
        return m.group(1) if m else None

    async def discover(self, server_url: str, www_authenticate: str | None = None) -> dict | None:
        base = server_url.rstrip("/")
        protected = None
        meta_url = self.parse_www_authenticate(www_authenticate)
        if meta_url:
            protected = await _http_json("GET", meta_url)
        if protected is None:
            protected = await _http_json("GET", base + "/.well-known/oauth-protected-resource")
        if protected is None:
            return None
        # resource：RFC 9728 metadata 的 resource 字段优先，无则回退 server_url（关键决策）
        resource = protected.get("resource") or base
        auth_servers = protected.get("authorization_servers")
        issuer = auth_servers[0] if isinstance(auth_servers, list) and auth_servers else None
        if issuer:
            as_md = await _http_json("GET", issuer.rstrip("/") + "/.well-known/oauth-authorization-server")
        else:
            as_md = await _http_json("GET", base + "/.well-known/oauth-authorization-server")
        if as_md is None:
            # OIDC Discovery fallback（RFC 8414 兼容）
            oidc_base = issuer.rstrip("/") if issuer else base
            oidc = await _http_json("GET", oidc_base + "/.well-known/openid-configuration")
            if oidc:
                as_md = {
                    "authorization_endpoint": oidc.get("authorization_endpoint"),
                    "token_endpoint": oidc.get("token_endpoint"),
                    "registration_endpoint": oidc.get("registration_endpoint"),
                }
        if not as_md or not as_md.get("authorization_endpoint") or not as_md.get("token_endpoint"):
            return None
        return {
            "authorization_endpoint": as_md["authorization_endpoint"],
            "token_endpoint": as_md["token_endpoint"],
            "registration_endpoint": as_md.get("registration_endpoint"),
            "resource": resource,
            "scopes_supported": as_md.get("scopes_supported"),
        }


class OAuthRegistration:
    """RFC 7591 动态客户端注册（DCR）。失败返回 None → 上层提示手动配置 client_id。"""

    async def register(self, registration_endpoint: str, client_name: str,
                       redirect_uri: str) -> dict | None:
        payload = {
            "client_name": client_name,
            "application_type": "native",  # RFC 8252
            "grant_types": ["authorization_code", "refresh_token"],
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "none",  # 公共客户端 + PKCE
        }
        data = await _http_json("POST", registration_endpoint, payload=payload)
        if data and data.get("client_id"):
            return data
        return None


class OAuthFlow:
    """OAuth 2.1 授权码 + PKCE S256。固定端口本地回调（默认 18091，可配置）。"""

    DEFAULT_PORT = _DEFAULT_REDIRECT_PORT

    def __init__(self, redirect_port: int = DEFAULT_PORT):
        self.redirect_port = redirect_port

    @property
    def redirect_uri(self) -> str:
        return f"http://127.0.0.1:{self.redirect_port}/mcp/oauth/callback"

    @staticmethod
    def challenge_from(verifier: str) -> str:
        """PKCE S256 code_challenge（RFC 7636）。"""
        digest = hashlib.sha256(verifier.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")

    @staticmethod
    def _generate_pkce() -> tuple[str, str]:
        verifier = secrets.token_urlsafe(48)  # 64 字符 base64url，落在 43~128 区间
        return verifier, OAuthFlow.challenge_from(verifier)

    async def authorize(self, discovery: dict, client_id: str, resource: str,
                        scopes: list[str] | None = None) -> dict | None:
        """完整浏览器授权 → 返回 token payload；用户取消/超时/端口占用返回 None。"""
        verifier, challenge = self._generate_pkce()
        state = secrets.token_urlsafe(16)
        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": self.redirect_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "resource": resource,  # RFC 8707
        }
        if scopes:
            params["scope"] = " ".join(scopes)
        sep = "&" if "?" in discovery["authorization_endpoint"] else "?"
        auth_url = discovery["authorization_endpoint"] + sep + urlencode(params)

        loop = asyncio.get_running_loop()
        code_fut = loop.create_future()
        server = await self._start_callback_server(code_fut, state)
        if server is None:
            return None
        try:
            logging.info(
                f"[mcp-oauth] 等待浏览器授权（回调 {self.redirect_uri}，最长 {int(_AUTH_WAIT_TIMEOUT)}s）")
            opened = False
            try:
                opened = bool(await asyncio.to_thread(webbrowser.open, auth_url))
            except Exception:
                opened = False
            if not opened:
                # 无头兜底（审查建议 6）：打印 URL 让用户手动打开
                print(f"[mcp-oauth] 浏览器打开失败，请手动打开授权链接：\n{auth_url}", file=sys.stderr)
            try:
                code = await asyncio.wait_for(code_fut, timeout=_AUTH_WAIT_TIMEOUT)
            except asyncio.TimeoutError:
                logging.warning("[mcp-oauth] 浏览器授权等待超时")
                return None
            if code is None:
                return None  # 用户取消或 state 不匹配
            return await self._exchange(discovery, client_id, code, verifier, resource)
        finally:
            server.close()
            await server.wait_closed()

    async def _exchange(self, discovery: dict, client_id: str, code: str,
                        verifier: str, resource: str) -> dict | None:
        """授权码换 token（RFC 8707 带 resource）。"""
        return await _http_json("POST", discovery["token_endpoint"], data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
            "resource": resource,
        })

    async def _start_callback_server(self, code_fut: asyncio.Future,
                                     state: str) -> asyncio.Server | None:
        try:
            return await asyncio.start_server(
                self._make_handler(code_fut, state), "127.0.0.1", self.redirect_port)
        except OSError as e:
            logging.warning(f"[mcp-oauth] 回调端口 {self.redirect_port} 被占用: {e}")
            return None

    def _make_handler(self, code_fut: asyncio.Future, state: str):
        async def handler(reader, writer):
            msg = "授权完成，可关闭此页面返回 slime。"
            try:
                request_line = await asyncio.wait_for(reader.readline(), timeout=10)
                parts = request_line.decode("utf-8", "replace").split()
                if len(parts) >= 2:
                    query = parse_qs(urlsplit(parts[1]).query)
                    if query.get("state") != [state]:
                        logging.warning("[mcp-oauth] 回调 state 不匹配（CSRF 防护）")
                        msg = "state 不匹配，授权失败。"
                        if not code_fut.done():
                            code_fut.set_result(None)
                    elif "error" in query:
                        logging.info(f"[mcp-oauth] 用户拒绝授权: {query.get('error')}")
                        msg = "已取消授权，可关闭此页面。"
                        if not code_fut.done():
                            code_fut.set_result(None)
                    elif query.get("code"):
                        if not code_fut.done():
                            code_fut.set_result(query["code"][0])
            except Exception:
                if not code_fut.done():
                    code_fut.set_result(None)
            finally:
                try:
                    body = _CALLBACK_HTML.format(msg).encode("utf-8")
                    writer.write(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                        + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("utf-8")
                        + body
                    )
                    await writer.drain()
                except Exception:
                    pass
                writer.close()
        return handler


class OAuthManager:
    """OAuth 门面：完整生命周期（预热授权 + 单飞并发 + refresh + 401 重试路径）。

    三层策略（P2-5 方案）：
    - 预热授权（start() 时）：warmup() 长窗口（浏览器授权 <300s）
    - 快速刷新（request() 401 路径）：refresh 通常 <5s，放得进请求超时
    - 后台授权（刷新失败触发）：create_task 独立授权任务，请求超时取消不杀死任务，
      用户慢授权完成后下次请求即成功
    - 单飞（per-server asyncio.Lock + _pending_auth 共享）：并发 401 只触发一次授权
    """

    def __init__(self, server_name: str, server_url: str, scopes: list[str] | None = None,
                 client_id: str | None = None, redirect_port: int = _DEFAULT_REDIRECT_PORT):
        self.name = server_name
        self._store = TokenStore(server_name)
        self._server_url = server_url.rstrip("/")
        self._scopes = scopes
        self._client_id = client_id
        self._flow = OAuthFlow(redirect_port)
        self._lock = asyncio.Lock()  # 单飞：并发 401 只触发一次授权
        self._pending_auth: asyncio.Task | None = None  # 进行中的后台授权任务
        self._tokens: dict | None = None
        self.last_error: str | None = None

    # ── 公开接口 ──

    async def warmup(self) -> bool:
        """预热授权（start() 阶段，长窗口）。有效缓存 → True；refresh；否则浏览器完整授权。"""
        if self._tokens is None:
            self._tokens = self._store.load()
        if self._token_valid():
            return True
        if self._tokens and self._tokens.get("refresh_token") and self._tokens.get("token_endpoint"):
            if await self._do_refresh():
                return True
            self._clear_tokens()
        logging.info(f"[mcp-oauth] {self.name}: 启动浏览器授权流程")
        return await self._do_authorize(None)

    async def ensure_token(self, www_authenticate: str | None = None) -> str | None:
        """request() 401 路径：快速确保 token。慢授权走后台任务（单飞），当前请求拿不到即 None。"""
        if self._tokens is None:
            self._tokens = self._store.load()
        if self._token_valid():
            return self._tokens["access_token"]
        if self._tokens and self._tokens.get("refresh_token") and self._tokens.get("token_endpoint"):
            if await self._do_refresh():
                return self._tokens["access_token"]
            self._clear_tokens()
        # 单飞：并发 401 共享同一个后台授权任务
        task = self._pending_auth
        if task is None or task.done():
            task = asyncio.create_task(self._do_authorize(www_authenticate))
            self._pending_auth = task
        try:
            # shield：调用方（请求超时）取消不杀死授权任务，任务独立存活
            await asyncio.shield(task)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass  # 任务内部已兜底；双保险防未检索任务异常
        return self._tokens["access_token"] if self._token_valid() else None

    def get_auth_header(self) -> dict:
        """返回 {"Authorization": "Bearer <token>"}，无 token 返回 {}（懒加载磁盘缓存）。"""
        if self._tokens is None:
            self._tokens = self._store.load()
        t = self._tokens
        if t and t.get("access_token"):
            return {"Authorization": f"Bearer {t['access_token']}"}
        return {}

    def status(self) -> str:
        """oauth 状态：pending / authorized / expired / none。"""
        if self._token_valid():
            return "authorized"
        if self._pending_auth is not None and not self._pending_auth.done():
            return "pending"
        return "expired" if self._tokens else "none"

    # ── 内部 ──

    def _token_valid(self) -> bool:
        t = self._tokens
        if not t or not t.get("access_token"):
            return False
        expires_at = t.get("expires_at")
        if expires_at is None:
            return True
        return time.time() < expires_at - _EXPIRY_SKEW

    async def _do_authorize(self, www_authenticate: str | None) -> bool:
        """完整授权：discover → DCR（或配置 client_id）→ 浏览器授权 → 落盘。异常全兜底。"""
        try:
            async with self._lock:
                if self._token_valid():
                    return True  # 等锁期间可能已被并发任务授权
                discovery = await OAuthDiscovery().discover(self._server_url, www_authenticate)
                if discovery is None:
                    self.last_error = "OAuth 发现失败（无 WWW-Authenticate / well-known 元数据）"
                    logging.warning(f"[mcp-oauth] {self.name}: {self.last_error}")
                    return False
                client_id = self._client_id
                client_secret = None
                if not client_id:
                    reg_endpoint = discovery.get("registration_endpoint")
                    if reg_endpoint:
                        reg = await OAuthRegistration().register(
                            reg_endpoint, self.name, self._flow.redirect_uri)
                        if reg:
                            client_id = reg.get("client_id")
                            client_secret = reg.get("client_secret")
                    if not client_id:
                        self.last_error = "DCR 注册失败，请在 slime.toml 配置 oauth_client_id"
                        logging.warning(f"[mcp-oauth] {self.name}: {self.last_error}")
                        return False
                payload = await self._flow.authorize(
                    discovery, client_id, discovery["resource"], self._scopes)
                if payload is None:
                    self.last_error = "授权未完成（用户取消或超时）"
                    logging.info(f"[mcp-oauth] {self.name}: {self.last_error}")
                    return False
                self._persist(payload, discovery, client_id, client_secret)
                self.last_error = None
                logging.info(f"[mcp-oauth] {self.name}: 授权成功")
                return True
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # 任务化时（_pending_auth）异常必须自吞，防 asyncio 未检索任务异常（收尾观察项 1 教训）
            logging.exception(f"[mcp-oauth] {self.name}: 授权异常")
            self.last_error = str(e)
            return False

    async def _do_refresh(self) -> bool:
        """refresh_token 换新 token；失败先 clear() 防残留脏状态（审查建议 5）。"""
        t = self._tokens
        endpoint = (t or {}).get("token_endpoint")
        if not t or not t.get("refresh_token") or not endpoint:
            return False
        data = {
            "grant_type": "refresh_token",
            "refresh_token": t["refresh_token"],
            "client_id": t.get("client_id"),
            "resource": t.get("resource"),
        }
        if t.get("client_secret"):
            data["client_secret"] = t["client_secret"]
        payload = await _http_json("POST", endpoint, data=data)
        if payload is None or not payload.get("access_token"):
            logging.warning(f"[mcp-oauth] {self.name}: refresh 失败")
            self._clear_tokens()
            return False
        if not payload.get("refresh_token"):
            payload["refresh_token"] = t.get("refresh_token")  # 部分 AS 不轮换 refresh_token
        self._persist(payload, {"token_endpoint": endpoint, "resource": t.get("resource")},
                      t.get("client_id"), t.get("client_secret"))
        return True

    def _persist(self, payload: dict, discovery: dict, client_id: str,
                 client_secret: str | None = None):
        expires_in = payload.get("expires_in")
        tokens = {
            "access_token": payload["access_token"],
            "refresh_token": payload.get("refresh_token"),
            "expires_at": time.time() + float(expires_in) if isinstance(expires_in, (int, float)) else None,
            "token_type": payload.get("token_type", "bearer"),
            "scope": payload.get("scope"),
            "client_id": client_id,
            "redirect_uri": self._flow.redirect_uri,
            # 方案外补充（重启后 refresh 必需）：token 端点 + resource + DCR 客户端密钥
            "token_endpoint": discovery["token_endpoint"],
            "resource": discovery.get("resource"),
            "client_secret": client_secret,
        }
        self._tokens = tokens
        self._store.save(tokens)

    def _clear_tokens(self):
        self._tokens = None
        self._store.clear()
