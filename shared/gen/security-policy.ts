// 本文件由 scripts/gen_security_policy.py 从 shared/security-policy.yaml 自动生成，禁止手改。
// 单一真相源：改 shared/security-policy.yaml 后重跑生成器。
/** protected_dirs（来自 shared/security-policy.yaml） */
export const PROTECTED_DIRS: readonly string[] = ["core-ts", "core", "tools", "social", "sidecar", "shared", "gateway-ts", "config", "configs", "scripts", "gui", "linux", "windows", "runtime", "skills", "tests", ".git"];

/** sensitive_filenames（来自 shared/security-policy.yaml） */
export const SENSITIVE_FILENAMES: readonly string[] = [".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json", "slime.toml", "agents.json", "global_config.json", "history.jsonl", "audit.jsonl", ".git/config", "passphrase", "password", "id_rsa", "id_ed25519", "slime_server.py", "slime_cli.py", "slime_launcher.py", "requirements.txt", "qa.py", "run_tests.py", "pytest.ini"];

/** write_block_suffixes（来自 shared/security-policy.yaml） */
export const WRITE_BLOCK_SUFFIXES: readonly string[] = [".enc", ".toml", ".key", ".pem", ".p12", ".pfx"];

/** classifier_write_block_suffixes（来自 shared/security-policy.yaml） */
export const CLASSIFIER_WRITE_BLOCK_SUFFIXES: readonly string[] = [".enc", ".key", ".pem", ".p12", ".pfx"];

/** Set 形态（热路径零分配判定） */
export const PROTECTED_DIRS_SET: ReadonlySet<string> = new Set(PROTECTED_DIRS);
export const SENSITIVE_FILENAMES_SET: ReadonlySet<string> = new Set(SENSITIVE_FILENAMES);
export const WRITE_BLOCK_SUFFIXES_SET: ReadonlySet<string> = new Set(WRITE_BLOCK_SUFFIXES);
export const CLASSIFIER_WRITE_BLOCK_SUFFIXES_SET: ReadonlySet<string> = new Set(CLASSIFIER_WRITE_BLOCK_SUFFIXES);
