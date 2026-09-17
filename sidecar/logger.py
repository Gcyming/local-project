"""
sidecar/logger.py — sidecar 日志：RotatingFileHandler（10MB × 5）+ StreamHandler。
7×24 必修：磁盘写满不得连锁崩溃。
"""

import logging
import logging.handlers
from pathlib import Path

_LOG_DIR = Path(__file__).resolve().parent.parent / "data" / "logs"


def get_logger(name: str = "sidecar", log_dir: Path | None = None) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    stream = logging.StreamHandler()
    stream.setFormatter(fmt)
    logger.addHandler(stream)
    try:
        (log_dir or _LOG_DIR).mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            (log_dir or _LOG_DIR) / "sidecar.log",
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setFormatter(fmt)
        logger.addHandler(file_handler)
    except OSError:
        pass
    return logger