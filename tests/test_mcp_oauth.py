"""slime MCP OAuth 2.1 客户端测试（P2-5，全 mock：httpx.MockTransport / patch _http_json）"""
import asyncio
import json
import time
from unittest.mock import patch

import httpx


def _run(coro):
    return asyncio.run(coro)


class TestOAuthDiscovery:
    """批4 P2-5: WWW-Authenticate 解析 / 保护资源元数据 / AS 元数据（OIDC fallback）。"""

    def test_parse_www_authenticate(self):
        from core.mcp_oauth import OAuthDiscovery
        header = 'Bearer resource_metadata="https://rs.example/mcp/oauth/metadata", error="invalid_token"'
        assert OAuthDiscovery.parse_www_authenticate(header) == "https://rs.example/mcp/oauth/metadata"
        assert OAuthDiscovery.parse_www_authenticate(None) is None
        assert OAuthDiscovery.parse_www_authenticate("Bearer") is None

    def test_discover_from_www_authenticate(self):
        from core import mcp_oauth
        from core.mcp_oauth import OAuthDiscovery
        responses = {
            "https://rs.example/mcp/oauth/metadata": {
                "resource": "https://rs.example/mcp",
                "authorization_servers": ["https://as.example"],
            },
            "https://as.example/.well-known/oauth-authorization-server": {
                "authorization_endpoint": "https://as.example/auth",
                "token_endpoint": "https://as.example/token",
                "registration_endpoint": "https://as.example/reg",
            },
        }

        async def fake_http(method, url, data=None, payload=None):
            return responses.get(url)

        async def scenario():
            with patch.object(mcp_oauth, "_http_json", fake_http):
                d = await OAuthDiscovery().discover(
                    "https://rs.example/mcp",
                    'Bearer resource_metadata="https://rs.example/mcp/oauth/metadata"')
            assert d["authorization_endpoint"] == "https://as.example/auth"
            assert d["token_endpoint"] == "https://as.example/token"
            assert d["registration_endpoint"] == "https://as.example/reg"
            assert d["resource"] == "https://rs.example/mcp"  # RFC 9728 resource 字段优先
        _run(scenario())

    def test_discover_oidc_fallback(self):
        from core import mcp_oauth
        from core.mcp_oauth import OAuthDiscovery
        responses = {
            "https://rs.example/.well-known/oauth-protected-resource": {
                "resource": "https://rs.example",
            },
            "https://rs.example/.well-known/oauth-authorization-server": None,
            "https://rs.example/.well-known/openid-configuration": {
                "authorization_endpoint": "https://as2.example/auth",
                "token_endpoint": "https://as2.example/token",
            },
        }

        async def fake_http(method, url, data=None, payload=None):
            return responses.get(url)

        async def scenario():
            with patch.object(mcp_oauth, "_http_json", fake_http):
                d = await OAuthDiscovery().discover("https://rs.example")
            assert d["authorization_endpoint"] == "https://as2.example/auth"
            assert d["token_endpoint"] == "https://as2.example/token"
            assert "registration_endpoint" in d
        _run(scenario())


class TestOAuthRegistration:
    """批4 P2-5: RFC 7591 DCR 成功 / 失败跳过（提示手动输入）。"""

    def test_register_success(self):
        from core import mcp_oauth
        from core.mcp_oauth import OAuthRegistration

        async def fake_http(method, url, data=None, payload=None):
            assert method == "POST"
            assert payload["application_type"] == "native"
            assert payload["redirect_uris"] == ["http://127.0.0.1:18091/mcp/oauth/callback"]
            return {"client_id": "cid-1"}

        async def scenario():
            with patch.object(mcp_oauth, "_http_json", fake_http):
                reg = await OAuthRegistration().register(
                    "https://as.example/reg", "slime",
                    "http://127.0.0.1:18091/mcp/oauth/callback")
            assert reg["client_id"] == "cid-1"
        _run(scenario())

    def test_register_failure_returns_none(self):
        from core import mcp_oauth
        from core.mcp_oauth import OAuthRegistration

        async def fake_http(method, url, data=None, payload=None):
            return None

        async def scenario():
            with patch.object(mcp_oauth, "_http_json", fake_http):
                reg = await OAuthRegistration().register("https://as.example/reg", "slime", "http://x")
            assert reg is None
        _run(scenario())


class TestOAuthPKCE:
    """批4 P2-5: code_verifier / code_challenge 生成 + S256 验证。"""

    def test_challenge_s256_known_vector(self):
        from core.mcp_oauth import OAuthFlow
        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        assert OAuthFlow.challenge_from(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

    def test_generate_pkce_pair(self):
        from core.mcp_oauth import OAuthFlow
        verifier, challenge = OAuthFlow._generate_pkce()
        assert 43 <= len(verifier) <= 128  # RFC 7636
        assert challenge == OAuthFlow.challenge_from(verifier)


class TestOAuthToken:
    """批4 P2-5: 授权码换 token / refresh 换新 token / refresh 失败 clear。"""

    def test_authorization_code_exchange(self):
        from core import mcp_oauth
        from core.mcp_oauth import OAuthFlow
        captured = {}

        async def fake_http(method, url, data=None, payload=None):
            captured.update(method=method, url=url, data=data)
            return {"access_token": "AT", "refresh_token": "RT",
                    "expires_in": 3600, "token_type": "Bearer"}

        async def scenario():
            with patch.object(mcp_oauth, "_http_json", fake_http):
                flow = OAuthFlow()
                payload = await flow._exchange(
                    {"token_endpoint": "https://as.example/token"},
                    "cid", "the-code", "verifier-xyz", "https://rs.example")
            assert payload["access_token"] == "AT"
            assert captured["method"] == "POST"
            assert captured["data"]["grant_type"] == "authorization_code"
            assert captured["data"]["code"] == "the-code"
            assert captured["data"]["code_verifier"] == "verifier-xyz"
            assert captured["data"]["resource"] == "https://rs.example"
        _run(scenario())

    def test_refresh_success(self, tmp_path):
        from core import mcp_oauth
        from core.mcp_oauth import OAuthManager

        async def fake_http(method, url, data=None, payload=None):
            assert data["grant_type"] == "refresh_token"
            assert data["refresh_token"] == "RT-old"
            return {"access_token": "AT-new", "refresh_token": "RT-new", "expires_in": 3600}

        async def scenario():
            with patch.object(mcp_oauth, "_PROJECT_ROOT", tmp_path):
                mgr = OAuthManager("srv", "https://rs.example")
                mgr._tokens = {
                    "access_token": "AT-old", "refresh_token": "RT-old",
                    "expires_at": time.time() - 10, "client_id": "cid",
                    "token_endpoint": "https://as.example/token", "resource": "https://rs.example",
                }
                with patch.object(mcp_oauth, "_http_json", fake_http):
                    token = await mgr.ensure_token()
                assert token == "AT-new"
                saved = mgr._store.load()  # 落盘持久化（重启后可用）
                assert saved["refresh_token"] == "RT-new"
                assert saved["token_endpoint"] == "https://as.example/token"
        _run(scenario())

    def test_refresh_failure_clears(self, tmp_path):
        from core import mcp_oauth
        from core.mcp_oauth import OAuthManager

        async def fake_http(method, url, data=None, payload=None):
            return None  # refresh 失败

        async def scenario():
            with patch.object(mcp_oauth, "_PROJECT_ROOT", tmp_path):
                mgr = OAuthManager("srv", "https://rs.example")
                mgr._tokens = {
                    "access_token": "AT-old", "refresh_token": "RT-old",
                    "expires_at": time.time() - 10, "client_id": "cid",
                    "token_endpoint": "https://as.example/token", "resource": "https://rs.example",
                }
                mgr._store.save(mgr._tokens)  # 先落盘模拟磁盘缓存
                with patch.object(mcp_oauth, "_http_json", fake_http):
                    ok = await mgr._do_refresh()
                assert ok is False
                assert mgr._tokens is None         # 内存清空
                assert mgr._store.load() is None   # 磁盘无残留脏状态（审查建议 5）
        _run(scenario())


class TestOAuthTokenStore:
    """批4 P2-5: token 持久化（save/load 往返 / clear / 路径 sanitize）。"""

    def test_save_load_roundtrip(self, tmp_path):
        from core import mcp_oauth
        with patch.object(mcp_oauth, "_PROJECT_ROOT", tmp_path):
            store = mcp_oauth.TokenStore("srv")
            tokens = {"access_token": "AT", "refresh_token": "RT",
                      "expires_at": 123.0, "scope": "read"}
            store.save(tokens)
            assert store.load() == tokens

    def test_clear(self, tmp_path):
        from core import mcp_oauth
        with patch.object(mcp_oauth, "_PROJECT_ROOT", tmp_path):
            store = mcp_oauth.TokenStore("srv")
            store.save({"access_token": "AT"})
            store.clear()
            assert store.load() is None

    def test_path_sanitize(self, tmp_path):
        from core import mcp_oauth
        with patch.object(mcp_oauth, "_PROJECT_ROOT", tmp_path):
            store = mcp_oauth.TokenStore("../evil name")
            store.save({"access_token": "AT"})
            assert store.load() is not None
            # 目录段已 sanitize（[A-Za-z0-9_-]），落盘未逃逸 tmp_path
            assert str(tmp_path.resolve()) in str(store._path.resolve())
            assert ".." not in store._path.parts


class TestOAuthIntegration:
    """批4 P2-5: 401 自动授权重试 / 兼容 / 并发单飞 / 静态 token 优先 / 重授权 /
    回调服务器实测 / start() warmup 语义。"""

    def test_transport_401_auto_auth_retry(self):
        from core import mcp_oauth
        from core.mcp_client import _HTTPTransport
        seen, www_auth_seen = [], []

        def handler(request):
            seen.append(request.headers.get("authorization"))
            if request.headers.get("authorization") == "Bearer AT":
                return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
            return httpx.Response(
                401, headers={"WWW-Authenticate": 'Bearer resource_metadata="https://rs.example/meta"'})

        async def scenario():
            mgr = mcp_oauth.OAuthManager("srv", "http://x/mcp")

            async def fake_ensure(www_auth=None):
                www_auth_seen.append(www_auth)
                mgr._tokens = {"access_token": "AT", "expires_at": None}
                return "AT"
            mgr.ensure_token = fake_ensure
            t = _HTTPTransport("http://x/mcp", None, "t", oauth=mgr)
            t._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            result = await t.request(
                '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', 1, timeout=5.0)
            assert result is not None and result["result"] == {"ok": True}
            assert len(seen) == 2          # 401 → ensure_token → 重试一次
            assert seen[0] is None         # 首次无 token，无 Authorization 头
            assert seen[1] == "Bearer AT"  # 重试带上 OAuth token
            assert www_auth_seen == ['Bearer resource_metadata="https://rs.example/meta"']
        _run(scenario())

    def test_no_oauth_401_keeps_error_body(self):
        """无 oauth 配置的 401 保持旧语义：body 解析透传（_MCPServerError 可诊断）。"""
        from core.mcp_client import _HTTPTransport

        def handler(request):
            return httpx.Response(
                401, json={"jsonrpc": "2.0", "id": 1,
                           "error": {"code": 32001, "message": "unauthorized"}})
        t = _HTTPTransport("http://x/mcp", None, "t")
        t._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        result = _run(t.request('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', 1))
        assert result is not None
        assert result["error"]["code"] == 32001

    def test_concurrent_401_single_flight(self):
        from core import mcp_oauth
        calls = 0

        async def scenario():
            mgr = mcp_oauth.OAuthManager("srv", "https://rs.example")

            async def fake_authorize(www_auth=None):
                nonlocal calls
                calls += 1
                await asyncio.sleep(0.05)
                mgr._tokens = {"access_token": "AT", "expires_at": None}
                return True

            mgr._do_authorize = fake_authorize
            r1, r2 = await asyncio.gather(mgr.ensure_token(), mgr.ensure_token())
            assert r1 == "AT" and r2 == "AT"
            assert calls == 1  # 单飞：并发 401 只触发一次授权
        _run(scenario())

    def test_static_auth_skips_oauth(self):
        from core import mcp_oauth
        from core.mcp_client import _HTTPTransport

        async def scenario():
            mgr = mcp_oauth.OAuthManager("srv", "https://rs.example")
            mgr._tokens = {"access_token": "AT-oauth", "expires_at": None}
            t = _HTTPTransport("http://x/mcp", {"Authorization": "Bearer static-xyz"}, "t", oauth=mgr)
            h = t._headers()
            assert h["Authorization"] == "Bearer static-xyz"  # 静态 token 优先，OAuth 不覆盖
        _run(scenario())

    def test_refresh_fail_then_reauth(self, tmp_path):
        from core import mcp_oauth

        async def fake_http(method, url, data=None, payload=None):
            return None  # refresh 失败

        async def scenario():
            with patch.object(mcp_oauth, "_PROJECT_ROOT", tmp_path):
                mgr = mcp_oauth.OAuthManager("srv", "https://rs.example")
                mgr._tokens = {
                    "access_token": "AT-old", "refresh_token": "RT-old",
                    "expires_at": time.time() - 10, "client_id": "cid",
                    "token_endpoint": "https://as.example/token", "resource": "https://rs.example",
                }

                async def fake_authorize(www_auth=None):
                    await asyncio.sleep(0.05)
                    mgr._tokens = {"access_token": "AT-new", "expires_at": None}
                    return True

                mgr._do_authorize = fake_authorize
                with patch.object(mcp_oauth, "_http_json", fake_http):
                    token = await mgr.ensure_token()
                assert token == "AT-new"  # refresh 失败 → clear → 后台重授权 → 新 token
                assert mgr._store.load() is None  # fake_authorize 未落盘（仅内存）
        _run(scenario())

    def test_callback_server_flow(self):
        """OAuthFlow.authorize 全链路：本地回调服务器收 code → 换 token（webbrowser / token POST mock）。"""
        import webbrowser
        from urllib.parse import parse_qs, urlsplit
        from core import mcp_oauth
        from core.mcp_oauth import OAuthFlow
        captured = {}

        async def fake_http(method, url, data=None, payload=None):
            captured.update(method=method, url=url, data=data)
            assert data["grant_type"] == "authorization_code"
            assert data["code"] == "test-code"
            assert data["code_verifier"]
            return {"access_token": "AT", "refresh_token": "RT", "expires_in": 3600}

        def fake_open(url):
            captured["url"] = url

        async def scenario():
            flow = OAuthFlow(redirect_port=18123)  # 非默认端口防冲突
            with patch.object(mcp_oauth, "_http_json", fake_http), \
                    patch.object(webbrowser, "open", fake_open):
                fut = asyncio.ensure_future(flow.authorize(
                    {"authorization_endpoint": "https://as.example/auth",
                     "token_endpoint": "https://as.example/token",
                     "resource": "https://rs.example"},
                    "cid", "https://rs.example"))
                # 等 authorize URL 生成（webbrowser.open 被调）
                for _ in range(100):
                    if captured:
                        break
                    await asyncio.sleep(0.05)
                q = parse_qs(urlsplit(captured["url"]).query)
                assert q["code_challenge_method"] == ["S256"]
                assert q["redirect_uri"] == ["http://127.0.0.1:18123/mcp/oauth/callback"]
                state = q["state"][0]
                # 模拟浏览器回调
                async with httpx.AsyncClient() as c:
                    resp = await c.get("http://127.0.0.1:18123/mcp/oauth/callback",
                                       params={"code": "test-code", "state": state})
                assert resp.status_code == 200
                result = await asyncio.wait_for(fut, 10)
                assert result["access_token"] == "AT"
                # PKCE 闭环：token 请求的 code_verifier 与 authorize URL 的 S256 challenge 匹配
                assert OAuthFlow.challenge_from(captured["data"]["code_verifier"]) == q["code_challenge"][0]
        _run(scenario())

    def test_server_start_warmup_fail(self):
        """warmup 失败（用户取消）→ start() 返回 False，transport 关闭，server 不启动。"""
        from core import mcp_oauth
        from core.mcp_client import _HTTPTransport, _MCPServer

        async def scenario():
            mgr = mcp_oauth.OAuthManager("srv", "https://rs.example")

            async def fake_warmup():
                mgr.last_error = "用户取消授权"
                return False
            mgr.warmup = fake_warmup
            server = _MCPServer("srv", _HTTPTransport("http://x/mcp", None, "srv", oauth=mgr), oauth=mgr)
            ok = await server.start()
            assert ok is False
            assert "OAuth" in (server.last_error or "")
            assert server.running is False
        _run(scenario())

    def test_server_start_warmup_success_injects_token(self):
        """warmup 成功 → initialize 握手带上 OAuth token，start() 正常。"""
        from core import mcp_oauth
        from core.mcp_client import _HTTPTransport, _MCPServer
        seen = []

        def handler(request):
            seen.append(request.headers.get("authorization"))
            msg = json.loads(request.content)
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg.get("id"), "result": {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "serverInfo": {"name": "fake", "version": "1.0"}}})

        async def scenario():
            mgr = mcp_oauth.OAuthManager("srv", "https://rs.example")
            mgr._tokens = {"access_token": "AT", "expires_at": None}
            t = _HTTPTransport("http://x/mcp", None, "srv", oauth=mgr)
            t._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            server = _MCPServer("srv", t, oauth=mgr)
            ok = await server.start()
            assert ok is True
            assert seen and seen[0] == "Bearer AT"  # initialize 带上了 OAuth token
        _run(scenario())
