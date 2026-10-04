








import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { extractZipTo } from "../../../core-ts/src/zip.js";
import { extractPercent, extractDetail } from "../shared/downloadPhase.js";
import type { AdbDownloadProgressInfo } from "../shared/ipc.js";
import { app } from "electron";
import { request as httpsRequest } from "node:https";
import { type IncomingMessage } from "node:http";


export type AdbSource = "path" | "common" | "bundled" | "missing";


export interface AdbDetect {
  ok: boolean;
  path?: string;
  version?: string;
  source?: AdbSource;
  error?: string;
}


export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
}


export interface AdbCmdResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}


export interface AdbScreencapResult {
  ok: boolean;
  pngBase64?: string;
  error?: string;
}


export type AdbDownloadProgress = AdbDownloadProgressInfo;


const PLATFORM_TOOLS_URL: Record<string, string> = {
  win32: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
  darwin: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  linux: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
};


const TIMEOUT_NORMAL = 30_000;

const TIMEOUT_LONG = 120_000;

export class AdbService {
  
  private cachedPath: string | null = null;

  
  private builtinDir(): string {
    try {
      return join(app.getPath("userData"), "adb");
    } catch {
      
      return join(homedir(), ".slime-adb");
    }
  }

  
  private candidatePaths(): string[] {
    const isWin = process.platform === "win32";
    const exeName = isWin ? "adb.exe" : "adb";
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "";

    const candidates: string[] = [];
    
    candidates.push(exeName);
    
    if (isWin) {
      candidates.push(join(localAppData, "Android", "Sdk", "platform-tools", "adb.exe"));
      if (androidHome) candidates.push(join(androidHome, "platform-tools", "adb.exe"));
    } else {
      candidates.push(join(homedir(), "Android", "Sdk", "platform-tools", "adb"));
      candidates.push("/opt/android-sdk/platform-tools/adb");
      candidates.push("/usr/lib/android-sdk/platform-tools/adb");
      if (androidHome) candidates.push(join(androidHome, "platform-tools", "adb"));
    }
    
    candidates.push(join(this.builtinDir(), "platform-tools", exeName));
    return candidates;
  }

  
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

  











  private async extractZip(zipPath: string, destDir: string, onProgress?: (p: AdbDownloadProgress) => void): Promise<{ ok: boolean; error?: string }> {
    try {
      const buf = await readFile(zipPath);
      let lastEmit = 0;
      const r = await extractZipTo(buf, destDir, {
        onProgress: (p) => {
          const now = Date.now();
          const isLast = p.current === "";
          if (!isLast && now - lastEmit < 150) { return; }
          lastEmit = now;
          onProgress?.({
            state: "extracting",
            percent: extractPercent(p),
            receivedMB: 0,
            totalMB: 0,
            detail: extractDetail(p),
          });
        },
      });
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
      onProgress?.({ state: "extracting", percent: 0, receivedMB: dl.receivedMB, totalMB: dl.totalMB, detail: "" });
      const ex = await this.extractZip(zipPath, destDir, onProgress);
      if (!ex.ok) {
        return { ok: false, error: ex.error ?? "解压失败", progress: { state: "error", percent: 0, receivedMB: 0, totalMB: 0, error: ex.error } };
      }
      
      await rm(zipPath, { force: true });
      
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

  
  private run(args: string[], opts: { timeout?: number; encoding?: BufferEncoding | null; maxBuffer?: number } = {}): Promise<AdbCmdResult & { buffer?: Buffer }> {
    return new Promise((resolveResult) => {
      void (async () => {
        const adbPath = await this.resolvePath();
        if (!adbPath) {
          resolveResult({ ok: false, error: "adb 未就绪，请先下载 platform-tools" });
          return;
        }
        const encoding = opts.encoding === null ? null : (opts.encoding ?? "utf8");
        
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

  
  async connect(host: string): Promise<AdbCmdResult> {
    const h = (host ?? "").trim();
    if (!h) { return { ok: false, error: "连接地址为空" }; }
    return this.run(["connect", h]);
  }

  
  async disconnect(host: string): Promise<AdbCmdResult> {
    const h = (host ?? "").trim();
    if (!h) { return { ok: false, error: "断开地址为空" }; }
    return this.run(["disconnect", h]);
  }

  
  async shell(serial: string, cmd: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const c = (cmd ?? "").trim();
    if (!c) { return { ok: false, error: "shell 命令为空" }; }
    const args = s ? ["-s", s, "shell", c] : ["shell", c];
    return this.run(args, { timeout: TIMEOUT_NORMAL });
  }

  





  async uiDump(serial: string): Promise<{ ok: boolean; xml?: string; error?: string }> {
    const s = (serial ?? "").trim();
    const remote = "/sdcard/slime_ui_dump.xml";
    const withS = (rest: string[]): string[] => (s ? ["-s", s, ...rest] : rest);
    
    const dumped = await this.run(withS(["shell", `uiautomator dump ${remote}`]), { timeout: TIMEOUT_NORMAL });
    const read = await this.run(withS(["shell", `cat ${remote}`]), { timeout: TIMEOUT_NORMAL });
    const xml1 = read.stdout ?? "";
    if (xml1.includes("<hierarchy")) { return { ok: true, xml: xml1 }; }
    
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

  
  async install(serial: string, apkPath: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const p = (apkPath ?? "").trim();
    if (!p) { return { ok: false, error: "APK 路径为空" }; }
    const args = s ? ["-s", s, "install", "-r", p] : ["install", "-r", p];
    return this.run(args, { timeout: TIMEOUT_LONG });
  }

  
  async uninstall(serial: string, pkg: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const p = (pkg ?? "").trim();
    if (!p) { return { ok: false, error: "包名为空" }; }
    const args = s ? ["-s", s, "uninstall", p] : ["uninstall", p];
    return this.run(args, { timeout: TIMEOUT_LONG });
  }

  
  async screencap(serial: string): Promise<AdbScreencapResult> {
    const s = (serial ?? "").trim();
    const args = s ? ["-s", s, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"];
    const r = await this.run(args, { timeout: TIMEOUT_LONG, encoding: null, maxBuffer: 64 * 1024 * 1024 });
    if (!r.ok) { return { ok: false, error: r.error }; }
    if (!r.buffer || r.buffer.length === 0) { return { ok: false, error: "截图为空" }; }
    return { ok: true, pngBase64: r.buffer.toString("base64") };
  }

  
  async pull(serial: string, remote: string, local: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const r = (remote ?? "").trim();
    const l = (local ?? "").trim();
    if (!r || !l) { return { ok: false, error: "远程/本地路径为空" }; }
    const args = s ? ["-s", s, "pull", r, l] : ["pull", r, l];
    return this.run(args, { timeout: TIMEOUT_LONG, maxBuffer: 64 * 1024 * 1024 });
  }

  
  async push(serial: string, local: string, remote: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const l = (local ?? "").trim();
    const r = (remote ?? "").trim();
    if (!l || !r) { return { ok: false, error: "本地/远程路径为空" }; }
    const args = s ? ["-s", s, "push", l, r] : ["push", l, r];
    return this.run(args, { timeout: TIMEOUT_LONG, maxBuffer: 64 * 1024 * 1024 });
  }

  
  async reboot(serial: string, mode?: string): Promise<AdbCmdResult> {
    const s = (serial ?? "").trim();
    const m = (mode ?? "").trim();
    const base = s ? ["-s", s, "reboot"] : ["reboot"];
    const args = m ? [...base, m] : base;
    return this.run(args, { timeout: TIMEOUT_NORMAL });
  }

  
  async startServer(): Promise<{ ok: boolean; version?: string; stdout?: string; stderr?: string; error?: string }> {
    const res = await this.run(["start-server"], { timeout: TIMEOUT_NORMAL });
    const v = await this.run(["version"], { timeout: TIMEOUT_NORMAL });
    const version = v.stdout?.split("\n")[0]?.trim();
    return { ok: res.ok, version, stdout: res.stdout, stderr: res.stderr, error: res.error };
  }

  
  async killServer(): Promise<AdbCmdResult> {
    return this.run(["kill-server"], { timeout: TIMEOUT_NORMAL });
  }
}


export const adbService = new AdbService();
