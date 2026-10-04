"""
slime 网页抓取模块（web_fetch 后端）
- WebFetcher：httpx client + SSRF 全校验 + IP 钉扎连接（防 DNS Rebinding）
  + 反爬头 + 手动重定向链 + 2MB 流式累计中断 + 编码启发式
- 对应 docs/search_engine.md 三.1 / 四 / 五

安全铁律（docs/search_engine.md 四）：
1. 只认解析后的标准 IP，hostname 用 getaddrinfo 全解析（A+AAAA），任一内网即拒
2. ipaddress 解析 try/except 兜底，不可解析一律拒绝
3. 重定向逐跳重验（协议白名单 → DNS+ipaddress → IP 钉扎）
4. IP 钉扎连接（P0）：校验通过的 IP 直接作为 httpx 连接目标，禁止二次 DNS 解析
"""

import asyncio
import ipaddress
import logging
import socket
from urllib.parse import urlparse, urlunsplit, urljoin

import httpx

logger = logging.getLogger(__name__)

_MAX_BYTES = 2 * 1024 * 1024          
_MAX_REDIRECTS = 5
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_CONN_LIMITS = httpx.Limits(max_connections=10, max_keepalive_connections=5)

_MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)


_PRIVATE_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("::ffff:0:0/96"),
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("2001:db8::/32"),
]


_TEXT_HINTS = ("text/", "html", "xml", "json")


class FetchError(Exception):
    """抓取错误（消息已转为用户友好中文文案）。"""


def _is_private_ip(ip_str: str) -> bool:
    """判断解析后的 IP 是否内网/保留段。不可解析一律按内网拒绝（嫌疑更大）。"""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    return any(ip in net for net in _PRIVATE_NETWORKS)


def _resolve_and_validate(hostname: str) -> str:
    """全解析（A+AAAA）→ 逐个 ipaddress 校验，任一内网即拒。
    A-030: 校验后优先 IPv4 作为钉扎 IP —— 部分环境有 AAAA 解析但无 IPv6 路由，
    取首个 IP（常为 IPv6）会导致连接失败（实测 example.com IPv6 在前）。"""
    try:
        infos = socket.getaddrinfo(hostname, None, 0, socket.SOCK_STREAM)
    except socket.gaierror:
        raise FetchError("[错误] 无法解析域名") from None
    ips = []
    for info in infos:
        ip = info[4][0]
        if _is_private_ip(ip):
            raise FetchError("[错误] 目标地址被 SSRF 防护拦截") from None
        ips.append(ip)
    if not ips:
        raise FetchError("[错误] 无法解析域名") from None
    
    v4_ips = [ip for ip in ips if ":" not in ip]
    return (v4_ips or ips)[0]


class WebFetcher:
    """httpx 抓取器：SSRF 防护 + IP 钉扎 + 重定向链 + 2MB 截断 + 编码启发式。"""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=_TIMEOUT,
            follow_redirects=False,
            limits=_CONN_LIMITS,
        )

    async def close(self):
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    

    def _pin(self, url: str) -> tuple[str, str, str]:
        """协议白名单 + SSRF 校验 + IP 钉扎。返回 (pinned_url, host_header, sni_hostname)。"""
        parsed = urlparse(url)
        scheme = parsed.scheme.lower()
        if scheme not in ("http", "https"):
            raise FetchError("[错误] 仅支持 http/https 协议")
        
        hostname = parsed.hostname
        if not hostname:
            raise FetchError("[错误] 无效的 URL")

        ip = _resolve_and_validate(hostname)

        
        try:
            port = parsed.port
        except ValueError:
            raise FetchError("[错误] 无效的端口") from None

        ip_netloc = f"[{ip}]" if ":" in ip else ip
        if port is not None:
            ip_netloc = f"{ip_netloc}:{port}"
        pinned_url = urlunsplit((scheme, ip_netloc, parsed.path or "/", parsed.query, ""))
        host_header = hostname if port is None else f"{hostname}:{port}"
        return pinned_url, host_header, hostname

    

    async def fetch_raw(self, url: str) -> str:
        """抓取并解码为文本（含 SSRF/重定向/2MB 截断/编码启发式）。返回原始 HTML 文本。"""
        current = url
        for _hop in range(_MAX_REDIRECTS + 1):
            
            
            pinned_url, host_header, sni_host = await asyncio.to_thread(self._pin, current)

            headers = {
                "User-Agent": _MOBILE_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Referer": f"{urlparse(pinned_url).scheme}://{host_header}",
                "Host": host_header,
            }
            
            extensions = {"sni_hostname": sni_host} if pinned_url.startswith("https://") else None

            try:
                resp = await self._client.get(pinned_url, headers=headers, extensions=extensions)
            except httpx.HTTPError as e:
                
                detail = str(e) or type(e).__name__
                raise FetchError(f"[错误] 请求失败: {detail}") from None

            status = resp.status_code
            if 300 <= status < 400:
                location = resp.headers.get("location", "")
                await resp.aclose()
                if not location:
                    raise FetchError("[错误] 重定向缺少 Location")
                current = urljoin(current, location)  
                continue
            if status >= 400:
                await resp.aclose()
                raise FetchError(f"[错误] 请求失败，状态码 {status}")

            return await self._read_response(resp)

        raise FetchError("[错误] 重定向次数超过限制")

    async def _read_response(self, resp: httpx.Response) -> str:
        """读取响应：非文本 Content-Type 拦截 + 2MB 流式累计中断 + 解码。"""
        ctype = (resp.headers.get("content-type") or "").lower()
        if ctype and not (ctype.startswith("text/") or any(h in ctype for h in _TEXT_HINTS)):
            await resp.aclose()
            raise FetchError(f"[该 URL 返回非文本内容（{ctype}），无法提取]")

        data = b""
        async for chunk in resp.aiter_bytes():
            data += chunk
            if len(data) >= _MAX_BYTES:
                await resp.aclose()  
                break
        return self._decode(data, resp.headers)

    @staticmethod
    def _decode(data: bytes, headers) -> str:
        """编码启发式：响应头 charset → utf-8 strict → gb18030（errors=replace 兜底）。"""
        ctype = (headers.get("content-type") or "").lower()
        charset = ""
        if "charset=" in ctype:
            charset = ctype.split("charset=", 1)[1].strip()
            charset = charset.strip('"').strip("'").split(";")[0].strip()
        if charset:
            try:
                return data.decode(charset, errors="strict")
            except (LookupError, UnicodeDecodeError):
                pass
        try:
            return data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return data.decode("gb18030", errors="replace")

    

    async def fetch(self, url: str, max_chars: int = 4000) -> str:
        """抓取并提取为结构化文本（web_fetch 工具入口）。FetchError → 返回文案。"""
        try:
            html = await self.fetch_raw(url)
        except FetchError as e:
            return str(e)
        from core.extractor import extract_content
        return extract_content(html, url=url, max_chars=max_chars)



_fetcher: WebFetcher | None = None


def get_fetcher() -> WebFetcher:
    global _fetcher
    if _fetcher is None:
        _fetcher = WebFetcher()
    return _fetcher
