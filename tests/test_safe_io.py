"""A-989 崩溃安全读写（core/safe_io）回归测试。

**必须用 stdlib，不依赖 pytest 夹具**：自研 `run_tests.py` 是反射直调，
只注入 `tmp_path`、不注入 `monkeypatch`（见 run_tests.py line 56-57），
凡带夹具参数的用例在门禁里必然 TypeError（test_prune_cache_capacity 就栽过）。
"""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path


class TestSafeIO(unittest.TestCase):
    """崩溃安全写：tmp + fsync + replace + .bak"""

    def test_atomic_write_text_creates_file(self):
        from core.safe_io import atomic_write_text
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "state.json"
            atomic_write_text(p, json.dumps({"a": 1}))
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"a": 1})

    def test_atomic_write_keeps_bak_of_previous(self):
        """写第二次时，第一次的内容要在 .bak 里留着 —— 这是崩溃后的回退源。"""
        from core.safe_io import atomic_write_text
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "state.json"
            atomic_write_text(p, json.dumps({"v": 1}))
            atomic_write_text(p, json.dumps({"v": 2}))
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"v": 2})
            bak = Path(td) / "state.json.bak"
            self.assertTrue(bak.exists(), "应保留上一份完好内容的 .bak")
            self.assertEqual(json.loads(bak.read_text(encoding="utf-8")), {"v": 1})

    def test_no_tmp_leftover_after_success(self):
        """正常写完后不该留下 .tmp —— 留着说明 replace 没成功。"""
        from core.safe_io import atomic_write_text
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "state.json"
            atomic_write_text(p, "{}")
            leftovers = [n for n in os.listdir(td) if n.endswith(".tmp")]
            self.assertEqual(leftovers, [], f"遗留临时文件: {leftovers}")

    def test_read_json_safe_falls_back_to_bak(self):
        """主文件被截断 → 必须拿到 .bak 的内容，而不是 None/默认值。"""
        from core.safe_io import read_json_safe
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "state.json"
            p.write_text(json.dumps({"v": "good"}), encoding="utf-8")
            (Path(td) / "state.json.bak").write_text(
                json.dumps({"v": "good"}), encoding="utf-8")
            # 模拟崩溃截断：半截 JSON
            p.write_text('{"v": "goo', encoding="utf-8")
            self.assertEqual(read_json_safe(p, default=None), {"v": "good"})

    def test_corrupt_main_is_renamed_not_silently_dropped(self):
        """坏文件改名 .corrupt 留证 —— 静默丢弃会让"配置为什么没了"变成悬案。"""
        from core.safe_io import read_text_safe
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "state.json"
            p.write_bytes(b"\xff\xfe\x00bad bytes")  # 非 UTF-8
            read_text_safe(p)
            self.assertTrue((Path(td) / "state.json.corrupt").exists(),
                            "坏文件应改名 .corrupt 留证，而不是被悄悄覆盖")

    def test_read_json_safe_returns_default_when_both_gone(self):
        from core.safe_io import read_json_safe
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "nope.json"
            self.assertEqual(read_json_safe(p, default={"fallback": True}),
                             {"fallback": True})

    def test_sweep_stale_temps_only_removes_old(self):
        """只删足够旧的 tmp —— 正在写的 tmp 寿命只有毫秒级，误删会打乱并发写。"""
        from core.safe_io import sweep_stale_temps
        with tempfile.TemporaryDirectory() as td:
            old = Path(td) / "a.json.aaaaaaaa.tmp"
            old.write_text("old", encoding="utf-8")
            fresh = Path(td) / "b.json.bbbbbbbb.tmp"
            fresh.write_text("fresh", encoding="utf-8")
            now = time.time()
            os.utime(old, (now - 3600, now - 3600))
            removed = sweep_stale_temps(td)
            self.assertEqual(removed, 1)
            self.assertFalse(old.exists())
            self.assertTrue(fresh.exists(), "新 tmp 不该被删")

    def test_atomic_write_into_missing_parent(self):
        """父目录不存在时应自动创建（首次登录 / 清数据后的场景）。"""
        from core.safe_io import atomic_write_text
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "deep" / "nested" / "state.json"
            atomic_write_text(p, "{}")
            self.assertTrue(p.exists())

    def test_overwrite_never_observed_half_written(self):
        """并发/大内容写入下，读到的内容要么全旧要么全新，不能是半截。"""
        from core.safe_io import atomic_write_text
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "big.json"
            atomic_write_text(p, "A" * 200000)
            atomic_write_text(p, "B" * 200000)
            content = p.read_text(encoding="utf-8")
            self.assertEqual(len(content), 200000)
            self.assertIn(content[0], ("A", "B"))
            self.assertEqual(len(set(content)), 1, "出现了半截内容（新旧混合）")


class TestCrashRecoveryIntegration(unittest.TestCase):
    """接入点验证：真实读取路径必须从损坏中恢复。"""

    def test_load_agents_recovers_from_truncated_file(self):
        """agents.json 被截断 → 回退 .bak，而不是返回空列表让用户以为 Agent 全没了。"""
        import core.agent as A
        from core.safe_io import atomic_write_text
        with tempfile.TemporaryDirectory() as td:
            saved = A.AGENTS_PATH
            try:
                real = Path(td) / "agents.json"
                A.AGENTS_PATH = real
                good = [{"id": "a1", "name": "小明", "role": "助理",
                         "model_choice": "api:x", "max_context": 4096,
                         "max_output": 2048, "enabled_tools": [],
                         "temperature": 0.7, "personality": ""}]
                # 写两次：第一次建文件，第二次才产出 .bak（.bak 是"覆盖前留旧"，
                # 首次写入没有旧内容可留）——真实崩溃必然发生在覆盖写时。
                atomic_write_text(real, json.dumps(good, ensure_ascii=False))
                atomic_write_text(real, json.dumps(good, ensure_ascii=False))
                real.write_text('[{"id": "a1", "na', encoding="utf-8")  # 崩溃截断
                agents = A.load_agents()
                self.assertTrue(len(agents) >= 1, "应从 .bak 恢复出 Agent")
                self.assertEqual(agents[0].name, "小明")
            finally:
                A.AGENTS_PATH = saved

    def test_load_global_config_recovers_from_corrupt(self):
        import core.global_config as G
        from core.safe_io import atomic_write_text
        with tempfile.TemporaryDirectory() as td:
            saved = G._GLOBAL_CONFIG_PATH
            try:
                real = Path(td) / "global_config.json"
                G._GLOBAL_CONFIG_PATH = real
                atomic_write_text(real, json.dumps({"max_context": 8192}))
                atomic_write_text(real, json.dumps({"max_context": 8192}))
                real.write_text('{"max_context": 81', encoding="utf-8")
                cfg = G.load_global_config()
                self.assertEqual(cfg.get("max_context"), 8192,
                                 "应从 .bak 恢复全局配置，而不是退回出厂默认")
            finally:
                G._GLOBAL_CONFIG_PATH = saved


class TestEncryptionCrashRecovery(unittest.TestCase):
    """加密配置（API Key）的崩溃恢复 —— 截断 = 密钥看起来全丢。"""

    def test_decrypt_recovers_from_truncated_cipher(self):
        from core.encryption import encrypt, decrypt
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "providers.enc.json"
            encrypt({"openai": {"api_key": "sk-should-survive-crash"}}, str(p))
            encrypt({"openai": {"api_key": "sk-should-survive-crash"}}, str(p))
            good = p.read_text(encoding="utf-8")

            # 模拟崩溃现场：主文件是**未加固**的半截内容（真实崩溃时写还没走到
            # _harden_file 那一步），同目录里有上一版的 .bak。
            sim = Path(td) / "sim"
            sim.mkdir()
            crashed = sim / "providers.enc.json"
            crashed.write_text(good[: len(good) // 2], encoding="utf-8")
            (sim / "providers.enc.json.bak").write_text(good, encoding="utf-8")

            got = decrypt(str(crashed))
            self.assertIsNotNone(got, "半截密文应回退 .bak，而不是返回 None")
            self.assertEqual(got["openai"]["api_key"], "sk-should-survive-crash")

    def test_bak_is_refreshed_on_every_save(self):
        """`.bak` 必须是**上一次**的内容，不能永远是第一版（否则回退回来的是过期密钥）。"""
        from core.encryption import encrypt
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "providers.enc.json"
            encrypt({"v": 1}, str(p))
            encrypt({"v": 2}, str(p))   # 此时 .bak 应是 v1
            encrypt({"v": 3}, str(p))   # 此时 .bak 应是 v2
            bak = Path(td) / "providers.enc.json.bak"
            self.assertTrue(bak.exists(), "应保留 .bak")
            from core.encryption import decrypt
            self.assertEqual(decrypt(str(bak)), {"v": 2},
                             ".bak 应随每次保存刷新，而不是永远停在最早那一版")


if __name__ == "__main__":
    unittest.main()
