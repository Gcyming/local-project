# -*- coding: utf-8 -*-
"""A-071/A-080: slime_launcher 测试——就绪校验 + server 信号隔离"""
import json
import sys
import threading
import http.server
import socketserver
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import slime_launcher as L  # noqa: E402


class _FakeHandler(http.server.BaseHTTPRequestHandler):
    """模拟占用 19000 的非 slime 程序：任意路径返回 200，但内容不是 slime /health"""
    body = b""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):
        pass


class TestWaitServerReady:
    """A-071: 端口被非 slime 程序占用时不得误判就绪"""

    def setup_method(self):
        self.srv = socketserver.TCPServer(("127.0.0.1", 0), _FakeHandler)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()
        self._old_url = L.HEALTH_URL
        L.HEALTH_URL = f"http://127.0.0.1:{self.port}/health"

    def teardown_method(self):
        self.srv.shutdown()
        self.srv.server_close()
        L.HEALTH_URL = self._old_url

    def test_fake_app_200_not_ready(self):
        """非 slime 程序返回 200（非 status=ok JSON）→ 不算就绪（A-071 修复）"""
        _FakeHandler.body = json.dumps({"hello": "world"}).encode()
        assert L._wait_server_ready(timeout=1) is False

    def test_slime_health_ready(self):
        """slime /health 格式（status=ok + agent_count）→ 算就绪"""
        _FakeHandler.body = json.dumps({"status": "ok", "agent_count": 3}).encode()
        assert L._wait_server_ready(timeout=1) is True

    def test_invalid_json_not_ready(self):
        """200 但响应体非 JSON → 不算就绪"""
        _FakeHandler.body = b"<html>not slime</html>"
        assert L._wait_server_ready(timeout=1) is False


class TestServerSignalIsolation:
    """A-080: launcher 启动 server 必须带 CREATE_NEW_PROCESS_GROUP
    （否则 Ctrl+C 直发共享控制台所有进程，server 自己收到 SIGINT 退出——
    A-077 只修了 launcher 不清理，server 照样死）"""

    def test_server_popen_uses_new_process_group(self):
        captured = {}

        def fake_popen(cmd, **kw):
            if str(cmd[1]).endswith("slime_server.py"):
                captured["server_cmd"] = cmd
                captured["server_kw"] = kw
                return mock.MagicMock()
            # CLI：wait 返回 0 使 launcher 正常退出
            return mock.MagicMock(wait=mock.MagicMock(return_value=0))

        with mock.patch.object(L.subprocess, "Popen", side_effect=fake_popen), \
             mock.patch.object(L, "_port_in_use", return_value=False), \
             mock.patch.object(L, "_wait_server_ready", return_value=True), \
             mock.patch.object(L, "_is_configured", return_value=True), \
             mock.patch.object(L, "_kill_process_tree"), \
             mock.patch.object(L, "_kill_port"), \
             mock.patch.object(sys, "argv", ["slime"]):
            try:
                L.main()  # 正常路径以 sys.exit(0) 结束
            except SystemExit:
                pass
        # server 启动命令指向 slime_server.py
        assert str(captured["server_cmd"][1]).endswith("slime_server.py"), captured["server_cmd"]
        # Windows 下必须带 CREATE_NEW_PROCESS_GROUP（脱离控制台信号组）
        if sys.platform == "win32":
            expected = getattr(L.subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            assert captured["server_kw"].get("creationflags", 0) == expected, captured["server_kw"]
        else:
            assert captured["server_kw"].get("creationflags", 0) == 0
