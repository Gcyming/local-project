"""slime 本地模型管理测试（不依赖真实 GPU/llama-server）"""
import json
import asyncio
from pathlib import Path
from unittest.mock import patch, MagicMock


class TestVRAMMonitor:
    def test_parse_valid(self):
        """nvidia-smi CSV 解析"""
        import subprocess
        from core.model_server import VRAMMonitor

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "8192, 2048, 6144\n"
        with patch.object(subprocess, "run", return_value=mock_result):
            monitor = VRAMMonitor()
            result = monitor.sample()
            assert result is not None
            assert result["total_gb"] == round(8192 / 1024, 2)
            assert result["used_gb"] == round(2048 / 1024, 2)
            assert result["free_gb"] == round(6144 / 1024, 2)

    def test_parse_fail_returns_none(self):
        """nvidia-smi 失败 → None"""
        import subprocess
        from core.model_server import VRAMMonitor

        with patch.object(subprocess, "run", side_effect=FileNotFoundError):
            monitor = VRAMMonitor()
            assert monitor.sample() is None

    def test_empty_output_returns_none(self):
        """nvidia-smi 空输出 → None"""
        import subprocess
        from core.model_server import VRAMMonitor

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        with patch.object(subprocess, "run", return_value=mock_result):
            monitor = VRAMMonitor()
            assert monitor.sample() is None


class TestModelBackend:
    def test_start_missing_binary(self, tmp_path):
        """llama_bin 不存在 → False"""
        from core.model_server import ModelBackend
        backend = ModelBackend(str(tmp_path / "nonexistent.exe"))
        assert backend.start("model.gguf", 9999, 99, 2048) is False

    def test_start_missing_model(self, tmp_path):
        """模型文件不存在 → False"""
        dummy = tmp_path / "llama-server.exe"
        dummy.write_text("")
        from core.model_server import ModelBackend
        backend = ModelBackend(str(dummy))
        assert backend.start(str(tmp_path / "none.gguf"), 9999, 99, 2048) is False

    def test_probe_no_server(self):
        """端口无服务 → False"""
        from core.model_server import ModelBackend
        backend = ModelBackend("llama-server")
        assert backend.probe(19999) is False

    def test_is_running_no_pid(self):
        """无 pid → False"""
        from core.model_server import ModelBackend
        backend = ModelBackend("llama-server")
        assert backend.is_running() is False


class TestModelServerManager:
    def _make_cfg(self, tmp_path):
        # A-037: 测试专用高位端口（19511/19521）—— 避免与用户正在运行的
        # 生产实例（embedding 8999 / chat 18082）冲突导致测试互相污染
        return {
            "llama_bin": str(tmp_path / "llama-server.exe"),
            "startup_timeout": 2,
            "vram_budget_gb": 7.0,
            "chat_est_gb": 4.0,
            "embedding": {
                "model_path": str(tmp_path / "bge.gguf"),
                "port": 19511,
                "gpu_layers": 99,
                "ctx_len": 2048,
                "persistent": True,
                "dim": 1024,
            },
            "chat": {
                "models_dir": str(tmp_path),
                "port_start": 19521,
                "gpu_layers": 99,
                "ctx_len": 8192,
                "persistent": False,
                "idle_unload_min": 0,
                "max_instances": 1,
            },
        }

    def test_ensure_missing_model(self, tmp_path):
        """模型文件不存在 → ok=False"""
        from core.model_server import ModelServerManager
        cfg = self._make_cfg(tmp_path)
        # 创建假 llama_bin 但模型文件不存在
        (tmp_path / "llama-server.exe").write_text("")
        mgr = ModelServerManager(cfg)
        import asyncio
        result = asyncio.run(mgr.ensure("embedding", cfg["embedding"]["model_path"], "bge-m3"))
        assert result["ok"] is False
        assert result["error"]  # 应有错误信息

    def test_release_embedding_denied(self, tmp_path):
        """release 不存在的 role → ok=False"""
        from core.model_server import ModelServerManager
        cfg = self._make_cfg(tmp_path)
        mgr = ModelServerManager(cfg)
        result = mgr.release("embedding")
        assert result["ok"] is False

    def test_status_empty(self, tmp_path):
        """未启动时 status 为空列表"""
        from core.model_server import ModelServerManager
        cfg = self._make_cfg(tmp_path)
        mgr = ModelServerManager(cfg)
        assert mgr.status() == []

    def test_registry_read_empty(self, tmp_path):
        """无文件时 read_registry 返回 {}"""
        from core import model_server as ms
        original = ms._REGISTRY_PATH
        ms._REGISTRY_PATH = tmp_path / "nonexistent.json"
        try:
            result = ms.ModelServerManager.read_registry()
            assert isinstance(result, dict)
            assert result == {}
        finally:
            ms._REGISTRY_PATH = original

    def test_find_free_port(self, tmp_path):
        """找空闲端口（chat：从 port_start 起）"""
        from core.model_server import ModelServerManager
        cfg = self._make_cfg(tmp_path)
        mgr = ModelServerManager(cfg)
        port = mgr._find_free_port(cfg["chat"]["port_start"])
        assert port >= 19521
        # 高端口范围应能找到空闲
        assert port < 19621

    def test_base_port_role_aware(self):
        """A-003: embedding 用固定配置端口，chat 用 port_start"""
        from core.model_server import _base_port_for
        embed_cfg = {"port": 8999}
        chat_cfg = {"port_start": 18082}
        assert _base_port_for("embedding", embed_cfg, chat_cfg) == 8999
        assert _base_port_for("chat", embed_cfg, chat_cfg) == 18082
        # 缺省兜底
        assert _base_port_for("embedding", {}, {}) == 8999
        assert _base_port_for("chat", {}, {}) == 18082

    def test_startup_purges_stale_registry(self, tmp_path):
        """A-003/H1: 启动时清空陈旧 registry（崩溃残留 ready 条目不再假就绪）"""
        from core import model_server as ms
        cfg = self._make_cfg(tmp_path)
        cfg["embedding"]["persistent"] = False  # 不拉起实例，只验证清理
        mgr = ms.ModelServerManager(cfg)

        # 预置陈旧 registry（模拟崩溃残留：embedding ready@19511 但实际无进程）
        original = ms._REGISTRY_PATH
        stale = tmp_path / "stale_registry.json"
        stale.write_text(json.dumps({
            "embedding": {"model": "bge-m3", "port": 19511, "pid": 13272, "state": "ready"}
        }), encoding="utf-8")
        ms._REGISTRY_PATH = stale
        try:
            asyncio.run(mgr.startup())
            data = json.loads(stale.read_text(encoding="utf-8"))
            assert data == {}
        finally:
            ms._REGISTRY_PATH = original


class TestEmbedFallback:
    """_embed 降级行为测试"""

    def test_dead_port_fallback_to_hash(self):
        """registry 端口无服务 → 哈希占位，维度 1024"""
        from core import memory as mem
        from core.model_server import ModelServerManager
        import json

        # 构造假 registry（端口指向不存在服务）
        original = ModelServerManager.read_registry
        ModelServerManager.read_registry = lambda: {
            "embedding": {"port": 19999, "state": "ready"}
        }
        try:
            result = mem._embed("测试文本")
            # 哈希占位应返回正确的 1024 维
            assert isinstance(result, list)
            assert len(result) == mem._EMBED_DIM
            # 所有值应在 [0, 1] 范围
            assert all(0.0 <= v <= 1.0 for v in result)
        finally:
            ModelServerManager.read_registry = original

    def test_hash_dimension_matches_embed_dim(self):
        """_hash_embed 维度始终等于 _EMBED_DIM"""
        from core import memory as mem
        result = mem._hash_embed("任意文本")
        assert len(result) == mem._EMBED_DIM
        result2 = mem._hash_embed("")
        assert len(result2) == mem._EMBED_DIM


# ── A-017: 崩溃残留孤儿 llama-server 检测与回收 ──────────────


class TestOrphanRecovery:
    """孤儿检测辅助函数（netstat/wmic/tasklist 解析）+ 活实例探测 + 回收决策"""

    def _make_cfg(self, tmp_path):
        # A-037: 测试专用高位端口（19511/19521）—— 避免与用户正在运行的
        # 生产实例（embedding 8999 / chat 18082）冲突导致测试互相污染
        return {
            "llama_bin": str(tmp_path / "llama-server.exe"),
            "startup_timeout": 2,
            "vram_budget_gb": 7.0,
            "chat_est_gb": 4.0,
            "embedding": {
                "model_path": str(tmp_path / "bge.gguf"),
                "port": 19511,
                "gpu_layers": 99,
                "ctx_len": 2048,
                "persistent": True,
                "dim": 1024,
            },
            "chat": {
                "models_dir": str(tmp_path),
                "port_start": 19521,
                "gpu_layers": 99,
                "ctx_len": 8192,
                "persistent": False,
                "idle_unload_min": 0,
                "max_instances": 1,
            },
        }

    def test_pid_for_port_parse(self):
        import subprocess
        from unittest.mock import patch, MagicMock
        from core.model_server import _pid_for_port
        mock = MagicMock()
        mock.stdout = "  TCP    127.0.0.1:8999   0.0.0.0:0    LISTENING    4242\n"
        with patch.object(subprocess, "run", return_value=mock):
            assert _pid_for_port(8999) == 4242

    def test_pid_for_port_missing(self):
        import subprocess
        from unittest.mock import patch, MagicMock
        from core.model_server import _pid_for_port
        mock = MagicMock()
        mock.stdout = "  TCP    127.0.0.1:9001   0.0.0.0:0    LISTENING    99\n"
        with patch.object(subprocess, "run", return_value=mock):
            assert _pid_for_port(8999) is None

    def test_is_orphan_parent_dead(self):
        import subprocess
        from unittest.mock import patch, MagicMock
        from core.model_server import _is_orphan

        def fake_run(args, **kw):
            m = MagicMock()
            if any("ParentProcessId" in a for a in args):
                m.stdout = "ParentProcessId\n99999\n"
            else:
                m.stdout = "INFO: No tasks are running."
            return m

        with patch.object(subprocess, "run", side_effect=fake_run):
            assert _is_orphan(4242) is True

    def test_is_orphan_parent_alive(self):
        import subprocess
        from unittest.mock import patch, MagicMock
        from core.model_server import _is_orphan

        def fake_run(args, **kw):
            m = MagicMock()
            if any("ParentProcessId" in a for a in args):
                m.stdout = "ParentProcessId\n99999\n"
            else:
                m.stdout = "python.exe   99999 Console  1  100,000 K"
            return m

        with patch.object(subprocess, "run", side_effect=fake_run):
            assert _is_orphan(4242) is False

    def test_verify_llama_server_pid_guard(self):
        """wmic 缺失（Win11 24H2+）→ tasklist 镜像名回退校验"""
        import subprocess
        from unittest.mock import patch, MagicMock
        from core.model_server import _verify_llama_server_pid
        ok = MagicMock()
        ok.stdout = '"llama-server.exe","4242","Console","1","2,000,000 K"\n'
        bad = MagicMock()
        bad.stdout = '"notepad.exe","4242","Console","1","100 K"\n'
        with patch("core.model_server.shutil.which", return_value=None), \
             patch.object(subprocess, "run", return_value=ok):
            assert _verify_llama_server_pid(4242) is True
        with patch("core.model_server.shutil.which", return_value=None), \
             patch.object(subprocess, "run", return_value=bad):
            assert _verify_llama_server_pid(4242) is False

    def test_parent_pid_powershell_fallback(self):
        """wmic 缺失 → PowerShell Get-CimInstance 回退解析父 PID"""
        import subprocess
        from unittest.mock import patch, MagicMock
        from core.model_server import _parent_pid
        mock = MagicMock()
        mock.stdout = "\n99999\n"
        with patch("core.model_server.shutil.which", return_value=None), \
             patch.object(subprocess, "run", return_value=mock):
            assert _parent_pid(4242) == 99999

    def test_kill_pid_refuses_non_llama_server(self):
        import subprocess
        from unittest.mock import patch, MagicMock
        from core.model_server import _kill_pid
        bad = MagicMock()
        bad.stdout = '"notepad.exe","4242","Console","1","100 K"\n'
        with patch("core.model_server.shutil.which", return_value=None), \
             patch.object(subprocess, "run", return_value=bad):
            assert _kill_pid(4242) is False

    def test_probe_live_embedding_and_chat(self, tmp_path):
        """embedding 查固定端口；chat 从 port_start 扫描（L2 死分支修复）"""
        import asyncio
        from unittest.mock import patch
        from core.model_server import ModelServerManager, ModelBackend

        cfg = self._make_cfg(tmp_path)
        mgr = ModelServerManager(cfg)

        async def fake_probe(self, port):
            return port == 19511  # 只有测试专用 embedding 端口有活实例

        with patch.object(ModelBackend, "probe_async", new=fake_probe), \
             patch("core.model_server._pid_for_port", return_value=4242):
            live = asyncio.run(mgr._probe_live("embedding", cfg["embedding"]))
            assert live == (19511, 4242)
            live2 = asyncio.run(mgr._probe_live("chat", cfg["chat"]))
            assert live2 is None  # 扫描 100 端口无活实例

    def test_ensure_adopts_external_instance(self, tmp_path):
        """活实例且非孤儿 → 外部复用（不杀、不重启）"""
        import asyncio
        from unittest.mock import patch
        from core.model_server import ModelServerManager, ModelBackend

        cfg = self._make_cfg(tmp_path)
        mgr = ModelServerManager(cfg)

        async def fake_probe(self, port):
            return port == 19511

        with patch.object(ModelBackend, "probe_async", new=fake_probe), \
             patch("core.model_server._pid_for_port", return_value=4242), \
             patch("core.model_server._is_orphan", return_value=False), \
             patch("core.model_server._kill_pid") as kill_mock:
            result = asyncio.run(mgr.ensure("embedding", cfg["embedding"]["model_path"], "bge-m3"))
            assert result["ok"] is True
            assert result["state"] == "external"
            assert result["port"] == 19511
            assert mgr._instances["embedding"].external is True
            kill_mock.assert_not_called()

    def test_ensure_kills_orphan_then_fresh_start(self, tmp_path):
        """孤儿实例 → 回收后全新启动（自愈）"""
        import asyncio
        from unittest.mock import patch
        from core.model_server import ModelServerManager, ModelBackend

        cfg = self._make_cfg(tmp_path)
        (tmp_path / "llama-server.exe").write_text("")
        (tmp_path / "bge.gguf").write_text("")
        mgr = ModelServerManager(cfg)

        async def fake_probe(self, port):
            return port == 19511

        async def fake_wait_ready(self, timeout=60):
            return True

        with patch.object(ModelBackend, "probe_async", new=fake_probe), \
             patch.object(ModelBackend, "start", return_value=True), \
             patch.object(ModelBackend, "wait_ready", new=fake_wait_ready), \
             patch("core.model_server._pid_for_port", return_value=4242), \
             patch("core.model_server._is_orphan", return_value=True), \
             patch("core.model_server._kill_pid", return_value=True) as kill_mock:
            result = asyncio.run(mgr.ensure("embedding", cfg["embedding"]["model_path"], "bge-m3"))
            assert result["ok"] is True
            assert result["state"] == "ready"
            assert result["port"] == 19511
            kill_mock.assert_called_once_with(4242)
            assert mgr._instances["embedding"].external is False
