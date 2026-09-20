/**
 * gui/src/main/adb.ts — ADB 设备管理核心服务（A-918++）。
 * - 解析 adb 可执行文件路径：环境变量 PATH → 常见安装路径 → 内置下载目录（userData/adb/platform-tools）
 * - detect()：检测 adb 是否就绪（含版本、来源）
 * - downloadPlatformTools()：下载官方便携包（platform-tools）并解压到内置目录（缺失时引导）
 * - devices/connect/disconnect/shell/install/uninstall/screencap/pull/push/reboot：封装 adb 子命令
 * - 安全基线：所有 adb 调用走 child_process.execFile（无 shell 拼接，杜绝注入）；超时 30s（install/screencap 120s）
 * - 严禁引入新依赖，仅用 node 内置（child_process/fs/path/https）+ electron app
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { extractZipTo } from "../../../core-ts/src/zip.js";
import { app } from "electron";
import { request as httpsRequest } from "node:https";
import { type IncomingMessage } from "node:http";

/** adb 可执行文件检测来源 */
export type AdbSource = "path" | "common" | "bundled" | "missing";

/** detect 结果 */
export interface AdbDetect {
  ok: boolean;
  path?: string;
  version?: string;
  source?: AdbSource;
  error?: string;
}

/** 设备条目（解析 `adb devices -l`） */
export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
}

/** 通用命令结果（stdout/stderr/error 结构化返回） */
export interface AdbCmdResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/** 截图结果（PNG base64） */
export interface AdbScreencapResult {
  ok: boolean;
  pngBase64?: string;
  error?: string;
}

/** 下载进度（转发渲染层，驱动进度条） */
export interface AdbDownloadProgress {
  state: "downloading" | "extracting" | "done" | "error";
  percent: number;
  receivedMB: number;
  totalMB: number;
  error?: string;
}

/** 官方 platform-tools 便携包（按平台区分） */
const PLATFORM_TOOLS_URL: Record<string, string> = {
  win32: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
  darwin: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  linux: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
};

/** 命令默认超时（普通命令 30s） */
const TIMEOUT_NORMAL = 30_000;
/** 安装 / 截图耗时较长（120s） */
const TIMEOUT_LONG = 120_000;

export class AdbService {
  /** 检测后缓存的 adb 路径（避免每次命令重复探测） */
  private cachedPath: string | null = null;

  /** 内置下载目录（app 用户数据目录下 adb/） */
  private builtinDir(): string {
    try {
      return join(app.getPath("userData"), "adb");
    } catch {
      // 极早期（app 未就绪）→ 回退到用户主目录，保证 API 可用
      return join(homedir(), ".slime-adb");
    }
  }

  /** 收集候选 adb 路径（按优先级：PATH → 常见安装路径 → 内置目录） */
  private candidatePaths(): string[] {
    const isWin = process.platform === "win32";
    const exeName = isWin ? "adb.exe" : "adb";
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "";

    const candidates: string[] = [];
    // 1) PATH（直接以文件名交由 execFile 解析）
    candidates.push(exeName);
    // 2) 常见安装路径
    if (isWin) {
      candidates.push(join(localAppData, "Android", "Sdk", "platform-tools", "adb.exe"));
      if (androidHome) candidates.push(join(androidHome, "platform-tools", "adb.exe"));
    } else {
      candidates.push(join(homedir(), "Android", "Sdk", "platform-tools", "adb"));
      candidates.push("/opt/android-sdk/platform-tools/adb");
      candidates.push("/usr/lib/android-sdk/platform-tools/adb");
      if (androidHome) candidates.push(join(androidHome, "platform-tools", "adb"));
    }
    // 3) 内置下载目录
    candidates.push(join(this.builtinDir(), "platform-tools", exeName));
    return candidates;
  }

  /** 试探单个候选路径是否可执行并返回版本 */
  private tryVersion(candidate: string): Promise<{ path: string; version: string } | null> {
    return new Promise((resolveResult) => {
      execFile(candidate, ["version"], { timeout: 8_000, windowsHide: true }, (err, stdout) => {
        if (err) { resolveResult(null); return; }
        const out = (stdout ?? "").toString();
        const m = out.match(/(\d+\.\d+\.\d+)/);
        const version = m ? m[1] : (out.trim() || "unknown");
        resolveResult({ path: candidate, version });
      });
    });
  }

  /** 解析当前可用 adb 路径（含缓存）；返回 null 表示未就绪 */
  private async resolvePath(): Promise<string | null> {
    if (this.cachedPath && existsSync(this.cachedPath)) {
      return this.cachedPath;
    }
    const candidates = this.candidatePaths();
    for (let i = 0; i < candidates.length; i++) {
      const hit = await this.tryVersion(candidates[i]);
      if (hit) {
        this.cachedPath = hit.path;
        return hit.path;
      }
    }
    return null;
  }

  /** 检测 adb 是否就绪 */
  async detect(): Promise<AdbDetect> {
    const candidates = this.candidatePaths();
    for (let i = 0; i < candidates.length; i++) {
      const hit = await this.tryVersion(candidates[i]);
      if (hit) {
        const source: AdbSource = i === 0 ? "path" : i < candidates.length - 1 ? "common" : "bundled";
        this.cachedPath = hit.path;
        return { ok: true, path: hit.path, version: hit.version, source };
      }
    }
    return { ok: false, source: "missing", error: "未检测到 adb，请下载 Android platform-tools" };
  }

  /** https 下载（跟随重定向；onProgress 上报字节进度） */
  private downloadFile(url: string, dest: string, onProgress?: (p: AdbDownloadProgress) => void): Promise<AdbDownloadProgress> {
    return new Promise((resolveResult) => {
      const doRequest = (u: string, redirects: number): void => {
        if (redirects > 5) {
          const errMsg = "下载重定向次数过多";
          onProgress?.({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
          resolveResult({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
          return;
        }
        const req = httpsRequest(u, { headers: { "User-Agent": "slime-gui/adb" } }, (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if ((status === 301 || status === 302 || status === 303) && location) {
            res.resume();
            doRequest(location, redirects + 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            const errMsg = `下载失败（HTTP ${status}）`;
            onProgress?.({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
            resolveResult({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
            return;
          }
          const total = Number(res.headers["content-length"] ?? 0);
          let received = 0;
          mkdir(dirname(dest), { recursive: true }).then(() => {
            const file = createWriteStream(dest);
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              const receivedMB = Math.round((received / 1024 / 1024) * 10) / 10;
              const totalMB = Math.round((total / 1024 / 1024) * 10) / 10;
              const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
              onProgress?.({ state: "downloading", percent, receivedMB, totalMB });
            });
            res.pipe(file);
            file.on("finish", () => {
              file.close(() => {
                const receivedMB = Math.round((received / 1024 / 1024) * 10) / 10;
                const totalMB = Math.round((total / 1024 / 1024) * 10) / 10;
                const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 100;
                resolveResult({ state: "downloading", percent, receivedMB, totalMB });
              });
            });
            file.on("error", (e: Error) => {
              const errMsg = `写入文件失败：${e.message}`;
              onProgress?.({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
              resolveResult({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
            });
          }).catch((e: Error) => {
            const errMsg = `创建目录失败：${e.message}`;
            onProgress?.({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
            resolveResult({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
          });
        });
        req.on("error", (e: Error) => {
          const errMsg = `网络请求失败：${e.message}`;
          onProgress?.({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
          resolveResult({ state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: errMsg });
        });
        req.end();
      };
      doRequest(url, 0);
    });
  }

  /**
   * 解压 zip。
   *
   * A-1034：**不再 spawn 外部命令**。此前 Windows 用 `tar`、POSIX 用 `unzip`，
   * 而"Windows 10+ 内置 tar.exe" **不等于它在 PATH 里** —— 打包后进程 PATH 与开发机不同，
   * 用户实测报错就是 `spawn tar ENOENT`（红字「解压失败」）。
   * 现在走 core-ts 的零依赖 zip 模块（node:zlib），平台无关、无外部依赖。
   */
  private async extractZip(zipPath: string, destDir: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const buf = await readFile(zipPath);
      const r = extractZipTo(buf, destDir);
      if (r.files === 0) {
        return { ok: false, error: "解压失败：压缩包内没有可写出的文件（可能已损坏）" };
      }
      if (r.skipped.length > 0) {
        return { ok: false, error: `解压失败：${r.skipped.length} 个条目因路径不安全被拒绝（首个：${r.skipped[0]}）` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `解压失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 下载官方 platform-tools 便携包并解压到内置目录 */
  async downloadPlatformTools(onProgress?: (p: AdbDownloadProgress) => void): Promise<AdbCmdResult & { progress?: AdbDownloadProgress }> {
    const url = PLATFORM_TOOLS_URL[process.platform];
    if (!url) {
      return { ok: false, error: `不支持的平台：${process.platform}` };
    }
    const destDir = this.builtinDir();
    const zipPath = join(destDir, "platform-tools.zip");
    try {
      await rm(zipPath, { force: true });
      await mkdir(destDir, { recursive: true });
      const dl = await this.downloadFile(url, zipPath, onProgress);
      if (dl.state === "error") {
        return { ok: false, error: dl.error ?? "下载失败", progress: dl };
      }
      onProgress?.({ state: "extracting", percent: 100, receivedMB: dl.receivedMB, totalMB: dl.totalMB });
      const ex = await this.extractZip(zipPath, destDir);
      if (!ex.ok) {
        return { ok: false, error: ex.error ?? "解压失败", progress: { state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: ex.error } };
      }
      // 清理压缩包（解压产物保留）
      await rm(zipPath, { force: true });
      // 重新探测路径（内置目录现已就绪）
      this.cachedPath = null;
      const detected = await this.detect();
      onProgress?.({ state: "done", percent: 100, receivedMB: dl.receivedMB, totalMB: dl.totalMB });
      if (!detected.ok) {
        return { ok: false, error: "解压完成但未能检测到 adb，请检查内置目录", progress: { state: "done", percent: 100, receivedMB: dl.receivedMB, totalMB: dl.totalMB } };
      }
      return { ok: true, stdout: `platform-tools 已安装至 ${join(destDir, "platform-tools")}`, progress: { state: "done", percent: 100, receivedMB: dl.receivedMB, totalMB: dl.totalMB } };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `下载 platform-tools 失败：${err}` };
    }
  }

  /** 统一执行 adb 子命令（无 shell；serial 可选，为空则操作唯一/默认设备） */
  private run(args: string[], opts: { timeout?: number; encoding?: BufferEncoding | null; maxBuffer?: number } = {}): Promise<AdbCmdResult & { buffer?: Buffer }> {
    return new Promise((resolveResult) => {
      void (async () => {
        const adbPath = await this.resolvePath();
        if (!adbPath) {
          resolveResult({ ok: false, error: "adb 未就绪，请先下载 platform-tools" });
          return;
        }
        const encoding = opts.encoding === null ? null : (opts.encoding ?? "utf8");
        // 统一把 string | Buffer 输出转成字符串（Buffer 走 utf8）
        const toStr = (x: string | Buffer | undefined): string => (x == null ? "" : (typeof x === "string" ? x : x.toString("utf8")));
        execFile(adbPath, args, {
          timeout: opts.timeout ?? TIMEOUT_NORMAL,
          windowsHide: true,
          maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
          encoding,
        }, (err, stdout, stderr) => {
          if (err) {
            const code = typeof (err as { code?: number }).code === "number" ? (err as { code?: number }).code : 1;
            resolveResult({
              ok: false,
              stdout: toStr(stdout),
              stderr: toStr(stderr),
              error: (toStr(stderr) || toStr(stdout) || `adb 命令失败（${code}）`).slice(0, 600),
            });
            return;
          }
          resolveResult({
            ok: true,
            stdout: toStr(stdout),
            stderr: toStr(stderr),
            buffer: Buffer.isBuffer(stdout) ? stdout : undefined,
          });
        });
      })();
    });
  }

  /** 列出已连接设备（解析 `adb devices -l`） */
  async devices(): Promise<{ ok: boolean; devices?: AdbDevice[]; error?: string }> {
    const r = await this.run(["devices", "-l"], { timeout: TIMEOUT_NORMAL });
    if (!r.ok) { return { ok: false, error: r.error }; }
    const lines = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const devices: AdbDevice[] = [];
    for (const line of lines) {
      if (/^list of devices attached$/i.test(line)) { continue; }
      const parts = line.split(/\s+/);
      const serial = parts[0];
      const state = parts[1] ?? "unknown";
      const dev: AdbDevice = { serial, state };
      for (let i = 2; i < parts.length; i++) {
        const kv = parts[i].split(":");
        if (kv.length === 2) {
          if (kv[0] === "model") { dev.model = kv[1]; }
          else if (kv[0] === "product") { dev.product = kv[1]; }
        }
      }
      devices.push(dev);
    }
    return { ok: true, devices };
  }

  /** 无线连接设备（host 形如 192.168.1.10:5555） */
  async connect(host: string): Promise<AdbCmdResult> {
    const h = (host ?? "").trim();
    if (!h) { return { ok: false, error: "连接地址为空" }; }
    return this.run(["connect", h]);
  }

  /** 断开无线连接 */
  async disconnect(host: string): Promise<AdbCmdResult> {
    const h = (host ?? "").trim();
    if (!h) { return { ok: false, error: "断开地址为空" }; }
    return this.run(["disconnect", h]);
  }

  /** 在指定设备执行 shell 命令（cmd 整体作为单参数转发，避免拼接注入） */
  async shell(serial: string, cmd: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const c = (cmd ?? "").trim();
    if (!c) { return { ok: false, error: "shell 命令为空" }; }
    const args = s ? ["-s", s, "shell", c] : ["shell", c];
    return this.run(args, { timeout: TIMEOUT_NORMAL });
  }

  /**
   * A-975：导出当前 UI 层级（uiautomator dump）——元素级定位的数据源。
   * 兼容策略（覆盖 MIUI/部分机型 dump 往 stderr 打警告、但文件仍生成；以及 exec-out 直出两条路）：
   *   ① dump 到 /sdcard → cat 读回（最稳，不受 tty 混输出影响）；
   *   ② 回退 exec-out uiautomator dump /dev/tty，从输出里截取 <hierarchy> 段。
   */
  async uiDump(serial: string): Promise<{ ok: boolean; xml?: string; error?: string }> {
    const s = (serial ?? "").trim();
    const remote = "/sdcard/slime_ui_dump.xml";
    const withS = (rest: string[]): string[] => (s ? ["-s", s, ...rest] : rest);
    // ① dump + cat
    const dumped = await this.run(withS(["shell", `uiautomator dump ${remote}`]), { timeout: TIMEOUT_NORMAL });
    const read = await this.run(withS(["shell", `cat ${remote}`]), { timeout: TIMEOUT_NORMAL });
    const xml1 = read.stdout ?? "";
    if (xml1.includes("<hierarchy")) { return { ok: true, xml: xml1 }; }
    // ② exec-out 回退
    const tty = await this.run(withS(["exec-out", "uiautomator dump /dev/tty"]), { timeout: TIMEOUT_NORMAL });
    const out2 = tty.stdout ?? "";
    const hIdx = out2.indexOf("<hierarchy");
    if (hIdx >= 0) {
      const xmlIdx = out2.lastIndexOf("<?xml", hIdx);
      return { ok: true, xml: out2.slice(xmlIdx >= 0 ? xmlIdx : hIdx) };
    }
    return {
      ok: false,
      error: (dumped.error ?? read.error ?? tty.error ?? "uiautomator dump 失败（界面可能为全屏画布/仍在加载）").slice(0, 200),
    };
  }

  /** 安装 APK（serial + 本地 apk 路径） */
  async install(serial: string, apkPath: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const p = (apkPath ?? "").trim();
    if (!p) { return { ok: false, error: "APK 路径为空" }; }
    const args = s ? ["-s", s, "install", "-r", p] : ["install", "-r", p];
    return this.run(args, { timeout: TIMEOUT_LONG });
  }

  /** 卸载应用（serial + 包名） */
  async uninstall(serial: string, pkg: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const p = (pkg ?? "").trim();
    if (!p) { return { ok: false, error: "包名为空" }; }
    const args = s ? ["-s", s, "uninstall", p] : ["uninstall", p];
    return this.run(args, { timeout: TIMEOUT_LONG });
  }

  /** 截图（返回 PNG base64；exec-out 二进制直出，无临时文件） */
  async screencap(serial: string): Promise<AdbScreencapResult> {
    const s = (serial ?? "").trim();
    const args = s ? ["-s", s, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"];
    const r = await this.run(args, { timeout: TIMEOUT_LONG, encoding: null, maxBuffer: 64 * 1024 * 1024 });
    if (!r.ok) { return { ok: false, error: r.error }; }
    if (!r.buffer || r.buffer.length === 0) { return { ok: false, error: "截图为空" }; }
    return { ok: true, pngBase64: r.buffer.toString("base64") };
  }

  /** 从设备拉取文件到本地 */
  async pull(serial: string, remote: string, local: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const r = (remote ?? "").trim();
    const l = (local ?? "").trim();
    if (!r || !l) { return { ok: false, error: "远程/本地路径为空" }; }
    const args = s ? ["-s", s, "pull", r, l] : ["pull", r, l];
    return this.run(args, { timeout: TIMEOUT_LONG, maxBuffer: 64 * 1024 * 1024 });
  }

  /** 推送本地文件到设备 */
  async push(serial: string, local: string, remote: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const l = (local ?? "").trim();
    const r = (remote ?? "").trim();
    if (!l || !r) { return { ok: false, error: "本地/远程路径为空" }; }
    const args = s ? ["-s", s, "push", l, r] : ["push", l, r];
    return this.run(args, { timeout: TIMEOUT_LONG, maxBuffer: 64 * 1024 * 1024 });
  }

  /** 重启设备（A-978：支持可选 mode，如 recovery / bootloader / sideload / fastboot） */
  async reboot(serial: string, mode?: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const m = (mode ?? "").trim();
    const base = s ? ["-s", s, "reboot"] : ["reboot"];
    const args = m ? [...base, m] : base;
    return this.run(args, { timeout: TIMEOUT_NORMAL });
  }

  /** A-918++：启动 ADB 服务（adb start-server）——连模拟器前需服务在跑；返回版本与状态 */
  async startServer(): Promise<{ ok: boolean; version?: string; stdout?: string; stderr?: string; error?: string }> {
    const res = await this.run(["start-server"], { timeout: TIMEOUT_NORMAL });
    const v = await this.run(["version"], { timeout: TIMEOUT_NORMAL });
    const version = v.stdout?.split("\n")[0]?.trim();
    return { ok: res.ok, version, stdout: res.stdout, stderr: res.stderr, error: res.error };
  }

  /** A-918++：停止 ADB 服务（adb kill-server） */
  async killServer(): Promise<AdbCmdResult> {
    return this.run(["kill-server"], { timeout: TIMEOUT_NORMAL });
  }
}

/** 模块级单例（main 启动时实例化并注入工具层） */
export const adbService = new AdbService();
