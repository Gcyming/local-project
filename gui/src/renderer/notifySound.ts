











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


export function subscribeNotifySound(): () => void {
  const a = api();
  if (!a?.onPlaySound) { return () => {  }; }
  return a.onPlaySound(() => { void playCustomNotifySound(); });
}
