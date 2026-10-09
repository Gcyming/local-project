"""
slime 内置只读工具
- file_read: 读取文件内容
- file_list: 列出目录内容
- 默认 read 权限，无需额外声明
"""

import os
import re
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
# ── 安全清单：单一真相源 shared/security-policy.yaml（经 scripts/gen_security_policy.py 生成） ──
# 与 core-ts/src/tools/classifier.ts 同源。历史上双端各写一份导致主链路缺失引擎源码保护，
# 故改为生成物共享；此处不再手写清单。
def _load_security_policy() -> tuple[
    frozenset[str], frozenset[str], tuple[str, ...], tuple[str, ...],
    tuple[str, ...], tuple[str, ...], str, str,
]:
    """载入 shared/gen/security_policy.py。打包场景若未附带 shared/ 则回退内嵌镜像，
    镜像与源的一致性由 tests/test_security_policy.py 断言（漂移即测试失败）。

    返回值第 4 项是 A-1197 新增的「受保护目录豁免子路径」（小写 POSIX 相对路径），
    与 core-ts/src/tools/classifier.ts 同源于 shared/security-policy.yaml §④；
    第 5~8 项是 §⑤ 的归属口径（保留资产目录 / 来源标记文件名 / 标记字段 / 标记取值），
    判据本体见 core-ts/src/tools/classifier.ts 的 isProtectedSourcePath（单一真相源）。"""
    import importlib.util

    def _load(mod: object, name: str, default: tuple[str, ...]) -> tuple[str, ...]:
        try:
            return tuple(str(x).lower() for x in getattr(mod, name, default))
        except Exception:
            return default

    def _scalar(mod: object, name: str, default: str) -> str:
        try:
            v = getattr(mod, name, default)
            return str(v).strip().lower() if v else default
        except Exception:
            return default

    path = _PROJECT_ROOT / "shared" / "gen" / "security_policy.py"
    try:
        spec = importlib.util.spec_from_file_location("_slime_security_policy", path)
        if spec and spec.loader:
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return (
                frozenset(str(x).lower() for x in mod.PROTECTED_DIRS),
                frozenset(str(x).lower() for x in mod.SENSITIVE_FILENAMES),
                tuple(str(x).lower() for x in mod.WRITE_BLOCK_SUFFIXES),
                _load(mod, "PROTECTED_PATH_EXEMPTIONS", ()),
                _load(mod, "CONTRIBUTION_RESERVED_ASSETS", ()),
                _load(mod, "CONTRIBUTION_OWNER_MARKERS", ()),
                _scalar(mod, "CONTRIBUTION_OWNER_FIELD", "origin"),
                _scalar(mod, "CONTRIBUTION_OWNER_VALUE", "agent"),
            )
    except Exception:
        pass
    # 回退镜像（仅当 shared/ 不可达；内容须与 security-policy.yaml 保持一致）
    return (
        frozenset({
            "core-ts", "core", "tools", "social", "sidecar", "shared", "gateway-ts",
            "config", "configs", "scripts", "gui", "linux", "windows", "runtime",
            "skills", "tests", ".git",
        }),
        frozenset({
            ".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json",
            "slime.toml", "agents.json", "global_config.json", "history.jsonl",
            "audit.jsonl", ".git/config", "passphrase", "password", "id_rsa", "id_ed25519",
            "slime_server.py", "slime_cli.py", "slime_launcher.py", "requirements.txt",
            "qa.py", "run_tests.py", "pytest.ini",
        }),
        (".enc", ".toml", ".key", ".pem", ".p12", ".pfx"),
        ("config/skills", "config/plugins"),
        # ⚠️ 保留资产目录的回退镜像必须与 yaml §⑤ 一致 —— 由 tests/test_security_policy.py
        # 断言（改 yaml 忘了改镜像即测试失败）。此处只列内置插件名，勿手改。
        tuple(
            "config/plugins/" + n for n in (
                "subagent", "file-io", "doc-authoring", "shell-exec", "web-access",
                "user-interaction", "planning", "memory", "android-device", "http-service",
                "sidebar", "screen-control", "browser", "skill-instructions", "doc-parsing",
                "office-render", "online-search", "mind", "silam", "local-model", "sandbox",
                "terminal-shell", "social", "multi-agent", "guardrails", "encryption",
                "observability", "model-routing", "mcp-bridge", "plugin-management",
            )
        ),
        ("plugin.json", "manifest.yaml", "manifest.json", "skill.md"),
        "origin",
        "agent",
    )


(
    _WRITE_BLOCKED_DIRS,
    _WRITE_BLOCKED_NAMES,
    _WRITE_BLOCKED_SUFFIXES,
    _WRITE_DIR_EXEMPTIONS,
    _RESERVED_ASSETS,
    _OWNER_MARKERS,
    _OWNER_FIELD,
    _OWNER_VALUE,
) = _load_security_policy()


def _contribution_asset_dir(rel_posix: str) -> str | None:
    """把 `<豁免根>/<资产目录>` 这一层抠出来；不在任何豁免根下则返回 None。

    ⚠️ 只认**恰好一层**资产目录（与 TS 侧 contributionAssetDir 同口径）：
    config/plugins/demo-tool/skills/x/SKILL.md 的资产目录是 config/plugins/demo-tool，
    不是 skills/x —— 否则「改别人插件里的一个技能」会被误当成一个新资产而放行。"""
    for ex in _WRITE_DIR_EXEMPTIONS:
        if not ex:
            continue
        if rel_posix == ex:
            return ex
        prefix = ex + "/"
        if not rel_posix.startswith(prefix):
            continue
        segs = [s for s in rel_posix[len(prefix):].split("/") if s]
        return f"{ex}/{segs[0]}" if segs else ex
    return None


def _asset_declares_agent_origin(asset_dir: Path) -> bool:
    """读资产目录的来源声明：标记字段 == 标记取值 才算「agent 自己建的」。

    ⚠️ 与 TS 侧 assetDeclaresAgentOrigin **逐条同口径**（双端漂移过一次源码写入保护，
    这里必须成套改）：JSON（plugin.json / manifest.json）用正则取 "origin": "…"；
    YAML（manifest.yaml / SKILL.md）只认**顶层** origin: value（行首无缩进）。
    fail-closed：判不出来一律 False（宁可拦一次让 Agent 换写法）。"""
    for marker in _OWNER_MARKERS:
        f = asset_dir / marker
        try:
            if not f.is_file():
                continue
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if marker.endswith(".json"):
            m = re.search(r'"%s"\s*:\s*"([^"]*)"' % re.escape(_OWNER_FIELD), text, re.I)
            if m and m.group(1).strip().lower() == _OWNER_VALUE:
                return True
            continue
        for line in text.splitlines():
            m = re.match(r"^%s\s*:\s*(.+?)\s*$" % re.escape(_OWNER_FIELD), line, re.I)
            if m:
                return m.group(1).strip().strip("\"'").lower() == _OWNER_VALUE
    return False


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
        parts = [x.lower() for x in rel.parts]
        first = parts[0] if parts else ""
        if first in _WRITE_BLOCKED_DIRS:
            # A-1197：受保护目录下的「用户自助贡献目录」豁免 —— 与 TS 侧同口径。
            # 只认写全的相对目录前缀（含其下全部），父目录依旧是禁区。
            rel_posix = "/".join(parts)
            asset_rel = _contribution_asset_dir(rel_posix)
            if asset_rel is not None:
                # A-1197 收口：豁免 ≠ 整目录随便写。三条判据见 security-policy.yaml §⑤：
                #   ① 资产目录不存在 ⇒ 放行（「新建」）；② 已存在但自带 agent 来源声明 ⇒
                #   放行（「迭代自己刚建的」）；③ 命中保留资产目录 ⇒ 拦（永不放行）。
                for rv in _RESERVED_ASSETS:
                    if asset_rel == rv or asset_rel.startswith(rv + "/"):
                        return True
                if not (_PROJECT_ROOT / asset_rel).exists():
                    return False
                return not _asset_declares_agent_origin(_PROJECT_ROOT / asset_rel)
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
            from core.subproc import run_text   # A-1134：text=True 无 errors ⇒ reader 线程会崩
            r = run_text(["node", "--check", str(p)], timeout=30)
            if r.returncode == 0:
                return f"语法校验通过: {path}（JavaScript）"
            return f"[错误] JavaScript 语法错误: {(r.stderr or r.stdout or '').strip()[:300]}"
        if suffix == ".ts":
            from core.subproc import run_text   # A-1134（同上）
            r = run_text(["node", "--check", str(p)], timeout=30)
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