"""core/safe_io.py — 崩溃安全的文件读写（A-989）。

## 为什么要有这个模块

本项目此前各处的落盘是**各写各的**：有的裸 `write_file`，有的做了 tmp+rename。
2026-09-17 全网检索（Electron 数据持久化 / 事务日志 / 原子写 的权威实践）后确认，
"write-to-temp-and-rename" 只是**三步协议的第一步**，漏掉后两步就仍然会丢数据：

    写 tmp  →  **fsync(tmp)**  →  rename(tmp, target)  →  **fsync(父目录)**

- **只 rename 不够**：rename 是**元数据**操作，可能先于文件数据真正落盘。
  断电或内核崩溃后会得到"文件名在、内容是空的或半截的"——比没有文件更难排查。
- **要 fsync 父目录**：rename 本身也是目录项变更，不刷目录就可能"文件内容对了但名字没了"。
- **要 `.bak`**：任何一步失败都还能回到上一份完好内容；读盘失败时自动回退。

这类故障在开发机上几乎复现不出来，只会在用户"强制退出 / 断电 / 蓝屏"之后爆发，
而且症状通常表现为**重启后应用起不来**（读到一个坏 JSON）。所以宁可每次多两次 fsync，
也不能让用户的 Agent 配置、全局配置、记忆数据裸奔。

## 用法

    from core.safe_io import atomic_write_text, read_json_safe

    atomic_write_text(AGENTS_PATH, json.dumps(agents, ensure_ascii=False, indent=2))
    cfg = read_json_safe(GLOBAL_CONFIG_PATH, default={})
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

__all__ = ["atomic_write_text", "read_text_safe", "read_json_safe", "sweep_stale_temps"]


def _fsync_dir(path: Path) -> None:
    """刷父目录的目录项（rename 的持久化保证）。

    Windows 上无法对目录句柄调用 os.fsync（会 OSError），故显式忽略——
    NTFS 的元数据日志本身对 rename 有一致的落盘语义，这里不退化成错误。
    """
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def atomic_write_text(path: str | Path, text: str, *, keep_bak: bool = True) -> None:
    """崩溃安全地写文本：tmp + fsync + rename + fsync(父目录)，并保留一份 `.bak`。

    与"裸写"的关键差别：**任何时刻盘上的目标文件要么是旧内容、要么是新内容，
    永远不会是半截**。并发写用 uuid 临时名，互不覆盖（沿用 A-113 的做法）。
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(f"{target.suffix}.{uuid.uuid4().hex[:8]}.tmp")

    # ① 写临时文件并 fsync —— 内容必须真正落到盘上，而不是停在 OS 缓存里等被丢
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())

    # ② 留一份旧的完好内容（新内容万一损坏，还有回退）
    #    ⚠️ 目标文件可能被硬化为"只可删除、不可覆盖"（加密配置会走 icacls 加固），
    #    此时 copyfile 直接失败；必须先删再写，否则 .bak 会永远停在最早那一版，
    #    回退回来的是过期内容（比没有 .bak 更危险——它看起来是"恢复成功"了）。
    if keep_bak and target.exists():
        bak = target.with_suffix(f"{target.suffix}.bak")
        try:
            shutil.copyfile(target, bak)
        except OSError:
            try:
                bak.unlink(missing_ok=True)
                shutil.copyfile(target, bak)
            except OSError:
                pass  # 备份失败不阻断主流程

    # ③ 原子替换 + 刷目录（Windows 并发 replace 偶发 PermissionError → 短重试，沿用 A-113）
    try:
        os.replace(tmp, target)
    except PermissionError:
        import time
        for _ in range(3):
            time.sleep(0.05)
            try:
                os.replace(tmp, target)
                break
            except PermissionError:
                continue
        else:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise
    _fsync_dir(target.parent)


def _mark_corrupt(path: Path) -> None:
    """把坏文件改名 `.corrupt` 留证（不覆盖同名旧证物则跳过）。"""
    try:
        target = Path(path)
        if target.exists():
            target.replace(target.with_suffix(f"{target.suffix}.corrupt"))
    except OSError:
        pass


def read_text_safe(path: str | Path) -> str | None:
    """读文本：主文件 → `.bak` 回退；两份都读不出来则把主文件改名 `.corrupt` **留证**后返回 None。

    留证很重要：静默丢弃会让"我的配置为什么没了"变成悬案，而现场是在的。

    注意：本函数只保证"读得出文本"，**不保证内容是合法 JSON** ——
    崩溃截断通常留下的是"能读但解析不了"的半截，那种情况由 `read_json_safe` 兜。
    """
    target = Path(path)
    bak = target.with_suffix(f"{target.suffix}.bak")
    for i, candidate in enumerate((target, bak)):
        try:
            return candidate.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except (OSError, UnicodeDecodeError):
            if i == 0:
                _mark_corrupt(target)
            continue
    return None


def read_json_safe(path: str | Path, default: Any = None) -> Any:
    """读 JSON：主文件 → `.bak` → 默认值。永不抛（读坏文件不该让应用起不来）。

    **逐个候选"先解析再决定"是关键**：崩溃截断留下的是能读通但 `json.loads` 失败的半截
    （`{"a": 1, "b`），若沿用 `read_text_safe`（只在读不出文本时才换候选），
    就会拿着半截内容去解析然后直接返回默认值 —— 回退形同虚设。
    """
    target = Path(path)
    bak = target.with_suffix(f"{target.suffix}.bak")
    for i, candidate in enumerate((target, bak)):
        try:
            raw = candidate.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError, UnicodeDecodeError):
            if i == 0:
                _mark_corrupt(target)
            continue
        if raw.strip() == "":
            # 空文件 = 写入被强杀的典型产物，视同损坏
            if i == 0:
                _mark_corrupt(target)
            continue
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            if i == 0:
                _mark_corrupt(target)
            continue
    return default


def sweep_stale_temps(directory: str | Path, *, older_than_seconds: float = 60.0) -> int:
    """清理陈旧 `*.tmp`（原子写被强杀留下的半成品）。返回删除数。

    只删**足够旧**的：正在进行的写入其 tmp 寿命只有毫秒级，误删会打乱并发写。
    """
    import time
    d = Path(directory)
    if not d.is_dir():
        return 0
    removed = 0
    now = time.time()
    for p in d.iterdir():
        if not p.name.endswith(".tmp"):
            continue
        try:
            if now - p.stat().st_mtime > older_than_seconds:
                p.unlink(missing_ok=True)
                removed += 1
        except OSError:
            pass
    return removed
