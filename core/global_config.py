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
    """加载全局配置，不存在/损坏则返回默认值

    A-989：主文件损坏时 `read_json_safe` 自动回退 `.bak`（上一份完好配置）并留证 `.corrupt`，
    避免"强退一次 → 全局配置被清空 → 下次登录所有设置回到出厂值"。
    """
    from core.safe_io import read_json_safe
    cfg = read_json_safe(_GLOBAL_CONFIG_PATH, default=None)
    if isinstance(cfg, dict):
        return cfg
    return dict(_DEFAULTS)


def save_global_config(cfg: dict):
    """保存全局配置（A-989：崩溃安全写 —— tmp + fsync + replace + fsync(父目录) + .bak）

    此前只做 tmp+replace 而**没有 fsync**：rename 是元数据操作，可能先于数据落盘，
    断电/强杀后会留下"文件名在、内容空或半截"的 global_config.json。
    """
    from core.safe_io import atomic_write_text
    _ensure_dir()
    atomic_write_text(_GLOBAL_CONFIG_PATH, json.dumps(cfg, ensure_ascii=False, indent=2))


def get_defaults() -> dict:
    """获取默认值（max_context, max_output）"""
    cfg = load_global_config()
    return {
        "max_context": cfg.get("max_context", _DEFAULTS["max_context"]),
        "max_output": cfg.get("max_output", _DEFAULTS["max_output"]),
    }
