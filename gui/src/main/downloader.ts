/**
 * gui/src/main/downloader.ts — 依赖下载器（应用内下载，国内镜像链路）。
 * - bge 嵌入模型：hf-mirror.com 镜像（HuggingFace 官方直连被墙）
 * - llama.cpp：GitHub API 查最新 win 预编译包 → gh-proxy 系列镜像加速下载
 * - 断点续传：Range 请求 + received 字节数；暂停=中止保留断点，恢复=续传，取消=删除文件
 * - 进度事件经回调推给渲染层（下载条 UI）
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readDepStatus, updateTomlKey } from "./mind_config.js";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { extractZipTo } from "../../../core-ts/src/zip.js";
import { clampPercent, extractDetail, extractPercent, type DownloadPhase } from "../shared/downloadPhase.js";

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
  /** 当前阶段（A-1038）：下载 / 解压 / 配置 / 完成 */
  phase: DownloadPhase;
  /** 阶段明细（"128/305 个文件"、"CUDA 运行时 …"）；无明细为空串 */
  detail: string;
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

/** 解压阶段推送压频窗口（毫秒）：解压是 CPU/IO 密集，逐条推会把 IPC 打满 */
const EXTRACT_EMIT_MS = 150;

interface Task {
  target: DownloadTarget;
  url: string;
  dest: string;
  fileName: string;
  /** Windows CUDA 需要叠加的 CUDA 运行时 DLL 包（cudart-*），可为空 */
  runtime: { name: string; url: string } | null;
  received: number;
  total: number;
  state: DownloadState;
  abort: AbortController | null;
  mirrorIndex: number;
  extractedDir: string;
  /** 当前阶段（A-1038）；解压/配置期的百分比走 phasePercent，不再看 received/total */
  phase: DownloadPhase;
  phasePercent: number;
  detail: string;
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

/**
 * 百分比口径**唯一判据**（A-1038）。
 *
 * 三个阶段各有一套分子分母，混用会拼出假数字：解压期若还拿 `received/total` 算，
 * 条子会停在 100%（下载已满）不动 —— 正是"看起来卡死"的旧观感。
 * 所以这里按 phase 分派，**不允许**调用方自己再算一遍。
 */
function currentPercent(t: Task): number {
  if (t.phase === "extract" || t.phase === "config") {
    return clampPercent(t.phasePercent);
  }
  if (t.phase === "done") {
    return 100;
  }
  return t.total > 0 ? clampPercent((t.received / t.total) * 100) : 0;
}

function taskProgress(t: Task, error?: string): DownloadProgress {
  return {
    target: t.target,
    state: t.state,
    phase: t.phase,
    detail: t.detail,
    percent: currentPercent(t),
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
    phase: "download",
    phasePercent: 0,
    detail: "",
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
  task.phase = "download";
  task.phasePercent = 0;
  task.detail = "";
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
      // ⚠️ 这里**不能**置 state="done"（A-1038）：对用户而言此刻还远远没完 ——
      // llama 的包还要解压上千个文件、部署 CUDA 运行时、改写配置。
      // 旧实现在这里就置 done，界面随即把进度条撤掉，解压期变成纯干等（用户原话"纯干等"）。
      // 现在保持 state="downloading"、把 phase 推到 extract，收尾由下面各分支负责。
      task.phase = "extract";
      task.phasePercent = 0;
      task.detail = "";
      emit(taskProgress(task));
      if (task.target === "llama") {
        const fin = await finishLlama(task);
        task.detail = "";
        if (fin.ok) {
          task.state = "done";
          task.phase = "done";
          emit(taskProgress(task));
        } else {
          task.state = "error";
          task.phase = "extract";
          emit(taskProgress(task, fin.error));
        }
        return;
      }
      relocateToConfiguredPath(task);
      task.state = "done";
      task.phase = "done";
      task.detail = "";
      emit(taskProgress(task));
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

/**
 * 解压单个归档到 outDir，并把**解压期进度**实时推给宿主 task（task 为 null 时只解压、不推）。
 *
 * ⚠️ Windows 走零依赖 zip 模块（`node:zlib`）：这同时修掉 A-1034 的同类隐患 ——
 * llama 这条路径此前仍在 `spawnSync("tar", ["-xf", zip])`，`tar` 在**打包后进程的 PATH 里**
 * 并不保证存在（用户实测过 adb 侧的 `spawn tar ENOENT`）。同一个错不该在两条路径上各犯一次。
 *
 * ⚠️ Linux 官方只发 `.tar.gz`。`node:zlib` 能解 gzip 但解不了 tar 容器本身，
 * 所以这条分支仍保留 `tar` —— 但失败时**必须把真实原因讲出来**（含 spawn 失败），
 * 不许只回一句"解压失败"。
 *
 * 返回 Promise：zip 分支的 `extractZipTo` 是 async（逐条目让出事件循环），同步签名会拿到
 * 一个 Promise 当结果用（tsc 会拦，但这类错误极易被 `as any` 绕过）——故统一 async。
 */
async function extractArchiveTo(archivePath: string, outDir: string, task: Task | null): Promise<{ ok: boolean; error?: string }> {
  if (!/\.zip$/i.test(archivePath)) {
    const r = spawnSync("tar", ["-xzf", archivePath, "-C", outDir], { windowsHide: true, timeout: 300_000 });
    if (r.status !== 0) {
      const stderr = (r.stderr?.toString() ?? "").trim();
      const spawnErr = (r.error as NodeJS.ErrnoException | undefined)?.message;
      return { ok: false, error: stderr || spawnErr || `tar 退出码 ${String(r.status)}` };
    }
    return { ok: true };
  }
  try {
    const buf = readFileSync(archivePath);
    let lastEmit = 0;
    // 解压本身是 async（逐条目让出事件循环）—— 否则主进程被独占，进度事件只在最后一次性落地
    const res = await extractZipTo(buf, outDir, {
      onProgress: (p) => {
        if (!task) { return; }
        const now = Date.now();
        const isLast = p.current === "";
        if (!isLast && now - lastEmit < EXTRACT_EMIT_MS) { return; }
        lastEmit = now;
        task.phase = "extract";
        task.phasePercent = extractPercent(p);
        task.detail = extractDetail(p);
        emit(taskProgress(task));
      },
    });
    if (res.files === 0) {
      return { ok: false, error: "压缩包内没有可写出的文件（可能已损坏）" };
    }
    if (res.skipped.length > 0) {
      return { ok: false, error: `${res.skipped.length} 个条目因路径不安全被拒绝（首个：${res.skipped[0]}）` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * llama 收尾：Windows 先部署 CUDA 运行时 DLL 包（如需），再解压二进制包到同一目录，最后自动配置 llama_bin。
 * 返回 ok=false 时**必须**由调用方把 task 置为 error —— 否则解压失败会伪装成"已完成"。
 */
async function finishLlama(task: Task): Promise<{ ok: boolean; error?: string }> {
  const outDir = resolve(PROJECT_ROOT, "downloads", "llama.cpp");
  mkdirSync(outDir, { recursive: true });
  const isWin = process.platform === "win32";
  const ext = isWin ? ".zip" : ".tar.gz";
  try {
    if (task.runtime) {
      const rtDest = resolve(dirname(task.dest), "llama-cudart" + ext);
      // 阶段文案必须标明"CUDA 运行时"：否则用户看到条子从 100% 退回 0% 会以为是重新下载
      const ok = await downloadArchive(task.runtime.url, rtDest, task, `CUDA 运行时 ${task.runtime.name}`);
      if (ok) {
        task.phase = "extract";
        task.phasePercent = 0;
        task.detail = "CUDA 运行时";
        emit(taskProgress(task));
        const r = await extractArchiveTo(rtDest, outDir, task);
        if (!r.ok) {
          console.warn(`[downloader] CUDA 运行时解压失败: ${r.error}`);
        }
      } else {
        console.warn("[downloader] CUDA 运行时下载失败（二进制仍使用，缺 cudart 时可能需手动补）");
      }
    }
    task.phase = "extract";
    task.phasePercent = 0;
    task.detail = "";
    emit(taskProgress(task));
    const r2 = await extractArchiveTo(task.dest, outDir, task);
    task.extractedDir = outDir;
    if (!r2.ok) {
      return { ok: false, error: `解压失败（${r2.error ?? "?"}），请手动解压 ${task.dest}` };
    }
    // 解压完到"可用"之间还有写配置这一步。它通常只有几十毫秒，但**必须有出口** ——
    // 否则用户会看到 100% 之后界面又静止一拍，同样的疑虑会再来一次。
    task.phase = "config";
    task.phasePercent = 100;
    task.detail = "";
    emit(taskProgress(task));
    relocateToConfiguredPath(task);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[downloader] finishLlama", e);
    return { ok: false, error: `llama 安装失败：${msg}` };
  }
}

/** 下载单个归档（带镜像与断点续传；进度并入宿主 task），返回是否成功 */
async function downloadArchive(url: string, dest: string, task: Task, label = ""): Promise<boolean> {
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
      // ⚠️ 子归档必须**整体替换** received/total（A-1038）。旧实现沿用主包残留的 received，
      // 于是这里的分母是别的文件的字节数 → 百分比一开始就 100% 或来回跳；
      // 触发条件又写成 `received % (CHUNK*16) === 0`（恰好 1MB 整数倍），实际几乎**永不命中**
      // —— 等于第二条下载完全没有进度。改成与主下载一样的"时间窗压频"。
      const lenHeader = Number(resp.headers.get("content-length") ?? 0);
      task.phase = "download";
      task.phasePercent = 0;
      task.detail = label;
      task.received = start;
      task.total = lenHeader > 0 ? start + lenHeader : 0;
      emit(taskProgress(task));
      const ws = createWriteStream(dest, { flags: start > 0 ? "a" : "w" });
      let lastEmit = Date.now();
      if (resp.body) {
        for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
          ws.write(chunk);
          task.received += chunk.byteLength;
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            emit(taskProgress(task));
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

/**
 * 启动/刷新时收尾：downloads/ 下已完成的文件自动归位到配置路径。
 *
 * A-1038 起为 async（内部解压走 async 的 `extractArchiveTo`）。调用方是"启动收尾"这种
 * 不关心结果的位置，`void` 掉即可 —— 但**必须显式写 `void`**，否则 Promise 拒绝会成为
 * unhandledRejection（本项目有全局兜底日志，但仍属噪声）。
 */
export async function tryRelocateDownloads(): Promise<void> {
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
          // A-1038：Windows 的 .zip 走内置解压（不再 spawnSync tar）。这条是"启动/刷新时收尾"
          // 路径 —— 与 finishLlama 是**同一件事的两个入口**，此前只有后者被修过，
          // 前者在打包环境里同样会 `spawn tar ENOENT`（A-1034 的老病）。现在两条都收敛到
          // extractArchiveTo，行为一致、都不依赖外部命令（.tar.gz 除外，Node 解不了 tar 容器）。
          const r = await extractArchiveTo(archive, outDir, null);
          if (!r.ok) {
            console.warn(`[downloader] llama 归档解压失败: ${r.error ?? "?"}`);
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
    return { target, state: "idle", percent: 0, receivedMB: 0, totalMB: 0, path: "", phase: "download", detail: "" };
  }
  return taskProgress(task);
}