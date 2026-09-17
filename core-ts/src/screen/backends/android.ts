/**
 * core-ts/src/screen/backends/android.ts — Android 图形控制后端。
 *
 * 实现选择（全网调研结论，AzurLaneAutoScript / android-mcp-server / scrcpy 生态对比）：
 *   | 方案                  | 协议            | 速度      | 依赖         |
 *   | adb shell input       | shell 命令      | ~100ms    | **无（通用）** |
 *   | uiautomator2 (ATX)    | HTTP            | ~50ms     | 需装 ATX agent |
 *   | minitouch / MaaTouch  | socket 二进制    | ~20ms     | 需推二进制    |
 *   | scrcpy                | ADB socket      | ~20ms     | 需 scrcpy server |
 *   | nemu_ipc              | 共享内存         | ~5ms      | 仅 MuMu      |
 *
 * slime 取 **adb shell input 路线**：零额外二进制、零新依赖、兼容全部设备与模拟器；
 * 高频场景可后续在此后端内加 minitouch/scrcpy 快路径而不改上层契约。
 *
 * 动作映射：
 *   click / tap        → input tap x y
 *   long_press         → input swipe x y x y <duration>   （同点长按）
 *   double_click       → 两次 input tap（间隔 80ms）
 *   swipe / drag       → input swipe x1 y1 x2 y2 <duration>
 *   scroll             → input swipe（纵向；delta 正=向上，手指反向滑动）
 *   type               → input text '<escaped>'
 *   key                → input keyevent KEYCODE_xxx
 *   mouse_move / right_click / middle_click → 不支持（明确报错，不静默降级）
 */
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

/** 依赖注入：ADB 服务（由装配层传入 gui/src/main/adb.ts 的 adbService，避免 core-ts 反向依赖 GUI） */
export interface AdbLike {
  devices(): Promise<{ ok: boolean; devices?: Array<{ serial: string; state: string; model?: string }>; error?: string }>;
  shell(serial: string, cmd: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  screencap(serial: string): Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
  /** A-975（可选）：uiautomator dump 取当前界面层级 XML（缺失时元素定位自动降级为纯视觉） */
  uiDump?(serial: string): Promise<{ ok: boolean; xml?: string; error?: string }>;
}

/** 后端支持的动作集合 */
const ANDROID_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([
  "click", "tap", "long_press", "double_click", "swipe", "drag", "scroll", "type", "key", "wait",
]);

/** 按键名规范化：BACK / Home / KEYCODE_ENTER → KEYCODE_BACK 等 */
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
  // 单字母 / 单数字：A → KEYCODE_A，1 → KEYCODE_1
  if (/^[a-z0-9]$/.test(lower)) { return `KEYCODE_${lower.toUpperCase()}`; }
  return "";
}

/** 设备 shell 单引号转义（防命令注入：' → '\''） */
function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** 是否含非 ASCII（中文/emoji 等）——`input text` 只吃 ASCII，需走剪贴板/ADBKeyboard 兜底 */
function hasNonAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(s);
}

/** 从 uiautomator XML 属性串里取一个属性值 */
function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/**
 * A-975：解析 uiautomator dump 的 XML → 可操作元素列表。
 * 采用业界标准做法（android-mcp-server / MIUI 自动化）：取 bounds [x1,y1][x2,y2]，
 * 点击取**包围盒中心**（`(x1+x2)/2, (y1+y2)/2`），比模型目测坐标可靠得多。
 * 只保留「有内容或可点/可滚」的元素，并按包内顺序给 1 起编号（供 selector.index）。
 */
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
    // 过滤：无内容、不可点、不可滚的纯容器节点（会淹没模型的注意力）
    if (!hasContent && !clickable && !scrollable) { continue; }
    // 过滤零面积节点（不可点）
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

  /** 列出已连接（state=device）的安卓目标 */
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

  /** 默认目标：第一台 state=device 的设备 */
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
    // 优先 Override size（用户改过分辨率时更准确），回退 Physical size
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
    } catch { /* 型号取不到不影响 */ }
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
      // A-975：物理尺寸与图像尺寸分开记录——模型的坐标以「它看到的图」为基准，
      // 而点击最终要落到物理分辨率，两者不能混用（此前把图像尺寸写成 width 是偏移根因之一）。
      let devW = 0; let devH = 0;
      try {
        const info = await this.displayInfo(serial);
        devW = info.width; devH = info.height;
      } catch { /* 尺寸取不到不阻断截图 */ }
      // 标注：把可点元素的编号框画到图上，模型可"点第 N 个框"
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
        } catch { /* dump 失败则仅网格 */ }
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
        width: devW, height: devH,            // 物理分辨率（坐标落地基准）
        imageWidth: imageW, imageHeight: imageH, // 模型所见尺寸（坐标输入基准）
        bytes: opt.bytes || bytes,
        annotate,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A-975：uiautomator dump → 解析可操作元素（供元素级点击） */
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
        // Android 无滚轮：delta>0（向上翻页）→ 手指从下往上滑（内容上移）
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
        // A-975：`input text` 只吃 ASCII，中文/emoji 会被静默丢弃（模型常据此误判"已输入"）。
        // 非 ASCII → 优先走 ADBKeyboard 的广播通道；不可用则明确报错，避免模型盲目重试。
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
        // input text 对空格敏感：Android 约定用 %s 表示空格
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
