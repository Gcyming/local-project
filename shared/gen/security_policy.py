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

# protected_path_exemptions（来自 shared/security-policy.yaml）
PROTECTED_PATH_EXEMPTIONS: tuple[str, ...] = (
    "config/skills",
    "config/plugins",
)

# contribution_reserved_assets（来自 shared/security-policy.yaml）
CONTRIBUTION_RESERVED_ASSETS: tuple[str, ...] = (
    "config/plugins/subagent",
    "config/plugins/file-io",
    "config/plugins/doc-authoring",
    "config/plugins/shell-exec",
    "config/plugins/web-access",
    "config/plugins/user-interaction",
    "config/plugins/planning",
    "config/plugins/memory",
    "config/plugins/android-device",
    "config/plugins/http-service",
    "config/plugins/sidebar",
    "config/plugins/screen-control",
    "config/plugins/browser",
    "config/plugins/skill-instructions",
    "config/plugins/doc-parsing",
    "config/plugins/office-render",
    "config/plugins/online-search",
    "config/plugins/mind",
    "config/plugins/silam",
    "config/plugins/local-model",
    "config/plugins/sandbox",
    "config/plugins/terminal-shell",
    "config/plugins/social",
    "config/plugins/multi-agent",
    "config/plugins/guardrails",
    "config/plugins/encryption",
    "config/plugins/observability",
    "config/plugins/model-routing",
    "config/plugins/mcp-bridge",
    "config/plugins/plugin-management",
)

# contribution_owner_markers（来自 shared/security-policy.yaml）
CONTRIBUTION_OWNER_MARKERS: tuple[str, ...] = (
    "plugin.json",
    "manifest.yaml",
    "manifest.json",
    "SKILL.md",
)

# contribution_owner_field（来自 shared/security-policy.yaml；标量）
CONTRIBUTION_OWNER_FIELD: str = "origin"

# contribution_owner_value（来自 shared/security-policy.yaml；标量）
CONTRIBUTION_OWNER_VALUE: str = "agent"

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

