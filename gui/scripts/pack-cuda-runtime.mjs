#!/usr/bin/env node
/**
 * scripts/pack-cuda-runtime.mjs — CUDA 运行时增补包（打包侧「压缩 → 打包」）
 *
 * 背景：随包自带的 llama.cpp 里，CUDA 三件套（ggml-cuda / cublas64_12 / cublasLt64_12 /
 * cudart64_12）占了 1061 MB，是 llama payload 的 96%，但对纯 CPU 推理的用户毫无用处。
 *
 * 分层策略：
 *   主安装包（Slime Setup <ver>.exe）只带 CPU 运行时 —— 见 electron-builder.json 的
 *   extraFiles filter，CUDA 文件已从主包剔除。
 *   本脚本把这四个 DLL 单独压成 Slime-CUDA-Runtime-<ver>.7z，随 Release 一起发布：
 *     打包侧 = 压缩（LZMA2 极限）→ 打包（单个 7z）
 *     使用方 = 下载增补包 → 解压到 Slime 安装目录 → 即可用 GPU 推理
 *
 * 产物内布局与安装目录一致：
 *     _README.txt
 *     llama.cpp/build/bin/ggml-cuda.dll
 *     llama.cpp/build/bin/cublas64_12.dll
 *     llama.cpp/build/bin/cublasLt64_12.dll
 *     llama.cpp/build/bin/cudart64_12.dll
 *
 * 幂等：产物已存在且不比任一源文件旧 → 直接跳过。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, rmSync, statSync, readdirSync,
  writeFileSync, linkSync, copyFileSync, readFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 本脚本住在 gui/scripts/：上两级才是仓库根（llama.cpp / electron-builder.json 都在那里）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUI = join(ROOT, "gui");
const LLAMA_BIN = join(ROOT, "llama.cpp", "build", "bin");

/** 与 electron-builder.json extraFiles 中剔除项一一对应的 CUDA 文件 */
const CUDA_FILES = [
  "ggml-cuda.dll",
  "cublas64_12.dll",
  "cublasLt64_12.dll",
  "cudart64_12.dll",
];

function log(msg) {
  console.info(`[pack-cuda] ${msg}`);
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(GUI, "package.json"), "utf8"));
  return pkg.version || "0.0.1";
}

function readOutputDir() {
  const cfg = JSON.parse(readFileSync(join(GUI, "electron-builder.json"), "utf8"));
  // 与 retry-build.mjs 同源：SLIME_OUT_DIR 可一次性覆盖输出目录，保证增补包与安装包落在同一处
  return resolve(GUI, (process.env.SLIME_OUT_DIR || "").trim() || cfg.directories?.output || "release");
}

/** 7z 可执行：优先 electron-winstaller 随包自带的 vendor，其次 PATH */
function find7z() {
  const pnpm = join(ROOT, "node_modules", ".pnpm");
  if (existsSync(pnpm)) {
    for (const entry of readdirSync(pnpm)) {
      if (!entry.startsWith("electron-winstaller@")) continue;
      const vendor = join(pnpm, entry, "node_modules", "electron-winstaller", "vendor");
      for (const name of ["7z-x64.exe", "7z.exe"]) {
        const p = join(vendor, name);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const cmd of ["7z", "7za"]) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    if (r.status === 0) return cmd;
  }
  return null;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";

function main() {
  const version = readVersion();
  const outDir = readOutputDir();
  const archive = join(outDir, `Slime-CUDA-Runtime-${version}.7z`);

  const sources = CUDA_FILES.map((f) => join(LLAMA_BIN, f));
  const missing = sources.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    log(`跳过：以下 CUDA 文件不存在（本机 llama.cpp 可能是纯 CPU 构建）`);
    for (const p of missing) log(`  - ${p}`);
    return;
  }

  // 幂等：产物存在且不比任一源文件旧
  if (existsSync(archive)) {
    const outMtime = statSync(archive).mtimeMs;
    const stale = sources.some((p) => statSync(p).mtimeMs > outMtime);
    if (!stale) {
      log(`已存在且为最新：${archive}（${mb(statSync(archive).size)}）`);
      return;
    }
  }

  const sevenZip = find7z();
  if (!sevenZip) {
    throw new Error("未找到 7z 可执行程序，无法生成 CUDA 增补包");
  }
  log(`7z: ${sevenZip}`);

  // 暂存目录：用硬链接避免复制 1 GB
  const stageRoot = join(outDir, ".cuda-stage");
  const stageBin = join(stageRoot, "llama.cpp", "build", "bin");
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageBin, { recursive: true });

  let totalBytes = 0;
  for (const src of sources) {
    const dst = join(stageBin, src.slice(src.lastIndexOf("\\") + 1).split("/").pop());
    try {
      linkSync(src, dst);
    } catch {
      copyFileSync(src, dst);
    }
    totalBytes += statSync(src).size;
  }

  writeFileSync(
    join(stageRoot, "_README.txt"),
    [
      `Slime CUDA 运行时增补包 v${version}`,
      ``,
      `用途：主安装包自带的是 CPU 版 llama.cpp。若你有 NVIDIA 显卡并希望本地模型跑 GPU，`,
      `把这个压缩包里的 llama.cpp 目录解压到 Slime 的安装目录（与已有的 llama.cpp 合并覆盖）即可。`,
      ``,
      `步骤：`,
      `  1. 退出 Slime。`,
      `  2. 找到 Slime 安装目录（默认 %LOCALAPPDATA%\\Programs\\Slime）。`,
      `  3. 把本压缩包内的 llama.cpp 整个目录解压进去，遇到同名文件选择覆盖。`,
      `  4. 重新启动 Slime，本地模型即可使用 GPU。`,
      ``,
      `不需要 GPU 的用户无需下载本包；缺少这些 DLL 时 llama-server 会自动回落到 CPU 推理。`,
      ``,
    ].join("\r\n"),
    "utf8",
  );

  log(`压缩 ${CUDA_FILES.length} 个文件（原始 ${mb(totalBytes)}）…`);
  const t0 = Date.now();
  const res = spawnSync(
    sevenZip,
    [
      "a", "-t7z",
      "-m0=LZMA2", "-mx=9", "-md=64m", "-ms=on", "-mmt=4",
      "-bso0", "-bsp1", "--",
      archive, "_README.txt", "llama.cpp",
    ],
    { cwd: stageRoot, stdio: "inherit" },
  );
  if (res.status !== 0) {
    throw new Error(`7z 退出码 ${res.status}`);
  }

  rmSync(stageRoot, { recursive: true, force: true });

  const size = statSync(archive).size;
  log(`完成：${archive}`);
  log(`  ${mb(totalBytes)} → ${mb(size)}（压缩率 ${((1 - size / totalBytes) * 100).toFixed(1)}%，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
}

main();
