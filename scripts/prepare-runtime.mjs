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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { platform } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * A-1034：系统自带的命令行工具必须用**绝对路径**调用。
 *
 * "系统自带" ≠ "在 PATH 里"：`tar.exe` 在 `%SystemRoot%\System32`，但打包/受限环境下的
 * 进程 PATH 未必包含 System32 —— 同一个坑已经让用户在安装版里吃到 `spawn tar ENOENT`
 * （platform-tools 装不上、llama 解压失败）。这里按绝对路径解析，解析不到再回退裸名。
 */
function systemExe(name) {
  if (isWindows) {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const abs = resolve(root, "System32", name);
    if (existsSync(abs)) { return abs; }
  }
  return name;
}
const TAR = systemExe(isWindows ? "tar.exe" : "tar");
const isWindows = platform() === "win32";
const pythonCmd = isWindows ? "py" : "python3";
const llamaZip = join(ROOT, `llama-${isWindows ? "win" : "linux"}.zip`);

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

// venv 幂等：requirements.txt 未变则跳过 pip install（P2）
const reqFile = join(ROOT, "requirements.txt");
const reqHashFile = join(venvDir, ".requirements.sha256");

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// —— 下载辅助函数：Node 原生 fetch + 多镜像 + 重试 + 断点续传 ——
async function downloadWithRetry(urls, dest, retries = 3, timeoutMs = 60000) {
  for (const url of urls) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log(`下载 (镜像 ${urls.indexOf(url) + 1}/${urls.length}, 尝试 ${attempt}/${retries}): ${basename(url)}`);

        // 断点续传
        let startByte = 0;
        if (existsSync(dest)) {
          const s = await statAsync(dest);
          if (s.size > 0) startByte = s.size;
        }

        const res = await fetch(url, {
          headers: startByte > 0 ? { Range: `bytes=${startByte}-` } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok && !(res.status === 416 && startByte > 0)) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const fs = createWriteStream(dest, { flags: startByte > 0 ? "a" : "w" });

        if (res.status === 416) {
          // Server says "Range Not Satisfiable" — file already complete
          log("文件已完整，跳过");
          fs.close();
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("无法获取响应流");

        const writer = fs;
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!writer.write(value)) {
            await new Promise((r) => writer.once("drain", r));
          }
          received += value.length;
        }
        writer.end();

        log(`完成: ${Math.round((startByte + received) / 1024 / 1024)} MB`);
        return;
      } catch (err) {
        log(`下载失败 (镜像 ${urls.indexOf(url) + 1}, 尝试 ${attempt}/${retries}): ${err.message}`);
        if (attempt === retries) break; // 换下一个镜像
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
  }
  throw new Error(`所有镜像下载失败: ${basename(urls[0])}`);
}

if (!existsSync(venvPython)) {
  log("创建 Python venv (--copies)");
  if (existsSync(venvDir)) rmSync(venvDir, { recursive: true, force: true });
  exec(pythonCmd, ["-m", "venv", "--copies", venvDir]);
}

const pipExe = isWindows
  ? join(venvDir, "Scripts", "pip.exe")
  : join(venvDir, "bin", "pip");

const reqHash = sha256File(reqFile);
const reqHashStored = existsSync(reqHashFile)
  ? readFileSync(reqHashFile, "utf8").trim()
  : "";
if (existsSync(venvPython) && reqHashStored === reqHash) {
  log("requirements.txt 未变化，跳过 pip install");
} else {
  log("pip install requirements.txt");
  exec(pipExe, [
    "install",
    "-r", reqFile,
    "-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
    "--extra-index-url", "https://pypi.org/simple",
    "-q",
    "--no-cache-dir",
  ]);
  writeFileSync(reqHashFile, reqHash);
}

// ── 2. llama-server ────────────────────────────────────
const llamaDir = join(ROOT, "llama.cpp", "build", "bin");
const llamaBin = isWindows
  ? join(llamaDir, "llama-server.exe")
  : join(llamaDir, "llama-server");

if (!existsSync(llamaBin)) {
  log("下载 llama-server 预编译二进制（Windows=CUDA 12.4；Linux=Vulkan）");
  mkdirSync(llamaDir, { recursive: true });

  const GH_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
  const GH_PROXIES = ["https://gh-proxy.com/", "https://ghproxy.net/", ""];
  let release = null;

  async function fetchRelease(endpoint) {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j?.assets)) throw new Error("响应无 assets");
    return j;
  }
  try {
    release = await fetchRelease(GH_API);
  } catch {
    for (const p of GH_PROXIES) {
      if (!p) continue;
      try {
        release = await fetchRelease(p + GH_API);
        break;
      } catch {}
    }
  }

  if (release?.assets) {
    // 直连优先；失败时走 gh-proxy 镜像
    const proxyUrls = (url) => [url, ...GH_PROXIES.filter((p) => p).map((p) => p + url)];

    if (isWindows) {
      // Windows CUDA：llama.cpp 新版把包拆成「二进制包」+「cudart 运行时 DLL 包」两份，
      // 需要两个都下载并解压到同一目录，才自包含可运行。CPU 为单一 zip 兜底。
      const byNeedle = (pred, ext) =>
        release.assets.find((a) => a.name && a.name.endsWith(ext) && pred(a.name)) ?? null;
      const binAsset = byNeedle((n) => /win-cuda/.test(n) && !n.startsWith("cudart-"), ".zip")
        ?? byNeedle((n) => n.includes("win-cpu-x64"), ".zip");
      const runtimeAsset = byNeedle((n) => n.startsWith("cudart-") && n.includes("win-cuda-12.4"), ".zip");

      if (binAsset?.browser_download_url) {
        const binFile = join(ROOT, "llama-bin-win.zip");
        log(`下载二进制包 ${binAsset.name} (${Math.round(binAsset.size / 1024 / 1024)} MB)`);
        await downloadWithRetry(proxyUrls(binAsset.browser_download_url), binFile, 2, 600_000);
        // zip：Windows 内置 bsdtar 可解压
        exec(TAR, ["-xf", binFile, "-C", llamaDir]);

        if (runtimeAsset?.browser_download_url) {
          const cudartFile = join(ROOT, "llama-cudart-win.zip");
          log(`下载 CUDA 运行时 ${runtimeAsset.name} (${Math.round(runtimeAsset.size / 1024 / 1024)} MB)`);
          await downloadWithRetry(proxyUrls(runtimeAsset.browser_download_url), cudartFile, 2, 600_000);
          exec(TAR, ["-xf", cudartFile, "-C", llamaDir]);
        }
      }
    } else {
      // Linux：官方无 CUDA 预编译，GPU 走 Vulkan 单包（tar.gz）；CPU 兜底
      const byNeedle = (pred, ext) =>
        release.assets.find((a) => a.name && a.name.endsWith(ext) && pred(a.name)) ?? null;
      const vulkan = byNeedle((n) => n.includes("vulkan-x64"), ".tar.gz")
        ?? byNeedle((n) => n.includes("ubuntu-x64"), ".tar.gz");
      if (vulkan?.browser_download_url) {
        const file = join(ROOT, "llama-linux.tar.gz");
        log(`下载 ${vulkan.name} (${Math.round(vulkan.size / 1024 / 1024)} MB)`);
        await downloadWithRetry(proxyUrls(vulkan.browser_download_url), file, 2, 600_000);
        exec(TAR, ["-xzf", file, "-C", llamaDir]);
      }
    }

    const extracted = existsSync(llamaBin);
    if (extracted) {
      const sizeMB = Math.round(statSync(llamaBin).size / 1024);
      log(`完成: llama-server 就绪 (${sizeMB} KB)`);
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

  // 下载模型：使用 Node 原生 fetch，自动重试，600s 超时
  await downloadWithRetry([m.url], m.out, 3, 600_000);
}

log("运行时准备完成");
process.exit(0);
