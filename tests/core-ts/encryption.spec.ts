/**
 * tests/core-ts/encryption.spec.ts — 加密配置语义测试。
 * 对照 core/encryption.py：PBKDF2 600k + AES-256-GCM，格式 base64(salt16+nonce12+ct+tag)。
 * 隔离：passFile/configPath 全部注入临时目录，绝不触碰真实 ~/.slime_pass / config/providers.enc.json。
 * 关键验证：与 Python cryptography AESGCM 双向兼容（Node 解密 Python 密文、Python 解密 Node 密文）。
 */
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { encrypt, decrypt, encryptRaw, decryptRaw, ensurePassphrase, SALT_SIZE, NONCE_SIZE } from "../../core-ts/src/encryption.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "enc-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const LOW_ITER = 1000; // 测试用低迭代（600k 每次 ~0.3s，且避免阻塞）
const ROOT = process.cwd();

function pyScript(code: string): string {
  return execFileSync("py", ["-X", "utf8", "-c", code], { encoding: "utf8", cwd: ROOT });
}

describe("encrypt/decrypt（对照 Python encrypt/decrypt）", () => {
  it("roundtrip：嵌套 dict + 中文 content", () => {
    const dir = makeTmp();
    const cfgPath = join(dir, "cfg.enc");
    const opts = { passFile: join(dir, "pass"), projectRoot: dir, iterations: LOW_ITER };
    const data = { providers: { main: { api_key: "sk-中文密钥", base: "https://x" } }, tags: ["a", "b"] };
    const encoded = encrypt(data, cfgPath, opts);
    expect(typeof encoded).toBe("string");
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(existsSync(cfgPath)).toBe(true);
    const back = decrypt(cfgPath, opts);
    expect(back).toEqual(data);
  });

  it("密文格式：base64(salt16 + nonce12 + ct + tag16)，随机盐每轮不同", () => {
    const dir = makeTmp();
    const cfgPath = join(dir, "fmt.enc");
    const opts = { passFile: join(dir, "pass"), projectRoot: dir, iterations: LOW_ITER };
    encrypt({ k: "v" }, cfgPath, opts);
    const combined = Buffer.from(readFileSync(cfgPath, "utf8").trim(), "base64");
    expect(combined.length).toBeGreaterThan(SALT_SIZE + NONCE_SIZE + 16);
    const first = readFileSync(cfgPath, "utf8").trim();
    const enc2 = encrypt({ k: "v" }, cfgPath, opts);
    expect(enc2).not.toBe(first); // 随机 salt/nonce → 密文不同
  });

  it("解密失败（passphrase 不匹配）→ null（A-113 不静默）", () => {
    const dir = makeTmp();
    const cfgPath = join(dir, "bad.enc");
    encrypt({ k: "v" }, cfgPath, { passFile: join(dir, "p1"), projectRoot: dir, iterations: LOW_ITER });
    const r = decrypt(cfgPath, { passFile: join(dir, "p2"), projectRoot: dir, iterations: LOW_ITER });
    expect(r).toBeNull();
  });

  it("文件不存在 → null", () => {
    const dir = makeTmp();
    expect(decrypt(join(dir, "missing.enc"), { passFile: join(dir, "p"), projectRoot: dir })).toBeNull();
  });
});

describe("encryptRaw/decryptRaw（auth token 等纯文本）", () => {
  it("roundtrip：原始字符串完整还原", () => {
    const dir = makeTmp();
    const p = join(dir, "token.enc");
    const opts = { passFile: join(dir, "pass"), projectRoot: dir, iterations: LOW_ITER };
    const token = "Bearer eyJhbGciOiJIUzI1NiJ9.中文payload";
    encryptRaw(token, p, opts);
    expect(decryptRaw(p, opts)).toBe(token);
  });

  it("失败返回 null", () => {
    const dir = makeTmp();
    expect(decryptRaw(join(dir, "nope.enc"), { passFile: join(dir, "p"), projectRoot: dir })).toBeNull();
  });
});

describe("ensurePassphrase（~/.slime_pass 语义）", () => {
  it("存在则复用；不存在则生成（64 hex）并持久化", () => {
    const dir = makeTmp();
    const passFile = join(dir, "slime_pass");
    const r1 = ensurePassphrase({ passFile, projectRoot: dir });
    expect(r1.passphrase).toMatch(/^[0-9a-f]{64}$/);
    const r2 = ensurePassphrase({ passFile, projectRoot: dir });
    expect(r2.passphrase).toBe(r1.passphrase);
  });

  it("空文件视为无效，重新生成", () => {
    const dir = makeTmp();
    const passFile = join(dir, "empty_pass");
    writeFileSync(passFile, "  \n", "utf8");
    const r = ensurePassphrase({ passFile, projectRoot: dir });
    expect(r.passphrase).toMatch(/^[0-9a-f]{64}$/);
  });

  it("主文件写入失败（路径是目录）→ 回退项目目录 .slime_pass", () => {
    const dir = makeTmp();
    const blockDir = join(dir, "is_a_dir");
    mkdirSync(blockDir, { recursive: true });
    const r = ensurePassphrase({ passFile: blockDir, projectRoot: dir });
    expect(existsSync(join(dir, ".slime_pass"))).toBe(true);
    expect(r.path).toBe(join(dir, ".slime_pass"));
  });
});

describe("跨栈兼容（Python cryptography AESGCM ↔ Node）", () => {
  it("Node 解密 Python 加密的 providers 配置", () => {
    const dir = makeTmp();
    const passFile = join(dir, "shared_pass");
    const cfgPath = join(dir, "providers.enc.json");
    ensurePassphrase({ passFile, projectRoot: dir });
    const pythonCode = `
import pathlib
import importlib.util
spec = importlib.util.spec_from_file_location("enc", r"${join(ROOT, "core", "encryption.py")}")
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)
enc.PASSPHRASE_FILE = pathlib.Path(${JSON.stringify(passFile)})
enc.PBKDF2_ITERATIONS = 1000
data = {"providers": {"main": {"api_key": "sk-cross-stack-中文", "base": "https://api.example.com"}}}
enc.encrypt(data, ${JSON.stringify(cfgPath)})
print("python-encrypted-ok")
`;
    const out = pyScript(pythonCode);
    expect(out.trim()).toBe("python-encrypted-ok");
    const back = decrypt(cfgPath, { passFile, projectRoot: dir, iterations: LOW_ITER });
    expect(back).toEqual({ providers: { main: { api_key: "sk-cross-stack-中文", base: "https://api.example.com" } } });
  });

  it("Python 解密 Node 加密的配置（同一 passphrase）", () => {
    const dir = makeTmp();
    const passFile = join(dir, "shared_pass2");
    const cfgPath = join(dir, "node.enc");
    ensurePassphrase({ passFile, projectRoot: dir });
    const data = { providers: { alt: { api_key: "sk-node-to-py" } } };
    encrypt(data, cfgPath, { passFile, projectRoot: dir, iterations: LOW_ITER });
    const pythonCode = `
import json, pathlib
import importlib.util
spec = importlib.util.spec_from_file_location("enc", r"${join(ROOT, "core", "encryption.py")}")
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)
enc.PASSPHRASE_FILE = pathlib.Path(${JSON.stringify(passFile)})
enc.PBKDF2_ITERATIONS = 1000
d = enc.decrypt(${JSON.stringify(cfgPath)})
print(json.dumps(d, ensure_ascii=False))
`;
    const out = pyScript(pythonCode);
    expect(JSON.parse(out.trim())).toEqual(data);
  });
});