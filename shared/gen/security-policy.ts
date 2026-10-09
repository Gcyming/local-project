// 本文件由 scripts/gen_security_policy.py 从 shared/security-policy.yaml 自动生成，禁止手改。
// 单一真相源：改 shared/security-policy.yaml 后重跑生成器。
/** protected_dirs（来自 shared/security-policy.yaml） */
export const PROTECTED_DIRS: readonly string[] = ["core-ts", "core", "tools", "social", "sidecar", "shared", "gateway-ts", "config", "configs", "scripts", "gui", "linux", "windows", "runtime", "skills", "tests", ".git"];

/** protected_path_exemptions（来自 shared/security-policy.yaml） */
export const PROTECTED_PATH_EXEMPTIONS: readonly string[] = ["config/skills", "config/plugins"];

/** contribution_reserved_assets（来自 shared/security-policy.yaml） */
export const CONTRIBUTION_RESERVED_ASSETS: readonly string[] = ["config/plugins/subagent", "config/plugins/file-io", "config/plugins/doc-authoring", "config/plugins/shell-exec", "config/plugins/web-access", "config/plugins/user-interaction", "config/plugins/planning", "config/plugins/memory", "config/plugins/android-device", "config/plugins/http-service", "config/plugins/sidebar", "config/plugins/screen-control", "config/plugins/browser", "config/plugins/skill-instructions", "config/plugins/doc-parsing", "config/plugins/office-render", "config/plugins/online-search", "config/plugins/mind", "config/plugins/silam", "config/plugins/local-model", "config/plugins/sandbox", "config/plugins/terminal-shell", "config/plugins/social", "config/plugins/multi-agent", "config/plugins/guardrails", "config/plugins/encryption", "config/plugins/observability", "config/plugins/model-routing", "config/plugins/mcp-bridge", "config/plugins/plugin-management"];

/** contribution_owner_markers（来自 shared/security-policy.yaml） */
export const CONTRIBUTION_OWNER_MARKERS: readonly string[] = ["plugin.json", "manifest.yaml", "manifest.json", "SKILL.md"];

/** contribution_owner_field（来自 shared/security-policy.yaml；标量） */
export const CONTRIBUTION_OWNER_FIELD: string = "origin";

/** contribution_owner_value（来自 shared/security-policy.yaml；标量） */
export const CONTRIBUTION_OWNER_VALUE: string = "agent";

/** sensitive_filenames（来自 shared/security-policy.yaml） */
export const SENSITIVE_FILENAMES: readonly string[] = [".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json", "slime.toml", "agents.json", "global_config.json", "history.jsonl", "audit.jsonl", ".git/config", "passphrase", "password", "id_rsa", "id_ed25519", "slime_server.py", "slime_cli.py", "slime_launcher.py", "requirements.txt", "qa.py", "run_tests.py", "pytest.ini"];

/** write_block_suffixes（来自 shared/security-policy.yaml） */
export const WRITE_BLOCK_SUFFIXES: readonly string[] = [".enc", ".toml", ".key", ".pem", ".p12", ".pfx"];

/** classifier_write_block_suffixes（来自 shared/security-policy.yaml） */
export const CLASSIFIER_WRITE_BLOCK_SUFFIXES: readonly string[] = [".enc", ".key", ".pem", ".p12", ".pfx"];

/** Set 形态（热路径零分配判定） */
export const PROTECTED_DIRS_SET: ReadonlySet<string> = new Set(PROTECTED_DIRS);
export const PROTECTED_PATH_EXEMPTIONS_SET: ReadonlySet<string> = new Set(PROTECTED_PATH_EXEMPTIONS);
export const CONTRIBUTION_RESERVED_ASSETS_SET: ReadonlySet<string> = new Set(CONTRIBUTION_RESERVED_ASSETS);
export const CONTRIBUTION_OWNER_MARKERS_SET: ReadonlySet<string> = new Set(CONTRIBUTION_OWNER_MARKERS);
export const SENSITIVE_FILENAMES_SET: ReadonlySet<string> = new Set(SENSITIVE_FILENAMES);
export const WRITE_BLOCK_SUFFIXES_SET: ReadonlySet<string> = new Set(WRITE_BLOCK_SUFFIXES);
export const CLASSIFIER_WRITE_BLOCK_SUFFIXES_SET: ReadonlySet<string> = new Set(CLASSIFIER_WRITE_BLOCK_SUFFIXES);
