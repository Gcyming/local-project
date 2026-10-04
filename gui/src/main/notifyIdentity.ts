



































import { execFileSync } from "node:child_process";
import { join } from "node:path";






export const APP_AUMID = "com.slime.gui";






export const APP_DISPLAY_NAME = "slime";


export interface NotifyPayload {
  title: string;
  body: string;
}







export function buildNotificationPayload(ev: { title?: string; body?: string }): NotifyPayload {
  const title = (ev.title ?? "").trim();
  const body = (ev.body ?? "").trim();
  
  const dedupedBody = title === body ? "" : body;
  return { title: title || APP_DISPLAY_NAME, body: dedupedBody };
}












export const NOTIFY_IMAGE_MAX_BYTES = 200 * 1024;
export const NOTIFY_IMAGE_MAX_DIM = 1024;


export interface NotifyImageVerdict { ok: boolean; reason: string }









export function checkNotifyImage(meta: { bytes: number; width?: number; height?: number }): NotifyImageVerdict {
  if (meta.bytes > NOTIFY_IMAGE_MAX_BYTES) {
    return { ok: false, reason: `体积 ${(meta.bytes / 1024).toFixed(1)} KB 超过上限 ${NOTIFY_IMAGE_MAX_BYTES / 1024} KB` };
  }
  if (meta.width !== undefined && meta.width > NOTIFY_IMAGE_MAX_DIM) {
    return { ok: false, reason: `宽 ${meta.width}px 超过上限 ${NOTIFY_IMAGE_MAX_DIM}px` };
  }
  if (meta.height !== undefined && meta.height > NOTIFY_IMAGE_MAX_DIM) {
    return { ok: false, reason: `高 ${meta.height}px 超过上限 ${NOTIFY_IMAGE_MAX_DIM}px` };
  }
  return { ok: true, reason: "符合 Windows 通知图片约束" };
}








export function notifyIconFileName(): string {
  return "notify-icon.png";
}


export interface AumidRegistryValue { name: string; value: string }


export interface IdentityApplyResult { ok: boolean; detail: string }


export function aumidRegistryKey(aumid: string = APP_AUMID): string {
  return `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`;
}













export function pngFileUri(p: string | null | undefined): string | null {
  if (!p) { return null; }
  const norm = p.replace(/\\/g, "/").trim();
  if (!/^[a-zA-Z]:\//.test(norm) && !norm.startsWith("/")) { return null; }
  if (!/\.(png|jpe?g)$/i.test(norm)) { return null; }
  const encoded = norm.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  
  return `file:///${encoded.replace(/^([a-zA-Z])%3A\//, "$1:/")}`;
}












export function aumidRegistryValues(displayName: string = APP_DISPLAY_NAME, iconPath?: string | null): AumidRegistryValue[] {
  const values: AumidRegistryValue[] = [{ name: "DisplayName", value: displayName }];
  const uri = pngFileUri(iconPath);
  if (uri) { values.push({ name: "IconUri", value: uri }); }
  return values;
}


function regExe(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
}


function currentValues(key: string, names: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const n of names) { out[n] = null; }
  try {
    const res = execFileSync(regExe(), ["query", key], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    for (const n of names) {
      const m = new RegExp(`${n}\\s+REG_SZ\\s+(.+?)\\s*$`, "m").exec(res);
      if (m) { out[n] = m[1]; }
    }
  } catch {
    
  }
  return out;
}














export function applyWindowsNotificationIdentity(iconPath?: string | null): IdentityApplyResult {
  if (process.platform !== "win32") { return { ok: true, detail: "非 Windows，跳过 AUMID 注册" }; }
  const key = aumidRegistryKey();
  const values = aumidRegistryValues(APP_DISPLAY_NAME, iconPath);
  const cur = currentValues(key, values.map((v) => v.name));
  const stale = values.filter((v) => cur[v.name] !== v.value);
  if (stale.length === 0) {
    return { ok: true, detail: `已注册（${values.map((v) => `${v.name}=${v.value}`).join(" / ")}），跳过` };
  }
  try {
    
    
    
    
    
    
    
    
    const failures: string[] = [];
    for (const v of values) {
      try {
        execFileSync(regExe(), ["add", key, "/f", "/v", v.name, "/t", "REG_SZ", "/d", v.value], {
          windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (e) {
        const err = e as { status?: number };
        failures.push(`${v.name}（reg add 退出码 ${err.status ?? "未知"}）`);
      }
    }
    if (failures.length > 0) {
      return { ok: false, detail: `写注册表失败：${failures.join("；")}` };
    }
    const got = currentValues(key, values.map((v) => v.name));
    const bad = values.filter((v) => got[v.name] !== v.value);
    return bad.length === 0
      ? { ok: true, detail: `已写入 ${key} → ${values.map((v) => `${v.name}=${v.value}`).join(" / ")}` }
      : { ok: false, detail: `写入后回读不符：${bad.map((v) => `${v.name} 期望 ${v.value} 实际 ${got[v.name] ?? "(读不到)"}`).join("；")}` };
  } catch (e) {
    return { ok: false, detail: `写注册表失败：${(e as Error)?.message ?? String(e)}` };
  }
}
