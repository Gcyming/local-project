"""social 适配器测试（A-021：webhook 签名验证 + 速率限制；P1-19：时间戳防重放）"""

import asyncio
import hashlib
import time


def _sha1_sorted(*parts):
    return hashlib.sha1("".join(sorted(parts)).encode("utf-8")).hexdigest()


class TestWeChatVerify:
    def _adapter(self, token="secret_token"):
        from social.wechat import WeChatAdapter
        return WeChatAdapter(verify_token=token)

    def test_verify_valid_signature(self):
        a = self._adapter()
        ts, nonce = str(int(time.time())), "n0nce"
        sig = _sha1_sorted("secret_token", ts, nonce)
        ok = asyncio.run(a.verify({"signature": sig, "timestamp": ts, "nonce": nonce, "echostr": "x"}))
        assert ok is True

    def test_verify_invalid_signature(self):
        a = self._adapter()
        ts = str(int(time.time()))
        ok = asyncio.run(a.verify({"signature": "deadbeef", "timestamp": ts, "nonce": "n"}))
        assert ok is False

    def test_verify_missing_fields(self):
        a = self._adapter()
        assert asyncio.run(a.verify({})) is False
        assert asyncio.run(a.verify({"signature": "x", "timestamp": "1"})) is False

    def test_verify_no_token_configured_rejects(self):
        from social.wechat import WeChatAdapter
        a = WeChatAdapter(verify_token="")
        ok = asyncio.run(a.verify({"signature": "x", "timestamp": str(int(time.time())), "nonce": "2"}))
        assert ok is False

    def test_verify_stale_timestamp_rejected(self):
        a = self._adapter()
        ts, nonce = "1000", "n"
        sig = _sha1_sorted("secret_token", ts, nonce)
        ok = asyncio.run(a.verify({"signature": sig, "timestamp": ts, "nonce": nonce}))
        assert ok is False

    def test_verify_invalid_timestamp_rejected(self):
        a = self._adapter()
        ok = asyncio.run(a.verify({"signature": "x", "timestamp": "not-a-number", "nonce": "n"}))
        assert ok is False


class TestWeChatWorkVerify:
    def test_verify_url_mode(self):
        from social.base import WeChatWorkAdapter
        a = WeChatWorkAdapter(verify_token="tok")
        ts, nonce = str(int(time.time())), "n"
        sig = _sha1_sorted("tok", ts, nonce, "echo")
        ok = asyncio.run(a.verify({"msg_signature": sig, "timestamp": ts, "nonce": nonce, "echostr": "echo"}))
        assert ok is True

    def test_verify_message_mode(self):
        from social.base import WeChatWorkAdapter
        a = WeChatWorkAdapter(verify_token="tok")
        ts, nonce = str(int(time.time())), "n"
        sig = _sha1_sorted("tok", ts, nonce)
        ok = asyncio.run(a.verify({"msg_signature": sig, "timestamp": ts, "nonce": nonce}))
        assert ok is True

    def test_verify_wrong_signature_rejected(self):
        from social.base import WeChatWorkAdapter
        a = WeChatWorkAdapter(verify_token="tok")
        ok = asyncio.run(a.verify({"msg_signature": "bad", "timestamp": str(int(time.time())), "nonce": "2"}))
        assert ok is False

    def test_verify_stale_timestamp_rejected(self):
        from social.base import WeChatWorkAdapter
        a = WeChatWorkAdapter(verify_token="tok")
        ts, nonce = "1000", "n"
        sig = _sha1_sorted("tok", ts, nonce)
        ok = asyncio.run(a.verify({"msg_signature": sig, "timestamp": ts, "nonce": nonce}))
        assert ok is False

    def test_verify_invalid_timestamp_rejected(self):
        from social.base import WeChatWorkAdapter
        a = WeChatWorkAdapter(verify_token="tok")
        ok = asyncio.run(a.verify({"msg_signature": "x", "timestamp": "NaN", "nonce": "n"}))
        assert ok is False


class TestSocialRateLimit:
    def test_rate_limit_wechat_adapter(self):
        from social.wechat import WeChatAdapter
        a = WeChatAdapter()
        results = [a._check_rate_limit("c1") for _ in range(12)]
        assert results[:10] == [True] * 10
        assert results[10] is False
        assert results[11] is False
        assert a._check_rate_limit("c2") is True  # 其他 chat 不受影响

    def test_rate_limit_wechat_work(self):
        from social.base import WeChatWorkAdapter
        a = WeChatWorkAdapter()
        results = [a._check_rate_limit("g1") for _ in range(12)]
        assert results.count(True) == 10
        assert results[10] is False
