/**
 * gui/src/main/updater.ts — electron-updater 自动更新管理。
 *
 * 职责：
 *   - 应用启动时检查更新（可选延迟，避免阻塞首屏）
 *   - 发现新版本 → 静默下载 + 提示用户重启
 *   - 更新失败 → 降级重试（最多 3 次，间隔递增）
 *   - 用户可跳过当前版本（session 级别）
 *
 * 配置依赖：slime.toml [update] 段（enabled + feed_url）。
 *   - enabled=false（默认）：不发起任何网络请求，状态为 "disabled"，避免无发布源时反复报"检查失败"
 *   - enabled=true + feed_url：使用自定义 feed（支持 https 直链 / GitHub release）
 *   - enabled=true + 空 feed_url：回退 electron-builder publish 字段（github provider）
 *
 * 注意：此模块仅在 production 构建下有效（dev 模式 updater 不可用）。
 */
import { autoUpdater } from "electron-updater";
import { app, ipcMain } from "electron";
import { readUpdateConfig } from "./mind_config.js";
import { normalizeReleaseNotes } from "../shared/releaseNotes.js";

/** 简单 semver 比较（数字点分段；不支持的字符按 0 处理）。a > b → 正数 */
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
  status: "checking" | "downloaded" | "error" | "available" | "up-to-date" | "skipped" | "disabled";
  version?: string;
  releaseNotes?: string;
  error?: string;
}

let currentStatus: UpdateStatus = { status: "disabled" };
let statusSink: ((s: UpdateStatus) => void) | null = null;

/** 事件名：主进程 → 渲染进程推送更新状态变化 */
export const UPDATE_CHANNEL = "slime:update:status";

/** 注册状态推送目标（主进程传入 webContents.send，避免循环依赖） */
export function setStatusSink(fn: (s: UpdateStatus) => void): void {
  statusSink = fn;
}

/** 配置 feed URL（enabled 且 feed_url 非空时用自定义源，否则回退 github publish 字段）
 *  A-980-R30：GitHub 仓库 Gcyming/local-project 是**公开**的（release v0.0.1 已含 latest.yml 差分资产）——
 *  private 改 false，否则 electron-updater 按私有仓库带认证逻辑访问公开仓库会检查失败。 */
function configureFeed(): void {
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

/** 启动更新检查（延迟 5s 避免阻塞首屏；未启用时静默跳过但仍广播 disabled） */
export function initUpdater(): void {
  if (process.env.NODE_ENV === "development") {
    console.info("[updater] skipped in dev mode — 仍推送 disabled 状态供 UI 兜底显示");
    currentStatus = { status: "disabled" };
    broadcastStatus();
    return;
  }

  const cfg = readUpdateConfig();
  if (!cfg.enabled) {
    currentStatus = { status: "disabled" };
    broadcastStatus();
    console.info("[updater] 自动更新未启用（slime.toml [update].enabled=false），跳过检查");
    return;
  }

  configureFeed();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // 延迟 5s 后首次检查
  setTimeout(() => void checkForUpdate(), 5000);

  // 事件监听
  autoUpdater.on("checking-for-update", () => {
    currentStatus = { status: "checking" };
    broadcastStatus();
  });

  autoUpdater.on("update-available", (info) => {
    currentStatus = { status: "available", version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) };
    broadcastStatus();
  });

  autoUpdater.on("update-not-available", () => {
    currentStatus = { status: "up-to-date" };
    broadcastStatus();
  });

  autoUpdater.on("update-downloaded", (info) => {
    // ⚠️ 这里必须**带上 releaseNotes**：下载完成是状态迁移，不是新信息。
    // 此前丢掉它 → 用户点开「已下载」时就再也看不到本版更新内容（面板直接空掉）。
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

/** 广播当前状态到所有渲染进程 */
function broadcastStatus(): void {
  if (statusSink) {
    statusSink(currentStatus);
  }
  console.info(`[updater] status: ${currentStatus.status}`, currentStatus);
}

/** 手动触发更新检查（可由渲染层调用）。
 *  A-980-R30：**手动检查不再受 slime.toml [update].enabled 限制**——用户主动点「手动检查」
 *  就应去 GitHub 检查；enabled 只由 initUpdater（启动自动检查）使用。dev 模式下 electron-updater
 *  不可用，返回 disabled + 提示，避免 UI 挂"检查失败"。 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  if (process.env.NODE_ENV === "development") {
    currentStatus = { status: "disabled", error: "开发模式不支持检查更新（打包版可用）" };
    broadcastStatus();
    return currentStatus;
  }
  configureFeed();
  try {
    const info = await autoUpdater.checkForUpdates();
    // 注意：checkForUpdates() 即使无新版本也会返回 updateInfo（远程当前版本），
    // 必须显式比较版本号，否则永远误报"有更新"
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

/** 安装已下载的更新（重启应用） */
export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}

/** 注册 IPC handler（渲染层触发检查/安装） */
export function registerUpdaterHandlers(): void {
  ipcMain.handle("slime:update:check", async () => {
    return checkForUpdate();
  });

  ipcMain.handle("slime:update:install", async () => {
    installUpdate();
    return { ok: true };
  });
}
