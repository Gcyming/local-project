"""
slime CLI 交互终端
- wizard：首次启动向导
- interactive：交互对话
- status：查看 Agent 状态
- providers：管理 Provider
"""

import sys
import os
import re
import json
import math
import time

# ANSI 转义序列清理（覆盖 CSI/OSC 序列，ESC 字节走 Python 转义防格式化工具破坏）
_ANSI_ESC_RE = re.compile('\x1b' + r'(\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(\x07|\x1b\\)?)')


def _clean_ansi(text: str) -> str:
    """A-009: 统一 ANSI 转义清理（终端注入防御）。SSE 所有内容渲染前必过此函数，
    修复此前仅 chunk 路径清理、reasoning/tool 路径未清理的不对称漏洞。"""
    if not text:
        return ""
    return _ANSI_ESC_RE.sub("", str(text))


def _format_tool_event(name: str, args, result) -> tuple[str, str]:
    """A-009: 工具事件展示格式化（ANSI 清理 + 参数/结果截断），返回 (调用行, 结果行)。
    修复此前 args 不截断刷屏（web_search 长参数）问题。"""
    name = _clean_ansi(name or "unknown")
    args_text = _clean_ansi(args if isinstance(args, str) else str(args or ""))
    if len(args_text) > 300:
        args_text = args_text[:300] + "... [参数过长已截断]"
    result_text = _clean_ansi(result if isinstance(result, str) else str(result or ""))
    if len(result_text) > 200:
        result_text = result_text[:200] + "..."
    call_line = f"  🔧 {name}({args_text})"
    result_line = f"     → {result_text}" if result_text else ""
    return call_line, result_line


def _flush_thinking_panel(thinking_parts: list, rendered: bool) -> bool:
    """A-009: 冲刷未渲染的思考缓冲。正常结束与异常路径共用，
    修复此前异常路径（断连/API 错误/Ctrl+C）丢失思考内容的缺陷。"""
    if thinking_parts and not rendered:
        _render_reasoning_panel("".join(thinking_parts))
        return True
    return rendered

import shutil
import textwrap
import platform
import logging
import difflib
from pathlib import Path
from datetime import datetime
from typing import Any, Optional

import click
import httpx
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.syntax import Syntax
from rich import box
from rich.text import Text

# A-108: rich.markdown / prompt_toolkit 重量级导入延迟到运行时（CLI 启动提速）
# A-110: 检索层（补全/幽灵建议/键绑定）所需轻量模块保持模块级导入（不触发 application 链）
from prompt_toolkit.auto_suggest import AutoSuggest, AutoSuggestFromHistory, Suggestion
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.key_binding import KeyBindings
from rich.prompt import Prompt
from html import escape
from rich.markup import escape as _rme  # 转义用户输入防 MarkupError

console = Console()

# A-108: rich.markdown 延迟导入 helper（CLI 启动提速，Markdown 仅在渲染回复时使用）
def _md(text: str):
    """延迟导入 Markdown 渲染（避免模块级加载 markdown_it 链，省 ~200ms 启动时间）"""
    from rich.markdown import Markdown
    return Markdown(text)

# ─ 启用 Windows ANSI 支持 ───────────────────────────────
if os.name == "nt":
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        # 获取 stdout 句柄并启用虚拟终端处理
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_ulong()
        kernel32.GetConsoleMode(handle, ctypes.byref(mode))
        kernel32.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass

# ─ 安全 Prompt 封装(Ctrl+C 回退而非退出)──────────────────

class PromptCancelled(Exception):
    """ask() 被 Ctrl+C 取消——冒泡至分发层统一捕获"""

def safe_ask(prompt_text: str, default="", choices=None, password=False):
    """
    wizard/swarm 用：Ctrl+C 时返回 None。
    调用方必须检查 None 并 return 回退上一步。
    """
    _p = Prompt.ask  # ponytail: 本地引用绕过类名替换
    try:
        if choices is not None:
            return _p(prompt_text, default=default, choices=choices, password=password)
        return _p(prompt_text, default=default, password=password)
    except KeyboardInterrupt:
        return None

def ask(prompt_text: str, default="", choices=None, password=False):
    """
    通用：Ctrl+C 时抛出 PromptCancelled，由分发层 / CLI 入口统一捕获。
    无需调用方判空。
    """
    _p = Prompt.ask
    try:
        if choices is not None:
            return _p(prompt_text, default=default, choices=choices, password=password)
        return _p(prompt_text, default=default, password=password)
    except KeyboardInterrupt:
        console.print()
        raise PromptCancelled() from None

# 端口支持 SLIME_PORT 环境变量
try:
    SLIME_PORT = int(os.environ.get("SLIME_PORT", "19000"))
except (ValueError, TypeError):
    SLIME_PORT = 19000
API_BASE = f"http://127.0.0.1:{SLIME_PORT}"

from core.llm import MAX_OUTPUT_LIMIT, MAX_CONTEXT_LIMIT

# 认证令牌（优先读取加密格式，兼容旧版明文）
_AUTH_TOKEN_ENC_PATH = Path(__file__).parent / "config" / "auth_token.enc"
_AUTH_TOKEN_PATH = Path(__file__).parent / "config" / "auth_token.json"
_AUTH_TOKEN: str = ""


def _load_auth_token() -> str:
    """读取认证令牌（优先加密格式，兼容旧版明文）"""
    global _AUTH_TOKEN
    if _AUTH_TOKEN:
        return _AUTH_TOKEN

    # 优先读取加密格式
    if _AUTH_TOKEN_ENC_PATH.exists():
        try:
            from core.encryption import decrypt_raw
            token = decrypt_raw(str(_AUTH_TOKEN_ENC_PATH))
            if token:
                _AUTH_TOKEN = token
                return _AUTH_TOKEN
        except Exception:
            pass

    # 兼容旧版明文格式
    if _AUTH_TOKEN_PATH.exists():
        try:
            _AUTH_TOKEN = json.loads(_AUTH_TOKEN_PATH.read_text(encoding="utf-8"))["token"]
        except (json.JSONDecodeError, KeyError, OSError, TypeError):
            pass
    return _AUTH_TOKEN


def _auth_headers() -> dict:
    """获取认证请求头"""
    token = _load_auth_token()
    if token:
        return {"Authorization": f"Bearer {token}"}
    return {}


# ─ 工具函数 ──────────────────────────────────────────────

def _api(method: str, path: str, **kwargs) -> dict | list:
    """调用 slime API（自动携带认证令牌）"""
    headers = _auth_headers()
    if "headers" in kwargs:
        headers.update(kwargs.pop("headers"))
    try:
        resp = httpx.request(method, f"{API_BASE}{path}", timeout=30.0, headers=headers, **kwargs)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        console.print("[red]错误：无法连接到 slime 服务。请先启动 slime_server.py[/]")
        sys.exit(1)
    except httpx.HTTPStatusError as e:
        # N11-P2-13: 不打印完整响应体（可能含堆栈/内部路径），只显示 status_code + detail
        detail = ""
        try:
            data = e.response.json()
            if isinstance(data, dict):
                detail = data.get("detail", "")
        except Exception:
            pass
        if detail:
            console.print(f"[red]API 错误 ({e.response.status_code}): {detail}[/]")
        else:
            console.print(f"[red]API 错误 ({e.response.status_code})[/]")
        # A-071: 401 时提示端口被其他程序占用的可能（launcher 假就绪场景）
        if e.response.status_code == 401:
            console.print(
                "[yellow]提示：若 19000 端口被其他程序占用（重启后自启程序常见），"
                "slime 可能连到了非 slime 服务。请用 SLIME_PORT 换端口重试，"
                "或先结束占用进程。[/]"
            )
        sys.exit(1)
    except httpx.TimeoutException:
        console.print("[red]错误：请求超时，请检查网络连接[/]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]API 错误: {e}[/]")
        sys.exit(1)


def _check_server():
    """检查服务是否运行"""
    try:
        resp = httpx.get(f"{API_BASE}/health", timeout=3.0)
        return resp.status_code == 200
    except Exception:
        return False


# ── A-044: 幻觉护栏（结构级反幻觉） ─────────────────────────
# 提示词约束只能"劝"，护栏才能"拦"：模型回复若声称"已保存/已生成"某文件，
# 客户端自动核验该路径真实存在；不存在 → 红字警告请勿采信。
# A-047: 核验逻辑抽到 core/claims.py（CLI 警告级 + Merger 硬信号级共用），
# 此处 re-export 保持既有函数名与调用点不变。

from core.claims import _CLAIM_VERBS, find_unverified_claims as _find_unverified_claims


def _verify_claimed_files(reply: str) -> bool:
    """幻觉护栏：警告回复中引用但实际不存在的文件。返回是否触发。"""
    claims = _find_unverified_claims(reply)
    if not claims:
        return False
    console.print()
    console.print("[bold red]⚠ 幻觉护栏：回复引用了不存在的文件，请勿采信：[/]")
    for c in claims[:5]:
        console.print(f"  [red]✗ {_rme(c)}[/]")
    console.print("[dim]请要求模型用 file_list 核实文件真实存在后再采信。[/]")
    return True


def _report_swarm(agent_id: str, task: str, summary: str, snapshots: list):
    """A-031: Swarm 完成后向 server 上报经验沉淀（记忆/演化/行为）。
    best-effort：失败只打 dim 提示，绝不影响 Swarm 主流程。"""
    try:
        _api("POST", f"/agents/{agent_id}/swarm/report", json={
            "task": task,
            "summary": summary,
            "results": [
                {"name": s.get("name", ""), "state": s.get("state", ""),
                 "result": s.get("result", ""), "error": s.get("error", "")}
                for s in (snapshots or [])
            ],
        })
        console.print("[dim]√ 已沉淀本次 Swarm 经验[/]")
    except SystemExit:
        pass
    except Exception:
        pass


def _fetch_models(api_base: str, api_key: str) -> list[str]:
    """从 OpenAI 兼容接口拉取可用模型列表"""
    base = api_base.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    base = base.rstrip("/")
    try:
        resp = httpx.get(
            f"{base}/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10.0,
        )
        resp.raise_for_status()
        data = resp.json()
        models = [m["id"] for m in data.get("data", [])]
        # 过滤掉嵌入/微调等杂项，保留聊天模型
        chat_models = []
        skip_keywords = ("embedding", "whisper", "tts", "dall-e", "moderation", "t2i")
        for m in models:
            if any(kw in m.lower() for kw in skip_keywords):
                continue
            chat_models.append(m)
        # 优先排序：gpt/claude/qwen/deepseek 等常见模型靠前
        priority = ("gpt-4o", "gpt-4", "gpt-3.5", "claude", "qwen", "deepseek", "glm")
        chat_models.sort(key=lambda m: next((i for i, p in enumerate(priority) if p in m.lower()), 999))
        return chat_models
    except Exception:
        return []


# ─ welcome 面板 ──────────────────────────────────────────

# 像素风格史莱姆（经典果冻造型）
# 使用 Rich Text API 渲染，每个 ░ 独立着色
# 主史莱姆 + 右侧3只分裂小史莱姆
# 渐变：天蓝(a) → 青蓝(b) → 淡紫(c) 平滑过渡

SLIME_PIXEL_GRID = [
    # 主史莱姆 + 右侧3只小史莱姆弧线，无左侧突出，两眼对称
    "                                ",
    "                                ",
    "                                ",
    "       aaaaaaaaaaaaaaaa         ",
    "       aaaeeeeaaaaaaeeaaa       ",
    "       aaaeppeaaaaaaepeaaa  bbb  ",
    "       aaaaaaaammmmaaaaaa        ",
    "       aaabbbbbbbbbbbbbba        ",
    "       aaaccccbbbbbbcccca        ",
    "       aaaaaaaaaaaaaaaaaa        ",
    "                                ",
    "                                ",
]

# 颜色映射（字符 -> Rich 样式名）
SLIME_STYLE_MAP = {
    'a': "bold cyan",     # 天蓝主体
    'b': "cyan",          # 青蓝过渡
    'c': "bright_blue",   # 淡紫底部
    'h': "white",         # 白色高光
    'e': "bright_black",    # 黑色眼眶（亮黑，可见）
    'p': "white",           # 白眼珠
    'm': "bright_black",    # 微笑嘴巴（亮黑，可见）
    ' ': None,            # 空格透明
}

def _render_pixel_slime():
    """逐像素渲染史莱姆（参考 Hermes 点阵风格，每个 ░ 独立着色）
    使用 Rich Text API + SLIME_STYLE_MAP 渲染。
    """
    from rich.text import Text
    for row in SLIME_PIXEL_GRID:
        text = Text()
        for ch in row:
            style = SLIME_STYLE_MAP.get(ch)
            if style is None:
                text.append(" ")
            else:
                text.append("░", style=style)
        console.print(text)


def _detect_os_name() -> str:
    """检测操作系统名称，正确处理 Windows 11"""
    system = platform.system()
    if system == "Windows":
        build = sys.getwindowsversion().build
        if build >= 22000:
            return "Windows 11"
        else:
            return f"Windows {platform.release()}"
    elif system == "Darwin":
        return f"macOS {platform.mac_ver()[0]}"
    else:
        return f"{system} {platform.release()}"


def _detect_system_info() -> dict:
    """自动检测系统信息"""
    return {
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "os": _detect_os_name(),
        "arch": platform.machine(),
        "project": str(Path(__file__).parent),
        "api": API_BASE,
        "time": datetime.now().strftime("%Y.%m.%d %H:%M"),
    }


def _get_tools_and_skills() -> tuple[list, list]:
    """获取可用工具和技能列表"""
    tools = []
    skills = []
    try:
        from tools.registry import get_registry
        registry = get_registry()
        tools = registry.list_tools()
    except Exception:
        pass
    try:
        skills_dir = Path(__file__).parent / "skills"
        if skills_dir.exists():
            for skill_dir in skills_dir.iterdir():
                if skill_dir.is_dir() and not skill_dir.name.startswith("__"):
                    manifest = skill_dir / "manifest.json"
                    if manifest.exists():
                        try:
                            import json
                            data = json.loads(manifest.read_text(encoding="utf-8"))
                            skills.append(data.get("name", skill_dir.name))
                        except Exception:
                            skills.append(skill_dir.name)
    except Exception:
        pass
    return tools, skills


def _render_entry_screen(agents_list: list, sys_info: dict):
    """渲染入口界面（面板整体居中）
    - 版本文本嵌入上边线（黄色高亮，居中）
    - 方框内：左侧两个嵌套子框(Agent Info / Tools & Skills)，右侧史莱姆像素画
    """
    from rich.text import Text

    console.print()

    tools, skills = _get_tools_and_skills()

    main_agent = next((a for a in agents_list if a["name"] == "Slime"), None)
    if not main_agent:
        main_agent = agents_list[0] if agents_list else None

    model_info = ""
    if main_agent:
        mc = main_agent.get("model_choice", "inherit")
        model_info = mc[4:] if mc.startswith("api:") else mc

    project_path = sys_info["project"]
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")

    # ── Dimensions ──
    SUB_W = 38       # inner width of each nested sub-box (matches reference)
    LEFT_W = SUB_W   # left column = sub-box width
    RIGHT_W = 32     # right slime column
    GAP = 2
    INNER = LEFT_W + GAP + RIGHT_W

    version_text = f" v0.1.0 │ Python {sys_info['python']} │ {sys_info['os']} │ {sys_info['time']}"
    vt_len = len(version_text)

    # 面板宽度（含边框）
    PANEL_W = INNER + 2

    # 面板居中
    term_w = shutil.get_terminal_size().columns
    center_pad = max(0, (term_w - PANEL_W) // 2)
    center_pad_str = ' ' * center_pad

    # Top border with version opening
    seg = max(1, (INNER - vt_len) // 2)
    seg2 = INNER - vt_len - seg
    top_t = Text()
    top_t.append(center_pad_str)
    top_t.append('╔', style='bold cyan')
    top_t.append('═' * seg, style='bold cyan')
    top_t.append(version_text, style='bold yellow')
    top_t.append('═' * max(0, seg2), style='bold cyan')
    top_t.append('╗', style='bold cyan')
    panel_rows = [top_t]

    # Helper: pad Text to exact display width
    def _pad(t: Text, width: int) -> Text:
        if t.cell_len < width:
            t2 = Text()
            t2.append_text(t)
            t2.append(' ' * (width - t.cell_len))
            return t2
        elif t.cell_len > width:
            t2 = Text()
            t2.append_text(t)
            t2.truncate(width)
            return t2
        return t

    def _box_line(markup: str, width: int) -> Text:
        """Render a Rich markup string (should be exactly width chars via format)
        and pad to width if markup changed things. Returns Text."""
        return _pad(Text.from_markup(markup), width)

    left_lines = []

    # ── Agent Info sub-box (EXACT width SUB_W chars including border) ──
    # Top:  ╭─ Agent Info ────────────────────╮
    title = " Agent Info "
    tlen = len(title)
    dash = SUB_W - 2 - tlen  # -2 for ╭ and ╯
    left_dash = dash // 2
    right_dash = dash - left_dash
    left_lines.append(_box_line(f"[bold cyan]╭{'─'*left_dash}{title}{'─'*right_dash}╮[/]", SUB_W))

    # Rows: │ Label: Value ...                 │  <- right │ at col SUB_W-1
    def _info_row(label, value_rich, value_plain_len):
        # width available for value: SUB_W - (│ +  + label + : +   ) = SUB_W - (2 + len(label))
        prefix = f"[bold cyan]│[/] [cyan]{label}:[/] "
        # after │ and label, remaining is:
        #  │ [cyan]Label:[/] value_rich  │  -> total cols SUB_W
        # 2 (│+ space) + len(label) + 1(:) + 1(space) = len_label_part
        label_w = 2 + len(label) + 2  # "│ Label: "  approx, but markup uses style tags
        # simpler: append manually
        t = Text()
        t.append('│', style='bold cyan')
        t.append(' ')
        t.append(f'{label}:', style='cyan')
        remaining = SUB_W - 3 - len(label) - 1  # cols left before │ at end (│=1, padding = 2 (space before+after label? no... let's compute)
        # Actually display:  │ + Label: + value + spaces + │
        # 1 (│) + 1 (sp) + len(label)+1 (label:) + 1(sp) + value_w + 1(sp) + 1(│) = SUB_W
        # => value_w = SUB_W - len(label) - 6
        value_w = SUB_W - len(label) - 6
        if value_w < 1: value_w = 1
        t.append(' ')
        # Append value_rich (pre-formatted Rich markup string)
        val_t = Text.from_markup(value_rich)
        if val_t.cell_len < value_w:
            val_t.append(' ' * (value_w - val_t.cell_len))
        elif val_t.cell_len > value_w:
            val_t.truncate(value_w)
        t.append_text(val_t)
        t.append(' ')
        t.append('│', style='bold cyan')
        return _pad(t, SUB_W)

    left_lines.append(_info_row('Name', '[bold]Slime[/]', len('Slime')))
    left_lines.append(_info_row('Model', f'[yellow]{model_info or "未配置"}[/]', len(model_info or '未配置')))
    left_lines.append(_info_row('Path', f'[dim]{_rme(project_path[:80])}[/]', len(project_path)))
    left_lines.append(_info_row('Session', f'[dim]{session_id}[/]', len(session_id)))

    # Bottom border of Agent Info:  ╰──────────────────────────────────╯
    left_lines.append(_box_line(f"[bold cyan]╰{'─'*(SUB_W-2)}╯[/]", SUB_W))
    left_lines.append(Text(' ' * SUB_W))  # gap

    # ── Tools & Skills sub-box ──
    title2 = " Tools & Skills "
    tlen2 = len(title2)
    dash2 = SUB_W - 2 - tlen2
    left_d2 = dash2 // 2
    right_d2 = dash2 - left_d2
    left_lines.append(_box_line(f"[bold cyan]╭{'─'*left_d2}{title2}{'─'*right_d2}╮[/]", SUB_W))

    # Header row: │  ● Tools (N)   ■ Skills (M)  │
    hdr = Text()
    hdr.append('│', style='bold cyan')
    hdr.append('  ')
    hdr.append(f'● Tools ({len(tools)})', style='bold magenta')
    avail = SUB_W - 2 - 2 - 1  # │ + 2sp + header_content + 1sp + │
    # Two columns
    col_w = (SUB_W - 4) // 2  # space for │...│ minus 2 edges + 2 inner pads
    # Pad out tools header
    hdr_cell_w = SUB_W - 6  # after │ __ and before __│
    tools_hdr = f'● Tools ({len(tools)})'
    skills_hdr = f'■ Skills ({len(skills)})'
    sep_w = 2
    col1_w = (hdr_cell_w - sep_w) // 2
    col2_w = hdr_cell_w - sep_w - col1_w
    # Build content using Text so we can pad cell widths properly
    row_t = Text()
    row_t.append('│', style='bold cyan')
    row_t.append('  ')
    t1 = Text(tools_hdr, style='bold magenta')
    if t1.cell_len < col1_w:
        t1.append(' ' * (col1_w - t1.cell_len))
    elif t1.cell_len > col1_w:
        t1.truncate(col1_w)
    row_t.append_text(t1)
    row_t.append(' ' * sep_w)
    t2 = Text(skills_hdr, style='bold magenta')
    if t2.cell_len < col2_w:
        t2.append(' ' * (col2_w - t2.cell_len))
    elif t2.cell_len > col2_w:
        t2.truncate(col2_w)
    row_t.append_text(t2)
    row_t.append('  ')
    row_t.append('│', style='bold cyan')
    left_lines.append(_pad(row_t, SUB_W))

    max_items = max(3, max(len(tools), len(skills)))
    for idx in range(max_items):
        # Build row Text
        rt = Text()
        rt.append('│', style='bold cyan')
        rt.append('  ')

        if idx < len(tools):
            func = tools[idx].get('function', {})
            tn = func.get('name', '')[:10]
            tool_markup = Text.from_markup(f'[cyan]· {tn:<10}[/]')
        elif idx < 3 and not tools:
            tool_markup = Text.from_markup('[dim]no tools  [/]')
        else:
            tool_markup = Text(' ' * 12)
        if tool_markup.cell_len < col1_w:
            tool_markup.append(' ' * (col1_w - tool_markup.cell_len))
        elif tool_markup.cell_len > col1_w:
            tool_markup.truncate(col1_w)
        rt.append_text(tool_markup)

        rt.append(' ' * sep_w)

        if idx < len(skills):
            sn = skills[idx][:10]
            sk_markup = Text.from_markup(f'[cyan]· {sn:<10}[/]')
        elif idx < 3 and not skills:
            sk_markup = Text.from_markup('[dim]no skills [/]')
        else:
            sk_markup = Text(' ' * 12)
        if sk_markup.cell_len < col2_w:
            sk_markup.append(' ' * (col2_w - sk_markup.cell_len))
        elif sk_markup.cell_len > col2_w:
            sk_markup.truncate(col2_w)
        rt.append_text(sk_markup)

        rt.append('  ')
        rt.append('│', style='bold cyan')
        left_lines.append(_pad(rt, SUB_W))

    left_lines.append(_box_line(f"[bold cyan]╰{'─'*(SUB_W-2)}╯[/]", SUB_W))

    # ── Right column: slime (pre-render + pad RIGHT_W) ──
    slime_rendered = []
    for row in SLIME_PIXEL_GRID:
        srt = Text()
        for ch in row:
            sl = SLIME_STYLE_MAP.get(ch)
            if sl is None:
                srt.append(' ')
            else:
                srt.append('█', style=sl)
        slime_rendered.append(_pad(srt, RIGHT_W))

    left_h = len(left_lines)
    slime_h = len(slime_rendered)
    slime_top = max(0, (left_h - slime_h) // 2)

    # ═══════════════════════════════════════
    # BODY RENDER:   LEFT (SUB_W)  GAP (2)  RIGHT (RIGHT_W) ║
    # ═══════════════════════════════════════
    for i in range(left_h):
        rt = Text()
        rt.append(center_pad_str)
        rt.append('║', style='bold cyan')

        lt = _pad(left_lines[i], LEFT_W)
        rt.append_text(lt)
        rt.append(' ' * GAP)

        s_idx = i - slime_top
        if 0 <= s_idx < slime_h:
            rt.append_text(slime_rendered[s_idx])
        else:
            rt.append(' ' * RIGHT_W)

        rt.append('║', style='bold cyan')
        panel_rows.append(rt)

    # Bottom border
    bottom_t = Text()
    bottom_t.append(center_pad_str)
    bottom_t.append('╚' + '═' * INNER + '╝', style='bold cyan')
    panel_rows.append(bottom_t)

    # 面板渲染（整体居中）
    for row in panel_rows:
        console.print(row)
    console.print()

    # Welcome + tip (centered under panel)
    welcome = Text()
    welcome.append(' Welcome to Slime Agent! ', style='bold cyan')
    welcome.append('Type your message or ')
    welcome.append('/help', style='cyan')
    welcome.append(' for commands.')

    tip = Text()
    tip.append(' Tip: ', style='bold yellow')
    tip.append('/back to return, /quit to exit, Ctrl+C to clear input.', style='dim')

    # Center based on terminal width (not panel width)
    wp = max(0, (term_w - welcome.cell_len) // 2)
    tp = max(0, (term_w - tip.cell_len) // 2)

    console.print(Text(' ' * wp) + welcome)
    console.print(Text(' ' * tp) + tip)
    console.print()



# ── 主交互循环 ──────────────────────────────────────────────



def _entry_loop():

    """主交互循环：显示欢迎界面并进入对话（/back 可返回欢迎界面）"""

    # 检查服务

    if not _check_server():

        console.print("[red]错误：slime 服务未运行[/]")

        console.print("[dim]请先运行: python slime_server.py[/]")

        sys.exit(1)



    # 注册内置工具（Swarm 本地执行时需要）

    try:

        from tools.builtin import register_builtin_tools

        register_builtin_tools()

    except Exception as e:

        console.print(f"[yellow]警告：内置工具注册失败: {e}[/]")

    # A-056: 注册媒体生成工具（agnes_*）——Swarm 在 CLI 进程本地执行，
    # 若不注册 Worker 的工具列表就没有 agnes_generate_image/video（实测分段任务全失败）
    try:
        from tools.agnes_media import register_agnes_media_tools
        register_agnes_media_tools()
    except Exception as e:
        console.print(f"[yellow]警告：媒体工具注册失败: {e}[/]")




    # 加载 Agent 列表

    try:

        agents_list = _api("GET", "/agents")

    except Exception as e:

        console.print(f"[red]加载 Agent 列表失败: {e}[/]")

        sys.exit(1)



    if not agents_list:

        console.print("[yellow]未找到 Agent，请先运行向导创建第一个 Agent[/]")

        console.print("[dim]运行: python slime_cli.py wizard[/]")

        sys.exit(1)



    # 查找主 Agent（名为 Slime 或第一个）

    main_agent = next((a for a in agents_list if a["name"] == "Slime"), None)

    if not main_agent:

        main_agent = agents_list[0]



    # 主循环：/back 返回欢迎界面，/quit 退出

    while True:

        # 获取系统信息 + 刷新 Agent 列表（/back 返回后反映最新状态）
        sys_info = _detect_system_info()
        try:
            agents_list = _api("GET", "/agents")
        except SystemExit:
            agents_list = agents_list  # 刷新失败保留旧列表



        # 渲染入口界面

        _render_entry_screen(agents_list, sys_info)


        # 进入对话循环（/back 会 return，/quit 会 break，/talk 会带 target 返回）
        switch_to = []
        _chat_loop(main_agent, switch_to)

        # /talk 切换：直接进入目标 Agent 对话
        if switch_to:
            main_agent = switch_to[0]
            console.clear()
            continue

        # /back 返回后清屏重新显示欢迎界面
        console.clear()


def _register_dynamic_commands(handlers: dict, specs: dict, pending: list,
                                skills_dir: str = "config/skills",
                                mcp_names: list | None = None):
    """A-094: 动态斜杠命令注册——技能与 MCP 服务器自动获得 /<名> 命令。
    - 技能来源：扫描 skills_dir/*/SKILL.md → /<目录名>，引导"使用技能 <名> 处理：<参数>"
    - MCP 来源：slime.toml [[mcp_servers]].name → /<server名>，引导使用该 MCP 工具
    - 已注册/内置命令冲突跳过（不覆盖）；无参数时打印用途引导
    - pending: 列表，注入包装后的用户消息（_chat_loop 主循环消费）
    注意：MCP 桥接工具实为 mcp_<工具名>（无 server 名前缀），引导文案不虚构前缀。"""
    import tomllib as _toml
    from pathlib import Path as _P
    from rich.console import Console as _Console
    _console = _Console()

    def _mk_handler(slug: str, prompt_prefix: str, desc: str):
        def handler(args: str):
            if not args.strip():
                _console.print(f"[cyan]/{slug}[/] {desc}\n用法: [cyan]/{slug} <参数>[/]")
                return
            pending.append(f"{prompt_prefix}：{args}")
        handler.__name__ = f"_h_dyn_{slug.replace('-', '_')}"
        return handler

    # 技能来源
    root = _P(skills_dir)
    if root.is_dir():
        for sub in sorted(root.iterdir()):
            if not sub.is_dir() or not (sub / "SKILL.md").is_file():
                continue
            slug = sub.name
            key = f"/{slug}"
            # A-094 修正：冲突检查必须含模块级 _CMD_SPECS（内置命令全集），
            # 动态命令永不覆盖内置命令（含别名/前缀匹配集）
            if key in handlers or key in specs or key in _CMD_SPECS:
                continue  # 冲突跳过（内置/已注册优先）
            handlers[key] = _mk_handler(slug, f"使用技能 {slug} 处理", "调用技能")
            specs[key] = {"desc": f"调用技能 {slug}", "group": "技能", "usage": f"/{slug} <参数>"}

    # MCP 来源
    try:
        # A-095: 绝对路径锚定项目根——从任意 cwd 启动 CLI 都能读到 slime.toml
        # （此前相对路径在项目目录外启动时 _cfg={} → MCP 命令静默不注册）
        with open(_P(__file__).parent / "slime.toml", "rb") as f:
            _cfg = _toml.load(f)
    except Exception:
        _cfg = {}
    mcp_servers = list(mcp_names) if mcp_names is not None else None
    if mcp_servers is None:
        mcp_servers = [s.get("name") for s in _cfg.get("mcp_servers", []) if isinstance(s, dict) and s.get("name")]
    for name in mcp_servers:
        key = f"/{name}"
        if key in handlers or key in specs or key in _CMD_SPECS:
            continue
        handlers[key] = _mk_handler(name, f"使用 MCP 服务器 {name} 的工具处理", "调用 MCP")
        specs[key] = {"desc": f"调用 MCP 服务器 {name}", "group": "MCP", "usage": f"/{name} <参数>"}


def _chat_loop(agent: dict, switch_to: list | None = None):
    """对话主循环（Hermes 风格，带 / 命令自动补全 + 注册表分发）
    switch_to: 可变列表，用于 /talk 命令切换 Agent。置 [target_dict] 后 return。
    """
    agent_id = agent["id"]
    agent_name = agent["name"]
    history: list[dict] = []

        # 加载持久化对话历史（limit=20 条对话 = 40 条消息，与会话窗口 40 条消息对齐）
    try:
        past = _api("GET", f"/agents/{agent_id}/history", params={"limit": 20})
        if past:
            for r in past:
                history.append({"role": "user", "content": r.get("user", "")})
                history.append({"role": "assistant", "content": r.get("ai", "")})
            del history[:-40]
    except Exception:
        pass

    # A-108: prompt_toolkit 会话（带 / 命令自动补全 + 命令历史），延迟导入省启动时间
    from prompt_toolkit import PromptSession
    from prompt_toolkit.history import FileHistory
    # N11-P1-7: 历史文件设权限（Unix 0o600 / Windows 隐藏+ACL），防明文泄露
    _history_path = Path.home() / ".slime_history"
    try:
        if not _history_path.exists():
            _history_path.touch()
        if os.name == "nt":
            import ctypes
            ctypes.windll.kernel32.SetFileAttributesW(str(_history_path), 2)  # 隐藏
            try:
                import subprocess
                subprocess.run(
                    ["icacls", str(_history_path), "/inheritance:r",
                     "/grant:r", f"{os.environ.get('USERNAME', '')}:(R,W)"],
                    capture_output=True, timeout=5,
                )
            except Exception:
                pass
        else:
            _history_path.chmod(0o600)
    except Exception:
        pass

    session = PromptSession(
        completer=_SlashCompleter(),
        complete_while_typing=True,
        auto_suggest=_SlashAutoSuggest(AutoSuggestFromHistory()),
        key_bindings=_chat_key_bindings(),
        history=FileHistory(str(_history_path)),
    )
    # A-109-R2: prompt_toolkit 仅 insert_text 触发补全重算，Backspace/Delete 等删除路径
    # 走 delete_before_cursor → _text_changed 清空 complete_state 且不重算 → 菜单消失
    # （用户实测：拼错后按 Backspace 提示框直接没了）。挂 on_text_changed：任何文本变化
    # （含删除）后重算补全，菜单持续跟随输入；输入路径的重复触发被 _only_one_at_a_time
    # 与 complete_state 检查吸收，无副作用。
    session.default_buffer.on_text_changed += (
        lambda _ev: session.default_buffer.start_completion()
    )

    # 顶部标题（青色分割线）
    console.print()
    _print_cyan_separator(agent_name)
    console.print(f"[dim]  {_rme(str(agent['role']))}[/]")
    console.print(f"[dim]  输入 / 查看命令，/back 返回，/quit 退出[/]")
    _print_cyan_separator()
    console.print()

    # 状态栏追踪（stats dict 供闭包共享修改）
    stats = {
        "total_tokens": 0,       # 最近一次请求的 token 总数（用于状态栏上下文占比）
        "prompt_tokens": 0,      # 累计 prompt tokens
        "completion_tokens": 0,  # 累计 completion tokens
        "request_count": 0,      # 本次会话请求次数
        "last_elapsed_ms": 0,
        "session_start_time": time.time(),
    }

    # 自动 Swarm 开关（/auto 切换）
    auto_swarm_enabled = [False]

    # /back 信号：闭包设置，主循环检查后 return
    should_return = [False]

    # ── 命令处理器（闭包捕获 history / agent_id / stats）──
    def _h_help(args):
        if args.strip():
            _show_command_detail("/" + args.strip().lower().lstrip("/"))
        else:
            _show_commands_popup()

    def _h_quit(args):
        console.print("[dim]再见！[/]")
        sys.exit(0)

    def _h_back(args):
        should_return[0] = True

    def _h_clear(args):
        console.clear()

    def _h_new(args):
        history.clear()
        console.print("[green]对话历史已清除[/]")

    def _h_retry(args):
        if len(history) >= 2:
            # M8: 检查末尾是否为 assistant（流失败时可能未追加）
            if history[-1].get("role") == "assistant":
                history.pop()  # 移除上一条 assistant 回复
            if not history or history[-1].get("role") != "user":
                console.print("[yellow]没有可重试的用户消息[/]")
                return
            last_user = history[-1]["content"]
            console.print(f"[dim]重试: {last_user}[/]")
            try:
                result = _api("POST", f"/agents/{agent_id}/chat", json={
                    "message": last_user,
                    "history": history[:-1],  # 末尾用户消息由 message 字段携带，不重复
                    "retry": True,            # 服务端写入历史前先移除上一条
                })
                reply = result["reply"]
                _print_agent_reply(agent_name, reply)
                history.append({"role": "assistant", "content": reply})
                stats["total_tokens"] = result.get("prompt_tokens", 0) + result.get("completion_tokens", 0)
                stats["prompt_tokens"] += result.get("prompt_tokens", 0)
                stats["completion_tokens"] += result.get("completion_tokens", 0)
                stats["request_count"] += 1
                stats["last_elapsed_ms"] = int(result.get("elapsed_ms", 0))
            except SystemExit:
                pass
        else:
            console.print("[yellow]没有可重试的消息[/]")

    def _h_export(args):
        _cmd_export(agent_id, agent_name, args)

    def _h_history(args):
        _cmd_history(agent_id, agent_name, args)

    def _h_persona(args):
        persona = _api("GET", f"/agents/{agent_id}/persona")
        console.print(Syntax(json.dumps(persona, ensure_ascii=False, indent=2), "json"))

    def _h_status(args):
        _cmd_status(agent_id, agent_name)

    def _h_tokens(args):
        _cmd_tokens(stats)

    def _h_tools(args):
        _cmd_tools()

    def _h_children(args):
        _cmd_children()

    def _h_agents(args):
        _cmd_agents()

    def _h_context(args):
        _cmd_context(agent)

    def _h_config(args):
        _cmd_config(agent)

    def _h_model(args):
        _cmd_model(agent, agent_id, agent_name, args)

    def _h_providers(args):
        _cmd_list_providers()

    def _h_provider(args):
        sub = args.strip().lower()
        if sub == "list":
            _cmd_list_providers()
        elif sub == "del" or sub.startswith("del "):
            _cmd_del_provider(sub[4:].strip())
        else:
            if sub:
                console.print(f"[yellow]未知子命令 '{sub}'，用法：/provider [list|del <key>][/]")
                return
            _cmd_add_provider()

    def _h_task(args):
        console.print("[dim]正在进入 Swarm 模式...[/]")
        # A-051: 并发默认用满 Provider（上限 6），不再写死 2
        from core.encryption import decrypt as _dec
        _providers = _dec() or {}
        _mw = min(6, max(1, len(_providers)))
        ctx = click.Context(cli)
        ctx.invoke(swarm, task=None, max_workers=_mw, agent=agent_name)

    def _h_review(args):
        """周期性审查：整理记忆、强化 trait、清理过期 pattern"""
        console.print()
        console.print("[bold cyan]━━━ 知识审查 ━━━[/]")
        try:
            agent_data = _api("GET", f"/agents/{agent_id}")
        except SystemExit:
            return

        from core.knowledge import get_knowledge_engine, reset_knowledge_engine
        from core.agent import Agent as AgentCls
        reset_knowledge_engine()
        ke = get_knowledge_engine(agent_id)

        stats = ke.get_stats()
        console.print(f"  Pattern 总数: [cyan]{stats['total_patterns']}[/]")
        console.print(f"  高优先级: [yellow]{stats['high_priority']}[/]")
        console.print(f"  已晋升规则: [green]{stats['total_rules']}[/]")
        console.print(f"  待审查: [magenta]{stats['pending_review']}[/]")

        high_pri = ke.get_high_priority_patterns()
        if high_pri:
            console.print("\n[bold yellow]⚠ 高优先级 Pattern:[/]")
            for p in high_pri[:10]:
                console.print(f"  [yellow]{_rme(p.key)}[/] ×{p.recurrence} [dim]{_rme(p.description[:60])}[/]")

        try:
            confirm = safe_ask("\n执行审查？(y/n)", default="y")
        except (KeyboardInterrupt, EOFError):
            return
        if confirm is None or confirm.lower() != "y":
            return

        main_a = AgentCls.from_dict(agent_data)
        result = ke.review(agent_persona=main_a.persona)

        try:
            _api("PATCH", f"/agents/{agent_id}", json={"persona": main_a.persona.to_dict()})
        except SystemExit:
            pass

        console.print(f"\n[green]√ 审查完成[/]")
        console.print(f"  审查: {result['patterns_reviewed']} | 归档: {result['patterns_resolved']} | 强化 trait: {result['traits_reinforced']}")
        for s in result["summary"][:5]:
            console.print(f"  [dim]- {s}[/]")
        console.print(f"[dim]日志 → Knowledge/Agent Memory/reviews/[/]")

    def _h_servers(args):
        """本地模型管理：列表/启停"""
        sub = args.strip().lower()
        try:
            if sub == "stop chat":
                result = _api("POST", "/model-servers/chat/stop")
                if result.get("ok"):
                    console.print(f"[green]√ chat 已卸载[/]")
                else:
                    console.print(f"[yellow]{result.get('error', '卸载失败')}[/]")
            elif sub == "start chat":
                console.print("[dim]正在拉起 chat 模型...[/]")
                result = _api("POST", "/model-servers/chat/start")
                if result.get("ok"):
                    console.print(f"[green]√ chat 已就绪 (port {result.get('port', '?')})[/]")
                else:
                    console.print(f"[yellow]{result.get('error', '启动失败')}[/]")
            else:
                # 列表
                servers = _api("GET", "/model-servers")
                if not servers:
                    console.print("[dim]无本地模型实例（slime.toml 中未配置 [model_server]）[/]")
                    return
                from rich.table import Table
                table = Table(title="本地模型实例")
                table.add_column("Role", style="cyan")
                table.add_column("Model", style="green")
                table.add_column("Port", style="yellow")
                table.add_column("State", style="magenta")
                table.add_column("VRAM(全卡)", style="dim")
                for s in servers:
                    vram = s.get("vram_gb", {}) or {}
                    vram_str = f"free {vram.get('free_gb', '?')}G" if vram else "N/A"
                    table.add_row(
                        s.get("role", ""),
                        s.get("model", ""),
                        str(s.get("port", "")),
                        s.get("state", ""),
                        vram_str,
                    )
                console.print(table)
                console.print("[dim]/servers start chat — 手动拉起 | /servers stop chat — 手动卸载[/]")
        except SystemExit:
            pass

    def _h_mcp(args):
        """MCP 服务器管理：列表/启停（对接 server /mcp/servers 路由）"""
        from urllib.parse import quote
        parts = args.strip().split()
        sub = parts[0].lower() if parts else ""
        name = parts[1] if len(parts) > 1 else ""
        try:
            if sub == "start" and name:
                result = _api("POST", f"/mcp/servers/{quote(name, safe='')}/start")
                if result.get("ok"):
                    console.print(f"[green]√ MCP Server '{name}' 已启动[/]")
                else:
                    console.print(f"[yellow]{result.get('error', '启动失败')}[/]")
            elif sub == "stop" and name:
                result = _api("POST", f"/mcp/servers/{quote(name, safe='')}/stop")
                if result.get("ok"):
                    console.print(f"[green]√ MCP Server '{name}' 已停止[/]")
                else:
                    console.print(f"[yellow]{result.get('error', '停止失败')}[/]")
            else:
                servers = _api("GET", "/mcp/servers")
                if not servers:
                    console.print("[dim]无 MCP Server（在 slime.toml 配置 [[mcp_servers]] 后重启 server）[/]")
                    return
                from rich.table import Table
                table = Table(title="MCP 服务器")
                table.add_column("名称", style="cyan")
                table.add_column("状态", style="magenta")
                table.add_column("工具", style="green")
                table.add_column("资源", style="yellow")
                table.add_column("提示", style="dim")
                for s in servers:
                    table.add_row(
                        s.get("name", ""),
                        "运行中" if s.get("running") else "已停止",
                        str(s.get("tools", 0)),
                        str(s.get("resources", 0)),
                        str(s.get("prompts", 0)),
                    )
                console.print(table)
                console.print("[dim]/mcp start <名称> — 启动 | /mcp stop <名称> — 停止 | 工具以 mcp_ 前缀桥接给 Agent[/]")
        except SystemExit:
            pass

    def _h_talk(args):
        """切换到指定 Agent 进行对话"""
        target_name = args.strip()
        if not target_name:
            console.print("[yellow]用法: /talk <Agent名称> | /talk list[/]")
            return
        if target_name.lower() == "list":
            try:
                all_agents = _api("GET", "/agents")
            except SystemExit:
                return
            console.print()
            for a in all_agents:
                marker = " [dim](当前)[/]" if a["id"] == agent_id else ""
                mc = a.get("model_choice", "inherit")
                if mc.startswith("api:"):
                    mc = mc[4:]
                console.print(f"  [cyan]{_rme(a['name'])}[/] [dim]{_rme(str(a.get('role', ''))[:40])}[/] [yellow]{_rme(mc)}[/]{marker}")
            return
        try:
            all_agents = _api("GET", "/agents")
        except SystemExit:
            return
        target = next((a for a in all_agents if a["name"].lower() == target_name.lower()), None)
        if not target:
            console.print(f"[yellow]Agent '{target_name}' 不存在。用 /talk list 查看所有 Agent。[/]")
            return
        if target["id"] == agent_id:
            console.print(f"[dim]已在与 {target_name} 对话中[/]")
            return
        if switch_to is not None:
            switch_to.append(target)
        should_return[0] = True
        console.print(f"[green]切换到 {target['name']}...[/]")

    def _h_auto(args):
        auto_swarm_enabled[0] = not auto_swarm_enabled[0]
        status = "启用" if auto_swarm_enabled[0] else "关闭"
        console.print(f"[green]自动 Swarm：{status}[/]")
        if auto_swarm_enabled[0]:
            console.print("[dim]当你的消息包含多个可并行的独立任务时，Agent 会自动分裂执行[/]")

    def _h_split(args):
        _cmd_split(agent_id, agent_name)

    def _h_memory(args):
        _cmd_memory(agent_id, agent_name, args)

    def _h_evolve(args):
        _cmd_evolve(agent_id, agent_name)

    def _h_compress(args):
        _cmd_compress(agent_id, agent_name, history)

    def _h_tool(args):
        _cmd_tool_call(agent_id, args)

    def _h_skills(args):
        _cmd_skills()

    def _h_mode(args):
        _cmd_mode(agent, agent_id, agent_name, args)

    def _h_think(args):
        _cmd_think(agent, agent_id, agent_name, args)

    def _h_thinking(args):
        _cmd_thinking(agent, agent_id, agent_name, args)

    handlers = {
        "/help":     _h_help,
        "/?":        _h_help,   # 快捷帮助别名
        "/quit":     _h_quit,
        "/exit":     _h_quit,   # 兼容别名（不在 _CMD_SPECS 中显示）
        "/back":     _h_back,
        "/clear":    _h_clear,
        "/new":      _h_new,
        "/retry":    _h_retry,
        "/export":   _h_export,
        "/history":  _h_history,
        "/persona":  _h_persona,
        "/status":   _h_status,
        "/tokens":   _h_tokens,
        "/tools":    _h_tools,
        "/children": _h_children,
        "/agents":   _h_agents,
        "/context":  _h_context,
        "/config":   _h_config,
        "/model":    _h_model,
        "/providers": _h_providers,
        "/provider": _h_provider,
        "/task":     _h_task,
        "/review":   _h_review,
        "/servers":  _h_servers,
        "/mcp":      _h_mcp,
        "/talk":     _h_talk,
        "/auto":     _h_auto,
        "/split":    _h_split,
        "/memory":   _h_memory,
        "/evolve":   _h_evolve,
        "/compress": _h_compress,
        "/tool":     _h_tool,
        "/skills":   _h_skills,
        "/mode":     _h_mode,
        "/think":    _h_think,
        "/thinking": _h_thinking,
    }

    # ── A-094: 动态命令注册（技能/MCP → /<名>），pending 队列由主循环消费 ──
    _dyn_pending: list = []
    try:
        _register_dynamic_commands(handlers, _CMD_SPECS, _dyn_pending)
    except Exception as _e:
        logging.warning(f"[slime CLI] 动态命令注册失败: {_e}")

    # ── 一致性校验：handlers 键应 ⊆ _CMD_SPECS ∪ 别名集 ──
    _ALIAS_KEYS = {"/exit", "/providers"}  # 仅精确匹配、不在 help 中显示的别名
    _missing = set(handlers) - set(_CMD_SPECS) - _ALIAS_KEYS
    if _missing:
        logging.warning(f"[slime CLI] handlers 中有命令未在 _CMD_SPECS 注册: {sorted(_missing)}")
    _orphan = set(_CMD_SPECS) - set(handlers)
    if _orphan:
        logging.warning(f"[slime CLI] _CMD_SPECS 中有命令未在 handlers 实现: {sorted(_orphan)}")

    while True:
        # ── 状态栏（Hermes 风格，context_max 动态读取）──
        model_name = agent.get("model_choice", "unknown")
        if model_name.startswith("api:"):
            model_name = model_name[4:]
        context_max = agent.get("max_context", 512 * 1024)  # 动态读取 Agent 配置
        total_tokens = stats["total_tokens"]
        context_pct = min(100, int(total_tokens / context_max * 100)) if context_max else 0
        bar_len = 10
        filled = int(bar_len * context_pct / 100)
        progress_bar = "█" * filled + "□" * (bar_len - filled)

        elapsed = int(time.time() - stats["session_start_time"])
        elapsed_str = f"{elapsed // 60}m {elapsed % 60:02d}s" if elapsed >= 60 else f"{elapsed}s"

        mode_badge = ""
        if agent.get("mode") == "plan":
            mode_badge = " [reverse yellow]PLAN[/]"
        think_badge = ""
        eff = agent.get("reasoning_effort", "none")
        if eff != "none":
            think_badge = f" [dim]think:{eff}[/]"

        total_k = total_tokens / 1024
        max_k = context_max / 1024
        last_elapsed_ms = stats["last_elapsed_ms"]
        req_str = f"{last_elapsed_ms / 1000:.1f}".rstrip("0").rstrip(".") + "s" if last_elapsed_ms else "0s"
        req_count = stats.get("request_count", 0)
        console.print(f"[dim]{_rme(str(model_name))}{mode_badge}{think_badge} │ {total_k:.1f}K/{max_k:.1f}K │ [{progress_bar}] {context_pct}% │ {elapsed_str} │ 耗时 {req_str} │ 成功 {req_count}[/]")

        # 上分割线 + 输入提示（下分割线在用户按回车后打印）
        _print_gray_separator()
        try:
            user_input = session.prompt(HTML("<b style='color:#00ffff'>&gt;</b> "))
        except (KeyboardInterrupt, EOFError):
            console.print("\n[dim]再见！[/]")
            sys.exit(0)
        # 用户按回车后，打印下分割线
        _print_gray_separator()

        if not user_input.strip():
            continue

        # ─ 命令处理（注册表 + 统一分发器）──
        if user_input.strip().startswith("/"):
            cmd_raw = user_input.strip()
            # A-111: 记录命令使用（艾宾浩斯排序数据源；失败静默）
            _record_usage("/" + cmd_raw[1:].split(None, 1)[0].lower())
            # 单独 "/" 显示帮助
            if cmd_raw == "/":
                _show_commands_popup()
                continue
            # S6: 命令分发兜底——API 失败(SystemExit 1)不杀死会话，仅主动退出(0)放行
            try:
                _dispatch_slash_command(cmd_raw, handlers)
            except SystemExit as e:
                if e.code == 0:
                    raise
                console.print("[dim]命令已取消（API 错误，会话保持）[/]")
            except PromptCancelled:
                console.print("[dim]输入已取消（Ctrl+C），会话保持[/]")
            except KeyboardInterrupt:
                console.print("\n[dim]操作已取消（Ctrl+C），会话保持[/]")
            if should_return[0]:
                return
            # A-094: 动态命令（技能/MCP）→ 包装消息注入发送流
            if _dyn_pending:
                user_input = _dyn_pending.pop(0)
            else:
                continue
        # ─ 发送消息 + 流式输出 ─
        _print_user_message(user_input)

        # 自动 Swarm 检测（/auto 开关启用时）
        if auto_swarm_enabled[0] and len(user_input.strip()) > 15:
            try:
                analysis = _api("POST", f"/agents/{agent_id}/chat/analyze", json={
                    "message": user_input, "history": history[-6:] if len(history) > 6 else history,
                })
                action = analysis.get("action", "chat")
                subtasks = analysis.get("subtasks", [])
                if action in ("fork", "swarm") and subtasks:
                    from core.encryption import decrypt as _dec
                    from core.executor import SwarmExecutor
                    from core.agent import Agent as AgentCls
                    all_providers = _dec() or {}
                    main_a = AgentCls.from_dict(agent)

                    skip = False
                    if action == "fork":
                        if main_a.fork_depth >= AgentCls.MAX_FORK_DEPTH:
                            console.print("[dim]已达最大 fork 深度，回退到正常对话[/]")
                            skip = True
                        else:
                            pk = None
                            if agent["model_choice"].startswith("api:"):
                                pk = agent["model_choice"][4:]
                            elif agent["model_choice"] == "inherit":
                                from core.llm import _resolve_provider_key
                                alist = [AgentCls.from_dict(a) for a in _api("GET", "/agents")]
                                pk = _resolve_provider_key(main_a, alist)
                            providers = {pk: all_providers[pk]} if pk and pk in all_providers else all_providers
                            max_w = 2
                            label = "自动 Fork（同模型并行）"
                    else:  # swarm
                        providers = all_providers
                        # A-051: 并发上限 3 → 6（用满全部 Provider，不再人为收紧）
                        max_w = min(len(providers), len(subtasks), 6)
                        label = "自动 Swarm（多模型分发）"

                    if not skip:
                        console.print(f"\n[bold bright_blue]⚡ {label}：检测到 {len(subtasks)} 个可并行子任务[/]")
                        console.print(f"[dim]分析：{analysis.get('reason', '')}[/]")

                        agents_list_raw = _api("GET", "/agents")
                        executor = SwarmExecutor(providers, main_a, [AgentCls.from_dict(a) for a in agents_list_raw])
                        sw_result = executor.run(
                            task=user_input,
                            max_workers=max_w,
                            subtask_names=None,
                            subtasks=subtasks,  # A-047: 复用 analyze 拆解结果，跳过内部二次拆解
                            on_progress=lambda stage, msg: console.print(f"[dim][{stage}] {msg}[/]"),
                            on_complete=lambda mr, snaps: (
                                console.print(f"\n[bold]{mr.final_verdict}[/]"),
                                console.print(_md(mr.summary[:1500]) if mr.summary else ""),
                            ),
                        )
                        if sw_result.get("error"):
                            console.print(f"[red]{sw_result['error']}[/]")
                        mr = sw_result.get("merge_result")
                        summary_text = mr.summary if hasattr(mr, "summary") else str(mr or "")
                        history.append({"role": "user", "content": user_input})
                        history.append({"role": "assistant", "content": summary_text})
                        stats["request_count"] += 1
                        # A-044: Swarm 结果同样过幻觉护栏
                        _verify_claimed_files(summary_text)
                        # A-031: Swarm 经验沉淀上报（best-effort）
                        if summary_text and not sw_result.get("error"):
                            _report_swarm(agent_id, user_input, summary_text,
                                          sw_result.get("agent_snapshots", []))
                        continue
            except SystemExit:
                pass
            except Exception:
                pass

        # 启动思考动画线程
        stop_event = [False]
        import threading
        anim_thread = threading.Thread(target=_print_thinking_animation, args=(stop_event,), daemon=True)
        anim_thread.start()

        try:
            # 流式请求
            headers = _auth_headers()
            full_reply = ""
            result_meta = {}
            done_received = False
            error_from_stream = False
            first_chunk = True
            thinking_parts = []      # 思考内容缓冲（局部，非全局；A-099 起实时输出为主）
            thinking_rendered = False
            late_thinking = []       # A-009: 正文开始后才到达的思考（结尾统一渲染，不破坏布局）
            thinking_started = False  # A-099: 思考标题已打印
            thinking_streamed = False  # A-099: 已有思考内容实时输出
            progress_active = False  # A-050: 工具进度条激活标记（完成时换行收尾）

            with httpx.stream(
                "POST",
                f"{API_BASE}/agents/{agent_id}/chat/stream",
                json={"message": user_input, "history": history},
                headers=headers,
                timeout=600.0,  # A-045: 委托生图/生视频等长链路可达数分钟（此前 120s 读超时掐断）
            ) as resp:
                resp.raise_for_status()

                for line in resp.iter_lines():
                    if not line or not line.startswith("data: "):
                        continue

                    import json as _json
                    data_str = line[6:]
                    try:
                        chunk = _json.loads(data_str)
                    except _json.JSONDecodeError:
                        continue

                    if chunk.get("type") == "chunk":
                        # A-099: 首个正文块 → 停动画 + 打印回复头部（思考已实时输出，无缓冲 Panel）
                        if first_chunk:
                            stop_event[0] = True
                            anim_thread.join(timeout=1.0)
                            first_chunk = False
                            console.print()
                            _print_cyan_separator(agent_name)
                        chunk_content = _clean_ansi(chunk.get("content", ""))
                        full_reply += chunk_content
                        # 逐块输出（用 sys.stdout 直接写入，绕过 Rich 缓冲）
                        sys.stdout.write(chunk_content)
                        sys.stdout.flush()
                    elif chunk.get("type") == "reasoning":
                        reasoning = _clean_ansi(chunk.get("content", ""))
                        if not reasoning:
                            continue
                        if thinking_rendered:
                            # A-009: 正文已开始后才到达的思考不再交错插入（破坏布局），
                            # 缓冲到结尾统一以"后续思考"Panel 渲染
                            late_thinking.append(reasoning)
                        else:
                            # A-099: 实时流式输出（dim 灰，Text 包裹防 MarkupError）——
                            # 不再缓冲到正文前一次性 Panel（原设计牺牲实时性）
                            if first_chunk:
                                stop_event[0] = True
                                anim_thread.join(timeout=1.0)
                                first_chunk = False
                            if not thinking_started:
                                console.print()
                                console.print("[dim]🤔 思考历程：[/]")
                                thinking_started = True
                            # A-099-R2: 思考与正文同用 sys.stdout 无缓冲通道（Rich console.print
                            # 可能在非 tty 下缓冲，导致思考攒到正文前一起出现）——ANSI dim 实现样式
                            sys.stdout.write("\x1b[2m" + reasoning + "\x1b[0m")
                            sys.stdout.flush()
                            thinking_streamed = True
                    elif chunk.get("type") == "progress":
                        # A-050: 工具进度条（视频/图片生成期间实时显示 0-100%）
                        progress_val = int(chunk.get("progress", 0) or 0)
                        name = chunk.get("name", "生成")
                        bar = "=" * (progress_val // 5) + "-" * (20 - progress_val // 5)
                        import sys as _sys
                        _sys.stdout.write(f"\r\u23F3 {name}中: [{bar}] {progress_val}%")
                        _sys.stdout.flush()
                        progress_active = True
                    elif chunk.get("type") == "tool":
                        # A3: 工具中间过程可视化（正文前按序输出）
                        if first_chunk:
                            stop_event[0] = True
                            anim_thread.join(timeout=1.0)
                            first_chunk = False
                            console.print()
                            _print_cyan_separator(agent_name)
                        if progress_active:
                            # 工具完成 → 进度条收尾换行
                            import sys as _sys
                            _sys.stdout.write("\n")
                            _sys.stdout.flush()
                            progress_active = False
                        if thinking_parts and not thinking_rendered:
                            # A-099: 实时模式下 thinking_parts 不累积（异常兜底路径保留）
                            _render_reasoning_panel("".join(thinking_parts))
                            thinking_rendered = True
                        # A-099-R 修复：Text 模块顶部已导入（L67）——此处局部 import 会使整个
                        # 函数内 Text 变局部变量，reasoning 分支（先执行）报 UnboundLocalError
                        call_line, result_line = _format_tool_event(
                            chunk.get("name", ""), chunk.get("args", ""), chunk.get("result", ""))
                        console.print(Text(call_line, style="bold cyan"))
                        if result_line:
                            console.print(Text(result_line, style="dim"))
                    elif chunk.get("type") == "done":
                        done_received = True
                        full_reply = chunk.get("reply", full_reply)
                        result_meta = chunk
                        break
                    elif chunk.get("type") == "error":
                        error_from_stream = True
                        full_reply = chunk.get("message", "[流式调用错误]")
                        result_meta = chunk
                        break

            # 确保动画已停止
            if first_chunk:
                stop_event[0] = True
                anim_thread.join(timeout=1.0)

            # 回复尾部的思考 Panel（A-099: 实时模式下思考已输出，仅异常残留兜底）
            thinking_rendered = _flush_thinking_panel(thinking_parts, thinking_rendered)

            # A-009: 正文后才到达的思考 → 结尾统一渲染，不破坏流式布局
            if late_thinking:
                _render_reasoning_panel("".join(late_thinking), title="后续思考")
                late_thinking = []

            # 打印回复尾部
            console.print()
            _print_cyan_separator()
            console.print()

            reply = full_reply

            # C5: 显示流式错误
            if error_from_stream:
                console.print(f"[red]流式错误: {full_reply}[/]")

            # C6: 流截断检测（A-009: 覆盖"仅思考无正文"静默断流场景）
            if not done_received and not error_from_stream:
                if full_reply:
                    console.print("\n[dim yellow]⚠ 回复可能被截断（连接中断）[/]")
                elif thinking_parts:
                    console.print("\n[dim yellow]⚠ 回复为空：仅收到思考内容（连接中断）[/]")

            # A-044: 幻觉护栏 —— 回复声称保存/生成的文件必须真实存在，否则红字警示
            _verify_claimed_files(full_reply)

            # 更新状态栏数据（total_tokens 为最近一次，prompt/completion 为累计）
            stats["total_tokens"] = result_meta.get("prompt_tokens", 0) + result_meta.get("completion_tokens", 0)
            stats["prompt_tokens"] += result_meta.get("prompt_tokens", 0)
            stats["completion_tokens"] += result_meta.get("completion_tokens", 0)
            stats["request_count"] += 1
            stats["last_elapsed_ms"] = int(result_meta.get("elapsed_ms", 0))

        except httpx.ConnectError:
            stop_event[0] = True
            anim_thread.join(timeout=1.0)
            _flush_thinking_panel(thinking_parts, thinking_rendered)  # A-009: 异常不丢思考
            reply = full_reply  # 保留已接收的部分内容
            console.print("[red]错误：无法连接到 slime 服务。请先启动 slime_server.py[/]")
            continue
        except httpx.HTTPStatusError as e:
            stop_event[0] = True
            anim_thread.join(timeout=1.0)
            _flush_thinking_panel(thinking_parts, thinking_rendered)
            reply = full_reply
            console.print(f"[red]API 错误: {e}[/]")
            continue
        except KeyboardInterrupt:
            stop_event[0] = True
            anim_thread.join(timeout=1.0)
            _flush_thinking_panel(thinking_parts, thinking_rendered)
            reply = full_reply
            console.print("\n[dim]已取消输入[/]")
            continue
        except Exception as e:
            stop_event[0] = True
            anim_thread.join(timeout=1.0)
            _flush_thinking_panel(thinking_parts, thinking_rendered)
            reply = full_reply
            console.print(f"[red]流式调用失败: {e}[/]")
            continue

        # N11-P2-12: 仅正常完成（done_received）才写历史，截断/异常不污染上下文
        if reply and not error_from_stream and done_received:
            history.append({"role": "user", "content": user_input})
            history.append({"role": "assistant", "content": reply})
        # 原地截断（闭包共享引用，不能 reassign）
        if len(history) > 40:
            del history[:-40]


# ── 聊天界面组件 ──────────────────────────────────────────

# 思考时的颜文字动画（GBK 安全字符）
_THINK_FACES = [
    "(o_o)", "(o.o)", "(-.-)", "(>_<)",
    "(O.O)", "(T_T)", "(=_=)", "(^o^)",
]

# 命令分组顺序（用于 /help 分组渲染；技能/MCP 为动态注册组，置后展示）
_CMD_GROUPS = ["系统", "对话", "查看", "配置", "模型", "高级", "技能", "MCP"]

# 命令注册表：desc=简要说明, group=所属分组, usage=用法
_CMD_SPECS = {
    # ── 系统 ──
    "/help":     {"desc": "显示帮助（/help 命令名 查看详情）", "group": "系统", "usage": "/help [命令]"},
    "/quit":     {"desc": "退出 Slime", "group": "系统", "usage": "/quit"},
    "/back":     {"desc": "退出对话，返回欢迎界面", "group": "系统", "usage": "/back"},
    "/clear":    {"desc": "清除屏幕", "group": "系统", "usage": "/clear"},
    "/?":        {"desc": "快捷帮助（同 /help）", "group": "系统", "usage": "/?"},
    # ── 对话 ──
    "/new":      {"desc": "清除对话历史，开始新对话", "group": "对话", "usage": "/new"},
    "/retry":    {"desc": "重试上一条消息", "group": "对话", "usage": "/retry"},
    "/export":   {"desc": "导出对话为 Markdown 文件", "group": "对话", "usage": "/export [文件名]"},
    "/history":  {"desc": "查看对话历史", "group": "对话", "usage": "/history [条数]"},
    # ── 查看 ──
    "/persona":  {"desc": "查看当前 Agent 人格", "group": "查看", "usage": "/persona"},
    "/status":   {"desc": "查看 Agent 生命周期状态", "group": "查看", "usage": "/status"},
    "/tokens":   {"desc": "本次会话 token 统计", "group": "查看", "usage": "/tokens"},
    "/tools":    {"desc": "查看已注册的工具", "group": "查看", "usage": "/tools"},
    "/children": {"desc": "查看 Agent 树（父/子关系）", "group": "查看", "usage": "/children"},
    "/agents":   {"desc": "列出所有 Agent", "group": "查看", "usage": "/agents"},
    # ── 配置 ──
    "/context":  {"desc": "配置上下文长度与最大输出", "group": "配置", "usage": "/context"},
    "/config":   {"desc": "查看全局配置总览", "group": "配置", "usage": "/config"},
    "/model":    {"desc": "快速切换模型（Provider）", "group": "配置", "usage": "/model [Provider名]"},
    "/provider": {"desc": "Provider 管理：/provider（向导）| list | del <key>", "group": "配置", "usage": "/provider [list|del <key>]"},
    # ── 高级 ──
    "/task":     {"desc": "创建 Swarm 任务（自动分裂子 Agent 并行执行）", "group": "高级", "usage": "/task"},
    "/review":   {"desc": "知识审查：整理记忆、强化 trait、归档过期 pattern", "group": "高级", "usage": "/review"},
    "/servers":  {"desc": "本地模型管理：列表/启停 chat（/servers start/stop chat）", "group": "模型", "usage": "/servers [start chat|stop chat]"},
    "/mcp":      {"desc": "MCP 服务器管理：列表/启停（/mcp start/stop <名称>）", "group": "高级", "usage": "/mcp [start|stop <名称>]"},
    "/talk":     {"desc": "切换到指定 Agent 对话（/talk <名称> 或 /talk list）", "group": "对话", "usage": "/talk <名称>"},
    "/auto":     {"desc": "切换自动 Swarm 模式（Agent 自动判断是否分裂执行）", "group": "高级", "usage": "/auto"},
    "/split":    {"desc": "分裂子 Agent", "group": "高级", "usage": "/split"},
    "/memory":   {"desc": "查看/搜索/添加 Agent 成长记忆", "group": "高级", "usage": "/memory [search <关键词>] | [add]"},
    "/evolve":   {"desc": "查看 Agent 演化状态", "group": "高级", "usage": "/evolve"},
    "/compress": {"desc": "手动压缩对话历史（LLM 摘要中间部分）", "group": "高级", "usage": "/compress"},
    "/tool":     {"desc": "手动调用工具", "group": "高级", "usage": "/tool <工具名> [JSON参数]"},
    "/skills":   {"desc": "查看已加载的技能列表", "group": "高级", "usage": "/skills"},
    "/mode":     {"desc": "设置 Agent 模式（plan/build）", "group": "配置", "usage": "/mode [plan|build]"},
    "/think":    {"desc": "设置推理强度（none/low/medium/high）", "group": "配置", "usage": "/think [none|low|medium|high]"},
    "/thinking": {"desc": "设置思考内容展示（on/off/auto）", "group": "配置", "usage": "/thinking [on|off|auto]"},
}


# ═══════════════════════════════════════════════════════════
# CLI 命令使用记忆（A-111）：艾宾浩斯遗忘曲线联动检索排序
# 模型对齐 core/memory.py:65-77（weight = exp(-days/τ)，τ = 5 天半衰期）：
#   命令 score = Σ exp(-(now - ts_i)/τ) —— 每次使用的记忆痕迹叠加，
#   效果：用得越多分越高、越近期越靠前、长期不用自然沉底（"不用就淡"）
# 数据源：~/.slime_usage.jsonl（每行 {"cmd": ..., "ts": epoch 秒}），
#   与 ~/.slime_history 同级用户目录；读写失败静默，绝不影响对话主流程
# 降级：无数据/异常 → 分数为空 → 稳定排序保持声明序（现行为不变）
# ═══════════════════════════════════════════════════════════
_USAGE_TAU = 5.0 * 86400.0  # 半衰期 5 天（秒），对齐 memory._EBBINGHAUS_TAU
_USAGE_FILE_OVERRIDE: Path | None = None  # 测试注入点（run_tests.py 无 monkeypatch，用模块变量）


def _usage_file() -> Path:
    """命令使用记录文件（可被测试覆盖）"""
    if _USAGE_FILE_OVERRIDE is not None:
        return _USAGE_FILE_OVERRIDE
    return Path.home() / ".slime_usage.jsonl"


def _usage_scores(file: Path | None = None) -> dict[str, float]:
    """艾宾浩斯权重：每命令累积痕迹 Σ exp(-Δt/τ) → 排序分数 {cmd: score}"""
    path = file or _usage_file()
    scores: dict[str, float] = {}
    try:
        now = time.time()
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    cmd = rec.get("cmd", "")
                    ts = float(rec.get("ts", 0))
                    if cmd and ts:
                        scores[cmd] = scores.get(cmd, 0.0) + math.exp(-(now - ts) / _USAGE_TAU)
                except Exception:
                    continue
    except Exception:
        pass
    return scores


def _record_usage(cmd: str, file: Path | None = None) -> None:
    """记录一次命令使用（追加 jsonl；失败静默不打扰对话）"""
    try:
        path = file or _usage_file()
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"cmd": cmd, "ts": time.time()}) + "\n")
    except Exception:
        pass


def _rank_by_usage(items: list, scores: dict | None = None) -> list:
    """稳定排序：高频/近期优先（艾宾浩斯分数降序）；无分数保持声明序（降级）"""
    if not items:
        return items
    sc = scores if scores is not None else _usage_scores()
    return sorted(items, key=lambda it: sc.get(it[0], 0.0), reverse=True)


# ═══════════════════════════════════════════════════════════
# 命令检索层（A-110 结构化重构：数据源 → 匹配策略 → 候选渲染）
# 设计不变式（tests/test_completer.py 固化，防回归红线）：
#   R1  任何 / 输入状态下候选集合非空（菜单永不静默消失）
#   R2  Enter 应用候选不破坏已有参数（空格分支空文本、fuzzy 只替换命令词）
#   R3  删除/编辑路径持续重算（session 挂 on_text_changed → start_completion）
#   R4  动态命令（技能/MCP 运行时注入 _CMD_SPECS）自动纳入所有检索层
#   R5  纯同步、无外部进程、无阻塞——不引入 ThreadedCompleter：
#       候选源为内存字典（~40 项）微秒级计算，线程化仅徒增调度抖动与竞态；
#       Hermes 线程化是因为其补全会 spawn rg/fd 进程（2s 超时），slime 无此负载
# ═══════════════════════════════════════════════════════════

def _cmd_names() -> list[str]:
    """数据源：全部命令名（含运行时注入的技能/MCP 动态命令）"""
    return list(_CMD_SPECS)


def _match_prefix(prefix: str) -> list:
    """策略一：前缀匹配 → [(cmd, spec)]（prefix 为去掉 / 的小写命令词）"""
    return [(c, s) for c, s in _CMD_SPECS.items() if c[1:].startswith(prefix)]


def _match_fuzzy(word: str) -> list:
    """策略二：fuzzy 相近匹配（difflib 序列比对，拼写容错）→ [(cmd, spec)]"""
    out = []
    for close in difflib.get_close_matches(word, [c[1:] for c in _CMD_SPECS], n=5, cutoff=0.5):
        out.append(("/" + close, _CMD_SPECS["/" + close]))
    return out


def _completion(cmd: str, spec: dict, start: int, fuzzy: bool = False) -> Completion:
    """渲染：候选 → Completion（fuzzy 候选带"拼写修正"标注）"""
    tag = "ansiyellow" if fuzzy else "ansicyan"
    suffix = "（相近命令）" if fuzzy else ""
    return Completion(
        cmd,
        start_position=start,
        display=HTML(f"<b>{cmd}</b>  <{tag}>— {escape(spec['desc'])}{suffix}</{tag}>"),
        display_meta="拼写修正" if fuzzy else None,
    )


class _SlashCompleter(Completer):
    """命令检索补全器：场景编排 + 候选渲染（匹配策略见 _match_prefix/_match_fuzzy）。
    - 空格分支（命令确定）：desc + usage 装饰提示（R2 空文本 Enter 无副作用；双候选保菜单 R1）
    - 命令词输入中：前缀匹配；完整命令名单候选会被 prompt_toolkit 丢弃（A-109-R）→ 补装饰候选
    - 无前缀匹配：fuzzy 兜底（R1 菜单不消失）"""
    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/"):
            return
        raw = text[1:]
        # ── 场景 A：命令词后已有空格（命令确定）──
        if " " in raw:
            cmd_part = raw.split()[0].lower()
            cmd = "/" + cmd_part
            spec = _CMD_SPECS.get(cmd)
            if spec:
                yield Completion(
                    "",
                    start_position=0,
                    display=HTML(f"<b>{cmd}</b>  <ansicyan>— {escape(spec['desc'])}</ansicyan>"),
                    display_meta=escape(spec["usage"]),
                )
                yield Completion(
                    "",
                    start_position=0,
                    display=HTML(f"<dim>用法：{escape(spec['usage'])}（输入参数后 Enter 执行）</dim>"),
                )
                return
            # 命令词拼错/不存在：fuzzy 修正（R2 参数保留——整行替换，参数拼入候选文本）
            args_part = raw[len(cmd_part):]
            for fix, fspec in _match_fuzzy(cmd_part):
                yield Completion(
                    fix + args_part,
                    start_position=-len(text),
                    display=HTML(f"<b>{fix}</b>  <ansiyellow>— {escape(fspec['desc'])}（相近命令）</ansiyellow>"),
                    display_meta="拼写修正",
                )
            return
        # ── 场景 B：命令词输入中 ──
        prefix = raw.lower()
        matched = _rank_by_usage(_match_prefix(prefix))  # A-111: 艾宾浩斯高频/近期优先
        # 完整命令名：单候选且无新增内容会被 prompt_toolkit 丢弃（A-109-R）→ 补装饰候选保菜单
        if len(matched) == 1 and matched[0][0][1:] == prefix:
            cmd, spec = matched[0]
            yield _completion(cmd, spec, -len(text))
            yield Completion(
                "",
                start_position=0,
                display=HTML(f"<dim>按空格查看参数用法 · 回车执行 · {escape(spec['usage'])}</dim>"),
            )
            return
        for cmd, spec in matched:
            yield _completion(cmd, spec, -len(text))
        # ── 场景 C：无前缀匹配 → fuzzy 兜底（R1 菜单不消失）──
        if not matched and len(prefix) >= 2:
            for cmd, spec in _match_fuzzy(prefix):
                yield _completion(cmd, spec, -len(text), fuzzy=True)


class _SlashAutoSuggest(AutoSuggest):
    """幽灵文本建议（A-110，参考 Hermes 分层）：
    - / 命令：唯一前缀匹配 → 幽灵补全剩余部分（如 /prov → 灰显 "ider"）
    - 普通文本：回退 AutoSuggestFromHistory（前缀匹配 ~/.slime_history）"""
    def __init__(self, history_suggest: AutoSuggestFromHistory):
        self._history = history_suggest

    def get_suggestion(self, buffer, document):
        text = document.text_before_cursor
        if text.startswith("/") and " " not in text:
            prefix = text[1:].lower()
            if not prefix:
                return None  # 仅 "/"：菜单已全列，无需幽灵
            if any(c[1:] == prefix for c in _CMD_SPECS):
                return None  # 命令已输完整
            cands = [c for c in _CMD_SPECS if c[1:].startswith(prefix)]
            if len(cands) == 1:
                return Suggestion(cands[0][1:][len(prefix):])
            return None
        return self._history.get_suggestion(buffer, document)


def _chat_key_bindings() -> KeyBindings:
    """对话输入键绑定（A-110）：Tab 三阶——补全菜单 > 幽灵文本 > 手动触发（Hermes 同款）"""
    kb = KeyBindings()

    @kb.add("tab", eager=True)
    def _handle_tab(event):
        buf = event.current_buffer
        if buf.complete_state:
            comp = buf.complete_state.current_completion
            if comp is not None:
                buf.apply_completion(comp)
            else:
                buf.start_completion(select_first=True)
        elif buf.suggestion and buf.suggestion.text:
            buf.insert_text(buf.suggestion.text)
        else:
            buf.start_completion()

    return kb


def _print_gray_separator():
    """灰色分割线（用户消息区域）"""
    w = shutil.get_terminal_size().columns
    console.print("─" * w, style="dim")


def _display_width(text: str) -> int:
    """计算字符串在终端中的显示宽度（中文=2列，英文=1列）"""
    w = 0
    for ch in text:
        if ord(ch) > 127:
            w += 2
        else:
            w += 1
    return w


def _print_cyan_separator(title: str = ""):
    """青色分割线（Agent 区域），标题居中嵌入线中"""
    w = shutil.get_terminal_size().columns
    if title:
        title_str = f" {title} "
        tw = _display_width(title_str)
        left = (w - tw) // 2
        right = w - tw - left
        line = "─" * left + title_str + "─" * right
    else:
        line = "─" * w
    console.print(line, style="bold cyan")


def _render_reasoning_panel(text: str, title: str = "思考") -> None:
    """渲染思考内容 Panel（正文之前 / 无正文时结尾渲染）。A-009: title 可定制（后续思考）。"""
    if not text.strip():
        return
    from rich.panel import Panel
    from rich.text import Text as _RT
    console.print(Panel(
        _RT(text),  # 用 Text() 包裹防 MarkupError
        title=f"[bold cyan]{title}[/bold cyan]",
        border_style="cyan",
        padding=(0, 1),
    ))
    console.print()


def _print_thinking_animation(stop_event: list):
    """原地刷新思考颜文字动画（不换行）"""
    idx = 0
    while not stop_event[0]:
        face = _THINK_FACES[idx % len(_THINK_FACES)]
        sys.stdout.write(f"\r  \033[90m{face}\033[0m \033[90mthinking...\033[0m          ")
        sys.stdout.flush()
        time.sleep(0.3)
        idx += 1
    # 清除动画行
    sys.stdout.write("\r" + " " * 50 + "\r")
    sys.stdout.flush()


def _show_commands_popup():
    """按分组渲染命令列表"""
    console.print()
    for group in _CMD_GROUPS:
        cmds = [(c, s) for c, s in _CMD_SPECS.items() if s["group"] == group]
        if not cmds:
            continue
        console.print(f"[bold bright_blue]━━ {group} ━━[/]")
        table = Table(box=box.SIMPLE, show_header=False, padding=(0, 1))
        table.add_column("命令", style="bold cyan", width=14)
        table.add_column("说明")
        for cmd, spec in cmds:
            table.add_row(cmd, spec["desc"])
        console.print(table)
        console.print()
    console.print("[dim]输入 /help <命令> 查看用法详情，未知命令会自动给出相近建议[/]")
    console.print()


def _show_command_detail(cmd: str):
    """显示单个命令的详情（desc + usage + group）"""
    spec = _CMD_SPECS.get(cmd)
    if not spec:
        console.print(f"[yellow]未知命令: {_rme(cmd)}[/]")
        close = difflib.get_close_matches(cmd, list(_CMD_SPECS), n=3, cutoff=0.6)
        if close:
            console.print("[yellow]你想输入的是：[/]")
            for c in close:
                console.print(f"  [cyan]{_rme(c)}[/]  {_rme(_CMD_SPECS[c]['desc'])}")
        return
    console.print()
    console.print(Panel(
        f"[bold cyan]{_rme(cmd)}[/]\n"
        f"[dim]分组:[/] {_rme(spec['group'])}\n"
        f"[dim]用法:[/] {_rme(spec['usage'])}\n"
        f"[dim]说明:[/] {_rme(spec['desc'])}",
        title=f"[bold bright_blue]命令详情[/]",
        border_style="bright_blue",
        box=box.ROUNDED,
    ))
    console.print()


def _dispatch_slash_command(cmd_raw: str, handlers: dict) -> bool:
    """统一命令分发器。
    返回 True 表示已处理（含未知命令提示），False 表示不是命令。
    匹配顺序：精确匹配 → 前缀唯一匹配（仅 _CMD_SPECS，不含别名）→ difflib 模糊建议。
    别名（如 /exit）仅参与精确匹配，不参与前缀匹配，避免 /exi 误触发。
    """
    parts = cmd_raw[1:].split(None, 1)
    cmd = "/" + parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""
    # 精确匹配（含别名）
    if cmd in handlers:
        handlers[cmd](args)
        return True
    # 前缀唯一匹配（仅对 _CMD_SPECS 中的公开命令，别名不参与）
    cands = [c for c in _CMD_SPECS if c.startswith(cmd)]
    if len(cands) == 1:
        console.print(f"[dim]按前缀匹配: {cands[0]}[/]")
        handlers[cands[0]](args)
        return True
    # 前缀多候选：直接列出，不走 difflib（避免短前缀误判）
    if len(cands) > 1:
        console.print(f"[yellow]多个命令以 '{cmd}' 开头：[/]")
        for c in cands:
            console.print(f"  [cyan]{c}[/]  {_CMD_SPECS[c]['desc']}")
        return True
    # 无前缀命中时，用 difflib 兜底拼写纠错（仅对长度 ≥4 的输入，避免短词噪声）
    if len(cmd) >= 4:
        close = difflib.get_close_matches(cmd, list(_CMD_SPECS), n=3, cutoff=0.6)
        if close:
            console.print("[yellow]未知命令，你想输入的是：[/]")
            for c in close:
                console.print(f"  [cyan]{c}[/]  {_CMD_SPECS[c]['desc']}")
            return True
    console.print("[yellow]未知命令，输入 / 或 /help 查看全部命令[/]")
    return True


def _cmd_list_providers():
    """查看已配置的 Provider（含主/子Agent分配、上下文、输出等信息）"""
    providers = _api("GET", "/providers")
    agents = _api("GET", "/agents")
    slime = next((a for a in agents if a["name"] == "Slime"), None)
    global_cfg = _api("GET", "/config/global")
    g_ctx = global_cfg.get("max_context", 4096)
    g_out = global_cfg.get("max_output", 2048)

    if not providers:
        console.print("[yellow]暂无 Provider 配置[/]")
        return

    # ── 主 Agent 信息 ─
    console.print()
    console.print("[bold cyan]━━━ 主 Agent (Slime) ━━━[/]")
    if slime:
        ctx_k = slime.get("max_context", g_ctx)
        out_k = slime.get("max_output", g_out)
        ctx_display = f"{ctx_k // 1024}K" if ctx_k >= 1024 else f"{ctx_k}"
        out_display = f"{out_k // 1024}K" if out_k >= 1024 else f"{out_k}"

        mc = slime.get("model_choice", "inherit")
        if mc.startswith("api:"):
            provider_key = mc[4:]
            provider_cfg = providers.get(provider_key, {})
            model = provider_cfg.get("model", "未知")
            api_base = provider_cfg.get("api_base", "未知")
            console.print(f"  模型:     [cyan]{_rme(str(model))}[/]  (Provider: {_rme(str(provider_key))})")
            console.print(f"  API 地址: {_rme(str(api_base))}")
        else:
            console.print(f"  模型选择: [yellow]{mc}[/]  [dim](未绑定 Provider)[/]")

        console.print(f"  上下文:   [cyan]{ctx_display}[/] ({ctx_k} tokens)")
        console.print(f"  最大输出: [cyan]{out_display}[/] ({out_k} tokens)")
    else:
        console.print("  [red]未找到 Slime Agent[/]")

    # ── Provider 列表 ──
    console.print()
    console.print("[bold cyan]━━━ 已配置的 Provider ━━━[/]")

    table = Table(box=box.ROUNDED)
    table.add_column("Key", style="cyan", min_width=10)
    table.add_column("API 地址", min_width=20)
    table.add_column("模型", min_width=16)
    table.add_column("用途", min_width=8)
    table.add_column("上下文", min_width=8)
    table.add_column("最大输出", min_width=8)

    # 判断哪些 Provider 被主 Agent 使用
    main_provider = None
    if slime and slime.get("model_choice", "").startswith("api:"):
        main_provider = slime["model_choice"][4:]

    for key, cfg in providers.items():
        api_base = cfg.get("api_base", "")
        model = cfg.get("model", "")

        if key == main_provider:
            usage = "[green]主[/]"
            # 主 Agent 的 Provider 行显示 Agent 的实际配置
            ctx_k = slime.get("max_context", g_ctx) if slime else g_ctx
            out_k = slime.get("max_output", g_out) if slime else g_out
        else:
            usage = "[yellow]子[/]"
            # 子 Agent Provider 优先显示 Provider 自身配置，未配置则显示全局默认值
            p_ctx = cfg.get("max_context") or 0
            p_out = cfg.get("max_output") or 0
            ctx_k = p_ctx if p_ctx else g_ctx
            out_k = p_out if p_out else g_out

        ctx_display = f"{ctx_k // 1024}K" if ctx_k >= 1024 else f"{ctx_k}"
        out_display = f"{out_k // 1024}K" if out_k >= 1024 else f"{out_k}"

        table.add_row(key, api_base, model, usage, ctx_display, out_display)

    console.print(table)
    console.print(f"[dim]  绿色=主Agent使用  黄色=子Agent使用[/]")


def _cmd_del_provider(key: str = ""):
    """删除 Provider（/provider del <key>）"""
    providers = _api("GET", "/providers")
    if not providers:
        console.print("[yellow]暂无 Provider 可删除[/]")
        return
    if key:
        if key not in providers:
            console.print(f"[yellow]Provider '{key}' 不存在，可用: {', '.join(providers)}[/]")
            return
    else:
        console.print("\n[bold cyan]选择要删除的 Provider：[/]")
        keys = list(providers.keys())
        for i, k in enumerate(keys):
            console.print(f"  [cyan]{i + 1}.[/] {k}")
        try:
            idx = int(ask("选择", default="1"))
            if not (1 <= idx <= len(keys)):
                return
            key = keys[idx - 1]
        except (ValueError, IndexError, KeyboardInterrupt, PromptCancelled):
            return
    # N11-P2-14: key 做 URL 净化，防 / ? # 等字符改变请求路径
    from urllib.parse import quote
    _api("DELETE", f"/providers/{quote(key, safe='')}")
    console.print(f"[green]√ 已删除 Provider '{key}'[/]")


def _cmd_add_provider():
    """添加/管理 API Provider"""
    console.print()
    console.print("[bold cyan]━━━ Provider 管理 ━━━[/]")
    console.print("  1. 添加新 Provider")
    console.print("  2. 查看已配置 Provider")
    console.print("  3. 删除 Provider")
    console.print("  0. 返回")

    choice = ask("选择", default="1", choices=["0", "1", "2", "3"])

    if choice == "0":
        return
    elif choice == "2":
        _cmd_list_providers()
        return
    elif choice == "3":
        _cmd_del_provider()
        return

    # 添加新 Provider
    console.print("\n[bold cyan]添加新 Provider[/]")
    provider_key = ask("  Provider 标识名", default="default")
    api_base = ask("  API 地址", default="https://api.openai.com")
    api_key_val = ask("  API Key", password=True)

    # 自动拉取模型列表
    console.print(f"[dim]  正在拉取模型列表...[/]")
    models = _fetch_models(api_base, api_key_val)
    if models:
        console.print(f"[dim]  找到 {len(models)} 个模型：[/]")
        for i, m in enumerate(models):
            console.print(f"    [cyan]{i + 1}.[/] {m}")
        try:
            idx = int(ask("  选择模型编号", default="1"))
            model = models[idx - 1] if 1 <= idx <= len(models) else models[0]
        except (ValueError, IndexError, KeyboardInterrupt, PromptCancelled):    model = models[0]
        console.print(f"[green]  已选: {model}[/]")
    else:
        console.print("[yellow]  无法拉取模型列表，请手动输入[/]")
        model = ask("  模型名", default="gpt-4o")

    # 显示全局默认值，让用户选择是否覆盖
    global_cfg = _api("GET", "/config/global")
    g_ctx = global_cfg.get("max_context", 4096)
    g_out = global_cfg.get("max_output", 2048)
    g_ctx_k = g_ctx // 1024 if g_ctx >= 1024 else g_ctx
    g_out_k = g_out // 1024 if g_out >= 1024 else g_out

    console.print(f"\n[bold cyan]配置此模型的上下文与输出：[/]")
    console.print(f"  [dim]全局默认: 上下文 {g_ctx_k}K / 输出 {g_out_k}K[/]")
    console.print("  1. 使用全局默认")
    console.print("  2. 使用预设方案")
    console.print("  3. 自定义（输入具体 K 值）")
    preset_choice = ask("选择", default="1", choices=["1", "2", "3"])

    if preset_choice == "1":
        max_ctx, max_out = g_ctx, g_out
        console.print(f"[dim]  → 使用全局默认: 上下文 {g_ctx_k}K / 输出 {g_out_k}K[/]")
    elif preset_choice == "2":
        console.print("\n  [bold cyan]预设方案：[/]")
        presets = [
            ("精简模式", 2, 0.5, "省 token，简单问答"),
            ("标准模式", 4, 2, "平衡性能与成本"),
            ("深度模式", 8, 4, "长对话，复杂任务"),
            ("极限模式", 32, 8, "超长上下文"),
        ]
        for i, (name, ctx_k, out_k, desc) in enumerate(presets):
            ctx_display = f"{int(ctx_k)}K" if ctx_k == int(ctx_k) else f"{ctx_k}K"
            out_display = f"{int(out_k)}K" if out_k == int(out_k) else f"{out_k}K"
            console.print(f"    [cyan]{i + 1}.[/] {name} — 上下文 {ctx_display} / 输出 {out_display}  [dim]({desc})[/]")
        max_ctx, max_out = g_ctx, g_out  # 默认值，防 OOB 越界不触发 except
        try:
            idx = int(ask("  选择预设", default="2"))
            if 1 <= idx <= len(presets):
                name, ctx_k, out_k, _ = presets[idx - 1]
                max_ctx = int(ctx_k * 1024)
                max_out = int(out_k * 1024)
        except (ValueError, IndexError, KeyboardInterrupt, PromptCancelled):
            pass  # 保留 g_ctx, g_out 默认值
    else:
        try:
            ctx_k = ask("  上下文长度 (K)", default=str(g_ctx_k))
            out_k = ask("  最大输出 (K)", default=str(g_out_k))
            max_ctx = int(float(ctx_k) * 1024)
            max_out = int(float(out_k) * 1024)
        except ValueError:
            max_ctx, max_out = g_ctx, g_out

    # 选择用途
    console.print("\n[bold cyan]选择此 Provider 的用途：[/]")
    console.print("  1. 主 Agent (Slime) 使用")
    console.print("  2. 子 Agent (Swarm 分裂) 使用")
    console.print("  3. 两者都用")
    usage = ask("选择", default="3", choices=["1", "2", "3"])

    _api("POST", "/providers", json={
        "key": provider_key,
        "api_base": api_base,
        "api_key": api_key_val,
        "model": model,
        "max_context": max_ctx,
        "max_output": max_out,
    })
    console.print(f"[green]√ Provider '{provider_key}' 已保存[/]")
    console.print(f"[dim]  → 模型: {model}[/]")

    # 根据用途绑定
    agents = _api("GET", "/agents")
    slime = next((a for a in agents if a["name"] == "Slime"), None)

    if usage in ("1", "3") and slime:
        _api("PATCH", f"/agents/{slime['id']}", json={
            "model_choice": f"api:{provider_key}",
            "max_context": max_ctx,
            "max_output": max_out,
        })
        console.print(f"[green]√ 已将 Slime 的模型切换为 {provider_key}[/]")
        console.print(f"[green]√ 上下文 {max_ctx} / 输出 {max_out} 已应用[/]")

    if usage in ("2", "3"):
        # 保存到配置，供 Swarm 使用
        console.print(f"[green]√ 此 Provider 可用于子 Agent 分裂[/]")


def _cmd_agents():
    """列出所有 Agent（名称/角色/lifecycle/模型）"""
    console.print()
    console.print("[bold cyan]━━━ 所有 Agent ━━━[/]")
    try:
        agents_list = _api("GET", "/agents")
    except SystemExit:
        return
    if not agents_list:
        console.print("[dim]暂无 Agent[/]")
        return
    lifecycle_map = {
        "birth": "初生", "growth": "成长", "specializing": "专精",
        "maturity": "成熟", "wise": "睿智", "dying": "衰退", "death": "归档",
    }
    table = Table(box=box.ROUNDED)
    table.add_column("名称", style="cyan")
    table.add_column("角色")
    table.add_column("生命周期", style="magenta")
    table.add_column("模型", style="yellow")
    for a in agents_list:
        mc = a.get("model_choice", "inherit")
        if mc.startswith("api:"):
            mc = mc[4:]
        table.add_row(
            a.get("name", ""),
            a.get("role", "")[:40],
            lifecycle_map.get(a.get("lifecycle", ""), a.get("lifecycle", "-")),
            mc,
        )
    console.print(table)


def _cmd_history(agent_id: str, agent_name: str, args: str):
    """查看对话历史（默认 40 条，与发送给 LLM 的会话窗口一致）"""
    limit = 40
    if args.strip().isdigit():
        limit = max(1, min(int(args.strip()), 200))
    console.print()
    console.print(f"[bold cyan]━━━ {agent_name} 最近 {limit} 条对话 ━━━[/]")
    try:
        records = _api("GET", f"/agents/{agent_id}/history", params={"limit": limit})
    except SystemExit:
        return
    if not records:
        console.print("[dim]暂无对话历史[/]")
        return
    for i, r in enumerate(records, 1):
        ts = r.get("timestamp", "")
        if ts:
            ts = ts[:19].replace("T", " ")
        console.print(f"[dim]── #{i}  {ts} ──[/]")
        console.print(f"[cyan]用户:[/] {_rme(str(r.get('user', '')))}")
        console.print(f"[green]回复:[/] {_rme(str(r.get('ai', ''))[:200])}")
        console.print()


def _cmd_export(agent_id: str, agent_name: str, args: str):
    """导出对话为 Markdown 文件（从 server 拉取持久化历史）。
    A-023: 拉取端点允许的最大条数（1000）——此前只拉 200，长对话导出静默截断。"""
    try:
        records = _api("GET", f"/agents/{agent_id}/history", params={"limit": 1000})
    except SystemExit:
        return
    if not records:
        console.print("[yellow]当前无对话历史可导出[/]")
        return
    if args.strip():
        filename = args.strip()
        if "/" in filename or "\\" in filename or ".." in filename or ":" in filename:
            console.print("[red]文件名不能包含路径分隔符、.. 或盘符[/]")
            return
        # Windows 保留名
        if filename.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4",
                                                "COM5", "COM6", "COM7", "COM8", "COM9",
                                                "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"}:
            console.print("[red]文件名使用了 Windows 保留名[/]")
            return
        if not filename.endswith(".md"):
            filename += ".md"
    else:
        filename = f"chat_{agent_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    lines = [f"# {agent_name} 对话记录\n"]
    lines.append(f"> 导出时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    lines.append(f"> 共 {len(records)} 条对话\n")
    for r in records:
        user_msg = r.get("user", "")
        ai_msg = r.get("ai", "")
        ts = r.get("timestamp", "")
        ts_str = f" _{ts[:19].replace('T', ' ')}_" if ts else ""
        lines.append(f"## 🧑 用户{ts_str}\n\n{user_msg}\n")
        lines.append(f"## 🤖 {agent_name}\n\n{ai_msg}\n")
    try:
        export_path = Path(filename)
        export_path.write_text("\n".join(lines), encoding="utf-8")
        console.print(f"[green]√ 已导出 {len(records)} 条对话到 {export_path.resolve()}[/]")
    except Exception as e:
        console.print(f"[red]导出失败: {e}[/]")


def _cmd_model(agent: dict, agent_id: str, agent_name: str, args: str):
    """快速切换模型（Provider）"""
    try:
        providers = _api("GET", "/providers")
    except SystemExit:
        return
    if not providers:
        console.print("[yellow]暂无 Provider，请先用 /provider 添加[/]")
        return
    keys = list(providers.keys())
    # 若 args 指定了 Provider 名，直接切换
    target = args.strip()
    if target:
        match = [k for k in keys if k.lower() == target.lower()]
        if not match:
            console.print(f"[yellow]未找到 Provider '{target}'，可用: {', '.join(keys)}[/]")
            return
        target = match[0]
    else:
        console.print()
        console.print(f"[bold cyan]━━━ {agent_name} 切换模型 ━━━[/]")
        for i, k in enumerate(keys):
            model = providers[k].get("model", "")
            console.print(f"  [cyan]{i + 1}.[/] {k}  [dim]({model})[/]")
        try:
            idx = int(ask("选择 Provider", default="1"))
            if not (1 <= idx <= len(keys)):
                return
            target = keys[idx - 1]
        except (ValueError, KeyboardInterrupt, PromptCancelled):
            return
    patch = {"model_choice": f"api:{target}"}
    # Provider 记录了上下文配置则一并同步（状态栏 context_max 即时刷新）
    p_ctx = providers[target].get("max_context") or 0
    p_out = providers[target].get("max_output") or 0
    if p_ctx:
        patch["max_context"] = p_ctx
        agent["max_context"] = p_ctx
    if p_out:
        patch["max_output"] = p_out
        agent["max_output"] = p_out
    _api("PATCH", f"/agents/{agent_id}", json=patch)
    # 同步更新 agent 实例，状态栏即时刷新
    agent["model_choice"] = f"api:{target}"
    note = f"，上下文 {p_ctx // 1024}K/输出 {p_out // 1024}K 已同步" if p_ctx and p_out else ""
    console.print(f"[green]√ {agent_name} 的模型已切换为 {target}{note}[/]")


def _cmd_tokens(stats: dict):
    """本次会话 token 统计"""
    console.print()
    console.print("[bold cyan]━━━ 本次会话统计 ━━━[/]")
    console.print(f"  请求次数:     [cyan]{stats.get('request_count', 0)}[/]")
    console.print(f"  Prompt tokens:     [cyan]{stats.get('prompt_tokens', 0)}[/]")
    console.print(f"  Completion tokens: [cyan]{stats.get('completion_tokens', 0)}[/]")
    console.print(f"  总 tokens:    [cyan]{stats.get('total_tokens', 0)}[/]")
    elapsed_ms = stats.get("last_elapsed_ms", 0)
    req_str = f"{elapsed_ms / 1000:.1f}".rstrip("0").rstrip(".") + "s" if elapsed_ms else "0s"
    console.print(f"  最近一次耗时: [cyan]{req_str}[/]")
    session_elapsed = int(time.time() - stats.get("session_start_time", time.time()))
    se_str = f"{session_elapsed // 60}m {session_elapsed % 60:02d}s" if session_elapsed >= 60 else f"{session_elapsed}s"
    console.print(f"  会话时长:     [cyan]{se_str}[/]")


def _cmd_config(agent: dict):
    """查看全局配置总览"""
    console.print()
    console.print("[bold cyan]━━━ 全局配置 ━━━[/]")
    try:
        cfg = _api("GET", "/config/global")
        providers = _api("GET", "/providers")
        agents_list = _api("GET", "/agents")
    except SystemExit:
        return
    ctx_k = cfg.get("max_context", 4096)
    out_k = cfg.get("max_output", 2048)
    ctx_display = f"{ctx_k // 1024}K" if ctx_k >= 1024 else f"{ctx_k}"
    out_display = f"{out_k // 1024}K" if out_k >= 1024 else f"{out_k}"
    console.print(f"  最大上下文: [cyan]{ctx_display}[/] ({ctx_k} tokens)")
    console.print(f"  最大输出:   [cyan]{out_display}[/] ({out_k} tokens)")
    console.print(f"  Provider 数: [cyan]{len(providers)}[/]")
    console.print(f"  Agent 数:    [cyan]{len(agents_list)}[/]")


def _cmd_status(agent_id: str, agent_name: str):
    """查看 Agent 生命周期状态概览"""
    console.print()
    console.print(f"[bold cyan]━━━ {agent_name} 生命周期 ━━━[/]")
    try:
        evolve = _api("GET", f"/agents/{agent_id}/evolve")
    except SystemExit:
        return
    lifecycle_map = {
        "birth": "初生", "growth": "成长", "specializing": "专精",
        "maturity": "成熟", "wise": "睿智", "dying": "衰退", "death": "归档",
    }
    console.print(f"  生命周期: [cyan]{lifecycle_map.get(evolve.get('lifecycle', ''), evolve.get('lifecycle', ''))}[/]")
    console.print(f"  总交互数: [cyan]{evolve.get('total_interactions', 0)}[/]")
    rate = evolve.get("success_rate", 0)
    rate_str = f"{rate:.1%}" if isinstance(rate, float) else str(rate)
    console.print(f"  成功率:   [cyan]{rate_str}[/]")
    last = evolve.get("last_active")
    if last:
        console.print(f"  最后活跃: [dim]{last[:19].replace('T', ' ')}[/]")


def _cmd_split(agent_id: str, agent_name: str):
    """分裂子 Agent"""
    console.print()
    console.print(f"[bold cyan]━━━ 从 {agent_name} 分裂子 Agent ━━━[/]")
    name = ask("  子 Agent 名称", default=f"{agent_name}-child")
    if not name.strip():
        return
    role = ask("  子 Agent 角色", default=name)
    console.print("  模型选择: 1.继承父 Agent  2.指定 Provider")
    mc = ask("选择", default="1", choices=["1", "2"])
    model_choice = "inherit"
    if mc == "2":
        try:
            providers = _api("GET", "/providers")
        except SystemExit:
            return
        if not providers:
            console.print("[yellow]暂无 Provider，将继承父 Agent[/]")
        else:
            keys = list(providers.keys())
            for i, k in enumerate(keys):
                console.print(f"    [cyan]{i + 1}.[/] {k} ({providers[k].get('model', '')})")
            try:
                idx = int(ask("  选择 Provider", default="1"))
                if 1 <= idx <= len(keys):
                    model_choice = f"api:{keys[idx - 1]}"
            except (ValueError, KeyboardInterrupt, PromptCancelled):
                pass
    try:
        child = _api("POST", f"/agents/{agent_id}/split", json={
            "name": name, "role": role, "model_choice": model_choice,
        })
    except SystemExit:
        return
    console.print(f"[green]√ 子 Agent '{_rme(str(child.get('name', name)))}' 已创建[/]")
    console.print(f"  ID: {_rme(str(child.get('id', '')))}")
    console.print(f"  角色: {_rme(str(child.get('role', role)))}")


def _cmd_children():
    """查看 Agent 树"""
    console.print()
    console.print("[bold cyan]━━━ Agent 树 ━━━[/]")
    try:
        tree = _api("GET", "/agents/tree")
    except SystemExit:
        return
    roots = tree.get("roots", [])
    if not roots:
        console.print("[dim]暂无 Agent[/]")
        return
    def _print_node(node, indent=0):
        prefix = "  " * indent + ("├─ " if indent > 0 else "")
        mc = node.get("model_choice", "inherit")
        if mc.startswith("api:"):
            mc = mc[4:]
        console.print(f"{prefix}[cyan]{node.get('name', '')}[/] [dim]({node.get('role', '')})[/] [yellow]{mc}[/]")
        for child in node.get("children", []):
            _print_node(child, indent + 1)
    for root in roots:
        _print_node(root)


def _cmd_tool_call(agent_id: str, args: str):
    """手动调用工具
    用法：
      /tool file_read                    → 交互式输入参数
      /tool file_read {"path":"x.txt"}   → 一行式传参
    """
    parts = args.strip().split(None, 1)
    if not parts or not parts[0]:
        console.print("[yellow]用法: /tool <工具名> [JSON参数]，先用 /tools 查看可用工具[/]")
        return
    tool_name = parts[0]
    tool_args = {}
    # 一行式：解析第二个 token 为 JSON
    if len(parts) > 1:
        raw = parts[1].strip()
        try:
            tool_args = json.loads(raw)
        except json.JSONDecodeError:
            console.print("[red]参数不是合法 JSON，已转为交互式[/]")
            tool_args = None
    # 无 JSON 或解析失败时回退交互式
    if tool_args is None or len(parts) == 1:
        console.print(f"[dim]调用工具: {_rme(tool_name)}[/]")
        raw_args = ask("  参数 (JSON 格式，留空则无参数)", default="")
        tool_args = {}
        if raw_args.strip():
            try:
                tool_args = json.loads(raw_args)
            except json.JSONDecodeError:
                console.print("[red]参数不是合法 JSON，已忽略[/]")
                tool_args = {}
    try:
        result = _api("POST", "/tools/call", json={"name": tool_name, "args": tool_args, "agent_id": agent_id})
    except SystemExit:
        return
    console.print(f"[green]√ 结果:[/]")
    console.print(_rme(str(result.get("result", ""))))


def _cmd_context(agent: dict):
    """配置全局上下文长度与最大输出（同步所有 Agent）"""
    # 从全局配置读取当前值
    global_cfg = _api("GET", "/config/global")
    cur_ctx = global_cfg.get("max_context", 4096)
    cur_out = global_cfg.get("max_output", 2048)

    console.print()
    console.print("[bold cyan]━━━ 全局上下文与输出配置 ━━━[/]")
    console.print(f"  当前上下文长度: [cyan]{cur_ctx // 1024}K[/] ({cur_ctx} tokens)")
    console.print(f"  当前最大输出:   [cyan]{cur_out // 1024}K[/] ({cur_out} tokens)")
    console.print(f"  [dim]修改后将同步所有在册 Agent[/]")
    console.print()
    console.print("  1. 修改上下文长度 (K)")
    console.print("  2. 修改最大输出 (K)")
    console.print("  3. 使用预设方案")
    console.print("  0. 返回")

    choice = ask("选择", default="0", choices=["0", "1", "2", "3"])

    if choice == "0":
        return
    elif choice == "1":
        val_k = ask("  上下文长度 (K)", default=str(cur_ctx // 1024))
        try:
            val = int(float(val_k) * 1024)
            if val < 256:
                val = 256
            if val > MAX_CONTEXT_LIMIT:
                val = MAX_CONTEXT_LIMIT
                console.print(f"[yellow]已限制为上限 {MAX_CONTEXT_LIMIT // 1024}K[/]")
            _api("PATCH", "/config/global", json={"max_context": val})
            # 同步刷新会话内 agent 实例，状态栏即时更新
            agent["max_context"] = val
            console.print(f"[green]√ 全局上下文长度已更新为 {val_k}K ({val} tokens)[/]")
            console.print(f"[dim]  → 已同步所有在册 Agent[/]")
        except ValueError:
            console.print("[red]请输入有效数字[/]")
    elif choice == "2":
        val_k = ask("  最大输出 (K)", default=str(cur_out // 1024))
        try:
            val = int(float(val_k) * 1024)
            if val < 64:
                val = 64
            if val > MAX_OUTPUT_LIMIT:
                val = MAX_OUTPUT_LIMIT
                console.print(f"[yellow]已限制为上限 {MAX_OUTPUT_LIMIT // 1024}K[/]")
            _api("PATCH", "/config/global", json={"max_output": val})
            # 同步刷新会话内 agent 实例
            agent["max_output"] = val
            console.print(f"[green]√ 全局最大输出已更新为 {val_k}K ({val} tokens)[/]")
            console.print(f"[dim]  → 已同步所有在册 Agent[/]")
        except ValueError:
            console.print("[red]请输入有效数字[/]")
    elif choice == "3":
        console.print("\n  [bold cyan]预设方案：[/]")
        presets = [
            ("精简模式", 2, 0.5, "省 token，适合简单问答"),
            ("标准模式", 4, 2, "平衡性能与成本"),
            ("深度模式", 8, 4, "长对话，复杂任务"),
            ("极限模式", 32, 8, "超长上下文，大量输出"),
        ]
        for i, (name, ctx_k, out_k, desc) in enumerate(presets):
            ctx_display = f"{int(ctx_k)}K" if ctx_k == int(ctx_k) else f"{ctx_k}K"
            out_display = f"{int(out_k)}K" if out_k == int(out_k) else f"{out_k}K"
            console.print(f"    [cyan]{i + 1}.[/] {name} — 上下文 {ctx_display} / 输出 {out_display}  [dim]({desc})[/]")
        try:
            idx = int(ask("  选择预设", default="2"))
            if 1 <= idx <= len(presets):
                name, ctx_k, out_k, _ = presets[idx - 1]
                ctx_val = int(ctx_k * 1024)
                out_val = int(out_k * 1024)
                _api("PATCH", "/config/global", json={"max_context": ctx_val, "max_output": out_val})
                # 同步刷新会话内 agent 实例
                agent["max_context"] = ctx_val
                agent["max_output"] = out_val
                ctx_display = f"{int(ctx_k)}K" if ctx_k == int(ctx_k) else f"{ctx_k}K"
                out_display = f"{int(out_k)}K" if out_k == int(out_k) else f"{out_k}K"
                console.print(f"[green]√ 已应用 [{name}]：上下文 {ctx_display} / 输出 {out_display}[/]")
                console.print(f"[dim]  → 已同步所有在册 Agent[/]")
        except (ValueError, IndexError, KeyboardInterrupt, PromptCancelled):    pass


def _cmd_memory(agent_id: str, agent_name: str, args: str = ""):
    """查看/搜索/添加 Agent 成长记忆
    用法：
      /memory                  → 查看记忆
      /memory search <关键词>   → 向量检索相关记忆（需开启 LanceDB）
      /memory add              → 交互式添加记忆
    """
    sub = args.strip().lower()
    if sub.startswith("search"):
        _cmd_memory_search(agent_id, agent_name, sub[6:].strip())
        return
    if sub == "add":
        _cmd_memory_add(agent_id, agent_name)
        return

    console.print()
    console.print(f"[bold cyan]━━━ {agent_name} 成长记忆 ━━━[/]")
    try:
        memory = _api("GET", f"/agents/{agent_id}/memory")
    except SystemExit:
        return

    facts = memory.get("facts", [])
    prefs = memory.get("preferences", [])
    skills = memory.get("skills_unlocked", [])
    lessons = memory.get("lessons", [])

    if not any([facts, prefs, skills, lessons]):
        console.print("[dim]暂无成长记忆，继续对话即可积累（/memory add 手动添加）[/]")
        return

    if facts:
        console.print("\n[bold]已知事实:[/]")
        for f in facts[-10:]:
            console.print(f"  [dim]·[/] {_rme(str(f.get('content', f)))}")

    if prefs:
        console.print("\n[bold]用户偏好:[/]")
        for p in prefs:
            console.print(f"  [dim]·[/] {_rme(str(p.get('key', '')))}: {_rme(str(p.get('value', '')))}")

    if skills:
        console.print("\n[bold]已解锁技能:[/]")
        for s in skills:
            console.print(f"  [dim]·[/] {_rme(str(s))}")

    if lessons:
        console.print("\n[bold]经验教训:[/]")
        for l in lessons[-10:]:
            icon = "[green]√[/]" if l.get("success") else "[red]×[/]"
            console.print(f"  {icon} {_rme(str(l.get('content', '')))}")


def _cmd_memory_search(agent_id: str, agent_name: str, query: str):
    """向量检索相关记忆（需要 LanceDB 已启用）"""
    if not query.strip():
        console.print("[yellow]用法: /memory search <关键词>[/]")
        return
    console.print()
    console.print(f"[bold cyan]━━━ 检索 {agent_name} 的记忆 ━━━[/]")
    console.print(f"[dim]关键词: {query}[/]")
    try:
        result = _api("POST", f"/agents/{agent_id}/memory/recall", json={"query": query, "top_k": 5})
    except SystemExit:
        return
    results = result.get("results", [])
    if not results:
        console.print("[dim]未找到相关记忆（LanceDB 可能未启用或无匹配）[/]")
        return
    console.print(f"\n[bold]找到 {len(results)} 条相关记忆:[/]\n")
    for i, r in enumerate(results, 1):
        role = r.get("role", "")
        content = r.get("content", "")
        console.print(f"  [cyan]#{i}[/] [{_rme(role)}] {_rme(content)}")


def _cmd_memory_add(agent_id: str, agent_name: str):
    """交互式添加成长记忆（对接 POST /agents/{id}/memory）"""
    console.print()
    console.print(f"[bold cyan]━━━ 为 {agent_name} 添加记忆 ━━━[/]")
    console.print("  1. 事实 (fact)")
    console.print("  2. 偏好 (preference)")
    console.print("  3. 技能 (skill)")
    console.print("  4. 教训 (lesson)")
    console.print("  0. 返回")
    choice = ask("选择类型", default="0", choices=["0", "1", "2", "3", "4"])
    if choice == "0":
        return
    payload = {}
    if choice == "1":
        val = ask("  事实内容")
        if val.strip():
            payload["fact"] = val.strip()
    elif choice == "2":
        key = ask("  偏好键名")
        val = ask("  偏好值")
        if key.strip() and val.strip():
            payload["preference"] = key.strip()
            payload["value"] = val.strip()
    elif choice == "3":
        val = ask("  技能名称")
        if val.strip():
            payload["skill"] = val.strip()
    elif choice == "4":
        val = ask("  教训内容")
        success = ask("  是否成功经验", default="y", choices=["y", "n"])
        if val.strip():
            payload["lesson"] = val.strip()
            payload["success"] = (success == "y")
    if not payload:
        console.print("[yellow]内容为空，已取消[/]")
        return
    try:
        _api("POST", f"/agents/{agent_id}/memory", json=payload)
        console.print(f"[green]√ 记忆已添加到 {agent_name}[/]")
    except SystemExit:
        pass


def _cmd_skills():
    """查看已加载的技能列表（A-096：优先走 server API——与 server 实际加载状态一致，
    避免 CLI 本地进程注册表与 server 不一致误导排障；server 未启动时 fallback 本地加载）"""
    console.print()
    console.print("[bold cyan]━━━ 已加载技能 ━━━[/]")
    try:
        skills = _api("GET", "/skills")
        if not skills:
            console.print("[dim]暂无技能，将 config/skills/ 下的目录放入即可[/]")
            return
        for i, s in enumerate(skills, 1):
            name = s.get("name", "?")
            desc = s.get("description", "")
            perms = s.get("permissions", {})
            perm_str = ", ".join(k for k, v in perms.items() if v) if isinstance(perms, dict) else ""
            console.print(f"  [cyan]{i}.[/] [bold]{name}[/]  [dim]({perm_str})[/]")
            if desc:
                console.print(f"     {desc}")
    except Exception:
        # server 未启动/API 失败 → fallback 本地加载（CLI 独立运行场景）
        try:
            from core.skill_engine import get_registry as get_skill_registry
            skill_reg = get_skill_registry()
            if not skill_reg._loaded:
                skill_reg.load_skills()
            skills = list(skill_reg._skills.values())
            if not skills:
                console.print("[dim]暂无技能，将 config/skills/ 下的目录放入即可[/]")
                return
            for i, s in enumerate(skills, 1):
                perms = s.manifest.permissions
                perm_str = ", ".join(k for k, v in perms.items() if v)
                console.print(f"  [cyan]{i}.[/] [bold]{s.name}[/]  [dim]({perm_str})[/]")
                console.print(f"     {s.description}")
        except Exception as e:
            console.print(f"[red]加载技能失败: {e}[/]")


def _cmd_mode(agent: dict, agent_id: str, agent_name: str, args: str = ""):
    """设置 Agent 模式（plan/build），无参数时显示当前值"""
    valid_modes = ("plan", "build")
    if not args.strip():
        cur = agent.get("mode", "build")
        console.print(f"[yellow]用法: /mode [plan|build][/]\n      当前模式: [cyan]{cur}[/]")
        return
    mode = args.strip().lower()
    if mode not in valid_modes:
        console.print(f"[red]无效模式: {mode}，可选: {', '.join(valid_modes)}[/]")
        return
    try:
        _api("PATCH", f"/agents/{agent_id}", json={"mode": mode})
        agent["mode"] = mode  # 同步本地字典（状态栏徽标即时生效）
        console.print(f"[green]√ 已切换到 {mode} 模式[/]")
    except SystemExit:
        pass


def _cmd_think(agent: dict, agent_id: str, agent_name: str, args: str = ""):
    """设置推理强度（none/low/medium/high），无参数时显示当前值"""
    valid_efforts = ("none", "low", "medium", "high")
    if not args.strip():
        cur = agent.get("reasoning_effort", "none")
        console.print(f"[yellow]用法: /think [none|low|medium|high][/]\n      当前: [cyan]{cur}[/]")
        return
    effort = args.strip().lower()
    if effort not in valid_efforts:
        console.print(f"[red]无效强度: {effort}，可选: {', '.join(valid_efforts)}[/]")
        return
    try:
        _api("PATCH", f"/agents/{agent_id}", json={"reasoning_effort": effort})
        agent["reasoning_effort"] = effort
        console.print(f"[green]√ 推理强度已设为 {effort}[/]")
    except SystemExit:
        pass


def _cmd_thinking(agent: dict, agent_id: str, agent_name: str, args: str = ""):
    """设置思考内容展示（on/off/auto），无参数时显示当前值"""
    valid_modes = ("on", "off", "auto")
    if not args.strip():
        cur = agent.get("show_thinking", "off")
        console.print(f"[yellow]用法: /thinking [on|off|auto][/]\n      当前: [cyan]{cur}[/]")
        return
    mode = args.strip().lower()
    if mode not in valid_modes:
        console.print(f"[red]无效值: {mode}，可选: {', '.join(valid_modes)}[/]")
        return
    try:
        _api("PATCH", f"/agents/{agent_id}", json={"show_thinking": mode})
        agent["show_thinking"] = mode
        console.print(f"[green]√ 思考展示已设为 {mode}[/]")
    except SystemExit:
        pass


def _cmd_evolve(agent_id: str, agent_name: str):
    """查看 Agent 演化状态"""
    console.print()
    console.print(f"[bold cyan]━━━ {agent_name} 演化状态 ━━━[/]")
    try:
        evolve = _api("GET", f"/agents/{agent_id}/evolve")
    except SystemExit:
        return

    lifecycle_map = {
        "birth": "初生",
        "growth": "成长",
        "specializing": "专精",
        "maturity": "成熟",
        "wise": "睿智",
        "dying": "衰退",
        "death": "归档",
    }

    console.print(f"  生命周期: [cyan]{lifecycle_map.get(evolve.get('lifecycle', ''), evolve.get('lifecycle', ''))}[/]")
    console.print(f"  总交互数: [cyan]{evolve.get('total_interactions', 0)}[/]")
    rate = evolve.get("success_rate", 0)
    rate_str = f"{rate:.1%}" if isinstance(rate, float) else str(rate)
    console.print(f"  成功率:   [cyan]{rate_str}[/]")
    last = evolve.get("last_active")
    if last:
        console.print(f"  最后活跃: [dim]{last}[/]")


def _cmd_tools():
    """查看已注册的工具"""
    console.print()
    console.print("[bold cyan]━━━ 已注册工具 ━━━[/]")
    try:
        tools = _api("GET", "/tools")
    except SystemExit:
        return

    if not tools:
        console.print("[dim]暂无注册工具[/]")
        return

    table = Table(box=box.ROUNDED)
    table.add_column("工具名", style="cyan")
    table.add_column("描述")
    for tool in tools:
        func = tool.get("function", {})
        table.add_row(
            func.get("name", ""),
            func.get("description", ""),
        )
    console.print(table)


def _cmd_compress(agent_id: str, agent_name: str, history: list[dict]):
    """手动压缩对话历史"""
    console.print()
    console.print(f"[bold cyan]━━━ {agent_name} 上下文压缩 ━━━[/]")

    if not history:
        console.print("[dim]无对话历史，无需压缩[/]")
        return

    console.print(f"[dim]当前 {len(history)} 条对话，正在压缩...[/]")
    try:
        result = _api("POST", f"/agents/{agent_id}/compress", json={"history": history})
    except SystemExit:
        return

    if result.get("compressed"):
        before = result["before"]
        after = result["after"]
        console.print(f"[green]{result['message']}[/]")
        console.print(f"[dim]压缩前: {before} 条 → 压缩后: {after} 条[/]")
        # 用服务器压缩结果原地更新会话历史（闭包共享同一列表对象）
        compressed = result.get("history")
        if compressed:
            history.clear()
            history.extend(compressed)
            console.print(f"[dim]会话历史已更新，后续请求将使用压缩后内容[/]")
    else:
        console.print(f"[yellow]{result['message']}[/]")


def _print_user_message(text: str):
    """用户消息已在输入框中显示，无需重复打印"""
    pass


def _print_agent_reply(agent_name: str, reply: str):
    """打印 Agent 回复（青色分割线包裹）"""
    console.print()
    _print_cyan_separator(agent_name)
    console.print(_md(reply))
    _print_cyan_separator()
    console.print()


# ── CLI 命令 ──────────────────────────────────────────────


@click.group(invoke_without_command=True)
@click.version_option(version="0.1.0")
@click.pass_context
def cli(ctx):
    """slime - 专属 AI Agent 平台

    启动后输入 Agent 名称即可进入对话。

    其他命令：

        slime_cli.py wizard    首次向导
        slime_cli.py status    查看状态
        slime_cli.py providers 查看 Provider
    """
    # 初始化沙箱系统：注入 CLI 确认回调 + 从 slime.toml 加载配置
    from core.sandbox import reset_sandbox_manager, SandboxConfig, cli_approval_callback
    _toml_path = Path(__file__).parent / "slime.toml"
    sandbox_cfg = SandboxConfig()
    try:
        try:
            import tomllib
            with open(_toml_path, "rb") as f:
                toml_data = tomllib.load(f)
            sandbox_cfg = SandboxConfig.from_dict(toml_data.get("sandbox", {}))
        except ImportError:
            pass
    except Exception:
        pass
    reset_sandbox_manager(config=sandbox_cfg, approval_callback=cli_approval_callback)

    if ctx.invoked_subcommand is None:
        _entry_loop()


@cli.command()
def wizard():
    """首次启动向导：创建你的第一个 Agent"""
    console.print("[bold cyan]slime[/] [magenta]v0.1.0[/]")
    console.print("[bold]欢迎来到 slime！让我们创建你的第一个 Agent。[/]\n")

    if not _check_server():
        console.print("[yellow]slime 服务未运行。正在启动...[/]")
        import subprocess
        import time
        subprocess.Popen(
            [sys.executable, "slime_server.py"],
            cwd=Path(__file__).parent,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # 重试等待，最多 10 秒
        for _ in range(10):
            time.sleep(1)
            if _check_server():
                console.print("[green]服务已启动[/]")
                break
        else:
            console.print("[red]服务启动失败，请手动运行 slime_server.py[/]")
            return

    # 步骤 1：命名
    console.print("[bold cyan]步骤 1/4：给你的 Agent 起个名字[/]")
    name = safe_ask("Agent 名称", default="Slime")
    if name is None:
        console.print("[yellow]已取消[/]"); return

    # 步骤 2：角色
    console.print("\n[bold cyan]步骤 2/4：定义 Agent 的角色[/]")
    role = safe_ask("角色描述", default="你的专属 AI 助手")
    if role is None:
        console.print("[yellow]已取消[/]"); return

    # 步骤 3：身份提示
    console.print("\n[bold cyan]步骤 3/4：自定义身份提示（可选）[/]")
    console.print("[dim]描述 Agent 的性格、说话风格、知识领域等[/]")
    identity_prompt = safe_ask("身份提示", default="")
    if identity_prompt is None:
        console.print("[yellow]已取消[/]"); return

    # 步骤 4：模型配置
    console.print("\n[bold cyan]步骤 4/4：配置模型[/]")
    console.print("  1. API 模型（OpenAI 兼容接口）")
    console.print("  2. 本地 GGUF 模型")
    console.print("  3. 跳过（稍后配置）")

    choice = safe_ask("选择", default="3", choices=["1", "2", "3"])
    if choice is None:
        console.print("[yellow]已取消[/]"); return

    model_choice = "inherit"
    provider_count = 0

    if choice == "1":
        console.print("[dim]可以连续输入多个 Provider（输入空标识名结束）[/]")
        console.print("[dim]Provider 数量决定 Swarm 分裂上限[/]")
        first_provider = ""
        while True:
            provider_key = safe_ask("  Provider 标识名", default="")
            if provider_key is None:
                console.print("[yellow]已取消[/]"); return
            if not provider_key.strip():
                if provider_count == 0:
                    provider_key = "default"
                    provider_count += 1
                else:
                    break
            else:
                provider_count += 1

            api_base = safe_ask("    API 地址", default="https://api.openai.com")
            if api_base is None:
                console.print("[yellow]已取消[/]"); return
            api_key_val = safe_ask("    API Key", password=True)
            if api_key_val is None:
                console.print("[yellow]已取消[/]"); return

            # 自动拉取模型列表
            console.print(f"[dim]    正在拉取模型列表...[/]")
            models = _fetch_models(api_base, api_key_val)
            selected_model = ""
            if models:
                console.print(f"[dim]    找到 {len(models)} 个模型：[/]")
                for i, m in enumerate(models):
                    console.print(f"      [cyan]{i + 1}.[/] {m}")
                console.print(f"  [dim]输入序号选择，或直接输入模型名（回车选第1个）[/]")
                model_sel = safe_ask("    选择模型", default="1")
                if model_sel is None:
                    console.print("[yellow]已取消[/]"); return
                if model_sel.strip().isdigit():
                    idx = int(model_sel.strip()) - 1
                    if 0 <= idx < len(models):
                        selected_model = models[idx]
                if not selected_model:
                    # 非纯数字（或无效序号）→ 当作模型名，但拒绝非法输入
                    candidate = model_sel.strip()
                    if candidate.isdigit() or candidate.lstrip("-").isdigit():
                        candidate = models[0] if models else "gpt-4o-mini"
                        console.print(f"[yellow]无效序号，使用默认: {candidate}[/]")
                    selected_model = candidate if candidate else (models[0] if models else "gpt-4o-mini")
            else:
                console.print(f"[yellow]    未拉取到模型列表，请手动输入模型名[/]")
                selected_model = safe_ask("    模型名", default="gpt-4o-mini")
                if selected_model is None:
                    console.print("[yellow]已取消[/]"); return

            # 保存 Provider（加密存储）
            try:
                _api("POST", "/providers", json={
                    "key": provider_key,
                    "api_base": api_base,
                    "api_key": api_key_val,
                    "model": selected_model,
                })
                console.print(f"[green]    √ Provider '{provider_key}' 已保存（模型: {selected_model}）[/]")
            except (Exception, SystemExit) as e:
                console.print(f"[red]    保存 Provider 失败: {e}[/]"); return

            if not first_provider:
                first_provider = provider_key
            model_choice = f"api:{first_provider}"

    elif choice == "2":
        console.print("[dim]本地 GGUF 模型已支持，稍后可用 /servers 命令管理（下载/启停 chat 模型）。[/]")
        console.print("[dim]当前 Agent 先用 inherit 模式，配置本地模型后可 /model 切换。[/]")
    else:
        console.print("[dim]已跳过模型配置，Agent 将使用 inherit 模式。[/]")

    # 创建 Agent
    try:
        agent_data = _api("POST", "/agents", json={
            "name": name,
            "role": role,
            "identity_prompt": identity_prompt,
            "model_choice": model_choice,
        })
    except (Exception, SystemExit) as e:
        console.print(f"[red]创建 Agent 失败: {e}[/]")
        return

    console.print()
    console.print(f"[green bold]√ 配置完成！[/]")
    console.print(f"[cyan]Agent:[/] {agent_data.get('name', name)}")
    console.print(f"[cyan]角色:[/] {role}")
    console.print(f"[cyan]模型:[/] {model_choice}")
    console.print()
    console.print(f"[bold]现在输入 [cyan]slime[/] 即可开始对话。[/]")


@cli.command()
def status():
    """查看 Agent 状态"""
    if not _check_server():
        console.print("[red]slime 服务未运行[/]")
        return

    try:
        agents_list = _api("GET", "/agents")
    except SystemExit:
        console.print("[red]获取 Agent 列表失败[/]")
        return
    if not agents_list:
        console.print("[yellow]暂无 Agent，运行 wizard 创建[/]")
        return

    table = Table(title="Agent 状态", border_style="cyan", box=box.ROUNDED)
    table.add_column("名称", style="cyan")
    table.add_column("角色", style="white")
    table.add_column("模型", style="yellow")
    table.add_column("生命周期", style="magenta")

    for a in agents_list:
        mc = a.get("model_choice", "inherit")
        table.add_row(
            a.get("name", ""),
            a.get("role", "")[:30],
            mc,
            a.get("lifecycle", "-"),
        )

    console.print(table)


@cli.command()
def providers():
    """查看已配置的 Provider"""
    if not _check_server():
        console.print("[red]slime 服务未运行[/]")
        return

    try:
        data = _api("GET", "/providers")
    except Exception as e:
        console.print(f"[red]获取 Provider 列表失败: {e}[/]")
        return

    if not data:
        console.print("[yellow]暂无 Provider，运行 wizard 配置[/]")
        return

    table = Table(title="Provider 列表", border_style="cyan", box=box.ROUNDED)
    table.add_column("标识名", style="cyan")
    table.add_column("API 地址", style="white")
    table.add_column("模型", style="yellow")

    for key, cfg in data.items():
        if isinstance(cfg, dict):
            table.add_row(
                key,
                cfg.get("api_base", ""),
                cfg.get("model", ""),
            )

    console.print(table)


# ── Swarm 命令（本地执行，不依赖 server）──────────────────

@cli.command()
@click.argument("task", required=False)
@click.option("--max-workers", "-m", default=2, type=int, help="最大并发数")
@click.option("--agent", "-a", default=None, type=str, help="指定主 Agent 名称")
def swarm(task, max_workers, agent):
    """Swarm 任务：自动分裂子 Agent 并行执行

    用法: slime_cli.py swarm "你的任务" [--max-workers M]

    如果不提供 task 参数，进入交互模式。
    """
    from core.encryption import decrypt
    from core.agent import load_agents
    from core.executor import SwarmExecutor

    # 加载配置
    providers = decrypt() or {}
    if not providers:
        console.print("[red]未配置任何 Provider，请先运行 wizard 配置 API。[/]")
        return

    agents_list = load_agents()
    if not agents_list:
        console.print("[red]没有 Agent，请先运行 wizard 创建。[/]")
        return

    # 选择主 Agent
    main_agent = _pick_main_agent(agents_list, preferred=agent)
    if not main_agent:
        return

    # 获取任务描述
    if not task:
        console.print("[bold cyan]━━━ Swarm 任务模式 ━━━[/]")
        console.print(f"[dim]当前 Provider 数量: {len(providers)} | 并发上限: {max_workers}[/]")
        try:
            task = safe_ask("[bold cyan]任务描述[/]")
        except (KeyboardInterrupt, EOFError):
            return
        if task is None:
            return
        if not task.strip():
            return

    console.print(f"\n[bold cyan]━━━ Slime Swarm ━━━[/]")
    console.print(f"[dim]主 Agent: {main_agent.name}[/]")
    console.print(f"[dim]Provider: {len(providers)} 个 | 并发: {max_workers}[/]")
    console.print(f"[dim]任务: {task}[/]")
    console.print()

    # 进度回调
    def on_progress(stage: str, msg: str):
        console.print(f"[dim][{stage}] {msg}[/]")

    # 命名回调（交互式）：A-051 增强——先展示拆解结果，允许用户逐个修改子任务描述，
    # 再命名。executor 传入的 subtasks_desc 为同一引用，修改即生效（可定义环节）。
    def on_naming(subtasks_desc: list[str]) -> list[str]:
        console.print(f"\n[bold cyan]拆解出 {len(subtasks_desc)} 个子任务（可修改描述，回车保留）[/]")
        for i, desc in enumerate(subtasks_desc):
            console.print(f"  [dim]{i + 1}. {desc}[/]")
            try:
                new_desc = safe_ask(f"  子任务 {i + 1} 描述（回车保留）", default=desc)
            except (KeyboardInterrupt, EOFError):
                new_desc = None
            if new_desc and new_desc.strip():
                subtasks_desc[i] = new_desc.strip()
        console.print(f"\n[bold cyan]为子 Agent 命名（回车用默认名）[/]")
        names = []
        for i, desc in enumerate(subtasks_desc):
            try:
                name = safe_ask(f"  Worker-{i + 1}", default=f"Worker-{i + 1}")
            except (KeyboardInterrupt, EOFError):
                name = f"Worker-{i + 1}"
            if name is None:
                name = f"Worker-{i + 1}"
            names.append(name)
        return names

    # 完成回调
    def on_complete(merge_result, agent_snapshots):
        console.print()
        _print_cyan_separator("合并结果")
        console.print(_md(merge_result.summary))
        _print_cyan_separator()
        console.print()

        console.print(f"[bold]{merge_result.final_verdict}[/]")
        if merge_result.trial_log:
            console.print(f"[dim]{merge_result.trial_log}[/]")

        # 提示可提升
        if agent_snapshots:
            console.print()
            console.print("[bold bright_blue]可提升的子 Agent：[/]")
            for snap in agent_snapshots:
                status_icon = "√" if snap["state"] == "done" else "×"
                console.print(
                    f"  [cyan]{snap['name']}[/] {status_icon} "
                    f"[dim]{snap['role'][:60]}[/]"
                )
            console.print(f"\n[dim]使用 slime_cli.py promote <Agent名> <角色> 提升为持久 Agent[/]")

    # A-066: Worker 轮次耗尽交互（用户选择 重置/升级/终止）
    def on_round_exhausted(worker_name: str, rounds: int) -> str:
        console.print(f"\n[bold yellow]⚠ Worker「{worker_name}」已达 {rounds}/5 轮上限（仍未确认完成）[/]")
        console.print("  请选择下一步：")
        console.print("  [cyan]1[/] 重置为 0/5 重新开始")
        console.print("  [cyan]2[/] 暂时提升为 10 次调用（0/10，失败后再弹窗）")
        console.print("  [cyan]3[/] 终止该 Worker")
        try:
            choice = safe_ask("  选择 (1/2/3)", default="1")
        except (KeyboardInterrupt, EOFError):
            return "terminate"
        return {"1": "reset", "2": "upgrade", "3": "terminate"}.get(str(choice).strip(), "reset")

    # 执行
    executor = SwarmExecutor(providers, main_agent, agents_list)
    result = executor.run(
        task=task,
        max_workers=max_workers,
        on_naming=on_naming,
        on_progress=on_progress,
        on_complete=on_complete,
        on_round_exhausted=on_round_exhausted,
    )

    if result.get("error"):
        console.print(f"[red]{result['error']}[/]")

    # A-059: Swarm 视频分段自动拼接结果展示
    concat_video = result.get("concat_video") or ""
    if concat_video:
        console.print()
        console.print(f"[bold green]🎬 分段视频已自动拼接为完整视频：[/]")
        console.print(f"  [cyan]{concat_video}[/]")

    # A-031/A-051: Swarm 经验沉淀上报（best-effort，失败不影响主流程）
    if not result.get("error"):
        mr = result.get("merge_result")
        summary_text = mr.summary if mr and hasattr(mr, "summary") else ""
        if summary_text:
            _report_swarm(main_agent.id, task, summary_text, result.get("agent_snapshots", []))


@cli.command()
@click.argument("name")
@click.argument("role", required=False)
def promote(name, role):
    """将 Swarm 子 Agent 提升为持久 Agent（走 server API，消除双写竞态）

    用法: slime_cli.py promote <Agent名> [角色描述]
    """
    # 通过 server API 获取 Agent 列表
    try:
        raw_agents = _api("GET", "/agents")
    except SystemExit:
        return

    if not raw_agents:
        console.print("[red]没有 Agent，请先创建主 Agent。[/]")
        return

    # 找到主 Agent（Slime）
    main = _pick_main_agent(raw_agents)
    if not main:
        console.print("[red]找不到主 Agent（需要名为 Slime 的 Agent）。[/]")
        return

    # 检查是否已存在同名 Agent
    if any(a["name"] == name for a in raw_agents):
        console.print(f"[yellow]Agent '{name}' 已存在[/]")
        return

    if not role:
        role = name

    # 通过 server API 创建持久 Agent
    new_agent = _api("POST", "/agents", json={
        "name": name,
        "role": role,
        "identity_prompt": f"由 Swarm 子 Agent {name} 提升而来",
        "model_choice": "inherit",
    })

    # 通过 server API 将新 Agent 挂到主 Agent 的 children
    children = list(main.children)
    children.append(new_agent["id"])
    _api("PATCH", f"/agents/{main.id}", json={"children": children})

    console.print(f"[green]√ Agent '{name}' 已提升为持久 Agent[/]")
    console.print(f"  ID: {new_agent['id']}")
    console.print(f"  角色: {new_agent['role']}")
    console.print(f"  父 Agent: {main.name}")


def _pick_main_agent(agents_list: list, preferred: str = None) -> Any:
    """选择主 Agent（优先 preferred，其次 Slime，否则交互选择）"""
    from core.agent import Agent as AgentCls

    # 如果指定了 preferred，优先匹配
    if preferred:
        for a in agents_list:
            name = a["name"] if isinstance(a, dict) else a.name
            if name.lower() == preferred.lower():
                return a if isinstance(a, AgentCls) else AgentCls.from_dict(a)
        console.print(f"[yellow]找不到指定 Agent '{preferred}'，回退到默认选择[/]")

    # 优先找 name == "Slime" 的
    for a in agents_list:
        if isinstance(a, dict):
            if a.get("name") == "Slime":
                return AgentCls.from_dict(a)
        elif a.name == "Slime":
            return a

    # 只有一个，直接返回
    if len(agents_list) == 1:
        a = agents_list[0]
        if isinstance(a, dict):
            return AgentCls.from_dict(a)
        return a

    # 交互选择
    console.print("[bold cyan]选择主 Agent：[/]")
    for i, a in enumerate(agents_list):
        name = a["name"] if isinstance(a, dict) else a.name
        role = a["role"] if isinstance(a, dict) else a.role
        console.print(f"  [cyan]{i + 1}.[/] {name} [dim]({role})[/]")

    try:
        idx = int(ask("选择", default="1"))
        a = agents_list[idx - 1]
    except (ValueError, IndexError, KeyboardInterrupt, PromptCancelled):
        return None

    if isinstance(a, dict):
        return AgentCls.from_dict(a)
    return a


# ── 入口 ──────────────────────────────────────────────────

if __name__ == "__main__":
    cli()