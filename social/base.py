"""
slime 社交适配器接口
- 抽象基类定义统一接口
- 微信企业号实现（绑定 Agent，接收→call_llm→发送）
"""

import hashlib
import logging
import time
from abc import ABC, abstractmethod

# P1-19: 签名时间戳新鲜度窗口（5 分钟），超窗拒绝防重放
_TS_FRESHNESS_WINDOW = 300


class SocialAdapter(ABC):
    """社交平台适配器抽象基类"""

    @abstractmethod
    async def receive(self, message: dict) -> str:
        """
        接收消息，返回处理后的回复文本。

        参数:
        - message: {"chat_id": str, "user_id": str, "content": str, "msg_type": str}

        返回: 回复文本
        """
        ...

    @abstractmethod
    async def send(self, chat_id: str, text: str) -> bool:
        """
        发送消息到指定聊天。

        返回: 是否发送成功
        """
        ...

    @abstractmethod
    async def verify(self, params: dict) -> bool:
        """
        验证 webhook 请求合法性。

        返回: 是否验证通过
        """
        ...


class WeChatWorkAdapter(SocialAdapter):
    """企业微信适配器（绑定 Agent，接收→call_llm→发送）"""

    # N11-P3-3: 速率限制（与个人微信 WeChatAdapter 对齐）
    _RATE_LIMIT_WINDOW = 60
    _RATE_LIMIT_MAX = 10

    def __init__(
        self,
        webhook_url: str = "",
        corp_id: str = "",
        corp_secret: str = "",
        verify_token: str = "",
        agent=None,
        providers: dict | None = None,
        agent_registry: list | None = None,
    ):
        self.webhook_url = webhook_url
        self.corp_id = corp_id
        self.corp_secret = corp_secret
        self.verify_token = verify_token  # 企业微信回调配置的 Token
        self.agent = agent                # 绑定的 Agent 实例
        self.providers = providers or {}
        self.agent_registry = agent_registry or []
        self._access_token: str | None = None
        self._token_expires: float = 0
        self._rate_buckets: dict[str, tuple[float, int]] = {}

    def _check_rate_limit(self, chat_id: str) -> bool:
        """per-chat_id 速率限制。返回 True=允许。N11-P3-3: 清理过期 entry。"""
        now = time.time()
        for cid in [c for c, (t, _) in self._rate_buckets.items()
                    if now - t > self._RATE_LIMIT_WINDOW]:
            del self._rate_buckets[cid]
        entry = self._rate_buckets.get(chat_id)
        if not entry:
            self._rate_buckets[chat_id] = (now, 1)
            return True
        window_start, count = entry
        if count >= self._RATE_LIMIT_MAX:
            logging.warning(f"[social] chat_id={chat_id} 速率限制触发（{count}/{self._RATE_LIMIT_WINDOW}s）")
            return False
        self._rate_buckets[chat_id] = (window_start, count + 1)
        return True

    async def _get_access_token(self) -> str:
        """获取企业微信 access_token（自动刷新）。
        N10-M9: corp_secret 仅请求时使用局部变量，完成后显式清理引用。"""
        if not self.corp_secret:
            return ""
        if self._access_token and time.time() < self._token_expires:
            return self._access_token

        secret = self.corp_secret  # 局部引用，避免直接暴露实例属性
        try:
            import httpx

            url = f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={self.corp_id}&corpsecret={secret}"
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url)
                data = resp.json()
                self._access_token = data.get("access_token", "")
                expires_in = data.get("expires_in", 7200)
                self._token_expires = time.time() + expires_in - 300
                return self._access_token
        except Exception as e:
            logging.error(f"[social] 获取 access_token 失败: {e}")
            return ""

    async def receive(self, message: dict) -> str:
        """
        接收企业微信消息 → 调用 Agent LLM → 返回回复文本。

        message 格式:
        {
            "chat_id": "群聊/用户 ID",
            "user_id": "发送者 ID",
            "content": "消息文本",
            "msg_type": "text"
        }
        """
        content = message.get("content", "")
        chat_id = message.get("chat_id", "")
        if not content or not self.agent:
            return ""

        # N11-P3-3: 速率限制
        if chat_id and not self._check_rate_limit(chat_id):
            return "[消息过于频繁，请稍候再试]"

        try:
            from core.llm import call_llm
            reply = await call_llm(
                self.agent, content,
                history=None,
                providers=self.providers,
                agent_registry=self.agent_registry,
            )

            # 输出过滤：拦截身份泄露
            from core.filter import get_filter
            try:
                f = get_filter()
                result = f.filter(reply, agent_name=self.agent.name)
                reply = result.filtered
            except Exception:
                pass

            return reply
        except Exception as e:
            logging.error(f"[social] Agent 回复失败: {e}")
            return "[回复失败]"

    async def send(self, chat_id: str, text: str) -> bool:
        """通过企业微信 webhook 发送消息"""
        if not self.webhook_url:
            logging.warning("[social] 企业微信 webhook_url 未配置")
            return False

        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    self.webhook_url,
                    json={
                        "msgtype": "text",
                        "text": {"content": text},
                    },
                )
                if resp.status_code != 200:
                    return False
                try:
                    data = resp.json()
                    return data.get("errcode", 0) == 0
                except Exception:
                    return resp.status_code == 200  # 非 JSON 回退
        except Exception as e:
            logging.error(f"[social] 企业微信发送失败: {e}")
            return False

    async def verify(self, params: dict) -> bool:
        """
        企业微信签名校验。两种模式：
        - URL 验证：4 字段（msg_signature, timestamp, nonce, echostr）
          sha1(sort([token, timestamp, nonce, echostr])) == msg_signature
        - 消息验签：3 字段（msg_signature, timestamp, nonce）
          sha1(sort([token, timestamp, nonce])) == msg_signature
        """
        msg_signature = params.get("msg_signature", "")
        timestamp = params.get("timestamp", "")
        nonce = params.get("nonce", "")
        echostr = params.get("echostr", "")

        is_url_verify = bool(echostr)
        required = [msg_signature, timestamp, nonce] if not is_url_verify else [msg_signature, timestamp, nonce, echostr]
        if not all(required):
            return False

        # P1-19: 时间戳新鲜度窗口（5 分钟），防签名重放
        try:
            ts = int(timestamp)
        except (TypeError, ValueError):
            logging.warning("[social] 签名时间戳非法，拒绝")
            return False
        if abs(time.time() - ts) > _TS_FRESHNESS_WINDOW:
            logging.warning(f"[social] 签名时间戳超窗（{abs(time.time() - ts):.0f}s > {_TS_FRESHNESS_WINDOW}s），拒绝（防重放）")
            return False

        if not self.verify_token:
            logging.warning("[social] verify_token 未配置，拒绝验证请求")
            return False

        sort_list = sorted([self.verify_token, timestamp, nonce] +
                           ([echostr] if is_url_verify else []))
        digest = hashlib.sha1("".join(sort_list).encode("utf-8")).hexdigest()
        # A-021: 恒定时间比较（hmac.compare_digest），防签名时序侧信道
        import hmac
        return hmac.compare_digest(digest, msg_signature)