

















import { app, Notification } from "electron";
import type { BrowserWindow } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";






import { buildNotificationPayload, applyWindowsNotificationIdentity, APP_AUMID, notifyIconFileName, checkNotifyImage } from "./notifyIdentity.js";
import { INSTALL_ROOT } from "./boot.js";


export { APP_AUMID, APP_DISPLAY_NAME, buildNotificationPayload, type NotifyPayload } from "./notifyIdentity.js";


export type NotifyKind = "done" | "choice" | "error" | "aborted" | "test";


const SOUND_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm", ".opus"];

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
  
  enabled: boolean;
  
  soundEnabled: boolean;
  
  soundFile: string | null;
  
  soundName: string | null;
}

const DEFAULT_CFG: NotifyConfig = { enabled: false, soundEnabled: true, soundFile: null, soundName: null };

function cfgPath(): string {
  return join(PROJECT_ROOT, "config", "notifications.json");
}

function soundsDir(): string {
  return join(PROJECT_ROOT, "config", "notification-sounds");
}


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


export function writeNotifyConfig(patch: Partial<NotifyConfig>): NotifyConfig {
  const next: NotifyConfig = { ...readNotifyConfig(), ...patch };
  
  if (!next.soundFile) { next.soundName = null; }
  try {
    mkdirSync(join(PROJECT_ROOT, "config"), { recursive: true });
    writeFileSync(cfgPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.warn("[gui:notify] 写入通知配置失败:", e instanceof Error ? e.message : String(e));
  }
  return next;
}


export function customSoundPath(): string | null {
  const cfg = readNotifyConfig();
  if (!cfg.soundFile) { return null; }
  const p = join(soundsDir(), basename(cfg.soundFile));
  return existsSync(p) ? p : null;
}



let getWindowRef: (() => BrowserWindow | null) | null = null;


export function initNotify(deps: { getWindow: () => BrowserWindow | null }): void {
  getWindowRef = deps.getWindow;
  ensureNotificationIdentity();
}


















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

















export function notificationIconPath(): string | undefined {
  const p = join(INSTALL_ROOT, "build", notifyIconFileName());
  if (!existsSync(p)) {
    
    console.warn(`[notify] 通知图标缺失：${p}（打包版请核对 electron-builder.json 的 extraFiles）`);
    return undefined;
  }
  const v = checkNotifyImage({ bytes: statSync(p).size });
  if (!v.ok) {
    console.warn(`[notify] 通知图标不合规（${v.reason}）→ 不传给系统（否则图标不显示/整条通知被丢弃）：${p}`);
    return undefined;
  }
  return p;
}


function askRendererToPlaySound(): void {
  const win = getWindowRef?.() ?? null;
  if (!win || win.isDestroyed()) { return; }
  try { win.webContents.send("slime:notify:playsound", {}); } catch {  }
}












export function notifyUser(ev: { kind: NotifyKind; title: string; body: string }): void {
  const cfg = readNotifyConfig();
  
  if (!cfg.enabled && ev.kind !== "test") { return; }
  






  if (ev.kind !== "test") {
    const w = getWindowRef?.() ?? null;
    try {
      if (w && !w.isDestroyed() && w.isFocused()) { return; }
    } catch {  }
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
      
      
      title: payload.title,
      body: payload.body,
      silent: !cfg.soundEnabled || Boolean(custom),
      
      
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



export interface SoundInfoResult {
  ok: boolean;
  
  name: string | null;
  
  file: string | null;
  size: number;
  error?: string;
}


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
    
    const target = join(soundsDir(), `custom${ext}`);
    
    const prev = readNotifyConfig().soundFile;
    if (prev && basename(prev) !== `custom${ext}`) {
      try { rmSync(join(soundsDir(), basename(prev)), { force: true }); } catch {  }
    }
    copyFileSync(srcPath, target);
    const name = basename(srcPath);
    writeNotifyConfig({ soundFile: `custom${ext}`, soundName: name });
    return { ok: true, name, file: `custom${ext}`, size };
  } catch (e) {
    return { ok: false, name: null, file: null, size: 0, error: e instanceof Error ? e.message : String(e) };
  }
}


export function clearSound(): SoundInfoResult {
  try {
    const cfg = readNotifyConfig();
    if (cfg.soundFile) {
      try { rmSync(join(soundsDir(), basename(cfg.soundFile)), { force: true }); } catch {  }
    }
    writeNotifyConfig({ soundFile: null, soundName: null });
    return { ok: true, name: null, file: null, size: 0 };
  } catch (e) {
    return { ok: false, name: null, file: null, size: 0, error: e instanceof Error ? e.message : String(e) };
  }
}





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
