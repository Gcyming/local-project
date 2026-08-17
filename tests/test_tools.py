"""web_fetch / web_search 内置工具测试（全 mock，不真实联网）"""

import asyncio
import socket
import time
from unittest.mock import patch

import httpx
import pytest

from core.fetcher import WebFetcher, FetchError, _is_private_ip, _resolve_and_validate
from core.extractor import extract_content
from core.search import SearchEngine

_HTML = "<html><head><title>T</title></head><body><p>正文内容</p></body></html>"


def _transport(handler):
    return httpx.MockTransport(handler)


def _html_response(status=200, text=_HTML, headers=None, content=None):
    if content is not None:
        return httpx.Response(status, content=content, headers=headers or {"content-type": "text/html"})
    return httpx.Response(status, text=text, headers=headers or {"content-type": "text/html"})


def _run(coro):
    return asyncio.run(coro)


def _resolve_mock(host, *a, **k):
    """mock getaddrinfo：example.com → 公网 IP；IP 字面量 → 原样返回（保留 SSRF 拦截语义）。"""
    ip = "93.184.216.34" if host == "example.com" else host
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]


class _StreamResp:
    """模拟流式响应：aiter_bytes 逐块 yield（测试 2MB 累计中断）。"""

    def __init__(self, chunks, headers=None):
        self._chunks = chunks
        self.headers = httpx.Headers(headers or {"content-type": "text/html"})
        self.aclosed = False

    async def aiter_bytes(self):
        for c in self._chunks:
            yield c

    async def aclose(self):
        self.aclosed = True


class _FakeFetcher:
    """可编程假 fetcher：记录调用、可指定失败 URL、可追踪并发。"""

    def __init__(self):
        self.calls = []
        self.concurrent = 0
        self.max_concurrent = 0
        self.fail_urls = set()
        self.responses = {}

    async def fetch_raw(self, url):
        self.calls.append(url)
        self.concurrent += 1
        self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            await asyncio.sleep(0.001)
            if url in self.fail_urls or "fail" in self.responses.get(url, ""):
                raise FetchError("[错误] 请求失败")
            return self.responses.get(url, "<html><body></body></html>")
        finally:
            self.concurrent -= 1


# ── SSRF（16）────────────────────────────────────────────

class TestSSRF:
    def test_loopback_v4(self):
        assert _is_private_ip("127.0.0.1") is True

    def test_private_10(self):
        assert _is_private_ip("10.0.0.1") is True

    def test_private_192(self):
        assert _is_private_ip("192.168.1.1") is True

    def test_private_172(self):
        assert _is_private_ip("172.16.0.1") is True

    def test_loopback_v6(self):
        assert _is_private_ip("::1") is True

    def test_link_local_v6(self):
        assert _is_private_ip("fe80::1") is True

    def test_ula_v6(self):
        assert _is_private_ip("fc00::1") is True

    def test_v4_mapped_v6(self):
        assert _is_private_ip("::ffff:127.0.0.1") is True

    def test_nat64(self):
        assert _is_private_ip("64:ff9b::1") is True

    def test_public_v4(self):
        assert _is_private_ip("8.8.8.8") is False

    def test_public_v6(self):
        assert _is_private_ip("2606:2800:220:1:248:1893:25c8:1946") is False

    def test_unparseable_rejected(self):
        # 不可解析（127.1 简写 / hex / 十进制长整型）→ 拒绝
        assert _is_private_ip("127.1") is True
        assert _is_private_ip("0x7f000001") is True
        assert _is_private_ip("2130706433") is True

    def test_userinfo_bypass(self):
        # https://google.com@127.0.0.1/ → hostname 剥离 userinfo 后为 127.0.0.1 → 拒绝
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        with pytest.raises(FetchError):
            f._pin("https://google.com@127.0.0.1/")

    def test_dual_stack_any_private_rejected(self):
        # 双栈域名：v4 公网 + v6 内网 → 任一内网即拒
        infos = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 0)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fe80::1", 0, 0, 0)),
        ]
        with patch("core.fetcher.socket.getaddrinfo", return_value=infos):
            with pytest.raises(FetchError):
                _resolve_and_validate("dual.example.com")

    def test_localhost_dual_stack_v6_first(self):
        infos = [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", 0, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ]
        with patch("core.fetcher.socket.getaddrinfo", return_value=infos):
            with pytest.raises(FetchError):
                _resolve_and_validate("localhost")

    def test_dns_rebinding_no_second_resolution(self):
        # 首次返回公网、二次返回内网 → 断言实现无二次解析，直接钉扎首个公网 IP
        calls = []

        def fake(host, *a, **k):
            calls.append(host)
            if len(calls) == 1:
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        with patch("core.fetcher.socket.getaddrinfo", side_effect=fake):
            pinned, host_header, sni = f._pin("https://example.com/path")
        assert len(calls) == 1  # 无二次 DNS 解析
        assert "93.184.216.34" in pinned
        assert host_header == "example.com"
        assert sni == "example.com"

    def test_invalid_port_rejected(self):
        """A-022: 非法端口（>65535）→ FetchError 友好文案（此前 ValueError 泄漏）"""
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
        with patch("core.fetcher.socket.getaddrinfo", return_value=infos):
            with pytest.raises(FetchError):
                f._pin("https://example.com:99999/")

    def test_ipv4_preferred_when_ipv6_first(self):
        """A-030: 解析 IPv6 在前时钉扎仍用 IPv4（无 IPv6 路由环境可连接）"""
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        infos = [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:10::6814:179a", 0, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("104.20.23.154", 0)),
        ]
        with patch("core.fetcher.socket.getaddrinfo", return_value=infos):
            pinned, host_header, sni = f._pin("https://example.com/path")
        assert "104.20.23.154" in pinned
        assert host_header == "example.com"

    def test_ipv6_fallback_when_only_ipv6(self):
        """A-030: 仅 IPv6 解析时回退使用 IPv6"""
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        infos = [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:10::6814:179a", 0, 0, 0)),
        ]
        with patch("core.fetcher.socket.getaddrinfo", return_value=infos):
            pinned, host_header, sni = f._pin("https://example.com/path")
        assert "2606:4700:10::6814:179a" in pinned

    def test_fetch_invalid_port_friendly_message(self):
        """A-022: fetch() 端到端 —— 非法端口经线程池路径返回友好文案而非崩溃"""
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
        with patch("core.fetcher.socket.getaddrinfo", return_value=infos):
            result = _run(f.fetch("https://example.com:99999/"))
        assert "[错误] 无效的端口" in result


# ── 重定向（5）───────────────────────────────────────────

class TestRedirect:
    def test_relative_location(self):
        seen = {}

        def handler(request):
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "../next"})
            seen["final_path"] = request.url.path
            return _html_response()

        f = WebFetcher(transport=_transport(handler))
        with patch("core.fetcher.socket.getaddrinfo", side_effect=_resolve_mock):
            _run(f.fetch_raw("https://example.com/start"))
        assert seen["final_path"] == "/next"  # urljoin 相对路径规范化

    def test_redirect_to_internal_blocked(self):
        def handler(request):
            return httpx.Response(302, headers={"location": "http://127.0.0.1/secret"})

        f = WebFetcher(transport=_transport(handler))
        with patch("core.fetcher.socket.getaddrinfo", side_effect=_resolve_mock):
            with pytest.raises(FetchError) as e:
                _run(f.fetch_raw("https://example.com/start"))
        assert "SSRF" in str(e.value) or "拦截" in str(e.value)

    def test_redirect_hop_limit(self):
        def handler(request):
            return httpx.Response(302, headers={"location": "/next"})

        f = WebFetcher(transport=_transport(handler))
        with patch("core.fetcher.socket.getaddrinfo", side_effect=_resolve_mock):
            with pytest.raises(FetchError) as e:
                _run(f.fetch_raw("https://example.com/start"))
        assert "重定向" in str(e.value)

    def test_redirect_to_file_protocol_rejected(self):
        def handler(request):
            return httpx.Response(302, headers={"location": "file:///etc/passwd"})

        f = WebFetcher(transport=_transport(handler))
        with patch("core.fetcher.socket.getaddrinfo", side_effect=_resolve_mock):
            with pytest.raises(FetchError):
                _run(f.fetch_raw("https://example.com/start"))

    def test_redirect_revalidates_each_hop(self):
        # 第一跳到公网，第二跳到内网 → 逐跳重验拦截
        def handler(request):
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "https://example.com/mid"})
            if request.url.path == "/mid":
                return httpx.Response(302, headers={"location": "http://10.0.0.1/secret"})
            return _html_response()

        f = WebFetcher(transport=_transport(handler))
        with patch("core.fetcher.socket.getaddrinfo", side_effect=_resolve_mock):
            with pytest.raises(FetchError):
                _run(f.fetch_raw("https://example.com/start"))


# ── 协议（2）─────────────────────────────────────────────

class TestProtocol:
    def test_file_rejected(self):
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        with pytest.raises(FetchError):
            f._pin("file:///etc/passwd")

    def test_ftp_rejected(self):
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        with pytest.raises(FetchError):
            f._pin("ftp://example.com/file")


# ── 响应（6）─────────────────────────────────────────────

class TestResponse:
    def test_2mb_truncation(self):
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        chunks = [b"a" * (1024 * 1024)] * 3  # 3 × 1MB 流式块
        resp = _StreamResp(chunks)
        result = _run(f._read_response(resp))
        assert len(result) == 2 * 1024 * 1024  # 2MB 累计中断
        assert resp.aclosed is True  # 显式释放连接

    def test_chunked_no_content_length(self):
        f = WebFetcher(transport=_transport(lambda r: _html_response()))
        chunks = [b"b" * (256 * 1024)] * 12  # chunked：无 Content-Length，多块累计
        resp = _StreamResp(chunks)
        result = _run(f._read_response(resp))
        assert len(result) == 2 * 1024 * 1024
        assert resp.aclosed is True

    def test_slow_response_timeout(self):
        def handler(request):
            raise httpx.ReadTimeout("read timeout")

        f = WebFetcher(transport=_transport(handler))
        with patch("core.fetcher.socket.getaddrinfo",
                   return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]):
            with pytest.raises(FetchError):
                _run(f.fetch_raw("https://example.com"))

    def test_gbk_decode(self):
        body = "<html><title>测试标题</title><body>内容正文</body></html>".encode("gbk")
        f = WebFetcher(transport=_transport(lambda r: _html_response(content=body)))
        with patch("core.fetcher.socket.getaddrinfo",
                   return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]):
            result = _run(f.fetch_raw("https://example.com"))
        assert "测试标题" in result

    def test_non_text_content_type(self):
        f = WebFetcher(transport=_transport(
            lambda r: httpx.Response(200, content=b"\x00\x01", headers={"content-type": "application/octet-stream"})))
        with patch("core.fetcher.socket.getaddrinfo",
                   return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]):
            msg = _run(f.fetch("https://example.com/file.bin"))
        assert "非文本内容" in msg

    def test_wrong_charset_header_fallback(self):
        # 头写 utf-8 实际 GBK → 启发式兜底
        body = "<html>测试</html>".encode("gbk")
        f = WebFetcher(transport=_transport(
            lambda r: _html_response(content=body, headers={"content-type": "text/html; charset=utf-8"})))
        with patch("core.fetcher.socket.getaddrinfo",
                   return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]):
            result = _run(f.fetch_raw("https://example.com"))
        assert "测试" in result


# ── 提取（7）─────────────────────────────────────────────

class TestExtract:
    def test_article_semantic(self):
        html = "<html><title>T</title><body><nav>nav</nav><article><p>正文</p></article><footer>foot</footer></body></html>"
        result = extract_content(html)
        assert "正文" in result
        assert "nav" not in result  # 噪声标签移除

    def test_body_fallback(self):
        html = "<html><title>T</title><body><p>没有语义标签</p></body></html>"
        result = extract_content(html)
        assert "没有语义标签" in result

    def test_script_removed(self):
        html = "<html><title>T</title><body><p>可见</p><script>alert('x')</script></body></html>"
        result = extract_content(html)
        assert "alert" not in result
        assert "可见" in result

    def test_4000_truncation(self):
        html = "<html><title>T</title><body><p>" + "长" * 5000 + "</p></body></html>"
        result = extract_content(html, max_chars=4000)
        assert "[内容已截断]" in result

    def test_js_rendered_detection(self):
        html = '<html><head></head><body><div id="app"></div><script>window.__INITIAL_STATE__={}</script></body></html>'
        result = extract_content(html)
        assert "浏览器渲染" in result

    def test_semantic_tag_not_misjudged(self):
        html = '<html><body><div id="app"><main><p>真实内容</p></main></div><script>window.__INITIAL_STATE__={}</script></body></html>'
        result = extract_content(html)
        assert "浏览器渲染" not in result
        assert "真实内容" in result

    def test_html_entity_decode(self):
        html = "<html><title>Tom &amp; Jerry &#x27;s</title><body><p>a &lt; b</p></body></html>"
        result = extract_content(html)
        assert "Tom & Jerry 's" in result
        assert "a < b" in result


# ── 反爬（6）─────────────────────────────────────────────

class TestAntiCrawl:
    def _engine(self, fetcher):
        e = SearchEngine(fetcher=fetcher)

        async def _no_delay():
            return None

        e._delay = _no_delay  # 免真实延迟（真实 async 函数，替代 AsyncMock 免未 await 警告）
        return e

    def test_captcha_chinese(self):
        fetcher = _FakeFetcher()
        fetcher.responses = {"https://cn.bing.com/search?q=x": "<html>安全验证 请输入验证码</html>"}
        e = self._engine(fetcher)
        e._prewarmed = True
        result = _run(e.search("x"))
        assert "人机验证" in result

    def test_captcha_english(self):
        fetcher = _FakeFetcher()
        fetcher.responses = {"https://cn.bing.com/search?q=x": "<html>Verify you are human</html>"}
        e = self._engine(fetcher)
        e._prewarmed = True
        result = _run(e.search("x"))
        assert "人机验证" in result

    def test_normal_result_not_captcha(self):
        # BUG-034: 正常结果页 + script 文件名含 "challenge" 子串 → 不应误判验证码
        html = (
            '<html><body><ul><li class="b_algo"><h2><a href="https://a.com">标题A</a></h2>'
            '<div class="b_caption"><p>摘要A</p></div></li></ul>'
            '<script src="https://cn.bing.com/powchallengesolver.js"></script></body></html>'
        )
        fetcher = _FakeFetcher()
        fetcher.responses = {"https://cn.bing.com/search?q=x": html}
        e = self._engine(fetcher)
        e._prewarmed = True
        result = _run(e.search("x"))
        assert "标题A" in result
        assert "人机验证" not in result

    def test_real_captcha_page(self):
        # BUG-034: 真验证码页（无结果 + 可见文本含关键词）→ 仍返回验证码文案
        html = '<html><body><p>请完成安全验证，输入验证码后继续访问</p></body></html>'
        fetcher = _FakeFetcher()
        fetcher.responses = {"https://cn.bing.com/search?q=x": html}
        e = self._engine(fetcher)
        e._prewarmed = True
        result = _run(e.search("x"))
        assert "人机验证" in result

    def test_bing_fail_fallback_baidu(self):
        fetcher = _FakeFetcher()
        fetcher.fail_urls.add("https://cn.bing.com/search?q=x")
        fetcher.responses = {"https://www.baidu.com/s?wd=x": "<html><div id='content_left'><h3><a href='http://a.com'>标题</a></h3></div></html>"}
        e = self._engine(fetcher)
        e._prewarmed = True
        result = _run(e.search("x"))
        assert "标题" in result
        assert "http://a.com" in result

    def test_prewarm_once(self):
        fetcher = _FakeFetcher()
        e = self._engine(fetcher)
        _run(e.search("a"))
        _run(e.search("b"))
        home_calls = [c for c in fetcher.calls if c == "https://cn.bing.com/"]
        assert len(home_calls) == 1

    def test_backoff_window(self):
        e = SearchEngine(fetcher=_FakeFetcher())
        e._mark_captcha()
        assert e._captcha_until > time.monotonic() + 200

    def test_semaphore_concurrency(self):
        fetcher = _FakeFetcher()
        e = self._engine(fetcher)
        e._prewarmed = True

        async def run_many():
            await asyncio.gather(*[e.search(f"q{i}") for i in range(10)])

        _run(run_many())
        assert fetcher.max_concurrent <= 5


# ── 沙箱/集成（2）────────────────────────────────────────

class TestSandboxIntegration:
    def test_workspace_url_passthrough(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager(config=SandboxConfig(workspace="D:/workspace"))
        # url 字段目标应放行（归 SSRF 管，不归路径隔离管）
        assert mgr._validate_workspace("D:/workspace", '{"url": "https://example.com"}') is True

    def test_pinning_host_header_and_url(self):
        captured = {}

        def handler(request):
            captured["host_header"] = request.headers.get("host")
            captured["url_host"] = request.url.host
            captured["sni"] = request.extensions.get("sni_hostname")
            return _html_response()

        f = WebFetcher(transport=_transport(handler))
        with patch("core.fetcher.socket.getaddrinfo",
                   return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]):
            _run(f.fetch_raw("https://example.com/path"))
        assert captured["url_host"] == "93.184.216.34"
        assert captured["host_header"] == "example.com"
        assert captured["sni"] == "example.com"


# ── DNS 异常（1）─────────────────────────────────────────

class TestDNS:
    def test_getaddrinfo_raises(self):
        with patch("core.fetcher.socket.getaddrinfo", side_effect=socket.gaierror("no such host")):
            with pytest.raises(FetchError) as e:
                _resolve_and_validate("nonexistent.example.com")
        assert "无法解析域名" in str(e.value)


class TestCapabilitiesPrompt:
    """Agent 能力描述应动态反映已注册工具（修复「认知不到自己能力」）"""

    def test_lists_registered_tools_dynamically(self):
        from tools.registry import get_registry, Tool
        from core.agent import Agent

        async def _noop(args):
            return "ok"

        reg = get_registry()
        reg.register(Tool("test_cap_tool", "测试能力工具", {"type": "object"},
                          execute_fn=_noop, permissions=[]), force=True)
        try:
            prompt = Agent._build_capabilities_prompt()
            assert "test_cap_tool" in prompt
            assert "测试能力工具" in prompt
        finally:
            reg.unregister("test_cap_tool")


class TestFileWriteTool:
    """A-041: 受控文件写入（仅项目根内/敏感屏蔽/大小上限/覆盖写/注册）"""

    def test_write_and_overwrite(self, tmp_path):
        import asyncio
        from unittest.mock import patch
        from tools.builtin import _file_write
        with patch("tools.builtin._PROJECT_ROOT", tmp_path):
            r = asyncio.run(_file_write({"path": "notes/hello.txt", "content": "你好世界"}))
            assert "已保存" in r
            p = tmp_path / "notes" / "hello.txt"
            assert p.read_text(encoding="utf-8") == "你好世界"
            r2 = asyncio.run(_file_write({"path": "notes/hello.txt", "content": "v2"}))
            assert p.read_text(encoding="utf-8") == "v2"

    def test_outside_root_rejected(self, tmp_path):
        import asyncio
        from unittest.mock import patch
        from tools.builtin import _file_write
        with patch("tools.builtin._PROJECT_ROOT", tmp_path):
            r = asyncio.run(_file_write({"path": "C:/Windows/evil.txt", "content": "x"}))
        assert "超出项目范围" in r

    def test_sensitive_names_rejected(self, tmp_path):
        import asyncio
        from unittest.mock import patch
        from tools.builtin import _file_write
        with patch("tools.builtin._PROJECT_ROOT", tmp_path):
            r = asyncio.run(_file_write({"path": "config/auth_token.enc", "content": "x"}))
            assert "敏感文件" in r
            r2 = asyncio.run(_file_write({"path": ".slime_pass", "content": "x"}))
            assert "敏感文件" in r2

    def test_size_cap(self, tmp_path):
        import asyncio
        from unittest.mock import patch
        from tools.builtin import _file_write
        with patch("tools.builtin._PROJECT_ROOT", tmp_path), \
             patch("tools.builtin._MAX_WRITE_BYTES", 10):
            r = asyncio.run(_file_write({"path": "big.txt", "content": "x" * 11}))
        assert "上限" in r

    def test_missing_params(self):
        import asyncio
        from tools.builtin import _file_write
        assert "缺少 path" in asyncio.run(_file_write({}))
        assert "缺少 content" in asyncio.run(_file_write({"path": "a.txt"}))

    def test_registered_in_registry(self):
        from tools.registry import get_registry, reset_registry
        from tools.builtin import register_builtin_tools
        reset_registry()
        try:
            register_builtin_tools()
            names = get_registry().list_tool_names()
            assert "file_write" in names
        finally:
            reset_registry()


class TestFileToolPathAnchoring:
    """A-036: 文件工具相对路径锚定项目根（server 任意 cwd 启动时 "." 亦指项目根）"""

    def test_file_list_dot_is_project_root(self):
        import asyncio
        from tools.builtin import _file_list
        out = asyncio.run(_file_list({"path": "."}))
        assert "[错误]" not in out
        assert "config" in out  # 项目根目录应包含 config/

    def test_file_read_relative_anchored(self):
        import asyncio
        from tools.builtin import _file_read
        out = asyncio.run(_file_read({"path": "CLAUDE.md"}))
        assert "[错误]" not in out
        assert "slime" in out.lower()

    def test_file_read_outside_root_rejected(self):
        import asyncio
        from tools.builtin import _file_read
        out = asyncio.run(_file_read({"path": "C:/Windows/System32/drivers/etc/hosts"}))
        assert "超出项目范围" in out


class TestReasoningExtraction:
    """A1: 通用思考字段提取（reasoning_content / reasoning / thinking + chunk 顶层）"""

    def test_three_fields_and_priority(self):
        from core.llm import _extract_reasoning
        assert _extract_reasoning({"reasoning_content": "r1"}) == "r1"
        assert _extract_reasoning({"reasoning": "r2"}) == "r2"
        assert _extract_reasoning({"thinking": "r3"}) == "r3"
        # 优先级：reasoning_content > reasoning > thinking
        assert _extract_reasoning({"reasoning_content": "a", "reasoning": "b", "thinking": "c"}) == "a"

    def test_chunk_top_level_fallback(self):
        from core.llm import _extract_reasoning
        assert _extract_reasoning({}, {"reasoning_content": "r4"}) == "r4"
        assert _extract_reasoning({}, {"thinking": "r5"}) == "r5"
        assert _extract_reasoning({}, {}) == ""


class TestReasoningParams:
    """A-014: reasoning 参数注入与思考透传（补齐 REASONING_STATUS 计划用例）"""

    def _make_agent(self, effort="none", show="off", mode="build"):
        from core.agent import Agent
        return Agent(name="t", role="测试", reasoning_effort=effort, show_thinking=show, mode=mode)

    def test_effort_none_zero_injection(self):
        from core.llm import _build_reasoning_params
        assert _build_reasoning_params(self._make_agent("none"), {}) == {}

    def test_openai_style_effort(self):
        from core.llm import _build_reasoning_params
        p = _build_reasoning_params(self._make_agent("high"), {"reasoning_style": "openai"})
        assert p == {"reasoning_effort": "high"}

    def test_anthropic_style_budget(self):
        from core.llm import _build_reasoning_params
        p = _build_reasoning_params(self._make_agent("low"), {"reasoning_style": "anthropic"})
        assert p["thinking"]["type"] == "enabled"
        assert p["thinking"]["budget_tokens"] == 2048

    def test_reasoning_disabled_gate(self):
        from core.llm import _build_reasoning_params
        assert _build_reasoning_params(self._make_agent("high"), {"reasoning_enabled": False}) == {}

    def test_agnes_style_chat_template_kwargs(self):
        """A-091（实测定稿）：agnes provider 只注入 chat_template_kwargs.enable_thinking
        （thinking/budget_tokens 格式实测被 Agnes 忽略，不注入）"""
        from core.llm import _build_reasoning_params
        p = _build_reasoning_params(self._make_agent("high"), {"api_base": "https://api.agnes-ai.cn/v1"})
        assert p == {"chat_template_kwargs": {"enable_thinking": True}}, p

    def test_agnes_auto_detect_api_base(self):
        """A-091: api_base 含 agnes-ai 自动生效（零配置）；不含则走 openai 回归"""
        from core.llm import _build_reasoning_params
        assert _build_reasoning_params(self._make_agent("medium"),
                                       {"api_base": "https://api.agnes-ai.cn/v1"}) == {"chat_template_kwargs": {"enable_thinking": True}}
        # 非 agnes api_base + 无 reasoning_style → openai 分支回归
        assert _build_reasoning_params(self._make_agent("high"),
                                       {"api_base": "https://api.openai.com/v1"}) == {"reasoning_effort": "high"}
        # 显式 style=agnes 优先
        assert _build_reasoning_params(self._make_agent("low"),
                                       {"reasoning_style": "agnes"}) == {"chat_template_kwargs": {"enable_thinking": True}}

    def test_agnes_max_tokens_linkage(self):
        """A-091: thinking 开启时 max_tokens 联动（max_output=2048 → 4096 防思考截断）"""
        from core.llm import _effective_max_output, _thinking_enabled
        ag = self._make_agent("high")
        cfg = {"api_base": "https://api.agnes-ai.cn/v1"}
        assert _thinking_enabled(ag, cfg) is True
        assert _effective_max_output(ag, cfg) == 4096
        # none → 不联动
        assert _effective_max_output(self._make_agent("none"), cfg) == 2048
        # 非 agnes → 不联动
        assert _effective_max_output(ag, {"api_base": "https://api.openai.com/v1"}) == 2048
        # 已是 8192 → 不变
        from core.agent import Agent
        big = Agent(name="b", role="r", reasoning_effort="high", max_output=8192)
        assert _effective_max_output(big, cfg) == 8192

    def test_should_yield_reasoning(self):
        from core.llm import _should_yield_reasoning
        assert _should_yield_reasoning(self._make_agent(show="on")) is True
        assert _should_yield_reasoning(self._make_agent(show="off")) is False
        assert _should_yield_reasoning(self._make_agent(show="auto", mode="plan")) is True
        assert _should_yield_reasoning(self._make_agent(show="auto", mode="build")) is False

    def test_split_inherits_reasoning_fields(self):
        from core.agent import Agent
        parent = Agent(name="p", role="主", reasoning_effort="medium", show_thinking="auto", mode="plan")
        child = parent.split("c", "子")
        assert child.reasoning_effort == "medium"
        assert child.show_thinking == "auto"
        assert child.mode == "plan"


class TestToolVisualization:
    """A3/A4: 工具过程可视化明细 + 超限文案带摘要"""

    def test_execute_returns_details(self):
        import asyncio
        from tools.registry import Tool, get_registry
        from core.agent import Agent
        from core.llm import _execute_pending_tools

        async def _echo(args):
            return "echo:" + args.get("text", "")

        reg = get_registry()
        reg.register(Tool("viz_echo", "测试", {"type": "object"}, execute_fn=_echo, permissions=[]), force=True)
        try:
            agent = Agent(name="t", role="测试")
            details = asyncio.run(_execute_pending_tools(agent, [], [
                {"id": "c1", "function": {"name": "viz_echo", "arguments": '{"text": "hi"}'}}
            ]))
            assert details == [("viz_echo", '{"text": "hi"}', "echo:hi")]
        finally:
            reg.unregister("viz_echo")

    def test_format_tool_rounds(self):
        from core.llm import _format_tool_rounds
        msg = _format_tool_rounds([(1, [("web_fetch", '{"url": "x"}', "[该页面需浏览器渲染]")])])
        assert "[工具调用轮次已达上限（3 轮）]" in msg
        assert "第1轮: web_fetch" in msg
        assert "[该页面需浏览器渲染]" in msg


class TestJSExtraction:
    """B1: JS 渲染站从 __NEXT_DATA__ / __INITIAL_STATE__ / __NUXT__ 提取正文"""

    def test_next_data_extraction(self):
        from core.extractor import extract_content
        html = (
            '<html><body><div id="__next"></div>'
            '<script id="__NEXT_DATA__" type="application/json">'
            '{"props":{"pageProps":{"title":"DeepSeek 定价","content":"每百万 tokens 1 元"}}}'
            '</script></body></html>'
        )
        result = extract_content(html)
        assert "DeepSeek 定价" in result
        assert "每百万 tokens 1 元" in result
        assert "浏览器渲染" not in result

    def test_js_without_data_still_prompt(self):
        from core.extractor import extract_content
        html = '<html><body><div id="app"></div><script>window.__INITIAL_STATE__=undefined</script></body></html>'
        result = extract_content(html)
        assert "浏览器渲染" in result
