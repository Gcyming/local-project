"""
slime 对话历史持久化模块
- 每次对话以 JSONL 格式追加到 config/history.jsonl
- 支持按 Agent ID 过滤加载
- 与 persona.interactions 互补（persona 用于演化，history 用于持久化）
"""

import json
import threading
from pathlib import Path
from datetime import datetime, timezone

_PROJECT_ROOT = Path(__file__).resolve().parent.parent  # N11-P3-11: resolve 锚定
_HISTORY_PATH = _PROJECT_ROOT / "config" / "history.jsonl"
_write_lock = threading.Lock()  # N11-P2-11: 保护 pop_last 读改写

# BUG-027: 轮转参数，防 history.jsonl 无限增长
_MAX_HISTORY_BYTES = 10 * 1024 * 1024  # 超过 10MB 触发轮转
_KEEP_RECORDS = 5000                   # 轮转后保留最近条数


def append(agent_id: str, user_msg: str, ai_reply: str, success: bool = True):
    """追加一条对话记录到 history.jsonl（BUG-027: 超阈值轮转，防无限增长）"""
    _HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "agent_id": agent_id,
        "user": user_msg,
        "ai": ai_reply,
        "success": success,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    with _write_lock:
        with open(_HISTORY_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        _rotate_if_needed()


def _rotate_if_needed():
    """超过大小阈值时只保留最近 _KEEP_RECORDS 条（按行保留，不解析）。"""
    try:
        if _HISTORY_PATH.stat().st_size <= _MAX_HISTORY_BYTES:
            return
    except OSError:
        return
    lines = []
    with open(_HISTORY_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                lines.append(line)
    if len(lines) <= _KEEP_RECORDS:
        return
    import os, uuid
    tmp_path = _HISTORY_PATH.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
    tmp_path.write_text("\n".join(lines[-_KEEP_RECORDS:]) + "\n", encoding="utf-8")
    os.replace(tmp_path, _HISTORY_PATH)


def pop_last(agent_id: str) -> bool:
    """移除该 Agent 最后一条历史记录（用于 /retry 去重）。返回是否移除成功。N11-P2-11: 锁内读改写。"""
    if not _HISTORY_PATH.exists():
        return False
    with _write_lock:
        records = []
        with open(_HISTORY_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        if not records:
            return False
        # 找到该 agent 最后一条记录
        idx = None
        for i in range(len(records) - 1, -1, -1):
            if records[i].get("agent_id") == agent_id:
                idx = i
                break
        if idx is None:
            return False
        records.pop(idx)
        import os, uuid
        tmp_path = _HISTORY_PATH.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
        # A-019: 必须以换行收尾 —— 否则下一次 append 会拼接到最后一条记录同一行，
        # 形成 "}{" 拼接行，load() 解析失败导致两条记录同时丢失（静默数据损坏）
        tmp_path.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp_path, _HISTORY_PATH)
        return True


def remove_agent(agent_id: str) -> int:
    """移除某 Agent 的全部历史记录（delete_agent 用）。返回移除条数。

    A-025: 与 append/pop_last 共用 _write_lock + uuid 临时名原子替换 ——
    修复此前 server 直写文件绕过锁的并发丢记录窗口与固定 .tmp 名冲突。"""
    if not _HISTORY_PATH.exists():
        return 0
    with _write_lock:
        kept_lines: list[str] = []
        removed = 0
        with open(_HISTORY_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    if record.get("agent_id") == agent_id:
                        removed += 1
                        continue
                    kept_lines.append(json.dumps(record, ensure_ascii=False))
                except json.JSONDecodeError:
                    kept_lines.append(line)  # 无法解析的行保留原文
        import os, uuid
        tmp_path = _HISTORY_PATH.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
        tmp_path.write_text(
            "\n".join(kept_lines) + ("\n" if kept_lines else ""),
            encoding="utf-8",
        )
        os.replace(tmp_path, _HISTORY_PATH)
        return removed


def load(agent_id: str | None = None, limit: int = 200) -> list[dict]:
    """
    加载对话历史。agent_id 为 None 时返回所有。
    返回最近 limit 条（最多），按时间升序。
    """
    if not _HISTORY_PATH.exists():
        return []

    records = []
    with open(_HISTORY_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                if agent_id is None or record.get("agent_id") == agent_id:
                    records.append(record)
            except json.JSONDecodeError:
                continue

    return records[-limit:]