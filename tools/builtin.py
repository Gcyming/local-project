"""
slime 内置只读工具
- file_read: 读取文件内容
- file_list: 列出目录内容
- 默认 read 权限，无需额外声明
"""

import os
from pathlib import Path
from .registry import Tool, get_registry

# A-036: 相对路径统一锚定项目根（而非进程 cwd）——
# server 从任意目录启动时 "." 也应该指项目根，避免"路径超出项目范围"误报
_PROJECT_ROOT = Path(__file__).resolve().parent.parent


async def _file_read(args: dict) -> str:
    """读取文件内容（只读）"""
    path = args.get("path", "")
    if not path:
        return "[错误] 缺少 path 参数"
    try:
        raw = Path(path)
        # A-036: 相对路径锚定项目根
        if not raw.is_absolute():
            raw = _PROJECT_ROOT / raw
        # N11-P2-7: 拒绝符号链接，防绕过路径限制读取敏感文件
        if raw.is_symlink():
            return f"[错误] 禁止跟随符号链接: {path}"
        p = raw.resolve()
        # 路径限制：只允许项目根内
        try:
            p.relative_to(_PROJECT_ROOT)
        except ValueError:
            return f"[错误] 路径超出项目范围: {path}"
        # 屏蔽敏感文件
        blocked = {".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json"}
        if p.name in blocked or p.suffix == ".enc":
            return f"[错误] 敏感文件禁止读取: {path}"
        if not p.exists():
            return f"[错误] 文件不存在: {path}"
        if not p.is_file():
            return f"[错误] 不是文件: {path}"
        # 限制读取大小（256KB），先查文件大小防 OOM
        try:
            fsize = p.stat().st_size
        except OSError:
            fsize = 0
        max_size = 262144
        if fsize > max_size * 10:  # >2.5MB 直接拒绝
            return f"[错误] 文件过大（{fsize / 1024 / 1024:.1f}MB），拒绝读取"
        content = p.read_text(encoding="utf-8", errors="replace")
        if len(content) > max_size:
            content = content[:max_size] + "\n... [文件过长，已截断]"
        return content
    except PermissionError:
        return f"[错误] 无权限读取: {path}"
    except Exception as e:
        return f"[错误] 读取失败: {e}"


async def _file_list(args: dict) -> str:
    """列出目录内容（只读）"""
    path = args.get("path", ".")
    try:
        raw = Path(path)
        # A-036: 相对路径锚定项目根（"." = 项目根）
        if not raw.is_absolute():
            raw = _PROJECT_ROOT / raw
        if raw.is_symlink():  # N11-P2-7: 拒绝符号链接
            return f"[错误] 禁止跟随符号链接: {path}"
        p = raw.resolve()
        # 路径限制（与 file_read 对齐）
        try:
            p.relative_to(_PROJECT_ROOT)
        except ValueError:
            return f"[错误] 路径超出项目范围: {path}"
        if not p.exists():
            return f"[错误] 目录不存在: {path}"
        if not p.is_dir():
            return f"[错误] 不是目录: {path}"
        entries = []
        for entry in sorted(p.iterdir()):
            entry_type = "📁" if entry.is_dir() else "📄"
            entries.append(f"{entry_type} {entry.name}")
        return "\n".join(entries) if entries else "[空目录]"
    except PermissionError:
        return f"[错误] 无权限访问: {path}"
    except Exception as e:
        return f"[错误] 列出失败: {e}"


# A-041: 受控文件写入 —— 此前模型无任何写能力，用户要求"保存到本地"时只能
# 幻觉编造（实测：声称保存了 21KB 图片，实际文件不存在）。安全边界：
# 仅项目根内、拒绝符号链接、敏感文件屏蔽、5MB 上限、原子写入。
_MAX_WRITE_BYTES = 5 * 1024 * 1024
# A-087（漏洞清单 P1-7）：写黑名单扩展——此前仅挡 4 个敏感文件，
# slime.toml / config/agents.json / core/ 等关键文件可被 file_write 覆写
# （实测把 slime.toml 覆盖成 1 字节致配置丢失）。黑名单覆盖：
# 配置/密钥类（含大小写变体，见 _is_blocked_write_path 的 lower() 比对）
_WRITE_BLOCKED_NAMES = {
    ".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json",
    "slime.toml", "slime_server.py", "slime_cli.py", "slime_launcher.py",
    "agents.json", "global_config.json", "history.jsonl", "audit.jsonl",
    "requirements.txt", "qa.py", "run_tests.py", "pytest.ini",
}
_WRITE_BLOCKED_DIRS = ("config", "core", "tools", "social", "tests")
_WRITE_BLOCKED_SUFFIXES = (".enc", ".toml")


def _is_blocked_write_path(p: Path) -> bool:
    """A-087（漏洞清单 P1-7）：判断写入目标是否命中黑名单（大小写不敏感，
    Windows 下 AUTH_TOKEN.JSON 等变体同样拦截——P1-6）。黑名单：
    ① 敏感文件名（含大小写变体）② 关键目录（config/core/tools/social/tests）
    ③ 敏感后缀（.enc/.toml）。"""
    name = p.name.lower()
    if name in _WRITE_BLOCKED_NAMES or p.suffix.lower() in _WRITE_BLOCKED_SUFFIXES:
        return True
    try:
        rel = p.relative_to(_PROJECT_ROOT)
        first = rel.parts[0].lower() if rel.parts else ""
        if first in _WRITE_BLOCKED_DIRS:
            return True
    except ValueError:
        pass  # 项目外路径已在调用处拦截
    return False


async def _code_check(args: dict) -> str:
    """A-084: 校验代码文件语法（Python→py_compile；JS/TS→node --check）。
    只读操作（编译不执行用户代码，无副作用）。"""
    path = str(args.get("path", "")).strip()
    if not path:
        return "[错误] 缺少 path 参数"
    try:
        raw = Path(path)
        if not raw.is_absolute():
            raw = _PROJECT_ROOT / raw
        p = raw.resolve()
        try:
            p.relative_to(_PROJECT_ROOT)
        except ValueError:
            return f"[错误] 路径超出项目范围: {path}"
        if not p.is_file():
            return f"[错误] 文件不存在: {path}"
    except Exception as e:
        return f"[错误] 路径无效: {e}"
    suffix = p.suffix.lower()
    try:
        if suffix == ".py":
            import py_compile
            py_compile.compile(str(p), doraise=True)
            return f"语法校验通过: {path}（Python）"
        if suffix in (".js", ".mjs", ".cjs"):
            import subprocess
            r = subprocess.run(
                ["node", "--check", str(p)], capture_output=True, text=True, timeout=30,
            )
            if r.returncode == 0:
                return f"语法校验通过: {path}（JavaScript）"
            return f"[错误] JavaScript 语法错误: {(r.stderr or r.stdout or '').strip()[:300]}"
        if suffix == ".ts":
            import subprocess
            r = subprocess.run(
                ["node", "--check", str(p)], capture_output=True, text=True, timeout=30,
            )
            if r.returncode == 0:
                return f"语法校验通过: {path}（TypeScript 基础语法）"
            return f"[错误] TypeScript 语法错误: {(r.stderr or r.stdout or '').strip()[:300]}"
        return f"[提示] 不支持的代码类型（{suffix or '无扩展名'}），跳过语法校验"
    except py_compile.PyCompileError as e:
        return f"[错误] Python 语法错误: {str(e)[:300]}"
    except Exception as e:
        return f"[错误] 校验失败: {str(e)[:200]}"


async def _file_write(args: dict) -> str:
    """写入文本文件（仅项目根内）"""
    path = args.get("path", "")
    if not path:
        return "[错误] 缺少 path 参数"
    if "content" not in args:
        return "[错误] 缺少 content 参数"
    content = args.get("content", "")
    try:
        raw = Path(path)
        if not raw.is_absolute():
            raw = _PROJECT_ROOT / raw
        if raw.is_symlink():
            return f"[错误] 禁止写入符号链接: {path}"
        p = raw.resolve()
        try:
            p.relative_to(_PROJECT_ROOT)
        except ValueError:
            return f"[错误] 路径超出项目范围: {path}"
        if p.is_dir():
            return f"[错误] 目标已存在且是目录: {path}"
        if _is_blocked_write_path(p):
            return f"[错误] 敏感文件/目录禁止写入: {path}"
        data = str(content).encode("utf-8")
        if len(data) > _MAX_WRITE_BYTES:
            return f"[错误] 内容超过 {_MAX_WRITE_BYTES // (1024 * 1024)}MB 上限，拒绝写入"
        p.parent.mkdir(parents=True, exist_ok=True)
        import os, uuid
        tmp = p.with_suffix(p.suffix + f".{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        return f"已保存 {len(data)} 字节到 {p}"
    except PermissionError:
        return f"[错误] 无权限写入: {path}"
    except Exception as e:
        return f"[错误] 写入失败: {e}"


async def _web_fetch(args: dict) -> str:
    """抓取网页并提取正文（网络工具，SSRF 防护在 fetcher 层）"""
    url = args.get("url", "")
    if not url:
        return "[错误] 缺少 url 参数"
    try:
        max_chars = int(args.get("max_chars", 4000))
    except (TypeError, ValueError):
        max_chars = 4000
    from core.fetcher import get_fetcher
    return await get_fetcher().fetch(url, max_chars=max_chars)


async def _web_search(args: dict) -> str:
    """搜索网页（Bing 主 + 百度兜底）"""
    query = args.get("query", "")
    if not query:
        return "[错误] 缺少 query 参数"
    try:
        max_results = int(args.get("max_results", 10))
    except (TypeError, ValueError):
        max_results = 10
    from core.search import get_search_engine
    from core.fetcher import FetchError
    try:
        return await get_search_engine().search(query, max_results)
    except FetchError as e:
        return str(e)


def register_builtin_tools():
    """注册内置只读工具到全局注册表"""
    registry = get_registry()

    registry.register(Tool(
        name="file_read",
        description="读取指定文件的内容。仅支持文本文件，最大 256KB。",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要读取的文件路径",
                },
            },
            "required": ["path"],
        },
        execute_fn=_file_read,
        permissions=["read"],
    ))

    registry.register(Tool(
        name="file_list",
        description="列出指定目录下的文件和子目录。",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要列出的目录路径，默认为当前目录",
                    "default": ".",
                },
            },
            "required": [],
        },
        execute_fn=_file_list,
        permissions=["read"],
    ))

    registry.register(Tool(
        name="file_write",
        description=(
            "把文本内容写入项目内的文件（如保存生成的内容、导出报告等）。"
            "path 为项目内相对/绝对路径，父目录自动创建；内容上限 5MB。"
            "敏感文件（密钥/加密配置）禁止写入。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "目标文件路径（项目内）"},
                "content": {"type": "string", "description": "要写入的文本内容"},
            },
            "required": ["path", "content"],
        },
        execute_fn=_file_write,
        permissions=["write"],
    ))

    registry.register(Tool(
        name="code_check",
        description=(
            "A-084: 校验生成的代码文件语法是否有效（Python 用 py_compile，"
            "JS/TS 用 node --check）。写代码文件后必须调用本工具验证语法通过，"
            "再声称代码完成——防止生成不可运行的代码。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "要校验的代码文件路径（项目内）"},
            },
            "required": ["path"],
        },
        execute_fn=_code_check,
        permissions=["read"],
    ))

    registry.register(Tool(
        name="web_fetch",
        description="抓取指定网页并提取正文文本（标题+正文，自动去除脚本/导航等噪声）。仅支持 http/https 公网地址。SPA/JS 渲染站可能无法获取正文，请勿对同一站点重复尝试抓取。",
        parameters={
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "要抓取的网页 URL",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "正文最大字符数，默认 4000",
                    "default": 4000,
                },
            },
            "required": ["url"],
        },
        execute_fn=_web_fetch,
        permissions=["network"],
    ))

    registry.register(Tool(
        name="web_search",
        description="搜索网页（Bing 国内版为主，百度兜底）。返回标题+链接+摘要，最多 10 条。",
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词",
                },
                "max_results": {
                    "type": "integer",
                    "description": "最大结果数，默认 10，上限 10",
                    "default": 10,
                },
            },
            "required": ["query"],
        },
        execute_fn=_web_search,
        permissions=["network"],
    ))