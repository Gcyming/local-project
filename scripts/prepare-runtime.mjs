#!/usr/bin/env node
/**
 * scripts/prepare-runtime.mjs — 构建前准备自包含安装包的运行时依赖。
 *
 * 在 `electron-vite build` 之前执行，确保以下产物就绪：
 *   1. Python venv（带 requirements.txt）
 *   2. llama-server 二进制
 *   3. 模型文件（BGE-M3 + Qwen3）
 *
 * 打包模式（electron-builder asarUnpack）会把项目根目录下以下路径包含到安装包内：
 *   - runtime/venv/**        (Python 虚拟环境)
 *   - runtime/node/**        (Node.js LTS)
 *   - models/**              (GGUF 模型)
 *   - llama.cpp/build/bin/   (llama-server.exe)
 *
 * 国内环境镜像策略：
 *   - Node.js:     nodejs.org 直连
 *   - Python venv: 系统 Python (--copies)
 *   - pip install: 国内镜像源（https://pypi.tuna.tsinghua.edu.cn/simple）
 *   - 模型:        hf-mirror.com（带断点续传）
 *   - llama-server: GitHub release 直连，失败时 gh-proxy 镜像
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { platform } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const isWindows = platform() === "win32";

function log(msg) {
  console.info(`[prepare-runtime] ${msg}`);
}
function exec(cmd, args = [], opts = {}) {
  log(`→ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
  return res;
}

// ── 1. Python venv ─────────────────────────────────────
const venvDir = join(ROOT, "runtime", "venv");
const venvPython = isWindows
  ? join(venvDir, "Scripts", "python.exe")
  : join(venvDir, "bin", "python");

if (!existsSync(venvPython)) {
  log("创建 Python venv (--copies)");
  if (existsSync(venvDir)) rmSync(venvDir, { recursive: true, force: true });
  exec("py", ["-m", "venv", "--copies", venvDir]);
}

const pipExe = isWindows
  ? join(venvDir, "Scripts", "pip.exe")
  : join(venvDir, "bin", "pip");

log("pip install requirements.txt");
exec(pipExe, ["install", "--upgrade", "pip", "-q"]);
exec(pipExe, [
  "install", "-r", join(ROOT, "requirements.txt"),
  "-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
  "--extra-index-url", "https://pypi.org/simple",
  "-q",
]);

// ── 2. llama-server ────────────────────────────────────
const llamaDir = join(ROOT, "llama.cpp", "build", "bin");
const llamaBin = isWindows
  ? join(llamaDir, "llama-server.exe")
  : join(llamaDir, "llama-server");

if (!existsSync(llamaBin)) {
  log("下载 llama-server 预编译二进制");
  mkdirSync(llamaDir, { recursive: true });

  const GH_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
  let release = null;

  try {
    const res = await fetch(GH_API, { signal: AbortSignal.timeout(15000) });
    release = await res.json();
  } catch {
    for (const proxy of ["https://gh-proxy.com/", "https://ghproxy.net/"]) {
      try {
        const res = await fetch(proxy + GH_API, { signal: AbortSignal.timeout(15000) });
        release = await res.json();
        break;
      } catch {}
    }
  }

  if (release?.assets) {
    const pattern = isWindows ? "win-cpu-x64.zip" : "linux-cpu-x64.tar.gz";
    for (const asset of release.assets) {
      if (asset.name.includes(pattern)) {
        log(`下载 ${asset.name}`);
        const outZip = join(ROOT, "llama-win.zip");
        exec("curl.exe", ["-fSL", "--max-time", "180", "-o", outZip, asset.browser_download_url]);
        if (isWindows) {
          exec("powershell", ["Expand-Archive", "-Path", outZip, "-DestinationPath", llamaDir, "-Force"]);
        } else {
          exec("tar", ["-xf", outZip, "-C", llamaDir]);
        }
        if (existsSync(outZip)) {
          const info = statSync(outZip);
          log(`完成: llama-server (${Math.round(info.size / 1024 / 1024)} MB)`);
        }
        break;
      }
    }
  }

  if (!existsSync(llamaBin)) {
    console.warn("[prepare-runtime] WARNING: llama-server 缺失，请手动放入");
  }
}

// ── 3. 模型 ───────────────────────────────────────────
const models = [
  {
    url: "https://hf-mirror.com/ggml-org/bge-m3-Q8_0-GGUF/resolve/main/bge-m3-q8_0.gguf",
    out: join(ROOT, "models", "BGE-M3", "bge-m3-q8_0.gguf"),
  },
  {
    url: "https://hf-mirror.com/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf",
    out: join(ROOT, "models", "chat", "qwen3-1.7b-q8_0.gguf"),
  },
];

for (const m of models) {
  if (existsSync(m.out)) {
    log(`模型已存在: ${basename(m.out)}`);
    continue;
  }
  mkdirSync(resolve(m.out, ".."), { recursive: true });
  log(`下载模型: ${basename(m.out)}`);
  exec("curl.exe", ["-fL", "--retry", "5", "--retry-delay", "3", "-C", "-", "-o", m.out, m.url]);
}

log("运行时准备完成");
process.exit(0);
