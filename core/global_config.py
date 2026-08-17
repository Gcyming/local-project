"""
全局配置管理
- 存储默认 max_context / max_output
- 所有 Agent 创建时继承，/context 修改时全局同步
"""

import json
from pathlib import Path

_PROJECT_ROOT = Path(__file__).parent.parent
_CONFIG_DIR = _PROJECT_ROOT / "config"
_GLOBAL_CONFIG_PATH = _CONFIG_DIR / "global_config.json"

_DEFAULTS = {
    "max_context": 4096,
    "max_output": 2048,
}


def _ensure_dir():
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_global_config() -> dict:
    """加载全局配置，不存在则返回默认值"""
    if _GLOBAL_CONFIG_PATH.exists():
        try:
            with open(_GLOBAL_CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                if isinstance(cfg, dict):
                    return cfg
        except (json.JSONDecodeError, OSError):
            pass
    return dict(_DEFAULTS)


def save_global_config(cfg: dict):
    """保存全局配置"""
    _ensure_dir()
    import uuid
    tmp = _GLOBAL_CONFIG_PATH.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    tmp.replace(_GLOBAL_CONFIG_PATH)


def get_defaults() -> dict:
    """获取默认值（max_context, max_output）"""
    cfg = load_global_config()
    return {
        "max_context": cfg.get("max_context", _DEFAULTS["max_context"]),
        "max_output": cfg.get("max_output", _DEFAULTS["max_output"]),
    }
