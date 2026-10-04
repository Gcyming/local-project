










import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { PROJECT_ROOT } from "./paths.js";
import { resolve, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export { PROJECT_ROOT };

export const SALT_SIZE = 16;
export const NONCE_SIZE = 12;
export const TAG_SIZE = 16; 
export const PBKDF2_ITERATIONS = 600_000;
export const KEY_SIZE = 32; 

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
      
    }
    if (passphrase) return { passphrase, path: passFile };
    if (existsSync(passFile)) {
      warn(`passphrase 文件 ${passFile} 为空或不可读，将重新生成`);
    }
  }

  
  const encPath = resolveConfigPath("config/providers.enc.json", projectRoot);
  if (existsSync(encPath)) {
    console.error(
      "[slime] WARNING: ~/.slime_pass is missing but encrypted config exists. " +
        "A new passphrase will be generated; old encrypted data will be PERMANENTLY lost.",
    );
  }

  const passphrase = randomBytes(32).toString("hex"); 
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


function unhideFile(path: string): void {
  if (process.platform === "win32") {
    try {
      execFileSync("attrib", ["-h", path], { windowsHide: true });
    } catch {
      
    }
  }
}





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