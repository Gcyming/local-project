/**
 * gui/src/main/downloader.ts — 依赖下载器（应用内下载，国内镜像链路）。
 * - bge 嵌入模型：hf-mirror.com 镜像（HuggingFace 官方直连被墙）
 * - llama.cpp：GitHub API 查最新 win 预编译包 → gh-proxy 系列镜像加速下载
 * - 断点续传：Range 请求 + received 字节数；暂停=中止保留断点，恢复=续传，取消=删除文件
 * - 进度事件经回调推给渲染层（下载条 UI）
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readDepStatus, updateTomlKey } from "./mind_config.js";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";

export type DownloadTarget = "llama" | "bge";

export type DownloadState = "idle" | "downloading" | "paused" | "done" | "error";

export interface DownloadProgress {
  target: DownloadTarget;
  state: DownloadState;
  percent: number;
  receivedMB: number;
  totalMB: number;
  path: string;
  error?: string;
  /** llama.cpp zip 解压完成后的目录提示 */
  extractedDir?: string;
}

export type ProgressListener = (p: DownloadProgress) => void;

/** 国内镜像（依次尝试；Range 续传语义与源文件一致） */
const GH_MIRRORS = [
  "https://gh-proxy.com/",
  "https://mirror.ghproxy.com/",
  "https://ghfast.top/",
];

/** 嵌入模型镜像（hf-mirror.com 是 HuggingFace 官方镜像，国内直连可用） */
const HF_MIRROR = "https://hf-mirror.com";

/** 官方权威源：llama.cpp 官方组织转换（BAAI/bge-m3 → GGUF Q8_0，635MB） */
const BGE_REPO = "ggml-org/bge-m3-Q8_0-GGUF";
const BGE_FILE = "bge-m3-q8_0.gguf";

const CHUNK = 64 * 1024;

interface Task {
  target: DownloadTarget;
  url: string;
  dest: string;
  fileName: string;
  received: number;
  total: number;
  state: DownloadState;
  abort: AbortController | null;
  mirrorIndex: number;
  extractedDir: string;
}

const tasks = new Map<DownloadTarget, Task>();

/** 进度回调（主进程注册，转发到渲染层） */
let listener: ProgressListener | null = null;

export function setDownloadListener(fn: ProgressListener | null): void {
  listener = fn;
}

function emit(p: DownloadProgress): void {
  listener?.(p);
}

function taskProgress(t: Task, error?: string): DownloadProgress {
  return {
    target: t.target,
    state: t.state,
    percent: t.total > 0 ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0,
    receivedMB: Math.round((t.received / 1024 / 1024) * 10) / 10,
    totalMB: Math.round((t.total / 1024 / 1024) * 10) / 10,
    path: t.dest,
    error,
    extractedDir: t.extractedDir,
  };
}

/** 下载目标目录：模型配置路径所在目录存在则用之（D:\tool\slime 生态），否则项目 downloads 兜底 */
function destDirFor(target: DownloadTarget): string {
  const deps = readDepStatus();
  const prefer = target === "bge" ? deps.bgeModel : deps.llamaBin;
  if (prefer && existsSync(dirname(prefer))) {
    return dirname(prefer);
  }
  const dir = resolve(PROJECT_ROOT, "downloads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 解析 llama.cpp 最新预编译包（按平台：Windows=win CPU x64 zip，Linux=linux x64 zip；GitHub API 失败抛错） */
async function resolveLlamaAsset(): Promise<{ name: string; url: string }> {
  const resp = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "slime-gui" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error(`GitHub API HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
  const assets = (data.assets ?? []).filter((a) => (a.name ?? "").endsWith(".zip"));
  const isWin = process.platform === "win32";
  // 优先官方 CPU x64 包（Windows: win-cpu-x64；Linux: linux-x64）；无匹配回退平台任意 zip
  const picked =
    assets.find((a) => (a.name ?? "").includes(isWin ? "win-cpu-x64" : "linux-x64")) ??
    assets.find((a) => (a.name ?? "").toLowerCase().includes(isWin ? "win" : "linux"));
  if (!picked?.browser_download_url) {
    throw new Error(`未找到 llama.cpp ${process.platform} 预编译包`);
  }
  return { name: picked.name ?? "llama.cpp.zip", url: picked.browser_download_url };
}

/** 获取下载任务（首次调用解析 URL 与目标路径） */
async function getOrCreateTask(target: DownloadTarget): Promise<Task> {
  const existing = tasks.get(target);
  if (existing) {
    return existing;
  }
  const dir = destDirFor(target);
  let url = "";
  let fileName = "";
  if (target === "bge") {
    url = `${HF_MIRROR}/${BGE_REPO}/resolve/main/${BGE_FILE}`;
    fileName = BGE_FILE;
  } else {
    const asset = await resolveLlamaAsset();
    url = asset.url;
    fileName = asset.name;
  }
  const task: Task = {
    target,
    url,
    dest: resolve(dir, fileName),
    fileName,
    received: 0,
    total: 0,
    state: "idle",
    abort: null,
    mirrorIndex: -1,
    extractedDir: "",
  };
  tasks.set(target, task);
  return task;
}

/** 开始/恢复下载（received>0 时带 Range 续传；镜像逐个尝试） */
async function runTask(task: Task): Promise<void> {
  if (task.state === "downloading") {
    return;
  }
  task.state = "downloading";
  emit(taskProgress(task));
  const ctrl = new AbortController();
  task.abort = ctrl;

  while (task.mirrorIndex < GH_MIRRORS.length) {
    if (task.target === "llama") {
      task.mirrorIndex += 1;
    }
    const base = task.target === "llama"
      ? (task.mirrorIndex === 0 ? "" : GH_MIRRORS[task.mirrorIndex - 1])
      : "";
    const useUrl = task.target === "llama" && base ? `${base}${task.url}` : task.url;

    const headers: Record<string, string> = {};
    if (task.received > 0) {
      headers.Range = `bytes=${task.received}-`;
    }
    try {
      const resp = await fetch(useUrl, { headers, signal: ctrl.signal });
      if (!resp.ok) {
        if (resp.status === 416) {
          // 已完整下载（断点=文件末尾）
          task.state = "done";
          emit(taskProgress(task));
          return;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      // 服务器忽略 Range 返回 200 → 从头重下，避免拼接损坏
      if (resp.status === 200 && task.received > 0) {
        task.received = 0;
      }
      const lengthHeader = resp.headers.get("content-length");
      const contentRange = resp.headers.get("content-range");
      if (contentRange) {
        const m = /\/\s*(\d+)\s*$/.exec(contentRange);
        if (m) {
          task.total = Number(m[1]);
        }
      } else if (lengthHeader) {
        task.total = task.received + Number(lengthHeader);
      }
      emit(taskProgress(task));

      const body = resp.body;
      if (!body) {
        throw new Error("空响应体");
      }
      const writeStream = createWriteStream(task.dest, { flags: task.received > 0 ? "a" : "w" });
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        if (ctrl.signal.aborted) {
          writeStream.destroy();
          return;
        }
        writeStream.write(chunk);
        task.received += (chunk as Uint8Array).byteLength;
        if (task.received % (CHUNK * 8) === 0) {
          emit(taskProgress(task));
        }
      }
      await new Promise<void>((done) => writeStream.end(done));
      task.state = "done";
      emit(taskProgress(task));
      if (task.target === "llama") {
        extractLlamaZip(task);
      } else {
        relocateToConfiguredPath(task);
      }
      return;
    } catch (e) {
      if (ctrl.signal.aborted) {
        return; // 用户暂停/取消，静默
      }
      const err = e instanceof Error ? e.message : String(e);
      if (task.target === "llama" && task.mirrorIndex < GH_MIRRORS.length) {
        console.warn(`[downloader] 镜像 ${task.mirrorIndex} 失败（${err}），切换下一镜像续传`);
        continue;
      }
      task.state = "error";
      emit(taskProgress(task, err));
      return;
    }
  }
  task.state = "error";
  emit(taskProgress(task, "镜像全部失败"));
}

/** 已下载文件归位到 slime.toml 配置路径（bge 移动；llama zip 解压 + 自动改写 llama_bin） */
function relocateToConfiguredPath(task: Task): void {
  const deps = readDepStatus();
  if (task.target === "bge") {
    const configured = deps.bgeModel;
    if (!configured || resolve(task.dest) === resolve(configured) || !existsSync(dirname(configured))) {
      return;
    }
    try {
      renameSync(task.dest, configured);
      task.dest = configured;
      emit(taskProgress(task));
      console.info(`[downloader] 嵌入模型已归位到配置路径: ${configured}`);
    } catch (e) {
      console.warn(`[downloader] 嵌入模型归位失败（可手动移动）: ${e}`);
    }
    return;
  }
  // llama：zip 已解压（extractLlamaZip 完成）→ 检测 llama-server.exe 并自动配置
  const configured = deps.llamaBin;
  if (!task.extractedDir || !configured || existsSync(configured)) {
    return;
  }
  const exe = findLlamaServer(task.extractedDir);
  if (!exe) {
    return;
  }
  updateTomlKey("llama_bin", exe);
  emit(taskProgress(task));
  console.info(`[downloader] slime.toml llama_bin 已更新: ${exe}`);
}

/** llama.cpp zip 解压（Windows 内置 tar 支持 zip；Linux 用 unzip，缺失时提示） */
function extractLlamaZip(task: Task): void {
  const outDir = resolve(PROJECT_ROOT, "downloads", "llama.cpp");
  mkdirSync(outDir, { recursive: true });
  const args = process.platform === "win32"
    ? ["-xf", task.dest, "-C", outDir]
    : ["-q", "-o", task.dest, "-d", outDir];
  const tool = process.platform === "win32" ? "tar" : "unzip";
  const child = spawn(tool, args, { windowsHide: true });
  child.on("exit", (code) => {
    if (code === 0) {
      task.extractedDir = outDir;
      emit(taskProgress(task));
      relocateToConfiguredPath(task);
    } else {
      task.extractedDir = "";
      emit(taskProgress(task, `解压失败（code ${code}），请手动解压 ${task.dest}`));
    }
  });
  child.on("error", (e) => {
    task.extractedDir = "";
    emit(taskProgress(task, `解压失败：${e.message}`));
  });
}

/** 递归查找 llama-server 可执行文件（Windows: llama-server.exe；Linux/macOS: llama-server） */
function findLlamaServer(dir: string): string | null {
  const isWin = process.platform === "win32";
  const want = isWin ? "llama-server.exe" : "llama-server";
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        const r = findLlamaServer(p);
        if (r) return r;
      } else if (e.name.toLowerCase() === want) {
        return p;
      }
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 启动/刷新时收尾：downloads/ 下已完成的文件自动归位到配置路径 */
export function tryRelocateDownloads(): void {
  const deps = readDepStatus();
  const dlDir = resolve(PROJECT_ROOT, "downloads");
  try {
    if (!existsSync(dlDir)) return;
    // bge：已下载文件 → 移动至配置路径
    if (deps.bgeModel && !existsSync(deps.bgeModel) && existsSync(dirname(deps.bgeModel))) {
      const src = resolve(dlDir, BGE_FILE);
      if (existsSync(src)) {
        renameSync(src, deps.bgeModel);
        console.info(`[downloader] 已归位嵌入模型: ${deps.bgeModel}`);
      }
    }
    // llama：zip 未解压且配置路径缺失 → 解压 + 自动配置
    if (deps.llamaBin && !existsSync(deps.llamaBin)) {
      const isWin = process.platform === "win32";
      const exeName = isWin ? "llama-server.exe" : "llama-server";
      const zips = readdirSync(dlDir).filter((f) => f.includes(isWin ? "win-cpu-x64" : "linux-x64") && f.endsWith(".zip"));
      if (zips.length > 0) {
        const outDir = resolve(dlDir, "llama.cpp");
        const zip = resolve(dlDir, zips[0]);
        if (!existsSync(resolve(outDir, exeName))) {
          mkdirSync(outDir, { recursive: true });
          const args = isWin
            ? ["-xf", zip, "-C", outDir]
            : ["-q", "-o", zip, "-d", outDir];
          const r = spawnSync(isWin ? "tar" : "unzip", args, { windowsHide: true, timeout: 120_000 });
          if (r.status !== 0) {
            console.warn(`[downloader] llama.zip 解压失败: ${r.stderr?.toString() ?? "?"}`);
          }
        }
        const exe = findLlamaServer(outDir);
        if (exe) {
          updateTomlKey("llama_bin", exe);
          console.info(`[downloader] slime.toml llama_bin 已更新: ${exe}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[downloader] 归位收尾失败: ${e}`);
  }
}

/** 对外：开始/恢复下载 */
export async function startDownload(target: DownloadTarget): Promise<{ ok: boolean; error?: string }> {
  try {
    const task = await getOrCreateTask(target);
    if (task.state === "done") {
      emit(taskProgress(task));
      return { ok: true };
    }
    void runTask(task);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 对外：暂停 / 取消 / 恢复 */
export function controlDownload(target: DownloadTarget, action: "pause" | "cancel" | "resume"): { ok: boolean } {
  const task = tasks.get(target);
  if (!task) {
    return { ok: false };
  }
  if (action === "pause" && task.state === "downloading") {
    task.abort?.abort();
    task.state = "paused";
    emit(taskProgress(task));
    return { ok: true };
  }
  if (action === "cancel") {
    task.abort?.abort();
    task.received = 0;
    task.total = 0;
    task.state = "idle";
    try {
      rmSync(task.dest, { force: true });
    } catch {
      /* 清理失败忽略 */
    }
    emit(taskProgress(task));
    return { ok: true };
  }
  if (action === "resume" && (task.state === "paused" || task.state === "error" || task.state === "idle")) {
    task.mirrorIndex = 0;
    void runTask(task);
    return { ok: true };
  }
  return { ok: false };
}

/** 对外：当前任务状态快照（面板刷新用） */
export function downloadSnapshot(target: DownloadTarget): DownloadProgress {
  const task = tasks.get(target);
  if (!task) {
    return { target, state: "idle", percent: 0, receivedMB: 0, totalMB: 0, path: "" };
  }
  return taskProgress(task);
}