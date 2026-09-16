/**
 * gui/src/renderer/notifySound.ts — 自定义通知提示音的**播放端**（A-980-R26）。
 *
 * 为什么在渲染层播：主进程（Electron main）没有音频输出能力，系统通知只能带/不带
 * 系统默认音（`Notification.silent`）。用户上传的音频必须由渲染进程用 `<audio>` 播。
 * 主进程判定"该响自定义音"后发 `slime:notify:playsound`，这里接住并播放。
 *
 * 音频数据走主进程读文件的 data URL（见 main/notify.ts readSoundData）：
 * 不必注册自定义协议、不受文件路径/CSP 影响；文件本身很小（上限 8MB），一次性读入可接受。
 * 读到的 data URL 会缓存，避免每次通知都跨进程搬一遍 base64；换音频时由界面调
 * `invalidateNotifySoundCache()` 失效。
 */
import type { NotifyConfigDTO } from "../shared/ipc.js";

interface NotifyApi {
  get?: () => Promise<{ ok: boolean; config: NotifyConfigDTO; soundReady: boolean }>;
  soundData?: () => Promise<{ ok: boolean; dataUrl?: string; name?: string; error?: string }>;
  onPlaySound?: (cb: () => void) => () => void;
}

function api(): NotifyApi | null {
  const w = window as unknown as { slimeAPI?: { notify?: NotifyApi } };
  return w.slimeAPI?.notify ?? null;
}

let cachedDataUrl: string | null = null;
let inflight: Promise<string | null> | null = null;

/** 换音频/清空后调用：下次播放重新向主进程取数据 */
export function invalidateNotifySoundCache(): void {
  cachedDataUrl = null;
  inflight = null;
}

async function loadDataUrl(): Promise<string | null> {
  if (cachedDataUrl) { return cachedDataUrl; }
  if (inflight) { return inflight; }
  inflight = (async () => {
    const a = api();
    if (!a?.soundData) { return null; }
    try {
      const r = await a.soundData();
      if (!r?.ok || !r.dataUrl) { return null; }
      cachedDataUrl = r.dataUrl;
      return cachedDataUrl;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 播放当前自定义提示音。
 * 失败一律静默（提示音不是关键路径：自动播放被拦、音频损坏等都不该打断用户）。
 * @returns 是否真的播了（设置界面"试听"用它给反馈）
 */
export async function playCustomNotifySound(): Promise<boolean> {
  const dataUrl = await loadDataUrl();
  if (!dataUrl) { return false; }
  try {
    const audio = new Audio(dataUrl);
    audio.volume = 1;
    await audio.play();
    return true;
  } catch (e) {
    console.warn("[slime:notify] 提示音播放失败:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** 订阅主进程的「该响提示音了」信号（App 启动时挂一次） */
export function subscribeNotifySound(): () => void {
  const a = api();
  if (!a?.onPlaySound) { return () => { /* 无 API：空清理 */ }; }
  return a.onPlaySound(() => { void playCustomNotifySound(); });
}
