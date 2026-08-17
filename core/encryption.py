"""
slime 加密配置模块
算法：PBKDF2-HMAC-SHA256（600k 迭代）+ AES-256-GCM
密钥文件：~/.slime_pass（隐藏，Windows ACL 限制读取）
"""

import os
import sys
import json
import secrets
import base64
import logging
import subprocess
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# ── 项目根目录 ────────────────────────────────────────────

def _project_root() -> Path:
    """返回项目根目录（slime/），锚定到本文件所在位置"""
    return Path(__file__).resolve().parent.parent


def _resolve_config_path(config_path: str) -> Path:
    """将相对路径解析为项目根目录下的绝对路径"""
    p = Path(config_path)
    if p.is_absolute():
        return p
    return _project_root() / p


# ── 常量 ──────────────────────────────────────────────────

PASSPHRASE_FILE = Path.home() / ".slime_pass"
_FALLBACK_PASSPHRASE_FILE = _project_root() / ".slime_pass"
SALT_SIZE = 16
NONCE_SIZE = 12
PBKDF2_ITERATIONS = 600_000
KEY_SIZE = 32  # AES-256


# ── 内部函数 ──────────────────────────────────────────────

def _derive_key(passphrase: str, salt: bytes) -> bytes:
    """从 passphrase + salt 派生 32 字节 AES 密钥"""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_SIZE,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def _brief_exc(e: Exception, limit: int = 120) -> str:
    """简短异常描述（类名 + 截断消息），用于日志"""
    msg = str(e).strip()
    if len(msg) > limit:
        msg = msg[:limit] + "..."
    return f"{type(e).__name__}: {msg}"


def _ensure_passphrase() -> str:
    """
    确保 passphrase 文件存在。
    读取优先级：~/.slime_pass → {project}/.slime_pass（fallback）
    不存在则生成随机 passphrase 并保存到 ~/.slime_pass。
    如果加密配置文件存在但 passphrase 丢失，发出警告（旧密文永久不可解密）。
    返回 passphrase 字符串和实际使用的文件路径。
    """
    # 优先读 ~/.slime_pass，否则尝试 fallback 路径
    for pass_file in (PASSPHRASE_FILE, _FALLBACK_PASSPHRASE_FILE):
        if pass_file.exists():
            passphrase = pass_file.read_text(encoding="utf-8").strip()
            if passphrase:  # 空文件视为无效，跳过
                return passphrase
            logging.warning(
                f"[encryption] passphrase 文件 {pass_file} 为空，将重新生成"
            )

    # 检查是否存在加密配置文件——如果存在，说明 passphrase 丢失，旧密文不可恢复
    enc_path = _resolve_config_path("config/providers.enc.json")
    if enc_path.exists():
        print(
            "[slime] WARNING: ~/.slime_pass is missing but encrypted config exists. "
            "A new passphrase will be generated; old encrypted data will be PERMANENTLY lost.",
            file=sys.stderr,
        )

    # 生成 64 字符随机 passphrase
    passphrase = secrets.token_hex(32)
    wrote_to = PASSPHRASE_FILE
    try:
        import tempfile as _tf
        _tmp = PASSPHRASE_FILE.with_suffix(f".{secrets.token_hex(4)}.tmp")
        _tmp.write_text(passphrase, encoding="utf-8")
        os.replace(_tmp, PASSPHRASE_FILE)
    except PermissionError:
        # fallback: 写到项目目录（A-113: 严重警告——项目目录权限不如 HOME 严格）
        print(
            "[slime] WARNING: 无法写入 ~/.slime_pass，passphrase 回退到项目目录 "
            f"{_FALLBACK_PASSPHRASE_FILE}（权限保护弱于用户目录）",
            file=sys.stderr,
        )
        wrote_to = _FALLBACK_PASSPHRASE_FILE
        _FALLBACK_PASSPHRASE_FILE.write_text(passphrase, encoding="utf-8")

    # 设置权限（Windows: 隐藏 + ACL 限制；Unix: 0o600）
    _harden_file(wrote_to)

    return passphrase


def _harden_file(path: Path):
    """设置文件权限（Windows: 隐藏 + ACL 限制；Unix: 0o600）。

    失败不阻塞（权限硬化是加固而非功能依赖），但必须打 warning 便于发现。
    """
    if os.name == "nt":
        import ctypes
        try:
            ctypes.windll.kernel32.SetFileAttributesW(str(path), 2)  # FILE_ATTRIBUTE_HIDDEN
        except Exception as e:
            logging.warning(f"[encryption] 设置隐藏属性失败 {path}: {e}")
        user = os.environ.get("USERNAME", "")
        if not user:
            logging.warning(f"[encryption] USERNAME 为空，跳过 icacls 权限限制: {path}")
        else:
            try:
                r = subprocess.run(
                    ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:(M)"],
                    capture_output=True, timeout=5,
                )
                if r.returncode != 0:
                    logging.warning(
                        f"[encryption] icacls 权限限制失败 {path}: rc={r.returncode} "
                        f"{r.stderr.decode(errors='replace').strip()}"
                    )
            except Exception as e:
                logging.warning(f"[encryption] icacls 执行异常 {path}: {e}")
    else:
        try:
            path.chmod(0o600)
        except OSError as e:
            logging.warning(f"[encryption] chmod 失败 {path}: {e}")


# ── 公共接口 ──────────────────────────────────────────────

def encrypt(config: dict, config_path: str = "config/providers.enc.json") -> str:
    """
    加密配置 dict 并写入文件。
    格式：base64(salt + nonce + ciphertext)
    返回写入内容的 base64 字符串。
    """
    path = _resolve_config_path(config_path)
    passphrase = _ensure_passphrase()
    salt = secrets.token_bytes(SALT_SIZE)
    nonce = secrets.token_bytes(NONCE_SIZE)
    key = _derive_key(passphrase, salt)

    aesgcm = AESGCM(key)
    plaintext = json.dumps(config, ensure_ascii=False).encode("utf-8")
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)

    # 拼接: salt + nonce + ciphertext
    combined = salt + nonce + ciphertext
    encoded = base64.b64encode(combined).decode("ascii")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoded, encoding="utf-8")
    _harden_file(path)

    return encoded


def decrypt(config_path: str = "config/providers.enc.json") -> dict | None:
    """
    解密配置文件，返回 dict。
    失败（文件不存在/密码错误/格式损坏）返回 None。
    """
    path = _resolve_config_path(config_path)
    if not path.exists():
        return None

    passphrase = _ensure_passphrase()

    try:
        encoded = path.read_text(encoding="utf-8").strip()
        combined = base64.b64decode(encoded)

        salt = combined[:SALT_SIZE]
        nonce = combined[SALT_SIZE:SALT_SIZE + NONCE_SIZE]
        ciphertext = combined[SALT_SIZE + NONCE_SIZE:]

        key = _derive_key(passphrase, salt)
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(nonce, ciphertext, None)

        return json.loads(plaintext.decode("utf-8"))
    except Exception as e:
        # A-113: 走到这里说明文件存在但解密失败（passphrase 不匹配/数据损坏），
        # 不再静默——打 warning 让调用方与用户可察觉配置静默失效
        logging.warning(f"[encryption] 解密失败 {path}: {_brief_exc(e)}")
        return None


# ── 纯文本加密/解密（用于 auth token 等字符串） ─────────────

def encrypt_raw(plaintext: str, config_path: str) -> str:
    """
    加密纯文本字符串并写入文件。
    格式：base64(salt + nonce + ciphertext)
    返回写入内容的 base64 字符串。
    """
    path = _resolve_config_path(config_path)
    passphrase = _ensure_passphrase()
    salt = secrets.token_bytes(SALT_SIZE)
    nonce = secrets.token_bytes(NONCE_SIZE)
    key = _derive_key(passphrase, salt)

    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)

    combined = salt + nonce + ciphertext
    encoded = base64.b64encode(combined).decode("ascii")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoded, encoding="utf-8")
    _harden_file(path)

    return encoded


def decrypt_raw(config_path: str) -> str | None:
    """
    解密纯文本文件，返回原始字符串。
    失败返回 None。
    """
    path = _resolve_config_path(config_path)
    if not path.exists():
        return None

    passphrase = _ensure_passphrase()

    try:
        encoded = path.read_text(encoding="utf-8").strip()
        combined = base64.b64decode(encoded)

        salt = combined[:SALT_SIZE]
        nonce = combined[SALT_SIZE:SALT_SIZE + NONCE_SIZE]
        ciphertext = combined[SALT_SIZE + NONCE_SIZE:]

        key = _derive_key(passphrase, salt)
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(nonce, ciphertext, None)

        return plaintext.decode("utf-8")
    except Exception as e:
        # A-113: 文件存在但解密失败（passphrase 不匹配/数据损坏）→ 打 warning 不静默
        logging.warning(f"[encryption] 解密失败 {path}: {_brief_exc(e)}")
        return None