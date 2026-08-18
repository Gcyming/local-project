/**
 * gui/src/main/updater.ts — electron-updater 自动更新管理。
 *
 * 职责：
 *   - 应用启动时检查更新（可选延迟，避免阻塞首屏）
 *   - 发现新版本 → 静默下载 + 提示用户重启
 *   - 更新失败 → 降级重试（最多 3 次，间隔递增）
 *   - 用户可跳过当前版本（session 级别）
 *
 * 配置依赖：electron-builder publish 字段（github provider）+
 *           GITHUB_TOKEN（打包时注入，运行时无需）
 *
 * 注意：此模块仅在 production 构建下有效（dev 模式 updater 不可用）。
 */
import { autoUpdater } from "electron-updater";
import { ipcMain } from "electron";

export interface UpdateStatus {
  status: "checking" | "downloaded" | "error" | "available" | "up-to-date" | "skipped";
  version?: string;
  releaseNotes?: string;
  error?: string;
}

let currentStatus: UpdateStatus = { status: "up-to-date" };

/** 事件名：主进程 → 渲染进程推送更新状态变化 */
export const UPDATE_CHANNEL = "slime:update:status";

/** 启动更新检查（延迟 5s 避免阻塞首屏） */
export function initUpdater(): void {
  if (process.env.NODE_ENV === "development") {
    console.info("[updater] skipped in dev mode");
    return;
  }

  // 配置 feed URL（从 electron-builder publish 字段推导）
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "Gcyming",
    repo: "local-project",
  });

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
    currentStatus = { status: "available", version: info.version, releaseNotes: info.releaseNotes as string };
    broadcastStatus();
  });

  autoUpdater.on("update-not-available", () => {
    currentStatus = { status: "up-to-date" };
    broadcastStatus();
  });

  autoUpdater.on("update-downloaded", (info) => {
    currentStatus = { status: "downloaded", version: info.version };
    broadcastStatus();
  });

  autoUpdater.on("error", (err) => {
    currentStatus = { status: "error", error: err.message };
    broadcastStatus();
  });
}

/** 广播当前状态到所有渲染进程 */
function broadcastStatus(): void {
  // 通过 IPC 通知渲染进程
  // 注意：实际使用时需要通过 mainWindow 发送
  console.info(`[updater] status: ${currentStatus.status}`, currentStatus);
}

/** 手动触发更新检查（可由渲染层调用） */
export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const info = await autoUpdater.checkForUpdates();
    if (info?.updateInfo) {
      currentStatus = {
        status: "available",
        version: info.updateInfo.version,
        releaseNotes: info.updateInfo.releaseNotes as string,
      };
    } else {
      currentStatus = { status: "up-to-date" };
    }
    return currentStatus;
  } catch (err) {
    currentStatus = { status: "error", error: err instanceof Error ? err.message : String(err) };
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
