"""
slime Multiplexer - Zellij 风格终端分屏 UI
- 在终端中分割多个面板，每个面板显示一个子 Agent 的执行状态
- 所有子 Agent 完成后自动合并关闭分屏
- 支持 Windows VT 终端 + CJK 字符宽度
"""

import os
import sys
import time
import shutil
import threading
from dataclasses import dataclass, field
from typing import Callable

# ── Windows VT 终端启用 ──────────────────────────────────

if sys.platform == "win32":
    import ctypes
    kernel32 = ctypes.windll.kernel32
    ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
    ENABLE_PROCESSED_OUTPUT = 0x0001
    INVALID_HANDLE_VALUE = -1

    for std_handle in (-11, -12):  # STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
        handle = kernel32.GetStdHandle(std_handle)
        if handle != INVALID_HANDLE_VALUE:
            mode = ctypes.c_ulong()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                kernel32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT)


# ── CJK 宽度计算 ─────────────────────────────────────────

try:
    from wcwidth import wcswidth
except ImportError:
    # fallback: 简单版（中文=2，英文=1）
    def wcswidth(text: str) -> int:
        w = 0
        for ch in text:
            if ord(ch) > 127:
                w += 2
            else:
                w += 1
        return w


def _safe_wcswidth(text: str) -> int:
    """安全的 wcswidth，对 emoji / 控制字符返回 -1 时回退为 1"""
    w = wcswidth(text)
    if w <= 0:
        # 单个字符宽度未知时，保守按 1 列处理
        return max(1, len(text))
    return w


def _pad_by_width(text: str, target_width: int) -> str:
    """按显示宽度右填充空格"""
    current = _safe_wcswidth(text)
    if current >= target_width:
        return text
    return text + " " * (target_width - current)


def _truncate(text: str, max_width: int) -> str:
    """按显示宽度截断文本"""
    if _safe_wcswidth(text) <= max_width:
        return text
    result = ""
    w = 0
    for ch in text:
        cw = _safe_wcswidth(ch)
        if w + cw > max_width - 1:
            return result + "…"
        result += ch
        w += cw
    return result


# ── ANSI 转义码 ──────────────────────────────────────────

ESC = "\033["
CLEAR = ESC + "2J"
HOME = ESC + "H"
HIDE_CURSOR = ESC + "?25l"
SHOW_CURSOR = ESC + "?25h"
RESET = ESC + "0m"
BOLD = ESC + "1m"
DIM = ESC + "2m"
CYAN = ESC + "36m"
BRIGHT_BLUE = ESC + "94m"
YELLOW = ESC + "33m"
GREEN = ESC + "32m"
RED = ESC + "31m"
WHITE = ESC + "37m"
GRAY = ESC + "90m"
MAGENTA = ESC + "35m"


@dataclass
class PaneState:
    """单个面板的状态"""
    name: str           # Agent 名称
    task: str = ""      # 当前任务描述
    status: str = "idle"  # idle / queued / running / done / failed
    output_lines: list[str] = field(default_factory=list)
    progress: str = ""

    # 状态图标映射
    _ICONS = {
        "idle": ("○", GRAY),
        "queued": ("⏳", MAGENTA),
        "running": ("◉", YELLOW),
        "done": ("✓", GREEN),
        "failed": ("✗", RED),
    }

    def status_icon(self) -> str:
        return self._ICONS.get(self.status, ("○", WHITE))[0]

    def status_color(self) -> str:
        return self._ICONS.get(self.status, ("○", WHITE))[1]


def _ensure_output_encoding_safe():
    """A-026: 重配 stdout/stderr 为 errors="replace"。

    Windows GBK 管道环境下，面板图标（◉ ✓ ✗ 等）无法以 cp936 编码，
    sys.stdout.write 抛 UnicodeEncodeError → Swarm Worker 调度与循环全员崩溃
    （实测 5/6 Worker failed + 1 卡 running）。errors=replace 保持原编码，
    仅把不可编码字符替换为 ?，不再抛异常。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(errors="replace")
        except Exception:
            pass


class Multiplexer:
    """
    Zellij 风格终端分屏管理器。
    将终端分割为多个面板，每个面板显示一个子 Agent 的实时状态。
    """

    def __init__(self, pane_names: list[str], title: str = "Slime Swarm"):
        self.title = title
        self.panes: dict[str, PaneState] = {}
        for name in pane_names:
            self.panes[name] = PaneState(name=name)
        self._running = False
        self._term_w = shutil.get_terminal_size().columns
        self._term_h = shutil.get_terminal_size().lines
        self._last_render = 0.0  # 节流时间戳
        self._render_lock = threading.Lock()

    def start(self):
        """进入分屏模式（清屏 + 隐藏光标）"""
        _ensure_output_encoding_safe()  # A-026: 任何编码环境下图标输出不崩溃
        self._running = True
        self._last_render = time.time()  # 初始化节流时间戳
        self._term_w = shutil.get_terminal_size().columns
        self._term_h = shutil.get_terminal_size().lines
        sys.stdout.write(CLEAR + HOME + HIDE_CURSOR)
        sys.stdout.flush()
        self.render()

    def stop(self):
        """退出分屏模式（恢复光标）"""
        self._running = False
        sys.stdout.write(SHOW_CURSOR + "\n")
        sys.stdout.flush()

    def update_pane(self, name: str, status: str = None, task: str = None,
                    progress: str = None, append_line: str = None):
        """更新面板状态"""
        pane = self.panes.get(name)
        if not pane:
            return
        with self._render_lock:
            if status is not None:
                pane.status = status
            if task is not None:
                pane.task = task
            if progress is not None:
                pane.progress = progress
            if append_line is not None:
                pane.output_lines.append(append_line)
                if len(pane.output_lines) > 20:
                    pane.output_lines = pane.output_lines[-20:]
        if self._running:
            self._throttled_render()

    def _throttled_render(self):
        """节流渲染：100ms 内最多渲染一次，减少闪烁（线程安全）"""
        now = time.time()
        if now - self._last_render < 0.1:
            return
        with self._render_lock:
            # 二次检查，避免锁等待期间已被其他线程渲染
            if now - self._last_render < 0.1:
                return
            self._last_render = now
            self.render()

    def render(self):
        """渲染整个分屏界面（整屏重绘，含清屏防止残影）"""
        if not self._running:
            return

        # 重新获取终端尺寸
        self._term_w = shutil.get_terminal_size().columns
        self._term_h = shutil.get_terminal_size().lines

        w = self._term_w
        h = self._term_h

        # 计算布局
        header_h = 4   # 标题栏
        footer_h = 1   # 底部状态栏
        pane_area_h = h - header_h - footer_h

        num_panes = len(self.panes)
        if num_panes == 0:
            return
        pane_h = max(3, pane_area_h // num_panes)

        buf = []
        # 先清屏再定位到左上角，根除残影
        buf.append(CLEAR + HOME)

        # ── 标题栏 ──
        title_line = f" {self.title} "
        buf.append(f"{BOLD}{CYAN}{title_line}{RESET}")
        buf.append(f"{GRAY}{'─' * w}{RESET}")

        # 状态统计
        queued = sum(1 for p in self.panes.values() if p.status == "queued")
        running = sum(1 for p in self.panes.values() if p.status == "running")
        done = sum(1 for p in self.panes.values() if p.status in ("done", "failed"))
        failed = sum(1 for p in self.panes.values() if p.status == "failed")

        stats_parts = [f"{DIM}  Agents: {num_panes}{RESET}"]
        if queued > 0:
            stats_parts.append(f"{MAGENTA} 排队 {queued}{RESET}")
        if running > 0:
            stats_parts.append(f"{YELLOW} 运行 {running}{RESET}")
        stats_parts.append(f"{GREEN} 完成 {done}{RESET}")
        if failed > 0:
            stats_parts.append(f"{RED} 失败 {failed}{RESET}")

        buf.append(f"{' '.join(stats_parts)}")
        buf.append(f"{GRAY}{'─' * w}{RESET}")

        # ── 面板区域 ──
        pane_names = list(self.panes.keys())
        for idx, name in enumerate(pane_names):
            pane = self.panes[name]
            is_last = (idx == num_panes - 1)

            # 面板标题
            icon = pane.status_icon()
            sc = pane.status_color()
            title_text = f"╭─ {icon} {name} {sc}[{pane.status}]{RESET}"
            title_w = _safe_wcswidth(f"╭─ {icon} {name} [{pane.status}]")
            pad = max(0, w - 2 - title_w)
            buf.append(f"{BOLD}{CYAN}{title_text}{'─' * pad}{RESET}")

            # 任务描述
            if pane.task:
                task_display = _truncate(pane.task, w - 4)
                buf.append(f"{DIM}│ {task_display}{RESET}")
            else:
                buf.append(f"{DIM}│{RESET}")

            # 进度
            if pane.progress:
                progress_display = _truncate(pane.progress, w - 4)
                buf.append(f"{DIM}│ {progress_display}{RESET}")

            # 输出内容（限制行数）
            used_top = 3 if pane.task else 2
            if pane.progress:
                used_top += 1
            max_lines = max(1, pane_h - used_top - 1)
            lines = pane.output_lines[-max_lines:] if pane.output_lines else []
            for line in lines:
                line_display = _truncate(line, w - 4)
                buf.append(f"{WHITE}│ {line_display}{RESET}")

            # 填充空行
            for _ in range(max(0, max_lines - len(lines))):
                buf.append(f"{DIM}│{RESET}")

            # 面板底部
            buf.append(f"{CYAN}╰{'─' * (w - 2)}{RESET}")

        # ── 底部状态栏 ──
        done_count = sum(1 for p in self.panes.values() if p.status == "done")
        failed_count = sum(1 for p in self.panes.values() if p.status == "failed")
        running_count = sum(1 for p in self.panes.values() if p.status == "running")
        queued_count = sum(1 for p in self.panes.values() if p.status == "queued")

        if failed_count > 0:
            status_text = f" {failed_count} failed | {done_count}/{num_panes} done "
            buf.append(f"{RED}{_pad_by_width(status_text, w)}{RESET}")
        elif done_count == num_panes:
            buf.append(f"{GREEN} All {num_panes} agents completed {RESET}")
        elif queued_count > 0:
            buf.append(f"{MAGENTA} {queued_count} queued | {running_count} running | {done_count}/{num_panes} done {RESET}")
        else:
            buf.append(f"{YELLOW} {running_count} running | {done_count}/{num_panes} done {RESET}")

        # 写入终端
        output = "\n".join(buf)
        sys.stdout.write(output)
        sys.stdout.flush()

    def get_summary(self) -> str:
        """获取所有面板的汇总文本（用于合并阶段）"""
        lines = [f"## Swarm 执行汇总\n"]
        for name, pane in self.panes.items():
            lines.append(f"### {name} [{pane.status}]")
            lines.append(f"任务: {pane.task}")
            if pane.output_lines:
                lines.append("输出:")
                lines.extend(pane.output_lines)
            if pane.progress:
                lines.append(f"进度: {pane.progress}")
            lines.append("")
        return "\n".join(lines)