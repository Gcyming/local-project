"""
slime 内容提取模块（web_fetch 后端）
- DOM → 结构化文本：标题 + 正文（截断 + JS 渲染检测 + 实体解码）
- 对应 docs/search_engine.md 六
"""

import html as _html
import json as _json
import re

from bs4 import BeautifulSoup

# JS 渲染站特征标记（对应 search_engine.md 六.6）
_JS_MARKERS = ("__INITIAL_STATE__", "__NEXT_DATA__", "__NUXT__")

# 语义标签优先级（article/main/.content 等有实文本则取之，避免误判 JS 站）
_SEMANTIC_SELECTORS = ("article", "main", ".post-content", ".article-content", ".content")

_NOISE_TAGS = ("script", "style", "nav", "footer", "header", "aside", "noscript")

_WHITESPACE_RE = re.compile(r"\s+")


def _is_js_rendered(soup: BeautifulSoup, raw_html: str, text: str) -> bool:
    """JS 渲染站检测：命中特征即返回 True，但语义标签有实文本则不误判。"""
    # 误判避免：语义标签有实际文本内容则不触发
    for sel in _SEMANTIC_SELECTORS:
        node = soup.select_one(sel)
        if node and node.get_text(strip=True):
            return False
    lower = raw_html.lower()
    for marker in _JS_MARKERS:
        if marker.lower() in lower:
            return True
    # 空壳 app/root 容器
    app = soup.select_one("#app, #root")
    if app is not None and not app.get_text(strip=True):
        return True
    # script 数量多且正文为空
    if len(soup.find_all("script")) > 20 and not text:
        return True
    return False


def _collect_js_texts(obj, depth: int = 0) -> list[str]:
    """递归遍历 JSON 值，收集字符串（B1）。跳过 URL 与过短噪声，深度上限防失控。"""
    if depth > 10:
        return []
    out: list[str] = []
    if isinstance(obj, str):
        s = obj.strip()
        if len(s) >= 4 and not s.startswith(("http://", "https://")):
            out.append(s)
    elif isinstance(obj, dict):
        for v in obj.values():
            out.extend(_collect_js_texts(v, depth + 1))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(_collect_js_texts(v, depth + 1))
    return out


def _extract_js_data(html_text: str) -> str:
    """从 JS 渲染站内嵌初始数据（__NEXT_DATA__ / __INITIAL_STATE__ / __NUXT__）提取文本（B1）。
    用原始 HTML 独立解析（主 soup 的 script 已被噪声清理移除）。失败返回空串。"""
    soup = BeautifulSoup(html_text or "", "html.parser")
    for marker in _JS_MARKERS:
        tag = soup.find("script", id=marker)
        if not tag or not tag.string:
            continue
        try:
            data = _json.loads(tag.string)
        except (ValueError, TypeError):
            continue
        texts = _collect_js_texts(data)
        seen = set()
        deduped = []
        for t in texts:
            if t not in seen:
                seen.add(t)
                deduped.append(t)
        text = _WHITESPACE_RE.sub(" ", " ".join(deduped)).strip()
        if text:
            return text
    return ""


def extract_content(html_text: str, url: str = "", max_chars: int = 4000) -> str:
    """从 HTML 提取结构化文本。返回「标题 + 正文」；JS 渲染站返回提示文案。"""
    soup = BeautifulSoup(html_text or "", "html.parser")

    # 标题：<title> 或 h1，缺失用 URL 兜底
    title = ""
    if soup.title and soup.title.get_text(strip=True):
        title = soup.title.get_text(strip=True)
    elif soup.h1 and soup.h1.get_text(strip=True):
        title = soup.h1.get_text(strip=True)
    else:
        title = url or "(无标题)"

    # 正文：语义标签优先，无则 body 兜底
    main_node = None
    for sel in _SEMANTIC_SELECTORS:
        node = soup.select_one(sel)
        if node and node.get_text(strip=True):
            main_node = node
            break
    if main_node is None:
        main_node = soup.body or soup

    # 移除噪声标签
    for tag in main_node.find_all(list(_NOISE_TAGS)):
        tag.decompose()

    text = main_node.get_text(" ", strip=True)
    text = _WHITESPACE_RE.sub(" ", text).strip()

    if _is_js_rendered(soup, html_text, text):
        # B1: JS 渲染站先尝试从内嵌初始数据提取正文，失败才提示需浏览器渲染
        js_text = _extract_js_data(html_text)
        if js_text:
            result = f"{title}\n\n{js_text}"
            if len(result) > max_chars:
                result = result[:max_chars] + "\n[内容已截断]"
            return result
        return "[该页面需浏览器渲染，无法获取内容]"

    # HTML 实体解码（get_text 不解实体，需在此统一解码）
    title = _html.unescape(title).strip()
    text = _html.unescape(text)

    result = f"{title}\n\n{text}"
    if len(result) > max_chars:
        result = result[:max_chars] + "\n[内容已截断]"
    return result
