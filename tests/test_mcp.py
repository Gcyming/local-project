"""slime MCP 客户端测试（stdio + HTTP 传输、资源/提示桥接）"""
import json
import sys
import time
import asyncio
from unittest.mock import patch, MagicMock


def _run(coro):
    return asyncio.run(coro)


class _FakeTransport:
    """mock 传输层：按 method 返回预设 result。"""

    def __init__(self, responses: dict):
        self.responses = responses
        self._running = True
        self.closed = False

    async def start(self):
        return True

    async def close(self):
        self._running = False
        self.closed = True

    @property
    def running(self):
        return self._running

    async def request(self, payload: str, req_id: int, timeout: float = None):
        msg = json.loads(payload)
        method = msg.get("method", "")
        if method not in self.responses:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "not found"}}
        return {"jsonrpc": "2.0", "id": req_id, "result": self.responses[method]}

    async def notify(self, payload: str):
        pass


class TestMCPSSEParsing:
    def test_extract_matching_id(self):
        from core.mcp_client import _HTTPTransport
        sse = (
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n'
            'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n'
        )
        result = _HTTPTransport._parse_sse(sse, 2)
        assert result is not None
        assert result["result"] == {"b": 2}

    def test_skip_done_and_non_data(self):
        from core.mcp_client import _HTTPTransport
        sse = (
            'data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n'
            'data: [DONE]\n\n'
            ': keep-alive\n\n'
        )
        assert _HTTPTransport._parse_sse(sse, 1)["result"] == {"x": 1}
        assert _HTTPTransport._parse_sse(sse, 99) is None

    def test_empty_returns_none(self):
        from core.mcp_client import _HTTPTransport
        assert _HTTPTransport._parse_sse("", 1) is None


class TestMCPContentToText:
    def _server(self):
        from core.mcp_client import _MCPServer
        return _MCPServer("test", _FakeTransport({}))

    def test_text_items(self):
        content = [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}]
        assert self._server()._content_to_text(content) == "hello\nworld"

    def test_resource_items(self):
        content = [{"type": "resource", "resource": {"uri": "file:///a"}}]
        assert "资源" in self._server()._content_to_text(content)

    def test_empty_content(self):
        assert self._server()._content_to_text([]) == "[MCP 空响应]"


class TestMCPPromptSchema:
    def test_convert_args(self):
        from core.mcp_client import MCPClient
        schema = MCPClient._prompt_args_to_schema([
            {"name": "city", "description": "城市名", "required": True},
            {"name": "unit", "description": "单位"},
        ])
        assert schema["type"] == "object"
        assert "city" in schema["properties"]
        assert schema["required"] == ["city"]
        assert "unit" in schema["properties"]
        assert "unit" not in schema["required"]


class TestMCPMediaContent:
    """批2 P0-4: image/audio/video content 落盘回传路径。"""

    def _server(self):
        from core.mcp_client import _MCPServer
        return _MCPServer("browser", _FakeTransport({}))

    def test_image_saved_to_disk(self, tmp_path):
        import base64
        from core import mcp_client
        server = self._server()
        png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 32).decode()
        with patch.object(mcp_client, "_PROJECT_ROOT", tmp_path):
            text = server._content_to_text([{"type": "image", "data": png, "mimeType": "image/png"}])
        assert "图片已保存" in text
        files = list((tmp_path / "data" / "mcp" / "browser").glob("*.png"))
        assert len(files) == 1
        assert files[0].read_bytes().startswith(b"\x89PNG")

    def test_audio_default_bin(self, tmp_path):
        import base64
        from core import mcp_client
        server = self._server()
        raw = base64.b64encode(b"\x00\x01\x02audio").decode()
        with patch.object(mcp_client, "_PROJECT_ROOT", tmp_path):
            text = server._content_to_text([{"type": "audio", "data": raw}])
        assert "音频已保存" in text
        assert len(list((tmp_path / "data" / "mcp" / "browser").glob("*.bin"))) == 1

    def test_oversize_skipped(self, tmp_path):
        import base64
        from core import mcp_client
        server = self._server()
        raw = base64.b64encode(b"x" * 16).decode()
        with patch.object(mcp_client, "_MAX_MEDIA_BYTES", 4):
            text = server._content_to_text([{"type": "image", "data": raw, "mimeType": "image/png"}])
        assert "过大" in text
        assert not (tmp_path / "data" / "mcp" / "browser").exists()

    def test_same_content_dedup(self, tmp_path):
        import base64
        from core import mcp_client
        server = self._server()
        raw = base64.b64encode(b"same-bytes").decode()
        item = {"type": "image", "data": raw, "mimeType": "image/png"}
        with patch.object(mcp_client, "_PROJECT_ROOT", tmp_path):
            server._content_to_text([item])
            server._content_to_text([item])
        assert len(list((tmp_path / "data" / "mcp" / "browser").glob("*.png"))) == 1


class TestMCPTimeoutConfig:
    """批2 P1-1: 超时可配，_request 把配置的 timeout 透传给 transport。"""

    class _RecordingTransport(_FakeTransport):
        def __init__(self):
            super().__init__({})
            self.last_timeout = None

        async def request(self, payload, req_id, timeout=None):
            self.last_timeout = timeout
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    def test_configured_timeout_passed(self):
        from core.mcp_client import _MCPServer
        t = self._RecordingTransport()
        server = _MCPServer("svc", t, timeout=7.5)
        _run(server._request("initialize", {}))
        assert t.last_timeout == 7.5

    def test_default_timeout_when_none(self):
        from core import mcp_client
        t = self._RecordingTransport()
        server = mcp_client._MCPServer("svc", t)
        _run(server._request("initialize", {}))
        assert t.last_timeout == mcp_client._REQUEST_TIMEOUT


class TestHTTPStreaming:
    """批2 P0-3: HTTP SSE 流式逐行读，命中 req_id 即返回。"""

    def _transport(self, sse):
        import httpx
        from core.mcp_client import _HTTPTransport

        def handler(request):
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=sse.encode()
            )
        t = _HTTPTransport("http://x/mcp", None, "t")
        t._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return t

    def test_sse_stream_matches_id(self):
        sse = (
            'data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n'
            'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n'
        )
        t = self._transport(sse)
        result = _run(t.request('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}', 2))
        assert result["result"] == {"b": 2}
        _run(t.close())

    def test_sse_missing_id_returns_none(self):
        sse = 'data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n'
        t = self._transport(sse)
        assert _run(t.request('{"jsonrpc":"2.0","id":99,"method":"tools/list","params":{}}', 99)) is None
        _run(t.close())

    def test_sse_keepalive_times_out(self):
        # 问题1：server 只发 keep-alive ping（`: ...`）不发匹配响应 → wait_for 兜底返回 None，不挂起
        import httpx
        from core.mcp_client import _HTTPTransport

        def handler(request):
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=": ping\n\n"
            )
        t = _HTTPTransport("http://x/mcp", None, "t")
        t._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        async def never_returns(resp, req_id):
            await asyncio.sleep(3600)  # 模拟无限 keep-alive 流

        t._read_sse_stream = never_returns
        result = _run(t.request('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}', 1, timeout=0.2))
        assert result is None
        _run(t.close())


class TestMCPServer:
    def test_discover_capabilities(self):
        from core.mcp_client import _MCPServer
        transport = _FakeTransport({
            "initialize": {"protocolVersion": "2024-11-05"},
            "tools/list": {"tools": [{"name": "t1", "description": "d", "inputSchema": {}}]},
            "resources/list": {"resources": [{"uri": "file:///a", "name": "res1"}]},
            "prompts/list": {"prompts": [{"name": "p1", "description": "pd"}]},
        })
        server = _MCPServer("test", transport)
        assert _run(server.start()) is True
        assert len(server.tools) == 1
        assert server.tools[0]["name"] == "t1"
        assert len(server.resources) == 1
        assert len(server.prompts) == 1
        _run(server.stop())

    def test_call_tool(self):
        from core.mcp_client import _MCPServer
        transport = _FakeTransport({
            "initialize": {"protocolVersion": "x"},
            "tools/list": {"tools": []},
            "tools/call": {"content": [{"type": "text", "text": "结果"}]},
        })
        server = _MCPServer("test", transport)
        assert _run(server.call_tool("t", {})) == "结果"

    def test_read_resource(self):
        from core.mcp_client import _MCPServer
        transport = _FakeTransport({
            "initialize": {"protocolVersion": "x"},
            "resources/read": {"contents": [{"uri": "file:///a", "text": "内容"}]},
        })
        server = _MCPServer("test", transport)
        assert _run(server.read_resource("file:///a")) == "内容"

    def test_get_prompt(self):
        from core.mcp_client import _MCPServer
        transport = _FakeTransport({
            "initialize": {"protocolVersion": "x"},
            "prompts/get": {
                "description": "提示描述",
                "messages": [{"role": "user", "content": {"type": "text", "text": "正文"}}],
            },
        })
        server = _MCPServer("test", transport)
        result = _run(server.get_prompt("p1"))
        assert "提示描述" in result
        assert "正文" in result


class TestStdioFraming:
    """stdio 双帧格式（JSONL + Content-Length）序列化/嗅探。"""

    def test_serialize_jsonl_default(self):
        from core.mcp_client import _StdioTransport
        t = _StdioTransport("cmd", [], None, "t")
        assert t._serialize('{"a":1}') == b'{"a":1}\n'

    def test_serialize_content_length_after_flip(self):
        from core.mcp_client import _StdioTransport
        t = _StdioTransport("cmd", [], None, "t")
        t.flip_framing()
        assert t._serialize('{"a":1}') == b'Content-Length: 7\r\n\r\n{"a":1}'

    def test_flip_framing_toggles(self):
        from core.mcp_client import _StdioTransport
        t = _StdioTransport("cmd", [], None, "t")
        assert t._framing == "jsonl"
        assert t.flip_framing() is True
        assert t._framing == "content_length"
        assert t.flip_framing() is True
        assert t._framing == "jsonl"

    def test_read_jsonl(self):
        from core.mcp_client import _StdioTransport
        t = _StdioTransport("cmd", [], None, "t")
        t._proc = MagicMock()
        # 首字节 b'{' 已嗅探，read(1) 返回剩余行
        t._proc.stdout.read = MagicMock(return_value=b'"jsonrpc":"2.0","id":1,"result":{"x":1}}\n')
        assert t._read_jsonl(b"{") == {"jsonrpc": "2.0", "id": 1, "result": {"x": 1}}

    def test_read_content_length(self):
        from core.mcp_client import _StdioTransport
        t = _StdioTransport("cmd", [], None, "t")
        t._proc = MagicMock()
        body = b'{"jsonrpc":"2.0","id":1,"result":{"x":1}}'
        n = len(body)
        # 首字节 b'C' 已嗅探，返回剩余 header + body
        t._proc.stdout.read = MagicMock(side_effect=[f"ontent-Length: {n}\r\n\r\n".encode(), body])
        assert t._read_content_length(b"C") == {"jsonrpc": "2.0", "id": 1, "result": {"x": 1}}


class TestStdioReaderLoop:
    """批1: 后台 reader 循环（notification 不错配 / stderr drain / 超时不 kill）。"""

    _FAKE_SERVER = '''
import sys, json

def send(msg):
    print(json.dumps(msg), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    rid = msg.get("id")
    meth = msg.get("method", "")
    if meth == "initialize":
        # 先发一条 notification（无 id）再回响应 —— 验证不错配
        send({"jsonrpc": "2.0", "method": "notifications/test", "params": {}})
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "fake", "version": "1.0"}}})
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "tools": [{"name": "t1", "description": "d", "inputSchema": {}}]}})
    else:
        send({"jsonrpc": "2.0", "id": rid,
              "error": {"code": -32601, "message": "not found"}})
'''

    _TIMEOUT_SERVER = '''
import sys, json

def send(msg):
    print(json.dumps(msg), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    rid = msg.get("id")
    meth = msg.get("method", "")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "fake", "version": "1.0"}}})
    # tools/list 等其他方法一律不响应，用于触发超时
'''

    def _spawn(self, script):
        from core.mcp_client import _StdioTransport
        return _StdioTransport(sys.executable, ["-c", script], None, "fake")

    def test_notification_before_response(self):
        async def scenario():
            t = self._spawn(self._FAKE_SERVER)
            assert await t.start() is True
            try:
                r = await t.request(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}), 1, timeout=10.0)
                assert r is not None and r.get("id") == 1
                assert r["result"]["protocolVersion"] == "2025-11-25"
                r = await t.request(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}), 2, timeout=10.0)
                assert r is not None and r.get("id") == 2
                assert r["result"]["tools"][0]["name"] == "t1"
            finally:
                await t.close()
        _run(scenario())

    def test_stderr_drain(self):
        # 子进程启动即写 200KB 到 stderr（>64KB 管道缓冲）；无 drain 则死锁
        script = "import sys\nsys.stderr.write('x' * 200000)\nsys.stderr.flush()\n" + self._FAKE_SERVER

        async def scenario():
            t = self._spawn(script)
            assert await t.start() is True
            try:
                r = await t.request(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}), 1, timeout=10.0)
                assert r is not None and r.get("id") == 1
            finally:
                await t.close()
        _run(scenario())

    def test_timeout_does_not_kill(self):
        async def scenario():
            t = self._spawn(self._TIMEOUT_SERVER)
            assert await t.start() is True
            try:
                r = await t.request(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}), 1, timeout=10.0)
                assert r is not None and r.get("id") == 1
                # tools/list 永不响应 → 超时，但进程仍 running（不再 kill）
                r = await t.request(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}), 2, timeout=1.0)
                assert r is None
                assert t.running is True
            finally:
                await t.close()
        _run(scenario())


class TestMCPClient:
    def _make_server(self):
        from core.mcp_client import _MCPServer
        transport = _FakeTransport({
            "initialize": {"protocolVersion": "x"},
            "tools/list": {"tools": [{"name": "echo", "description": "回显", "inputSchema": {}}]},
            "resources/list": {"resources": [{"uri": "file:///a", "name": "doc"}]},
            "prompts/list": {"prompts": [{"name": "greet", "description": "问候"}]},
        })
        return _MCPServer("svc", transport)

    def test_bridge_prefixes_and_permissions(self):
        from core.mcp_client import MCPClient
        from tools.registry import get_registry
        client = MCPClient()
        server = self._make_server()
        _run(server.start())
        client._servers["svc"] = server
        client._register_capabilities("svc", server)

        registry = get_registry()
        assert registry.get("mcp_echo") is not None
        assert registry.get("mcp_res_doc") is not None
        assert registry.get("mcp_prompt_greet") is not None
        # 权限：tools=network，resources/prompts=read
        assert registry.get("mcp_echo").permissions == ["network"]
        assert registry.get("mcp_res_doc").permissions == ["read"]
        assert registry.get("mcp_prompt_greet").permissions == ["read"]
        # 清理
        client._unregister_all_tools()

    def test_call_tool_routing(self):
        from core.mcp_client import MCPClient
        client = MCPClient()
        server = self._make_server()
        _run(server.start())
        client._servers["svc"] = server
        client._register_capabilities("svc", server)
        client._tool_map["mcp_res_doc"] = ("svc", "resource", "file:///a")

        # resource 路由
        result = _run(client.call_tool("mcp_res_doc", {}))
        assert result == "[错误] MCP 资源 'file:///a' 读取失败：服务无响应" or "资源" in result

        # 未知工具
        assert _run(client.call_tool("mcp_nonexistent", {})) == "[错误] MCP 未找到工具 'mcp_nonexistent'"
        client._unregister_all_tools()


class TestMCPPermissions:
    """批3 P2-3: per-server 权限映射（按名覆盖 / default 兜底 / 非法值回退）。"""

    def _server(self, tool_permissions=None):
        from core.mcp_client import _MCPServer
        return _MCPServer("svc", _FakeTransport({}), tool_permissions=tool_permissions)

    def test_no_config_defaults_network(self):
        from core.mcp_client import MCPClient
        client = MCPClient()
        assert client._resolve_tool_permissions(self._server(), "echo") == ["network"]

    def test_default_override(self):
        from core.mcp_client import MCPClient
        client = MCPClient()
        assert client._resolve_tool_permissions(self._server({"default": ["read"]}), "echo") == ["read"]

    def test_per_tool_override(self):
        from core.mcp_client import MCPClient
        client = MCPClient()
        server = self._server({"default": ["network"], "echo": ["read"]})
        assert client._resolve_tool_permissions(server, "echo") == ["read"]
        assert client._resolve_tool_permissions(server, "other") == ["network"]

    def test_invalid_value_falls_back(self):
        from core.mcp_client import MCPClient
        client = MCPClient()
        assert client._resolve_tool_permissions(self._server({"default": ["read", "bogus"]}), "echo") == ["network"]

    def test_string_config_accepted(self):
        from core.mcp_client import MCPClient
        client = MCPClient()
        assert client._resolve_tool_permissions(self._server({"default": "read"}), "echo") == ["read"]

    def test_registry_applies_permissions(self):
        from core.mcp_client import _MCPServer, MCPClient
        from tools.registry import get_registry
        server = _MCPServer("svc", _FakeTransport({
            "initialize": {"protocolVersion": "x"},
            "tools/list": {"tools": [{"name": "echo", "description": "d", "inputSchema": {}}]},
        }), tool_permissions={"default": ["read"]})
        _run(server.start())
        client = MCPClient()
        client._servers["svc"] = server
        client._register_capabilities("svc", server)
        assert get_registry().get("mcp_echo").permissions == ["read"]
        client._unregister_all_tools()


class TestMCPNameConflict:
    """批3 P2-4: 多 server 同名工具冲突后缀 _2/_3。"""

    def _server(self):
        from core.mcp_client import _MCPServer
        return _MCPServer("svc", _FakeTransport({
            "initialize": {"protocolVersion": "x"},
            "tools/list": {"tools": [{"name": "echo", "description": "d", "inputSchema": {}}]},
        }))

    def test_conflict_suffix(self):
        from core.mcp_client import MCPClient
        from tools.registry import get_registry
        client = MCPClient()
        a, b = self._server(), self._server()
        _run(a.start()); _run(b.start())
        client._servers["a"] = a
        client._servers["b"] = b
        client._register_capabilities("a", a)
        client._register_capabilities("b", b)
        registry = get_registry()
        assert registry.get("mcp_echo") is not None
        assert registry.get("mcp_echo_2") is not None
        assert client._tool_map["mcp_echo"] == ("a", "tool", "echo")
        assert client._tool_map["mcp_echo_2"] == ("b", "tool", "echo")
        client._unregister_all_tools()


class TestMCPConcurrentStart:
    """批3 P2-2: start_all 并发，单 server 失败不拖累其他。"""

    def _server(self):
        from core.mcp_client import _MCPServer
        return _MCPServer("svc", _FakeTransport({
            "initialize": {"protocolVersion": "x"},
            "tools/list": {"tools": [{"name": "echo", "description": "d", "inputSchema": {}}]},
        }))

    def test_start_all_registers_all(self):
        from core.mcp_client import MCPClient
        from tools.registry import get_registry
        client = MCPClient()
        client._servers["a"] = self._server()
        client._servers["b"] = self._server()
        results = _run(client.start_all())
        assert results == {"a": True, "b": True}
        assert get_registry().get("mcp_echo") is not None
        assert get_registry().get("mcp_echo_2") is not None
        client._unregister_all_tools()

    def test_start_all_failure_isolated(self):
        async def scenario():
            from core.mcp_client import _MCPServer, MCPClient
            from tools.registry import get_registry
            client = MCPClient()
            client._servers["ok"] = _MCPServer("ok", _FakeTransport({
                "initialize": {"protocolVersion": "x"},
                "tools/list": {"tools": [{"name": "t1", "description": "d", "inputSchema": {}}]},
            }))
            client.add_server("bad", "definitely_not_a_real_cmd_xyz", [])
            results = await client.start_all()
            assert results["ok"] is True
            assert results["bad"] is False
            assert get_registry().get("mcp_t1") is not None
            await client.stop_all()
        _run(scenario())


class TestMCPNotificationRefresh:
    """批3 P1-3: tools/list_changed 通知 → 重新发现 + 重注册。"""

    _NOTIFY_SERVER = '''
import sys, json

TOOLS = [{"name": "t1", "description": "d", "inputSchema": {}}]

def send(msg):
    print(json.dumps(msg), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    rid = msg.get("id")
    meth = msg.get("method", "")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "fake", "version": "1.0"}}})
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
    elif meth == "trigger":
        TOOLS.append({"name": "t2", "description": "d2", "inputSchema": {}})
        send({"jsonrpc": "2.0", "method": "notifications/tools/list_changed", "params": {}})
        send({"jsonrpc": "2.0", "id": rid, "result": {"ok": True}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "not found"}})
'''

    def test_list_changed_refresh(self):
        async def scenario():
            import sys
            from core.mcp_client import MCPClient
            from tools.registry import get_registry
            client = MCPClient()
            client.add_server("fake", sys.executable, ["-c", self._NOTIFY_SERVER])
            results = await client.start_all()
            assert results["fake"] is True
            assert get_registry().get("mcp_t1") is not None
            assert get_registry().get("mcp_t2") is None
            # 触发 server 加工具 + 发 list_changed
            await client._servers["fake"]._request("trigger", {})
            # 等通知异步处理（create_task → _refresh_server_tools）
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and get_registry().get("mcp_t2") is None:
                await asyncio.sleep(0.05)
            assert get_registry().get("mcp_t2") is not None
            await client.stop_all()
        _run(scenario())

    def test_notification_handler_swallows_errors(self):
        """收尾观察项 1：handler 内 try/except，_refresh_server_tools 抛异常不产生未检索任务异常。"""
        from core.mcp_client import MCPClient

        async def boom(_name):
            raise RuntimeError("传输层意外异常")

        async def scenario():
            client = MCPClient()
            handler = client._make_notification_handler("fake")
            with patch.object(client, "_refresh_server_tools", boom):
                # 异常被 handler 吞掉，不向外抛（否则 create_task 的任务异常无人 retrieve）
                await handler({"method": "notifications/tools/list_changed"})
        _run(scenario())

    def test_concurrent_refresh_no_duplicate(self):
        """收尾观察项 2：并发 list_changed 刷新被 per-server 锁串行化，不产生 _2 重复注册。"""
        from core.mcp_client import MCPClient, _MCPServer
        from tools.registry import get_registry

        class _SlowTransport(_FakeTransport):
            async def request(self, payload, req_id, timeout=None):
                await asyncio.sleep(0.02)  # 强制真实交错，放大并发窗口
                return await super().request(payload, req_id, timeout)

        async def scenario():
            client = MCPClient()
            transport = _SlowTransport({
                "initialize": {"protocolVersion": "x"},
                "tools/list": {"tools": [{"name": "t1", "description": "d", "inputSchema": {}}]},
            })
            server = _MCPServer("fake", transport)
            client._servers["fake"] = server
            assert await server.start() is True
            client._register_capabilities("fake", server)
            assert get_registry().get("mcp_t1") is not None
            await asyncio.gather(
                client._refresh_server_tools("fake"),
                client._refresh_server_tools("fake"),
            )
            # 锁串行化后第二次刷新先摘旧再挂新，只保留一个 mcp_t1，无 _2 后缀
            assert get_registry().get("mcp_t1") is not None
            assert get_registry().get("mcp_t1_2") is None
            client._unregister_server_tools("fake")
        _run(scenario())


class TestMCPReconnect:
    """批3 P2-1: 进程死亡 → 自动重连 + last_error 清空。"""

    _DIE_SERVER = '''
import sys, json

def send(msg):
    print(json.dumps(msg), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    rid = msg.get("id")
    meth = msg.get("method", "")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "fake", "version": "1.0"}}})
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "tools": [{"name": "t1", "description": "d", "inputSchema": {}}]}})
    elif meth == "die":
        sys.exit(0)
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "not found"}})
'''

    def test_reconnect_after_death(self):
        async def scenario():
            import sys
            from core.mcp_client import MCPClient
            from tools.registry import get_registry
            client = MCPClient()
            client.add_server("fake", sys.executable, ["-c", self._DIE_SERVER])
            results = await client.start_all()
            assert results["fake"] is True
            assert get_registry().get("mcp_t1") is not None
            # 让 server 死掉
            await client._servers["fake"]._notify("die", {})
            # 等死亡被检测（工具被摘除）
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and get_registry().get("mcp_t1") is not None:
                await asyncio.sleep(0.05)
            assert get_registry().get("mcp_t1") is None
            # 等重连（退避 1s + 重启 + 重注册）
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and get_registry().get("mcp_t1") is None:
                await asyncio.sleep(0.1)
            assert get_registry().get("mcp_t1") is not None
            assert client._servers["fake"].last_error is None
            assert client._servers["fake"].running is True
            await client.stop_all()
        _run(scenario())


class TestReconnectLimit:
    """A-096: 重连上限（漏洞清单 M1/P1-17）——不再无限退避"""

    def test_reconnect_gives_up_after_limit(self):
        import asyncio
        from core import mcp_client as M
        client = M.MCPClient()

        class FakeSrv:
            name = "x"

            def __init__(self):
                self.last_error = ""
                self.start_calls = 0

            async def start(self):
                self.start_calls += 1
                raise ConnectionError("down")

        srv = FakeSrv()
        client._servers["x"] = srv
        orig = asyncio.sleep
        async def _noop(s):
            return None
        asyncio.sleep = _noop
        try:
            asyncio.run(client._reconnect_loop("x"))
        finally:
            asyncio.sleep = orig
        assert srv.start_calls == M._MCP_MAX_RECONNECT
        assert "重连放弃" in srv.last_error
