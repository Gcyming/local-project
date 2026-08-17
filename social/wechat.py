"""
slime 个人微信适配器
- 基于 WeChatWorkAdapter 模式扩展
- 支持文本/图片消息收发
- webhook 签名校验
- 绑定 Agent，接收→call_llm→发送
"""

import hashlib
import logging
import time
from typing import Optional

from social.base import SocialAdapter, WeChatWorkAdapter

# P1-19: 签名时间戳新鲜度窗口（5 分钟），超窗拒绝防重放
_TS_FRESHNESS_WINDOW = 300


class WeChatAdapter(SocialAdapter):
    """个人微信适配器（通过第三方桥接服务接入）"""

    # N10-H1: 速率限制 — 每 chat_id 每窗口最多 N 条消息
    _RATE_LIMIT_WINDOW = 60       # 窗口 60s
    _RATE_LIMIT_MAX = 10          # 每窗口最多 10 条

    def _check_rate_limit(self, chat_id: str) -> bool:
        """检查 chat_id 是否超过速率限制。返回 True=允许，False=拒绝。N11-P1-8: 清理过期 entry。"""
        now = time.time()
        # 清理过期 entry，防内存泄漏
        for cid in [c for c, (t, _) in self._rate_buckets.items()
                    if now - t > self._RATE_LIMIT_WINDOW]:
            del self._rate_buckets[cid]
        entry = self._rate_buckets.get(chat_id)
        if not entry:
            self._rate_buckets[chat_id] = (now, 1)
            return True
        window_start, count = entry
        if count >= self._RATE_LIMIT_MAX:
            logging.warning(f"[social/wechat] chat_id={chat_id} 速率限制触发（{count}/{self._RATE_LIMIT_WINDOW}s）")
            return False
        self._rate_buckets[chat_id] = (window_start, count + 1)
        return True

    def __init__(
        self,
        bridge_url: str = "",
        bridge_token: str = "",
        verify_token: str = "",
        agent=None,
        providers: dict | None = None,
        agent_registry: list | None = None,
    ):
        """
        参数:
        - bridge_url: 微信桥接服务地址（如 wechaty / wechat-bot 的 HTTP 接口）
        - bridge_token: 桥接服务的认证 token
        - verify_token: webhook 回调配置的 Token（用于签名校验）
        - agent: 绑定的 Agent 实例
        - providers: Provider 配置
        - agent_registry: Agent 注册表
        """
        self.bridge_url = bridge_url.rstrip("/")
        self.bridge_token = bridge_token
        self.verify_token = verify_token
        self.agent = agent
        self.providers = providers or {}
        self.agent_registry = agent_registry or []
        # N11-P1-8: 实例变量，避免多实例共享 + 永不清理
        self._rate_buckets: dict[str, tuple[float, int]] = {}

    async def receive(self, message: dict) -> str:
        """
        接收微信消息 → 调用 Agent LLM → 返回回复文本。

        message 格式:
        {
            "chat_id": "联系人/群聊 ID",
            "user_id": "发送者 ID",
            "user_name": "发送者昵称",
            "content": "消息文本",
            "msg_type": "text" | "image",
            "is_group": bool,
        }
        """
        content = message.get("content", "")
        msg_type = message.get("msg_type", "text")
        chat_id = message.get("chat_id", "")

        # N10-H1: 速率限制
        if chat_id and not self._check_rate_limit(chat_id):
            return "[消息过于频繁，请稍候再试]"

        if msg_type == "image":
            return "[我暂时无法识别图片，请发送文字消息]"

        if not content or not self.agent:
            return ""

        try:
            from core.llm import call_llm

            # 群聊消息加上发送者上下文
            if message.get("is_group"):
                user_name = message.get("user_name", "群成员")
                content = f"[{user_name}]: {content}"

            reply = await call_llm(
                self.agent,
                content,
                history=None,
                providers=self.providers,
                agent_registry=self.agent_registry,
            )

            # 输出过滤
            from core.filter import get_filter
            try:
                f = get_filter()
                result = f.filter(reply, agent_name=self.agent.name)
                reply = result.filtered
            except Exception:
                pass

            return reply
        except Exception as e:
            logging.error(f"[social/wechat] Agent 回复失败: {e}")
            return f"[回复失败]"

    async def send(self, chat_id: str, text: str) -> bool:
        """通过桥接服务发送消息到微信"""
        if not self.bridge_url:
            logging.warning("[social/wechat] bridge_url 未配置")
            return False

        try:
            import httpx

            headers = {"Authorization": f"Bearer {self.bridge_token}"}
            payload = {
                "chat_id": chat_id,
                "msg_type": "text",
                "content": text,
            }

            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{self.bridge_url}/send",
                    json=payload,
                    headers=headers,
                )

                if resp.status_code == 200:
                    data = resp.json()
                    return data.get("success", False)
                else:
                    logging.warning(f"[social/wechat] 发送失败: HTTP {resp.status_code}")
                return False
        except Exception as e:
            logging.error(f"[social/wechat] 发送失败: {e}")
            return False

    async def send_image(self, chat_id: str, image_url: str) -> bool:
        """发送图片消息"""
        if not self.bridge_url:
            return False

        try:
            import httpx

            headers = {"Authorization": f"Bearer {self.bridge_token}"}
            payload = {
                "chat_id": chat_id,
                "msg_type": "image",
                "content": image_url,
            }

            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{self.bridge_url}/send",
                    json=payload,
                    headers=headers,
                )
                return resp.status_code == 200
        except Exception as e:
            logging.error(f"[social/wechat] 图片发送失败: {e}")
            return False

    async def verify(self, params: dict) -> bool:
        """
        微信 webhook 签名校验。
        params: {"signature": str, "timestamp": str, "nonce": str, "echostr": str}

        校验方式：sha1(sort([token, timestamp, nonce])) == signature
        """
        signature = params.get("signature", "")
        timestamp = params.get("timestamp", "")
        nonce = params.get("nonce", "")
        echostr = params.get("echostr", "")

        if not all([signature, timestamp, nonce]):
            return False

        # P1-19: 时间戳新鲜度窗口（5 分钟），防签名重放
        try:
            ts = int(timestamp)
        except (TypeError, ValueError):
            logging.warning("[social/wechat] 签名时间戳非法，拒绝")
            return False
        if abs(time.time() - ts) > _TS_FRESHNESS_WINDOW:
            logging.warning(f"[social/wechat] 签名时间戳超窗（{abs(time.time() - ts):.0f}s > {_TS_FRESHNESS_WINDOW}s），拒绝（防重放）")
            return False

        if not self.verify_token:
            logging.warning("[social/wechat] verify_token 未配置，拒绝验证请求")
            return False

        sort_list = sorted([self.verify_token, timestamp, nonce])
        digest = hashlib.sha1("".join(sort_list).encode("utf-8")).hexdigest()
        # A-021: 恒定时间比较，防签名时序侧信道
        import hmac
        return hmac.compare_digest(digest, signature)

    async def handle_webhook(self, body: dict) -> dict:
        """
        处理 webhook 回调（接收消息 + 自动回复）。

        body: 桥接服务 POST 的 JSON body

        返回: {"reply": str, "chat_id": str} 或 {"ok": True}
        """
        try:
            msg_type = body.get("msg_type", "text")
            chat_id = body.get("chat_id", "")
            content = body.get("content", "")
            user_id = body.get("user_id", "")
            user_name = body.get("user_name", "")
            is_group = body.get("is_group", False)

            if not content:
                return {"ok": True, "message": "空消息，已忽略"}

            message = {
                "chat_id": chat_id,
                "user_id": user_id,
                "user_name": user_name,
                "content": content,
                "msg_type": msg_type,
                "is_group": is_group,
            }

            reply = await self.receive(message)

            if reply and chat_id:
                await self.send(chat_id, reply)
                return {"reply": reply, "chat_id": chat_id}

            return {"ok": True, "message": "无回复内容"}
        except Exception as e:
            logging.error(f"[social/wechat] webhook 处理失败: {e}")
            return {"ok": False, "error": str(e)}


# ── 便捷工厂函数 ────────────────────────────────────────────

def create_wechat_adapter(config: dict, agent=None, providers: dict = None, agent_registry: list = None) -> WeChatAdapter:
    """
    从配置字典创建微信适配器。

    config:
    {
        "platform": "wechat" | "wechat_work",
        "bridge_url": "...",
        "bridge_token": "...",
        "webhook_url": "...",
        "corp_id": "...",
        "corp_secret": "...",
        "verify_token": "...",
    }
    """
    platform = config.get("platform", "wechat")

    if platform == "wechat_work":
        return WeChatWorkAdapter(
            webhook_url=config.get("webhook_url", ""),
            corp_id=config.get("corp_id", ""),
            corp_secret=config.get("corp_secret", ""),
            verify_token=config.get("verify_token", ""),
            agent=agent,
            providers=providers,
            agent_registry=agent_registry,
        )

    return WeChatAdapter(
        bridge_url=config.get("bridge_url", ""),
        bridge_token=config.get("bridge_token", ""),
        verify_token=config.get("verify_token", ""),
        agent=agent,
        providers=providers,
        agent_registry=agent_registry,
    )
