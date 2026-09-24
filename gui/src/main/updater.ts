/**
 * gui/src/main/updater.ts — electron-updater 自动更新管理。
 *
 * 职责：
 *   - 应用启动时**检查**更新（可延迟，避免阻塞首屏）—— 只读元数据，廉价
 *   - 发现新版本 → **由用户点「下载更新」**才开始下载（绝不自动下载）
 *   - 下载完成 → **由用户点「安装并重启」**才生效
 *   - 更新失败 → 如实上报错误原文（不吞）
 *
 * 配置依赖：slime.toml [update] 段（auto_check + enabled + feed_url）。
 *
 *   ⚠️ A-1059③：三件事**分开**，判据在纯模块 `core-ts/src/services/updatePolicy.ts`：
 *   - `auto_check`（新键，默认 **true**）：是否在启动时自动检查（只读，不下载）
 *   - `enabled`（旧键）：历史上混用；**我们自己的模板曾写死 false**，所以它给 false 时
 *     不当作"用户想关"（详见 updatePolicy.ts 的 reason 表）—— 这正是用户说的"你怎能直接关了"
 *   - `feed_url` 非空 → 自定义 generic 源；留空 → 回退 electron-builder 的 github provider
 *
 *   **下载与安装没有任何开关可以让它自动发生** —— 这是代码层不变量（见 disableAutoDownload）。
 *
 * 注意：此模块仅在 production 构建下有效（dev 模式 updater 不可用）。
 */
import { autoUpdater } from "electron-updater";
import { app, ipcMain } from "electron";
import { readUpdateConfig } from "./mind_config.js";
import { decideUpdatePolicy, describeUpdatePolicy } from "../../../core-ts/src/services/updatePolicy.js";
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
  status: "checking" | "downloading" | "downloaded" | "error" | "available" | "up-to-date" | "skipped" | "disabled";
  version?: string;
  releaseNotes?: string;
  error?: string;
  /** 下载进度百分比（0–100，仅 status === "downloading" 时有意义） */
  percent?: number;
  /** 已下载 / 总字节（用于「12.3MB / 499.8MB」这种可核对的展示） */
  transferred?: number;
  total?: number;
  /** 瞬时速率（字节/秒），由 electron-updater 提供 */
  bytesPerSecond?: number;
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
  // A-1055：**先**关掉自动下载再设源 —— 顺序重要，checkForUpdates() 一旦发出就来不及了
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

/**
 * 关闭「自动下载 / 退出时自动安装」。
 *
 * ⚠️ A-1055 **根因修复**（用户原话："怎么一有新版本，进入设置的状态菜单内，翻过去就直接显示
 * 后台更新了？你改一下，要用户主动选择啊"）：
 *
 * `electron-updater` 的 `autoDownload` **默认就是 true**。我们此前只在
 * `initUpdater()` 里（且仅在 `[update].enabled === true` 时）显式赋值 —— 于是发行版
 * 配置里的 `enabled = false` 反而成了最糟的组合：没有任何人把 autoDownload 设成 false，
 * 而 `checkForUpdate()`（**手动检查不受 enabled 限制**，A-980-R30）一被调用，
 * electron-updater 就自作主张在后台把 500MB 安装包拉下来了。
 * 用户只是在设置里翻到「状态」页 → 面板挂载即 check → 500MB 静默下载。
 *
 * 现在：**任何路径进入 updater 都先关掉自动下载**（本函数由 configureFeed 一并调用，
 * 覆盖 initUpdater 与 checkForUpdate 两条入口），下载必须由用户在界面上点「下载更新」触发。
 */
function disableAutoDownload(): void {
  autoUpdater.autoDownload = false;
  // 退出时自动安装同样属于"替用户做主"：更新必须在用户点「安装并重启」后才生效
  autoUpdater.autoInstallOnAppQuit = false;
}

/** 启动更新检查（延迟 5s 避免阻塞首屏；未启用时静默跳过但仍广播 disabled） */
export function initUpdater(): void {
  // A-1055：模块级默认值先立起来（此时还没配源）。见 disableAutoDownload 的说明 ——
  // 必须在任何 checkForUpdates 之前执行，否则 electron-updater 的默认 autoDownload=true 会接管。
  disableAutoDownload();
  if (process.env.NODE_ENV === "development") {
    console.info("[updater] skipped in dev mode — 仍推送 disabled 状态供 UI 兜底显示");
    currentStatus = { status: "disabled" };
    broadcastStatus();
    return;
  }

  const cfg = readUpdateConfig();
  // A-1059③：**"检查 / 下载 / 安装"三件事彻底分开**，判据在纯模块里（可单测、过变异）：
  //   · 检查（只读一次 release 元数据）→ 由 auto_check 决定，**默认开**（否则用户根本不知道有新版本）
  //   · 下载（几百 MB）→ 只有点「下载更新」；· 安装 → 只有点「安装并重启」（代码层不变量，无开关）
  const policy = decideUpdatePolicy({ autoCheck: cfg.autoCheck, enabled: cfg.enabled });
  console.info(`[updater] 启动时自动检查 = ${policy.autoCheck}（${policy.reason}）· ${describeUpdatePolicy(policy)}`);
  if (!policy.autoCheck) {
    currentStatus = { status: "disabled" };
    broadcastStatus();
    return;
  }

  configureFeed();

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

  /* A-1055：下载进度上报（此前**完全没有** download-progress 监听 —— 这就是用户
     "为什么更新、下载这些功能还是没有实时加载渲染的进度条"的直接原因：
     主进程根本没把进度发出来，界面无从渲染，只能显示一句静态的"正在后台下载…"）。 */
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

/** 下载并安装已发现的更新（**用户主动触发**；见 disableAutoDownload 的说明） */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (process.env.NODE_ENV === "development") {
    currentStatus = { status: "disabled", error: "开发模式不支持下载更新（打包版可用）" };
    broadcastStatus();
    return currentStatus;
  }
  try {
    // 先置 downloading（0%）—— 否则在首个 download-progress 事件到达前，界面会停在
    // "发现新版本"，用户以为点击没生效（进度条从 0% 起步比"什么都不动"诚实）
    currentStatus = {
      status: "downloading",
      version: currentStatus.version,
      releaseNotes: currentStatus.releaseNotes,
      percent: 0,
    };
    broadcastStatus();
    await autoUpdater.downloadUpdate();
    // 真正的终态由 update-downloaded / error 事件写入，这里返回当前快照即可
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

/** 注册 IPC handler（渲染层触发检查/下载/安装） */
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
