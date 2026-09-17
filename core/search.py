"""
slime 搜索引擎模块（web_search 后端）
- Bing 国内版为主（cn.bing.com）+ 百度兜底
- 预热 / 随机延迟 / 验证码自适应退避 / 并发限制
- 中英文验证码检测
- 对应 docs/search_engine.md 三.2 / 五
"""

import asyncio
import logging
import random
import time
from urllib.parse import urlencode, urlparse, parse_qs, unquote

from bs4 import BeautifulSoup

from core.fetcher import WebFetcher, FetchError, get_fetcher

logger = logging.getLogger(__name__)

_BING_HOME = "https://cn.bing.com/"
_BING_SEARCH = "https://cn.bing.com/search"
_BAIDU_SEARCH = "https://www.baidu.com/s"

_MAX_RESULTS = 10
_SNIPPET_MAX = 300

# 中英文验证码特征（docs/search_engine.md 三.2 第 6 步）
_CAPTCHA_KEYWORDS = (
    "安全验证", "验证码", "滑块", "人机验证",
    "verify", "captcha", "robot", "unusual traffic", "challenge",
)

# 反爬节奏（docs/search_engine.md 五）
_DELAY_MIN, _DELAY_MAX = 0.5, 1.3
_BACKOFF_MIN, _BACKOFF_MAX = 2.0, 4.0
_BACKOFF_WINDOW = 300.0  # 5 分钟退避窗口


class SearchEngine:
    """搜索引擎：Bing 主 + 百度兜底，含反爬节奏与验证码退避。"""

    def __init__(self, fetcher: WebFetcher | None = None):
        self._fetcher = fetcher or get_fetcher()
        self._sem = asyncio.Semaphore(5)
        self._prewarmed = False
        self._prewarm_lock = asyncio.Lock()
        self._captcha_until = 0.0  # 验证码退避窗口截止（time.monotonic）

    async def search(self, query: str, max_results: int = 10) -> str:
        """搜索入口。Bing 请求级失败（非验证码）才切百度。"""
        query = (query or "").strip()
        if not query:
            return "[错误] 缺少 query 参数"
        max_results = max(1, min(_MAX_RESULTS, int(max_results)))

        async with self._sem:
            await self._prewarm()
            await self._delay()
            try:
                return await self._search_bing(query, max_results)
            except FetchError:
                return await self._search_baidu(query, max_results)

    # ── 预热 / 延迟 ──────────────────────────────────────

    async def _prewarm(self):
        """进程内首次搜索前先访问 Bing 主页（降低首次被标记概率）。只调一次。"""
        if self._prewarmed:
            return
        async with self._prewarm_lock:
            if self._prewarmed:
                return
            self._prewarmed = True  # await 前设置，防并行 tool_calls 双重预热
            try:
                await self._fetcher.fetch_raw(_BING_HOME)
            except FetchError:
                pass  # 预热失败不影响搜索

    async def _delay(self):
        """随机延迟（验证码退避窗口内加长）。"""
        now = time.monotonic()
        if now < self._captcha_until:
            delay = random.uniform(_BACKOFF_MIN, _BACKOFF_MAX)
        else:
            delay = random.uniform(_DELAY_MIN, _DELAY_MAX)
        await asyncio.sleep(delay)

    def _mark_captcha(self):
        self._captcha_until = time.monotonic() + _BACKOFF_WINDOW

    # ── Bing ────────────────────────────────────────────

    async def _search_bing(self, query: str, max_results: int) -> str:
        url = f"{_BING_SEARCH}?{urlencode({'q': query})}"
        html = await self._fetcher.fetch_raw(url)  # FetchError → 由 search() 切百度
        results = self._parse_bing(html, max_results)
        if results:
            return self._format(results)
        # BUG-034: 无结果时才做验证码检测（真验证码页必然无结果，双保险）
        if self._is_captcha(html):
            self._mark_captcha()
            return self._CAPTCHA_MSG
        return "[未找到相关结果]"

    @staticmethod
    def _is_captcha(html: str) -> bool:
        # BUG-034: 只检测可见文本，脚本文件名（如 powchallengesolver 含 "challenge"）不参与
        text = BeautifulSoup(html, "html.parser").get_text(" ").lower()
        return any(k in text for k in _CAPTCHA_KEYWORDS)

    def _parse_bing(self, html: str, max_results: int) -> list:
        soup = BeautifulSoup(html, "html.parser")
        items = soup.select("li.b_algo") or soup.select(".b_algo")
        results = []
        for item in items:
            a = item.select_one("h2 a") or item.select_one("a")
            if not a or not a.get("href"):
                continue
            title = a.get_text(strip=True)
            url = self._unwrap_url(a["href"])
            if not title or not url:
                continue
            desc_node = item.select_one(".b_caption p") or item.select_one("p")
            desc = (desc_node.get_text(strip=True) if desc_node else "")[:_SNIPPET_MAX]
            results.append((title, url, desc))
            if len(results) >= max_results:
                break
        return results

    # ── 百度 ────────────────────────────────────────────

    async def _search_baidu(self, query: str, max_results: int) -> str:
        url = f"{_BAIDU_SEARCH}?{urlencode({'wd': query})}"
        html = await self._fetcher.fetch_raw(url)  # FetchError → 向上抛
        results = self._parse_baidu(html, max_results)
        if results:
            return self._format(results)
        # BUG-034: 无结果时才做验证码检测
        if self._is_captcha(html):
            self._mark_captcha()
            return self._CAPTCHA_MSG
        return "[未找到相关结果]"

    def _parse_baidu(self, html: str, max_results: int) -> list:
        soup = BeautifulSoup(html, "html.parser")
        # 多选择器 fallback（百度结构频繁变动）
        results = []
        seen = set()
        for h3 in soup.select("#content_left h3, h3.c-title, div.result h3"):
            a = h3.select_one("a") or h3
            if not a.get("href"):
                continue
            title = a.get_text(strip=True)
            url = a["href"]
            if not title or not url or url in seen:
                continue
            seen.add(url)
            # 百度跳转链接一般保留真实 url，无需解包
            desc = ""
            parent = h3.find_parent("div") or h3.find_parent("li")
            if parent is not None:
                desc_node = parent.select_one(".c-abstract") or parent.select_one("span")
                desc = (desc_node.get_text(strip=True) if desc_node else "")[:_SNIPPET_MAX]
            results.append((title, url, desc))
            if len(results) >= max_results:
                break
        return results

    # ── 工具函数 ────────────────────────────────────────

    @staticmethod
    def _unwrap_url(href: str) -> str:
        """去掉 Bing 的 /url?q= 跳转包装。"""
        if href.startswith("/url?") or ("bing.com" in href and "/url?" in href):
            parsed = urlparse(href)
            q = parse_qs(parsed.query).get("q", [""])[0]
            if q:
                return unquote(q)
        return href

    @staticmethod
    def _format(results: list[tuple[str, str, str]]) -> str:
        lines = []
        for i, (title, url, desc) in enumerate(results, 1):
            if desc:
                lines.append(f"{i}. {title}\n   {url}\n   {desc}")
            else:
                lines.append(f"{i}. {title}\n   {url}")
        return "\n\n".join(lines)

    _CAPTCHA_MSG = "[搜索引擎要求人机验证。请稍等 1 分钟后重试，或更换网络环境后再搜索。]"


# 模块级单例（连接池 + 预热/退避状态复用）
_search_engine: SearchEngine | None = None


def get_search_engine() -> SearchEngine:
    global _search_engine
    if _search_engine is None:
        _search_engine = SearchEngine()
    return _search_engine
