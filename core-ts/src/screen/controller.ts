/**
 * core-ts/src/screen/controller.ts — slime 图形控制 Executor（三层架构第 ② 层）。
 *
 * 职责（对齐 Claude Code computerUse 的 executor.ts）：
 *   1. **后端注册与分发**：按 backend id 路由到 desktop / android；
 *   2. **坐标缩放**：模型归一化坐标（0-1000）→ 目标真实像素（DPI/分辨率无关）；
 *   3. **互斥锁**：同一时刻只允许一个图形动作（防鼠标/触摸事件竞态，computerUseLock 语义）；
 *   4. **能力校验**：后端不支持的动作直接拒绝，不静默失败；
 *   5. **动作后复截**：默认在动作后回一张截图（对齐 Anthropic「每个动作后回图」），便于模型自校验。
 *
 * 与 ADB 的关系：Android 后端只是一个注册进来的 backend —— 本控制器是**整个 slime 的图形控制能力**，
 * 桌面与应用窗口同样通过它驱动。
 */
import {
  DisplayInfo,
  ScreenAction,
  ScreenActionResult,
  ScreenBackend,
  ScreenBackendId,
  ScreenCaptureResult,
  UiElement,
  coordToDeviceInRegion,
} from "./types.js";

/** controller 级错误（工具层据此回传可读原因） */
export class ScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenError";
  }
}

/** A-975：最近一次截图的尺寸现场（模型所见图像尺寸 vs 目标物理尺寸）——坐标换算的基准 */
interface CaptureBasis {
  imageWidth: number;
  imageHeight: number;
  deviceWidth: number;
  deviceHeight: number;
  /** A-978：截图覆盖区域在目标坐标系里的原点（整屏=0,0；按窗口截取=窗口左上角） */
  originX: number;
  originY: number;
  at: number;
}

export class ScreenController {
  private backends = new Map<ScreenBackendId, ScreenBackend>();
  /** 图形动作互斥锁：串行化，杜绝并发输入事件互相踩踏 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 紧急停止标志（用户中断 / 应用退出时置位，后续动作一律拒绝） */
  private halted = false;
  /** 动作后是否自动复截（默认开；halt 或 wait 动作不复截） */
  autoCapture = true;
  /**
   * A-975：每个 (backend,target) 最近一次截图的尺寸现场。
   * 模型给出的坐标默认以"它看到的那张图"为基准，必须按 image→device 比例换算；
   * 不记录这张基准，就会拿缩放后的图像坐标当物理坐标用 → 系统性偏移。
   */
  private basis = new Map<string, CaptureBasis>();

  register(backend: ScreenBackend): void {
    this.backends.set(backend.id, backend);
  }

  unregister(id: ScreenBackendId): void {
    this.backends.delete(id);
  }

  has(id: ScreenBackendId): boolean {
    return this.backends.has(id);
  }

  /** 可用后端清单（工具层 screen_info 返回给模型） */
  listBackends(): ScreenBackendId[] {
    return [...this.backends.keys()];
  }

  /** 紧急停止：中断所有后续图形动作（用户在 GUI 里点「停止」或应用退出时调用） */
  halt(): void {
    this.halted = true;
  }

  /** 恢复（新一轮会话开始时调用） */
  resume(): void {
    this.halted = false;
  }

  isHalted(): boolean {
    return this.halted;
  }

  private backend(id: ScreenBackendId): ScreenBackend {
    const b = this.backends.get(id);
    if (!b) {
      throw new ScreenError(
        `图形控制后端 '${id}' 不可用（已注册：${[...this.backends.keys()].join("、") || "无"}）`,
      );
    }
    return b;
  }

  /** 列出某后端（缺省全部）的目标 */
  async listTargets(id?: ScreenBackendId): Promise<DisplayInfo[]> {
    const ids: ScreenBackendId[] = id ? [id] : this.listBackends();
    const out: DisplayInfo[] = [];
    for (const bid of ids) {
      try {
        out.push(...(await this.backend(bid).listTargets()));
      } catch { /* 单后端不可用不影响其它后端枚举 */ }
    }
    return out;
  }

  /** 截屏（不占用互斥锁 —— 纯读，可并发）。同时记录坐标换算基准。 */
  async capture(id: ScreenBackendId, target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult> {
    try {
      const r = await this.backend(id).capture(target, opts);
      if (r.ok) { this.rememberBasis(id, target, r); }
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A-975：记录本次截图的坐标基准（图像尺寸 vs 物理尺寸） */
  private rememberBasis(id: ScreenBackendId, target: string | undefined, r: ScreenCaptureResult): void {
    const devW = r.width ?? 0;
    const devH = r.height ?? 0;
    if (!devW || !devH) { return; }
    this.basis.set(`${id}|${target ?? ""}`, {
      imageWidth: r.imageWidth ?? devW,
      imageHeight: r.imageHeight ?? devH,
      deviceWidth: devW,
      deviceHeight: devH,
      originX: r.originX ?? 0,
      originY: r.originY ?? 0,
      at: Date.now(),
    });
  }

  /** A-975：外部截屏（如 adb_screencap 直接走 ADB 服务）登记坐标基准，
   *  让随后的 screen_action 用 image 坐标时能按正确比例折算到设备物理像素。 */
  noteCaptureBasis(
    id: ScreenBackendId,
    target: string | undefined,
    imageW: number,
    imageH: number,
    devW: number,
    devH: number,
    originX = 0,
    originY = 0,
  ): void {
    if (!imageW || !imageH || !devW || !devH) { return; }
    this.basis.set(`${id}|${target ?? ""}`, {
      imageWidth: imageW,
      imageHeight: imageH,
      deviceWidth: devW,
      deviceHeight: devH,
      originX,
      originY,
      at: Date.now(),
    });
  }

  /** A-975：导出某后端的 UI 元素层级（不支持/失败时返回空数组，工具层据此降级为纯视觉） */
  async uiDump(id: ScreenBackendId, target?: string): Promise<UiElement[]> {
    const b = this.backends.get(id);
    if (!b?.uiDump) { return []; }
    try {
      return await b.uiDump(target);
    } catch {
      return [];
    }
  }

  /** A-977：枚举可见窗口（仅桌面后端支持；不支持时返回空数组） */
  async listWindows(id: ScreenBackendId): Promise<Array<{ title: string; pid: number; x: number; y: number; width: number; height: number }>> {
    const b = this.backends.get(id);
    if (!b?.listWindows) { return []; }
    try { return await b.listWindows(); } catch { return []; }
  }

  /** A-977：按标题聚焦窗口并返回其矩形（仅桌面后端支持） */
  async focusWindow(id: ScreenBackendId, title: string): Promise<{ focused: boolean; detail: string; rect?: { x: number; y: number; width: number; height: number } }> {
    const b = this.backends.get(id);
    if (!b?.focusWindow) { return { focused: false, detail: `${id} 后端不支持窗口聚焦` }; }
    try { return await b.focusWindow(title); } catch (e) { return { focused: false, detail: e instanceof Error ? e.message : String(e) }; }
  }

  /**
   * A-978：按窗口标题截取该窗口区域（先聚焦再区域截取），并记录坐标基准（含窗口原点）。
   * 仅桌面后端支持。
   */
  async captureWindow(id: ScreenBackendId, title: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult> {
    const b = this.backends.get(id);
    if (!b?.captureWindow) { return { ok: false, error: `${id} 后端不支持按窗口截图（桌面窗口截图仅 Windows 桌面可用）` }; }
    try {
      const r = await b.captureWindow(title, opts);
      if (r.ok) { this.rememberBasis(id, undefined, r); }
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 显示信息（截图与坐标缩放的基准） */
  async displayInfo(id: ScreenBackendId, target?: string): Promise<DisplayInfo> {
    return this.backend(id).displayInfo(target);
  }

  /**
   * 执行一个图形动作（串行化 + 坐标换算 + 元素定位 + 能力校验 + 可选复截）。
   */
  async perform(id: ScreenBackendId, action: ScreenAction, target?: string): Promise<ScreenActionResult> {
    // 串行化：把本次动作挂到链尾，保证全局同一时刻只有一个图形动作
    const run = this.chain.then(() => this.performInner(id, action, target), () => this.performInner(id, action, target));
    // 链尾吞掉异常，避免一次失败污染后续排队动作
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async performInner(
    id: ScreenBackendId,
    action: ScreenAction,
    target?: string,
  ): Promise<ScreenActionResult> {
    if (this.halted) {
      return { ok: false, error: "图形控制已被紧急停止（用户中断）——请重新发起任务" };
    }
    const backend = this.backend(id);

    // 能力校验：不支持的动作直接拒绝（诚实报错优于静默降级）
    if (!backend.actions.has(action.kind)) {
      return {
        ok: false,
        error: `后端 '${id}' 不支持动作 '${action.kind}'（支持：${[...backend.actions].join("、")}）`,
      };
    }

    let info: DisplayInfo;
    try {
      info = await backend.displayInfo(target);
    } catch (e) {
      return { ok: false, error: `获取显示信息失败：${e instanceof Error ? e.message : String(e)}` };
    }

    // A-975：元素定位优先——比坐标可靠得多（取 bounds 中心，天然规避目测漂移）
    let resolved = action;
    let locateNote = "";
    if (action.selector && (action.kind === "click" || action.kind === "tap" || action.kind === "double_click" || action.kind === "long_press")) {
      const els = await this.uiDump(id, target);
      const el = matchElement(els, action.selector);
      if (!el) {
        return {
          ok: false,
          error: `元素定位失败（selector=${JSON.stringify(action.selector)}）——请先 screen_ui_dump 查看可选元素（必要时先下滑/翻页）`,
        };
      }
      resolved = { ...action, x: el.center.x, y: el.center.y, coordSpace: "device" };
      locateNote = `（按元素 #${el.index}${el.text ? ` "${el.text}"` : el.id ? ` ${el.id}` : ""} 的中心）`;
    }

    // 坐标换算：统一折算到物理像素（A-978：带上截图区域原点，按窗口截图才不会整体偏移）
    const key = `${id}|${target ?? ""}`;
    const basis = this.basis.get(key);
    const imageW = basis?.imageWidth ?? info.width;
    const imageH = basis?.imageHeight ?? info.height;
    const regionW = basis?.deviceWidth ?? info.width;
    const regionH = basis?.deviceHeight ?? info.height;
    const ox = basis?.originX ?? 0;
    const oy = basis?.originY ?? 0;
    const space = resolved.coordSpace ?? (resolved.absolute === true ? "device" : "image");
    const scaled: ScreenAction = {
      ...resolved,
      x: coordToDeviceInRegion(space, resolved.x, imageW, regionW, ox),
      y: coordToDeviceInRegion(space, resolved.y, imageH, regionH, oy),
      x2: coordToDeviceInRegion(space, resolved.x2, imageW, regionW, ox),
      y2: coordToDeviceInRegion(space, resolved.y2, imageH, regionH, oy),
      // 落地后一律按像素执行，后端无需再关心坐标系
      absolute: true,
      coordSpace: "device",
      selector: undefined,
    };

    let result: ScreenActionResult;
    try {
      result = await backend.perform(scaled, target, info);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // 动作后自动复截（wait 无副作用、halt 已停 → 不复截）
    if (result.ok && this.autoCapture && action.kind !== "wait") {
      const shot = await this.capture(id, target);
      if (shot.ok) { result.capture = shot; }
    }
    if (result.ok && locateNote && result.detail) {
      result.detail = `${result.detail}${locateNote}`;
    }
    return result;
  }
}

/** A-975：按 selector 在元素列表中定位（index → id → text → desc，逐级回退） */
function matchElement(els: UiElement[], sel: { index?: number; id?: string; text?: string; desc?: string }): UiElement | undefined {
  if (typeof sel.index === "number") {
    const hit = els.find((e) => e.index === sel.index);
    if (hit) { return hit; }
  }
  if (sel.id) {
    const hit = els.find((e) => e.id === sel.id) ?? els.find((e) => (e.id ?? "").includes(sel.id!));
    if (hit) { return hit; }
  }
  if (sel.text) {
    const t = sel.text.trim();
    const hit = els.find((e) => (e.text ?? "").trim() === t) ?? els.find((e) => (e.text ?? "").includes(t));
    if (hit) { return hit; }
  }
  if (sel.desc) {
    const d = sel.desc.trim();
    const hit = els.find((e) => (e.desc ?? "").trim() === d) ?? els.find((e) => (e.desc ?? "").includes(d));
    if (hit) { return hit; }
  }
  return undefined;
}

let globalController: ScreenController | null = null;

export function getScreenController(): ScreenController {
  if (!globalController) {
    globalController = new ScreenController();
  }
  return globalController;
}

export function resetScreenController(): void {
  globalController = null;
}
