/**
 * core-ts/src/encryption.ts — 加密配置模块。
 * 语义移植自 core/encryption.py：PBKDF2-HMAC-SHA256（600k 迭代）+ AES-256-GCM。
 *
 * - 密文格式：base64(salt(16) + nonce(12) + ciphertext + tag(16))，与 Python cryptography AESGCM 双向兼容
 * - 密钥文件：~/.slime_pass（优先）→ {project}/.slime_pass（fallback）
 * - Windows：隐藏属性 + icacls ACL 限制；Unix：chmod 0o600
 * - A-113：解密失败打 warning 不静默；passphrase 丢失但密文存在 → stderr 警告
 * - 可注入 passFile/projectRoot/iterations（测试隔离，绝不触碰真实 ~/.slime_pass）
 */

import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const SALT_SIZE = 16;
export const NONCE_SIZE = 12;
export const TAG_SIZE = 16; // AES-256-GCM 认证标签（Python AESGCM 附加在密文末尾）
export const PBKDF2_ITERATIONS = 600_000;
export const KEY_SIZE = 32; // AES-256

export interface EncryptionOptions {
  passFile?: string;
  projectRoot?: string;
  iterations?: number;
}

function defaultPassFile(): string {
  return resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", ".slime_pass");
}

function resolveConfigPath(configPath: string, projectRoot: string): string {
  return isAbsolute(configPath) ? configPath : resolve(projectRoot, configPath);
}

function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, salt, iterations, KEY_SIZE, "sha256");
}

function briefExc(e: unknown, limit = 120): string {
  const msg = String(e instanceof Error ? e.message : e).trim();
  return `${e instanceof Error ? e.constructor.name : "Error"}: ${msg.length > limit ? msg.slice(0, limit) + "..." : msg}`;
}

function warn(msg: string): void {
  console.warn(`[encryption] ${msg}`);
}

/** Windows: 隐藏属性 + icacls ACL 限制；Unix: chmod 0o600。失败不阻塞，但打 warning。 */
function hardenFile(path: string): void {
  if (process.platform === "win32") {
    try {
      execFileSync("attrib", ["+h", path], { windowsHide: true });
    } catch (e) {
      warn(`设置隐藏属性失败 ${path}: ${briefExc(e)}`);
    }
    const user = process.env.USERNAME ?? "";
    if (!user) {
      warn(`USERNAME 为空，跳过 icacls 权限限制: ${path}`);
    } else {
      try {
        execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:(M)`], {
          windowsHide: true,
          timeout: 5000,
          stdio: "pipe",
        });
      } catch (e) {
        warn(`icacls 权限限制失败 ${path}: ${briefExc(e)}`);
      }
    }
  } else {
    try {
      chmodSync(path, 0o600);
    } catch (e) {
      warn(`chmod 失败 ${path}: ${briefExc(e)}`);
    }
  }
}

/**
 * 确保 passphrase 存在：~/.slime_pass → {project}/.slime_pass（fallback）。
 * 不存在则生成随机 passphrase（64 hex）并硬化保存。
 * A-113: 加密配置存在但 passphrase 丢失 → 警告旧密文永久不可解密。
 */
export function ensurePassphrase(opts: EncryptionOptions = {}): { passphrase: string; path: string } {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const primary = opts.passFile ?? defaultPassFile();
  const fallback = resolve(projectRoot, ".slime_pass");
  const candidates = [primary, fallback];

  for (const passFile of candidates) {
    let passphrase = "";
    try {
      if (statSync(passFile).isFile()) {
        passphrase = readFileSync(passFile, "utf8").trim();
      }
    } catch {
      /* 不存在或不可读 → 跳过 */
    }
    if (passphrase) return { passphrase, path: passFile };
    if (existsSync(passFile)) {
      warn(`passphrase 文件 ${passFile} 为空或不可读，将重新生成`);
    }
  }

  // passphrase 丢失但密文存在 → 旧密文永久不可解密
  const encPath = resolveConfigPath("config/providers.enc.json", projectRoot);
  if (existsSync(encPath)) {
    console.error(
      "[slime] WARNING: ~/.slime_pass is missing but encrypted config exists. " +
        "A new passphrase will be generated; old encrypted data will be PERMANENTLY lost.",
    );
  }

  const passphrase = randomBytes(32).toString("hex"); // 64 hex 字符
  let wroteTo = primary;
  try {
    const tmp = `${primary}.${randomBytes(4).toString("hex")}.tmp`;
    mkdirSync(dirname(primary), { recursive: true });
    writeFileSync(tmp, passphrase, "utf8");
    renameSync(tmp, primary);
  } catch (e) {
    console.error(
      `[slime] WARNING: 无法写入 ~/.slime_pass，passphrase 回退到项目目录 ${fallback}（权限保护弱于用户目录）`,
    );
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, passphrase, "utf8");
    wroteTo = fallback;
  }

  hardenFile(wroteTo);
  return { passphrase, path: wroteTo };
}

/** 拼接/拆分：salt + nonce + ciphertext(+tag)。返回密文（含 tag）与 tag 分离。 */
function splitCombined(combined: Buffer): { salt: Buffer; nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  return {
    salt: combined.subarray(0, SALT_SIZE),
    nonce: combined.subarray(SALT_SIZE, SALT_SIZE + NONCE_SIZE),
    ciphertext: combined.subarray(SALT_SIZE + NONCE_SIZE, combined.length - TAG_SIZE),
    tag: combined.subarray(combined.length - TAG_SIZE),
  };
}

function encryptBytes(plaintext: Buffer, passphrase: string, iterations: number): string {
  const salt = randomBytes(SALT_SIZE);
  const nonce = randomBytes(NONCE_SIZE);
  const key = deriveKey(passphrase, salt, iterations);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([salt, nonce, ct, tag]);
  return combined.toString("base64");
}

function decryptBytes(encoded: string, passphrase: string, iterations: number): Buffer | null {
  try {
    const combined = Buffer.from(encoded, "base64");
    const { salt, nonce, ciphertext, tag } = splitCombined(combined);
    const key = deriveKey(passphrase, salt, iterations);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

/** Windows 写前清除隐藏属性（attrib +h 后对已存在文件 truncate 写会 EPERM；写完再硬化）。 */
function unhideFile(path: string): void {
  if (process.platform === "win32") {
    try {
      execFileSync("attrib", ["-h", path], { windowsHide: true });
    } catch {
      /* 文件可能不存在（首次写入），忽略 */
    }
  }
}

/**
 * 加密配置 dict 并写入文件，返回 base64 字符串。
 * 格式：base64(salt + nonce + ciphertext + tag)，与 Python encrypt() 双向兼容。
 */
export function encrypt(config: Record<string, unknown>, configPath = "config/providers.enc.json", opts: EncryptionOptions = {}): string {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const path = resolveConfigPath(configPath, projectRoot);
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const { passphrase } = ensurePassphrase(opts);
  const encoded = encryptBytes(Buffer.from(JSON.stringify(config), "utf8"), passphrase, iterations);
  mkdirSync(dirname(path), { recursive: true });
  unhideFile(path);
  writeFileSync(path, encoded, "utf8");
  hardenFile(path);
  return encoded;
}

/**
 * 解密配置文件，返回 dict。失败（不存在/密码错误/格式损坏）返回 null。
 * A-113: 文件存在但解密失败 → warning 不静默。
 */
export function decrypt(configPath = "config/providers.enc.json", opts: EncryptionOptions = {}): Record<string, unknown> | null {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const path = resolveConfigPath(configPath, projectRoot);
  if (!existsSync(path)) return null;
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const { passphrase } = ensurePassphrase(opts);
  const plain = decryptBytes(readFileSync(path, "utf8").trim(), passphrase, iterations);
  if (plain === null) {
    warn(`解密失败 ${path}: 密文损坏或 passphrase 不匹配`);
    return null;
  }
  try {
    return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
  } catch (e) {
    warn(`解密失败 ${path}: ${briefExc(e)}`);
    return null;
  }
}

/** 加密纯文本并写入文件（auth token 等），返回 base64 字符串。 */
export function encryptRaw(plaintext: string, configPath: string, opts: EncryptionOptions = {}): string {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const path = resolveConfigPath(configPath, projectRoot);
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const { passphrase } = ensurePassphrase(opts);
  const encoded = encryptBytes(Buffer.from(plaintext, "utf8"), passphrase, iterations);
  mkdirSync(dirname(path), { recursive: true });
  unhideFile(path);
  writeFileSync(path, encoded, "utf8");
  hardenFile(path);
  return encoded;
}

/** 解密纯文本文件，返回原始字符串。失败返回 null（A-113 warning）。 */
export function decryptRaw(configPath: string, opts: EncryptionOptions = {}): string | null {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const path = resolveConfigPath(configPath, projectRoot);
  if (!existsSync(path)) return null;
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const { passphrase } = ensurePassphrase(opts);
  const plain = decryptBytes(readFileSync(path, "utf8").trim(), passphrase, iterations);
  if (plain === null) {
    warn(`解密失败 ${path}: 密文损坏或 passphrase 不匹配`);
    return null;
  }
  return plain.toString("utf8");
}