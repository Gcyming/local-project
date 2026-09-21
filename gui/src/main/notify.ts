/**
 * gui/src/main/notify.ts — 系统通知 + 可定制提示音（设置 → 通用）。
 *
 * 目标（用户需求）：Agent 任务完成 / 需要用户做选择 / 出错 / 意外终止时弹**系统**通知，
 * 且提示音可由用户选择"系统默认"或**自己上传的音频**。
 *
 * 职责边界：
 * - 配置落盘：PROJECT_ROOT/config/notifications.json（与其它用户配置同源，打包后随 SLIME_ROOT 走）
 * - 自定义音频：拷贝到 PROJECT_ROOT/config/notification-sounds/（原始文件不动，避免用户删了源文件就哑）
 * - 通知本体：Electron Notification（主进程能力，渲染层拿不到）
 * - 提示音：**自定义音频由渲染层播放**（主进程没有音频播放能力）——
 *   主进程只负责把"该响了"的信号发给渲染层；系统默认音则由 Notification.silent=false 交给系统响。
 *
 * ⚠️ Windows 上通知要能正确归属到本应用：AUMID 必须与安装器快捷方式的 AUMID 一致
 *    （见 gui/electron-builder.json 的 appId = com.slime.gui），**且**要注册一个可显示的应用名
 *    （`HKCU\Software\Classes\AppUserModelId\<AUMID>` 的 DisplayName），否则 toast 头部会
 *    显示成 AUMID 原文（用户实测症状）。完整说明见 `notifyIdentity.ts`。
 */
import { app, Notification } from "electron";
import type { BrowserWindow } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
/*
 * A-1021：通知的**身份与文案**（AUMID / 头部显示名 / 载荷构造）已移到 `notifyIdentity.ts`
 * —— 那里不 import electron，所以能被 `tests/core-ts/a1021-guards.spec.ts` 直接导入断言
 * （本文件顶层 import electron，测试里导不进来）。
 * 本文件从此只当"Electron 适配层"：读配置、拷音频、注册身份、真的弹通知。
 */
import { buildNotificationPayload, applyWindowsNotificationIdentity, APP_AUMID } from "./notifyIdentity.js";
import { INSTALL_ROOT } from "./boot.js";

// re-export：公开面不变（`APP_AUMID` / `APP_DISPLAY_NAME` 的唯一出处仍在 notifyIdentity.ts）
export { APP_AUMID, APP_DISPLAY_NAME, buildNotificationPayload, type NotifyPayload } from "./notifyIdentity.js";

/** 通知类型：决定标题语气与（未来可能的）分组/免打扰策略 */
export type NotifyKind = "done" | "choice" | "error" | "aborted" | "test";

/** 允许的提示音扩展名（Chromium <audio> 在 Windows 上稳定支持的几种） */
const SOUND_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm", ".opus"];
/** 自定义音频体积上限：通知音不该是大文件，超了直接拒绝（也避免 dataUrl 把 IPC 撑爆） */
const SOUND_MAX_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".opus": "audio/ogg",
};

export interface NotifyConfig {
  /** 总开关：关闭后四类事件都不弹系统通知（也不响） */
  enabled: boolean;
  /** 提示音开关：仅在 enabled 时有效。关 → 静默通知（silent:true） */
  soundEnabled: boolean;
  /** 自定义音频文件名（存于 notification-sounds/）；null = 用系统默认提示音 */
  soundFile: string | null;
  /** 自定义音频的原始文件名，仅用于设置界面展示 */
  soundName: string | null;
}

const DEFAULT_CFG: NotifyConfig = { enabled: false, soundEnabled: true, soundFile: null, soundName: null };

function cfgPath(): string {
  return join(PROJECT_ROOT, "config", "notifications.json");
}

function soundsDir(): string {
  return join(PROJECT_ROOT, "config", "notification-sounds");
}

/** 读取配置（文件缺失/损坏一律回默认值，绝不抛） */
export function readNotifyConfig(): NotifyConfig {
  try {
    const raw = readFileSync(cfgPath(), "utf8");
    const p = JSON.parse(raw) as Partial<NotifyConfig>;
    return {
      enabled: p.enabled === true,
      soundEnabled: p.soundEnabled !== false,
      soundFile: typeof p.soundFile === "string" && p.soundFile ? p.soundFile : null,
      soundName: typeof p.soundName === "string" && p.soundName ? p.soundName : null,
    };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

/** 写入配置（局部合并语义：只覆盖传入字段） */
export function writeNotifyConfig(patch: Partial<NotifyConfig>): NotifyConfig {
  const next: NotifyConfig = { ...readNotifyConfig(), ...patch };
  // 音频被清空时，把展示名一起清掉，避免界面残留"xxx.mp3"却没有文件
  if (!next.soundFile) { next.soundName = null; }
  try {
    mkdirSync(join(PROJECT_ROOT, "config"), { recursive: true });
    writeFileSync(cfgPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.warn("[gui:notify] 写入通知配置失败:", e instanceof Error ? e.message : String(e));
  }
  return next;
}

/** 当前自定义音频的绝对路径（未配置或文件已丢失 → null） */
export function customSoundPath(): string | null {
  const cfg = readNotifyConfig();
  if (!cfg.soundFile) { return null; }
  const p = join(soundsDir(), basename(cfg.soundFile));
  return existsSync(p) ? p : null;
}

/* ────────────────────────── 通知本体 ────────────────────────── */

let getWindowRef: (() => BrowserWindow | null) | null = null;

/** 注入主窗口获取器（避免 notify.ts 反向依赖 index.ts 造成循环 import） */
export function initNotify(deps: { getWindow: () => BrowserWindow | null }): void {
  getWindowRef = deps.getWindow;
  ensureNotificationIdentity();
}

/**
 * 注册系统通知的**应用身份**（Windows）。
 *
 * 这一步决定 toast 头部那行显示什么（A-1021 的真实根因，详见 `notifyIdentity.ts`）：
 * 没有它，Windows 只能把 AUMID 原文 `com.slime.gui` 顶上去。
 *
 * 两个动作缺一不可：
 *  ① `app.setAppUserModelId(APP_AUMID)` —— 告诉 Windows 这条通知属于哪个身份
 *     （不设 → 通知归不到本应用，通知中心里可能根本找不到它）；
 *  ② 往 `HKCU\Software\Classes\AppUserModelId\<AUMID>` 写 `DisplayName` ——
 *     给这个身份一个**人能看懂的名字**（未打包应用的正规做法，无需管理员）。
 *
 * ⚠️ 在**创建主窗口之前**调用（本函数由 index.ts 在 `new BrowserWindow` 之前调）：
 *    身份越早确定，第一条通知就越不可能带着旧品牌信息出去。
 * ⚠️ 失败**不静默**：通知照常能弹，但头部会退回包名 —— 这正是用户截图里那个现象，
 *    所以必须留下一行可归因的 warn，而不是让下一个人再去猜。
 */
function ensureNotificationIdentity(): void {
  if (process.platform !== "win32") { return; }
  try {
    app.setAppUserModelId(APP_AUMID);
  } catch (e) {
    console.warn(`[notify] 设置 AppUserModelId 失败（通知可能无法归属到本应用）：${(e as Error)?.message ?? String(e)}`);
  }
  const r = applyWindowsNotificationIdentity(notificationIconPath());
  if (!r.ok) {
    console.warn(`[notify] 注册通知应用身份失败（toast 头部会显示成包名 ${APP_AUMID} / 无图标）：${r.detail}`);
  }
}

/** 通知图标文件（应用自身资源，见 boot.ts 的 INSTALL_ROOT 定义）。
 *
 * ⚠️ A-1055 修正：此前是 `join(PROJECT_ROOT, "build", "icon.png")` ——
 * `PROJECT_ROOT` 是**数据根**（打包版 = `userData/slime-data`），那里**没有** build/icon.png；
 * 于是 Electron 拿不到图标，弹出来的通知是 Electron 默认图标（用户实测"图标不是 slime 的"）。
 * 正确口径是**安装根**：`electron-builder.json` extraFiles 里 `build/icon.png` 落到安装根。
 * 文件不存在时返回 undefined —— 让 Electron 用应用图标兜底，而不是塞一个坏路径。 */
export function notificationIconPath(): string | undefined {
  const p = join(INSTALL_ROOT, "build", "icon.png");
  return existsSync(p) ? p : undefined;
}

/** 让渲染层播放自定义提示音（系统默认音由 Notification.silent=false 负责，不走这里） */
function askRendererToPlaySound(): void {
  const win = getWindowRef?.() ?? null;
  if (!win || win.isDestroyed()) { return; }
  try { win.webContents.send("slime:notify:playsound", {}); } catch { /* 渲染层不可达则静默 */ }
}

/**
 * 弹一条系统通知（并按配置决定提示音）。
 *
 * 提示音三种组合：
 * - soundEnabled=false → silent:true（完全静音）
 * - soundEnabled=true + 自定义音频 → silent:true + 让渲染层播自定义音频
 *   （必须 silent:true，否则系统默认音会和自定义音一起响）
 * - soundEnabled=true + 未配置音频 → silent:false，交给系统响默认提示音
 *
 * 点击通知 → 唤起主窗口（最小化到托盘的场景下点通知就能回到应用）。
 */
export function notifyUser(ev: { kind: NotifyKind; title: string; body: string }): void {
  const cfg = readNotifyConfig();
  // 测试通知无视总开关（用户点"发送测试"就是要立刻看到效果），但仍遵守提示音设置
  if (!cfg.enabled && ev.kind !== "test") { return; }
  /* A-1018：**只在 slime 不在前台时才弹系统通知**（用户原话："我像的应该是 slime 程序不在操作
     界面时才弹通知"）。
     为什么必须挡在这里：系统通知是给"用户在看别的窗口"准备的——用户就盯着 slime 时，
     通知既多余、又会盖住界面（Windows 通知在右下角浮出、还可能抢焦点）。
     `test` 仍然放行：那是用户在设置页主动点"发送测试"，不弹就等于功能坏了。
     判据用 **isFocused()**（当前是否前台活动窗口），而不是 isVisible()——窗口可见但在后台
     （被别的应用盖住）时，用户看不到界面，正是最需要通知的场景。 */
  if (ev.kind !== "test") {
    const w = getWindowRef?.() ?? null;
    try {
      if (w && !w.isDestroyed() && w.isFocused()) { return; }
    } catch { /* 拿不到焦点状态时按"不在前台"处理，宁可多弹一次也不静默吞掉 */ }
  }
  let supported = true;
  try { supported = Notification.isSupported(); } catch { supported = false; }
  if (!supported) {
    console.warn("[gui:notify] 当前系统不支持通知");
    return;
  }
  const custom = cfg.soundEnabled ? customSoundPath() : null;
  const payload = buildNotificationPayload(ev);
  try {
    const n = new Notification({
      // 标题 = **事件文案**（「xxx 已完成」/「… 出错」）；程序名不在这里，它是身份行的事
      // （由 ensureNotificationIdentity() 注册的 DisplayName 决定）。分工见 notifyIdentity.ts。
      title: payload.title,
      body: payload.body,
      silent: !cfg.soundEnabled || Boolean(custom),
      // A-1055：图标口径改为安装根（见 notificationIconPath 的说明）。
      // `icon` 为 undefined 时 Electron 回落到应用图标，不再塞一个不存在的路径。
      icon: notificationIconPath(),
    });
    n.on("click", () => {
      const win = getWindowRef?.() ?? null;
      if (!win || win.isDestroyed()) { return; }
      if (win.isMinimized()) { win.restore(); }
      win.show();
      win.focus();
    });
    n.show();
  } catch (e) {
    console.error("[gui:notify] 弹出通知失败:", e instanceof Error ? e.message : String(e));
    return;
  }
  if (custom) { askRendererToPlaySound(); }
}

/* ────────────────────────── 音频文件管理（设置界面用） ────────────────────────── */

export interface SoundInfoResult {
  ok: boolean;
  /** 自定义音频的展示名（原始文件名） */
  name: string | null;
  /** 实际落盘的文件名 */
  file: string | null;
  size: number;
  error?: string;
}

/** 把用户选中的音频拷进应用配置目录（覆盖旧的），并写进配置 */
export function importSound(srcPath: string): SoundInfoResult {
  try {
    if (!srcPath || !existsSync(srcPath)) {
      return { ok: false, name: null, file: null, size: 0, error: "文件不存在" };
    }
    const ext = extname(srcPath).toLowerCase();
    if (!SOUND_EXTS.includes(ext)) {
      return { ok: false, name: null, file: null, size: 0, error: `不支持的音频格式 ${ext}（支持 ${SOUND_EXTS.join(" / ")}）` };
    }
    const size = statSync(srcPath).size;
    if (size > SOUND_MAX_BYTES) {
      return { ok: false, name: null, file: null, size: 0, error: `音频过大（${(size / 1024 / 1024).toFixed(1)}MB，上限 ${SOUND_MAX_BYTES / 1024 / 1024}MB）` };
    }
    if (size === 0) { return { ok: false, name: null, file: null, size: 0, error: "音频文件为空" }; }
    mkdirSync(soundsDir(), { recursive: true });
    // 固定文件名（custom + 原扩展名）：换音频时自然覆盖，不留垃圾
    const target = join(soundsDir(), `custom${ext}`);
    // 换扩展名时把旧的删掉，否则目录里会攒下多个 custom.*，且旧文件仍被配置引用过
    const prev = readNotifyConfig().soundFile;
    if (prev && basename(prev) !== `custom${ext}`) {
      try { rmSync(join(soundsDir(), basename(prev)), { force: true }); } catch { /* 删不掉不影响新音频 */ }
    }
    copyFileSync(srcPath, target);
    const name = basename(srcPath);
    writeNotifyConfig({ soundFile: `custom${ext}`, soundName: name });
    return { ok: true, name, file: `custom${ext}`, size };
  } catch (e) {
    return { ok: false, name: null, file: null, size: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 移除自定义音频（保留配置里的 soundEnabled，回落到系统默认音） */
export function clearSound(): SoundInfoResult {
  try {
    const cfg = readNotifyConfig();
    if (cfg.soundFile) {
      try { rmSync(join(soundsDir(), basename(cfg.soundFile)), { force: true }); } catch { /* ignore */ }
    }
    writeNotifyConfig({ soundFile: null, soundName: null });
    return { ok: true, name: null, file: null, size: 0 };
  } catch (e) {
    return { ok: false, name: null, file: null, size: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 读出自定义音频内容（data URL）——渲染层用 `new Audio(dataUrl)` 播放。
 * 用 data URL 而非自定义协议：不必注册 protocol、不受 CSP/文件路径转义影响，且音频很小。
 */
export function readSoundData(): { ok: boolean; dataUrl?: string; name?: string; size?: number; error?: string } {
  const p = customSoundPath();
  if (!p) { return { ok: false, error: "未配置自定义提示音" }; }
  try {
    const size = statSync(p).size;
    if (size > SOUND_MAX_BYTES) { return { ok: false, error: "音频过大" }; }
    const mime = MIME_BY_EXT[extname(p).toLowerCase()] ?? "audio/mpeg";
    const b64 = readFileSync(p).toString("base64");
    return { ok: true, dataUrl: `data:${mime};base64,${b64}`, name: readNotifyConfig().soundName ?? basename(p), size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
