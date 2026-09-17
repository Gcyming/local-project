# 本文件由 scripts/gen_security_policy.py 从 shared/security-policy.yaml 自动生成，禁止手改。
# 单一真相源：改 shared/security-policy.yaml 后重跑生成器。
from __future__ import annotations

# protected_dirs（来自 shared/security-policy.yaml）
PROTECTED_DIRS: tuple[str, ...] = (
    "core-ts",
    "core",
    "tools",
    "social",
    "sidecar",
    "shared",
    "gateway-ts",
    "config",
    "configs",
    "scripts",
    "gui",
    "linux",
    "windows",
    "runtime",
    "skills",
    "tests",
    ".git",
)

# sensitive_filenames（来自 shared/security-policy.yaml）
SENSITIVE_FILENAMES: tuple[str, ...] = (
    ".slime_pass",
    "providers.enc.json",
    "auth_token.enc",
    "auth_token.json",
    "slime.toml",
    "agents.json",
    "global_config.json",
    "history.jsonl",
    "audit.jsonl",
    ".git/config",
    "passphrase",
    "password",
    "id_rsa",
    "id_ed25519",
    "slime_server.py",
    "slime_cli.py",
    "slime_launcher.py",
    "requirements.txt",
    "qa.py",
    "run_tests.py",
    "pytest.ini",
)

# write_block_suffixes（来自 shared/security-policy.yaml）
WRITE_BLOCK_SUFFIXES: tuple[str, ...] = (
    ".enc",
    ".toml",
    ".key",
    ".pem",
    ".p12",
    ".pfx",
)

# classifier_write_block_suffixes（来自 shared/security-policy.yaml）
CLASSIFIER_WRITE_BLOCK_SUFFIXES: tuple[str, ...] = (
    ".enc",
    ".key",
    ".pem",
    ".p12",
    ".pfx",
)

