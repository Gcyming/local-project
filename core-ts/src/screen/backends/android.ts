























import {
  DisplayInfo,
  ScreenAction,
  ScreenActionKind,
  ScreenActionResult,
  ScreenBackend,
  ScreenCaptureResult,
  UiElement,
} from "../types.js";
import { toOptimizedDataUrl } from "../optimize.js";


export interface AdbLike {
  devices(): Promise<{ ok: boolean; devices?: Array<{ serial: string; state: string; model?: string }>; error?: string }>;
  shell(serial: string, cmd: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  screencap(serial: string): Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
  
  uiDump?(serial: string): Promise<{ ok: boolean; xml?: string; error?: string }>;
}


const ANDROID_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([
  "click", "tap", "long_press", "double_click", "swipe", "drag", "scroll", "type", "key", "wait",
]);


const KEY_ALIASES: Record<string, string> = {
  enter: "KEYCODE_ENTER", return: "KEYCODE_ENTER", back: "KEYCODE_BACK", home: "KEYCODE_HOME",
  menu: "KEYCODE_MENU", power: "KEYCODE_POWER", escape: "KEYCODE_ESCAPE", esc: "KEYCODE_ESCAPE",
  tab: "KEYCODE_TAB", delete: "KEYCODE_DEL", backspace: "KEYCODE_DEL", space: "KEYCODE_SPACE",
  up: "KEYCODE_DPAD_UP", down: "KEYCODE_DPAD_DOWN", left: "KEYCODE_DPAD_LEFT", right: "KEYCODE_DPAD_RIGHT",
  volume_up: "KEYCODE_VOLUME_UP", volume_down: "KEYCODE_VOLUME_DOWN", wakeup: "KEYCODE_WAKEUP",
  sleep: "KEYCODE_SLEEP", app_switch: "KEYCODE_APP_SWITCH", recents: "KEYCODE_APP_SWITCH",
  search: "KEYCODE_SEARCH", camera: "KEYCODE_CAMERA",
};

function normalizeKey(key: string): string {
  const raw = (key ?? "").trim();
  if (!raw) { return ""; }
  if (/^KEYCODE_[A-Z0-9_]+$/i.test(raw)) { return raw.toUpperCase(); }
  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower]) { return KEY_ALIASES[lower]; }
  
  if (/^[a-z0-9]$/.test(lower)) { return `KEYCODE_${lower.toUpperCase()}`; }
  return "";
}


function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}


function hasNonAscii(s: string): boolean {
  
  return /[^\x00-\x7F]/.test(s);
}


function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}







export function parseUiHierarchy(xml: string): UiElement[] {
  const out: UiElement[] = [];
  if (!xml) { return out; }
  const nodeRe = /<node\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const tag = m[0];
    const bounds = attr(tag, "bounds");
    if (!bounds) { continue; }
    const bm = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!bm) { continue; }
    const x1 = Number(bm[1]); const y1 = Number(bm[2]);
    const x2 = Number(bm[3]); const y2 = Number(bm[4]);
    const text = (attr(tag, "text") ?? "").trim();
    const id = (attr(tag, "resource-id") ?? "").trim();
    const desc = (attr(tag, "content-desc") ?? "").trim();
    const clickable = attr(tag, "clickable") === "true";
    const scrollable = attr(tag, "scrollable") === "true";
    const enabled = attr(tag, "enabled") !== "false";
    const className = attr(tag, "class");
    const hasContent = text.length > 0 || desc.length > 0;
    
    if (!hasContent && !clickable && !scrollable) { continue; }
    
    if (!clickable && (x2 - x1 <= 0 || y2 - y1 <= 0)) { continue; }
    out.push({
      index: out.length + 1,
      className,
      text: text || undefined,
      id: id || undefined,
      desc: desc || undefined,
      bounds: { x1, y1, x2, y2 },
      center: { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) },
      clickable,
      scrollable,
      enabled,
    });
  }
  return out;
}

export class AndroidScreenBackend implements ScreenBackend {
  readonly id = "android" as const;
  readonly actions = ANDROID_ACTIONS;
  private adb: AdbLike;

  constructor(adb: AdbLike) {
    this.adb = adb;
  }

  
  async listTargets(): Promise<DisplayInfo[]> {
    const r = await this.adb.devices();
    const list = (r.devices ?? []).filter((d) => d.state === "device");
    const out: DisplayInfo[] = [];
    for (const d of list) {
      try {
        out.push(await this.displayInfo(d.serial));
      } catch {
        out.push({ backend: "android", target: d.serial, width: 0, height: 0, label: d.model ?? d.serial });
      }
    }
    return out;
  }

  
  private async defaultSerial(): Promise<string> {
    const r = await this.adb.devices();
    const d = (r.devices ?? []).find((x) => x.state === "device");
    if (!d) {
      throw new Error("没有可用的 Android 设备（请先用 adb_connect 连接模拟器/设备）");
    }
    return d.serial;
  }

  async displayInfo(target?: string): Promise<DisplayInfo> {
    const serial = target?.trim() || await this.defaultSerial();
    const r = await this.adb.shell(serial, "wm size");
    const out = r.stdout ?? "";
    
    const om = out.match(/Override size:\s*(\d+)\s*x\s*(\d+)/i);
    const pm = out.match(/Physical size:\s*(\d+)\s*x\s*(\d+)/i);
    const m = om ?? pm;
    const width = m ? Number(m[1]) : 0;
    const height = m ? Number(m[2]) : 0;
    if (!width || !height) {
      throw new Error(`无法解析设备分辨率（wm size 返回：${out.slice(0, 120) || r.error || "空"}）`);
    }
    let model = "";
    try {
      const props = await this.adb.shell(serial, "getprop ro.product.model");
      model = (props.stdout ?? "").trim();
    } catch {  }
    return {
      backend: "android",
      target: serial,
      width,
      height,
      label: model ? `${model} (${width}×${height})` : `${serial} (${width}×${height})`,
    };
  }

  async capture(target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult> {
    try {
      const serial = target?.trim() || await this.defaultSerial();
      const r = await this.adb.screencap(serial);
      if (!r.ok || !r.pngBase64) {
        return { ok: false, error: r.error ?? "截图失败" };
      }
      const bytes = Math.floor((r.pngBase64.length * 3) / 4);
      
      
      let devW = 0; let devH = 0;
      try {
        const info = await this.displayInfo(serial);
        devW = info.width; devH = info.height;
      } catch {  }
      
      let annotate: ScreenCaptureResult["annotate"];
      const marks: Array<{ index: number; label?: string; x1: number; y1: number; x2: number; y2: number }> = [];
      if (opts?.marks) {
        try {
          const els = await this.uiDump(serial);
          for (const e of els) {
            if (!e.clickable || marks.length >= 40) { continue; }
            const label = e.text || e.desc || (e.id ? e.id.split("/").pop() : "") || "";
            marks.push({ index: e.index, label: label.slice(0, 12), x1: e.bounds.x1, y1: e.bounds.y1, x2: e.bounds.x2, y2: e.bounds.y2 });
          }
        } catch {  }
      }
      const opt = toOptimizedDataUrl(r.pngBase64, { grid: true, marks, marksSpace: { width: devW, height: devH } });
      const imageW = opt.width; const imageH = opt.height;
      if (opts?.marks) {
        annotate = {
          grid: true,
          marks: marks.length,
          scaleX: imageW && devW ? Number((devW / imageW).toFixed(4)) : 1,
          scaleY: imageH && devH ? Number((devH / imageH).toFixed(4)) : 1,
        };
      }
      return {
        ok: true,
        pngBase64: r.pngBase64,
        dataUrl: opt.dataUrl,
        width: devW, height: devH,            
        imageWidth: imageW, imageHeight: imageH, 
        bytes: opt.bytes || bytes,
        annotate,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  
  async uiDump(target?: string): Promise<UiElement[]> {
    if (!this.adb.uiDump) { return []; }
    const serial = target?.trim() || await this.defaultSerial();
    const r = await this.adb.uiDump(serial);
    if (!r.ok || !r.xml) { return []; }
    return parseUiHierarchy(r.xml);
  }

  async perform(action: ScreenAction, target?: string, info?: DisplayInfo): Promise<ScreenActionResult> {
    const serial = target?.trim() || await this.defaultSerial();
    const x = action.x ?? 0;
    const y = action.y ?? 0;
    const x2 = action.x2;
    const y2 = action.y2;
    const dur = action.durationMs ?? 300;

    const input = async (cmd: string): Promise<ScreenActionResult> => {
      const r = await this.adb.shell(serial, cmd);
      if (!r.ok) {
        return { ok: false, error: (r.error ?? r.stderr ?? "adb shell 失败").slice(0, 300) };
      }
      return { ok: true, detail: `[${serial}] ${cmd}` };
    };

    switch (action.kind) {
      case "click":
      case "tap":
        return input(`input tap ${x} ${y}`);

      case "double_click":
        await input(`input tap ${x} ${y}`);
        await new Promise((res) => setTimeout(res, 80));
        return input(`input tap ${x} ${y}`);

      case "long_press":
        return input(`input swipe ${x} ${y} ${x} ${y} ${Math.max(500, dur)}`);

      case "swipe":
      case "drag": {
        if (x2 === undefined || y2 === undefined) {
          return { ok: false, error: `${action.kind} 需要 x、y（起点）与 x2、y2（终点）` };
        }
        return input(`input swipe ${x} ${y} ${x2} ${y2} ${Math.max(50, dur)}`);
      }

      case "scroll": {
        
        const delta = action.delta ?? -100;
        const height = info?.height ?? 2400;
        const span = Math.max(120, Math.min(height * 0.4, Math.abs(delta) * 4));
        const fromY = delta > 0 ? y + span / 2 : y - span / 2;
        const toY = delta > 0 ? y - span / 2 : y + span / 2;
        return input(`input swipe ${Math.round(x)} ${Math.round(fromY)} ${Math.round(x)} ${Math.round(toY)} 200`);
      }

      case "type": {
        const text = action.text ?? "";
        if (!text) { return { ok: false, error: "type 需要 text 参数" }; }
        
        
        if (hasNonAscii(text)) {
          const bc = await this.adb.shell(serial, `am broadcast -a ADB_INPUT_TEXT --es msg ${shQuote(text)}`);
          const out = `${bc.stdout ?? ""}${bc.stderr ?? ""}`;
          const okBc = bc.ok && /result=0|Broadcast completed|结果=0/i.test(out);
          if (okBc) { return { ok: true, detail: `[${serial}] 已输入（ADBKeyboard 广播）${text.slice(0, 20)}` }; }
          return {
            ok: false,
            error: "设备不支持非 ASCII 文本输入（`input text` 仅支持英文数字）。请改用：①在设备安装并启用 ADBKeyboard（设置→输入法切换到 ADBKeyboard），或 ②先用 screen_action 点击输入框，再让用户在设备上手动输入。",
          };
        }
        
        const escaped = shQuote(text.replace(/%/g, "%%").replace(/ /g, "%s"));
        return input(`input text ${escaped}`);
      }

      case "key": {
        const code = normalizeKey(action.key ?? "");
        if (!code) {
          return { ok: false, error: `无法识别的按键 '${action.key ?? ""}'（可用：HOME / BACK / ENTER / KEYCODE_XXX / 单字母）` };
        }
        return input(`input keyevent ${code}`);
      }

      case "wait": {
        const ms = Math.max(0, Math.min(30_000, action.durationMs ?? 500));
        await new Promise((res) => setTimeout(res, ms));
        return { ok: true, detail: `已等待 ${ms}ms` };
      }

      default:
        return { ok: false, error: `Android 后端不支持动作 '${action.kind}'` };
    }
  }
}
