




















import { autoUpdater } from "electron-updater";
import { app, ipcMain } from "electron";
import { readUpdateConfig } from "./mind_config.js";
import { decideUpdatePolicy, describeUpdatePolicy } from "../../../core-ts/src/services/updatePolicy.js";
import { normalizeReleaseNotes } from "../shared/releaseNotes.js";


function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n.replace(/\D+/g, ""), 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n.replace(/\D+/g, ""), 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface UpdateStatus {
  status: "checking" | "downloading" | "downloaded" | "error" | "available" | "up-to-date" | "skipped" | "disabled";
  version?: string;
  releaseNotes?: string;
  error?: string;
  
  percent?: number;
  
  transferred?: number;
  total?: number;
  
  bytesPerSecond?: number;
}

let currentStatus: UpdateStatus = { status: "disabled" };
let statusSink: ((s: UpdateStatus) => void) | null = null;


export const UPDATE_CHANNEL = "slime:update:status";


export function setStatusSink(fn: (s: UpdateStatus) => void): void {
  statusSink = fn;
}




function configureFeed(): void {
  
  disableAutoDownload();
  const cfg = readUpdateConfig();
  if (cfg.feedUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: cfg.feedUrl });
  } else {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "Gcyming",
      repo: "local-project",
      private: false,
    });
  }
}

















function disableAutoDownload(): void {
  autoUpdater.autoDownload = false;
  
  autoUpdater.autoInstallOnAppQuit = false;
}


export function initUpdater(): void {
  
  
  disableAutoDownload();
  if (process.env.NODE_ENV === "development") {
    console.info("[updater] skipped in dev mode — 仍推送 disabled 状态供 UI 兜底显示");
    currentStatus = { status: "disabled" };
    broadcastStatus();
    return;
  }

  const cfg = readUpdateConfig();
  
  
  
  const policy = decideUpdatePolicy({ autoCheck: cfg.autoCheck, enabled: cfg.enabled });
  console.info(`[updater] 启动时自动检查 = ${policy.autoCheck}（${policy.reason}）· ${describeUpdatePolicy(policy)}`);
  if (!policy.autoCheck) {
    currentStatus = { status: "disabled" };
    broadcastStatus();
    return;
  }

  configureFeed();

  
  setTimeout(() => void checkForUpdate(), 5000);

  
  autoUpdater.on("checking-for-update", () => {
    currentStatus = { status: "checking" };
    broadcastStatus();
  });

  autoUpdater.on("update-available", (info) => {
    currentStatus = { status: "available", version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) };
    broadcastStatus();
  });

  


  autoUpdater.on("download-progress", (p) => {
    currentStatus = {
      status: "downloading",
      version: currentStatus.version,
      releaseNotes: currentStatus.releaseNotes,
      percent: Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : undefined,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    };
    broadcastStatus();
  });

  autoUpdater.on("update-not-available", () => {
    currentStatus = { status: "up-to-date" };
    broadcastStatus();
  });

  autoUpdater.on("update-downloaded", (info) => {
    
    
    currentStatus = {
      status: "downloaded",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes) || currentStatus.releaseNotes,
    };
    broadcastStatus();
  });

  autoUpdater.on("error", (err) => {
    currentStatus = { status: "error", error: err.message };
    broadcastStatus();
  });
}


function broadcastStatus(): void {
  if (statusSink) {
    statusSink(currentStatus);
  }
  console.info(`[updater] status: ${currentStatus.status}`, currentStatus);
}





export async function checkForUpdate(): Promise<UpdateStatus> {
  if (process.env.NODE_ENV === "development") {
    currentStatus = { status: "disabled", error: "开发模式不支持检查更新（打包版可用）" };
    broadcastStatus();
    return currentStatus;
  }
  configureFeed();
  try {
    const info = await autoUpdater.checkForUpdates();
    
    
    const remote = info?.updateInfo?.version;
    const current = app.getVersion();
    if (remote && compareVersions(remote, current) > 0) {
      currentStatus = {
        status: "available",
        version: remote,
        releaseNotes: normalizeReleaseNotes(info.updateInfo.releaseNotes),
      };
    } else {
      currentStatus = { status: "up-to-date" };
    }
    broadcastStatus();
    return currentStatus;
  } catch (err) {
    currentStatus = { status: "error", error: err instanceof Error ? err.message : String(err) };
    broadcastStatus();
    return currentStatus;
  }
}


export async function downloadUpdate(): Promise<UpdateStatus> {
  if (process.env.NODE_ENV === "development") {
    currentStatus = { status: "disabled", error: "开发模式不支持下载更新（打包版可用）" };
    broadcastStatus();
    return currentStatus;
  }
  try {
    
    
    currentStatus = {
      status: "downloading",
      version: currentStatus.version,
      releaseNotes: currentStatus.releaseNotes,
      percent: 0,
    };
    broadcastStatus();
    await autoUpdater.downloadUpdate();
    
    return currentStatus;
  } catch (err) {
    currentStatus = { status: "error", error: err instanceof Error ? err.message : String(err) };
    broadcastStatus();
    return currentStatus;
  }
}


export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}


export function registerUpdaterHandlers(): void {
  ipcMain.handle("slime:update:check", async () => {
    return checkForUpdate();
  });

  ipcMain.handle("slime:update:download", async () => {
    return downloadUpdate();
  });

  ipcMain.handle("slime:update:install", async () => {
    installUpdate();
    return { ok: true };
  });
}
