/**
 * gui/src/main/downloader.ts — 依赖下载器（应用内下载，国内镜像链路）。
 * - bge 嵌入模型：hf-mirror.com 镜像（HuggingFace 官方直连被墙）
 * - llama.cpp：GitHub API 查最新 win 预编译包 → gh-proxy 系列镜像加速下载
 * - 断点续传：Range 请求 + received 字节数；暂停=中止保留断点，恢复=续传，取消=删除文件
 * - 进度事件经回调推给渲染层（下载条 UI）
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

/** 各目标的最小有效文件大小（字节）：小于此值视为残缺/中断的下载残片，强制重下 */
const MIN_VALID_SIZE: Record<DownloadTarget, number> = {
  bge: 500 * 1024 * 1024,   // bge-m3-q8_0.gguf 完整约 634MB
  llama: 1 * 1024 * 1024,   // llama.cpp 预编译 zip 至少 1MB
};

interface Task {
  target: DownloadTarget;
  url: string;
  dest: string;
  fileName: string;
  /** Windows CUDA 需要叠加的 CUDA 运行时 DLL 包（cudart-*），可为空 */
  runtime?: { name: string; url: string } | null;
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

/** bge 嵌入模型下载完成回调（index.ts 注册 → 自动拉起 embedding 服务，免手动重试） */
let bgeReadyCb: (() => void) | null = null;

export function setBgeReadyCallback(fn: (() => void) | null): void {
  bgeReadyCb = fn;
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

/**
 * 下载目标目录：优先落到 slime.toml 配置路径所在目录（不存在则自动创建），
 * 使 bge 下载完成后直接命中配置路径，依赖状态随即变绿；无配置才回退
 * 项目 downloads 目录。此前只识别「已存在」的目录，URL 配到 AppData 下
 * 尚未创建的目录时退到 downloads/，下载后无法归位、状态永远不变 —— 这是
 * 用户反馈「进度不动/反复退出才显示正确」的根因。
 */
function destDirFor(target: DownloadTarget): string {
  const deps = readDepStatus();
  const prefer = target === "bge" ? deps.bgeModel : deps.llamaBin;
  if (prefer) {
    const dir = dirname(prefer);
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      console.warn(`[downloader] 无法创建配置目录（${dir}），回退 downloads: ${e}`);
    }
  }
  const dir = resolve(PROJECT_ROOT, "downloads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 解析 llama.cpp 最新预编译包（按平台；GitHub API 失败抛错）。
 * - Windows：优先 CUDA 12.4 —— llama.cpp 新版把 CUDA 拆成「二进制包」+「cudart 运行时 DLL 包」两张，
 *   故返回二进制包为主 + runtime 运行时包；两者都解压到同一目录才自包含。CPU 单 zip 兜底。
 * - Linux：官方不再发布 CUDA 预编译，其 NVIDIA/AMD GPU 加速走 Vulkan 单包（tar.gz），回退 CPU。
 */
async function resolveLlamaAsset(): Promise<{ name: string; url: string; runtime?: { name: string; url: string } | null }> {
  const resp = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "slime-gui" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error(`GitHub API HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
  const assets = (data.assets ?? []) as Array<{ name: string; browser_download_url: string }>;
  const isWin = process.platform === "win32";
  if (!isWin) {
    // Linux：Vulkan 单包（GPU）→ CPU 兜底
    const vulkan =
      assets.find((a) => a.name && a.name.endsWith(".tar.gz") && /vulkan-x64/.test(a.name)) ??
      assets.find((a) => a.name && a.name.endsWith(".tar.gz") && a.name.includes("ubuntu-x64"));
    if (!vulkan?.browser_download_url) {
      throw new Error(`未找到 llama.cpp ${process.platform} 预编译包`);
    }
    return { name: vulkan.name, url: vulkan.browser_download_url };
  }
  // Windows：二进制包（win-cuda*，排除 cudart- 运行时包）→ 叠加 cudart 运行时包 → CPU 兜底
  const bin =
    assets.find((a) => a.name && a.name.endsWith(".zip") && /win-cuda/.test(a.name) && !a.name.startsWith("cudart-")) ??
    assets.find((a) => a.name && a.name.endsWith(".zip") && a.name.includes("win-cpu-x64"));
  if (!bin?.browser_download_url) {
    throw new Error(`未找到 llama.cpp ${process.platform} 预编译包`);
  }
  const runtime = assets.find((a) => a.name && a.name.endsWith(".zip") && a.name.startsWith("cudart-") && a.name.includes("win-cuda-12.4"));
  return {
    name: bin.name,
    url: bin.browser_download_url,
    runtime: runtime?.browser_download_url ? { name: runtime.name, url: runtime.browser_download_url } : null,
  };
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
  let runtime: { name: string; url: string } | null = null;
  if (target === "bge") {
    url = `${HF_MIRROR}/${BGE_REPO}/resolve/main/${BGE_FILE}`;
    fileName = BGE_FILE;
  } else {
    const asset = await resolveLlamaAsset();
    url = asset.url;
    fileName = asset.name;
    runtime = asset.runtime ?? null;
  }
  const task: Task = {
    target,
    url,
    dest: resolve(dir, fileName),
    fileName,
    runtime,
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
  // 残缺文件强制从头重下：上次中断留下的残片（如几 KB 的 bge）不得被断点续传拼接成损坏模型
  if (existsSync(task.dest)) {
    try {
      const st = statSync(task.dest);
      if (st.size > 0 && st.size < MIN_VALID_SIZE[task.target]) {
        console.warn(`[downloader] ${task.target} 存在残缺文件（${st.size} 字节 < ${MIN_VALID_SIZE[task.target]}），删除并从头重下`);
        rmSync(task.dest, { force: true });
        task.received = 0;
        task.total = 0;
      }
    } catch { /* 忽略 stat 失败 */ }
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
      // 进度实时推送：每 128KB 或 400ms 至少一次（修复进度条不实时更新）
      let lastEmitAt = 0;
      let lastDataAt = Date.now();
      const STALL_MS = 30_000;
      const stallTimer = setInterval(() => {
        if (task.state !== "downloading") { clearInterval(stallTimer); return; }
        if (Date.now() - lastDataAt > STALL_MS) {
          clearInterval(stallTimer);
          ctrl.abort();
          task.state = "error";
          emit(taskProgress(task, "下载连接超时（30 秒无数据），请重试"));
        }
      }, 5000);
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        if (ctrl.signal.aborted) {
          clearInterval(stallTimer);
          writeStream.destroy();
          return;
        }
        writeStream.write(chunk);
        task.received += (chunk as Uint8Array).byteLength;
        lastDataAt = Date.now();
        const now = Date.now();
        if (task.received % (CHUNK * 2) === 0 || now - lastEmitAt > 400) {
          lastEmitAt = now;
          emit(taskProgress(task));
        }
      }
      clearInterval(stallTimer);
      await new Promise<void>((done) => writeStream.end(done));
      // 完整性校验：下载完成但文件仍小于最小有效大小 → 视为失败（防镜像返回残缺内容）
      let finalSize = 0;
      try {
        finalSize = statSync(task.dest).size;
      } catch { /* 忽略 */ }
      if (finalSize < MIN_VALID_SIZE[task.target]) {
        task.state = "error";
        emit(taskProgress(task, `下载不完整（${Math.round(finalSize / 1024 / 1024)}MB < 预期最小 ${Math.round(MIN_VALID_SIZE[task.target] / 1024 / 1024)}MB），请重试`));
        return;
      }
      task.state = "done";
      emit(taskProgress(task));
      if (task.target === "llama") {
        void finishLlama(task);
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
      bgeReadyCb?.(); // 下载完成 → 自动拉起 embedding 服务
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

/** llama 收尾：Windows 先部署 CUDA 运行时 DLL 包（如需），再解压二进制包到同一目录，最后自动配置 llama_bin */
async function finishLlama(task: Task): Promise<void> {
  const outDir = resolve(PROJECT_ROOT, "downloads", "llama.cpp");
  mkdirSync(outDir, { recursive: true });
  const isWin = process.platform === "win32";
  const ext = isWin ? ".zip" : ".tar.gz";
  try {
    if (task.runtime) {
      const rtDest = resolve(dirname(task.dest), "llama-cudart" + ext);
      const ok = await downloadArchive(task.runtime.url, rtDest, task);
      if (ok) {
        const r = spawnSync("tar", isWin ? ["-xf", rtDest, "-C", outDir] : ["-xzf", rtDest, "-C", outDir], { windowsHide: true, timeout: 120_000 });
        if (r.status !== 0) {
          console.warn(`[downloader] CUDA 运行时解压失败: ${r.stderr?.toString() ?? "?"}`);
        }
      } else {
        console.warn("[downloader] CUDA 运行时下载失败（二进制仍使用，缺 cudart 时可能需手动补）");
      }
    }
    const args = isWin ? ["-xf", task.dest, "-C", outDir] : ["-xzf", task.dest, "-C", outDir];
    const r2 = spawnSync("tar", args, { windowsHide: true, timeout: 120_000 });
    task.extractedDir = outDir;
    emit(taskProgress(task, r2.status !== 0 ? `解压失败（code ${r2.status}），请手动解压 ${task.dest}` : undefined));
    if (r2.status === 0) {
      relocateToConfiguredPath(task);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit(taskProgress(task, `llama 安装失败：${msg}`));
    console.error("[downloader] finishLlama", e);
  }
}

/** 下载单个归档（带镜像与断点续传；进度并入宿主 task），返回是否成功 */
async function downloadArchive(url: string, dest: string, task: Task): Promise<boolean> {
  for (const base of ["", ...GH_MIRRORS]) {
    const useUrl = base ? `${base}${url}` : url;
    try {
      let start = 0;
      if (existsSync(dest)) {
        start = statSync(dest).size;
      }
      const resp = await fetch(useUrl, { headers: start > 0 ? { Range: `bytes=${start}-` } : {} });
      if (!resp.ok && !(resp.status === 416 && start > 0)) {
        continue;
      }
      if (resp.status === 416) {
        return true; // 已完整
      }
      if (start > 0 && resp.status === 200) {
        start = 0; // 忽略 Range，重下
      }
      const ws = createWriteStream(dest, { flags: start > 0 ? "a" : "w" });
      if (resp.body) {
        for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
          ws.write(chunk);
          task.received += chunk.byteLength;
          if (task.received % (CHUNK * 16) === 0) {
            emit(taskProgress(task, undefined));
          }
        }
      }
      await new Promise<void>((done) => ws.end(done));
      return true;
    } catch (e) {
      console.warn(`[downloader] 归档下载失败（${base || "直连"}: ${e instanceof Error ? e.message : e}）`);
    }
  }
  return false;
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
    // llama：归档未解压且配置路径缺失 → 解压 + 自动配置（Windows=zip，Linux=tar.gz）
    if (deps.llamaBin && !existsSync(deps.llamaBin)) {
      const isWin = process.platform === "win32";
      const exeName = isWin ? "llama-server.exe" : "llama-server";
      const ext = isWin ? ".zip" : ".tar.gz";
      const marker = isWin ? "win" : "ubuntu";
      const archives = readdirSync(dlDir).filter((f) => f.includes(marker) && f.endsWith(ext));
      if (archives.length > 0) {
        const outDir = resolve(dlDir, "llama.cpp");
        const archive = resolve(dlDir, archives[0]);
        if (!existsSync(resolve(outDir, exeName))) {
          mkdirSync(outDir, { recursive: true });
          const args = isWin
            ? ["-xf", archive, "-C", outDir]
            : ["-xzf", archive, "-C", outDir];
          const r = spawnSync("tar", args, { windowsHide: true, timeout: 120_000 });
          if (r.status !== 0) {
            console.warn(`[downloader] llama 归档解压失败: ${r.stderr?.toString() ?? "?"}`);
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