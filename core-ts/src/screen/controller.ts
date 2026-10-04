












import {
  ActionVerify,
  DisplayInfo,
  ScreenAction,
  ScreenActionKind,
  ScreenActionResult,
  ScreenBackend,
  ScreenBackendId,
  ScreenCaptureResult,
  UiDumpOutcome,
  UiElement,
  coordToDeviceInRegion,
} from "./types.js";

import { getImageDiffer, imageDiffRatio } from "./optimize.js";

import {
  decideUserYield,
  operationRegionBox,
  USER_ACTIVE_WINDOW_MS,
  USER_YIELD_MAX_WAIT_MS,
  USER_YIELD_PROBE_MS,
  type Region,
} from "./arbiter.js";





export interface OperationFocusEvent {
  phase: "begin" | "end";
  backend: ScreenBackendId;
  action: ScreenActionKind;
  
  label: string;
  
  region: Region | null;
  
  waitingUser?: boolean;
}







const USER_CONFLICT_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([
  "click", "double_click", "right_click", "middle_click", "long_press",
  "mouse_move", "drag", "scroll", "type", "key", "tap", "swipe",
]);






















const VERIFY_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([
  "click", "double_click", "right_click",
  "middle_click", "long_press",
  "tap", "key", "type", "scroll", "drag", "swipe",
]);






const VERIFY_MIN_RATIO = 0.002;


const VERIFY_MAX_ATTEMPTS = 2;


export class ScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenError";
  }
}


interface CaptureBasis {
  imageWidth: number;
  imageHeight: number;
  deviceWidth: number;
  deviceHeight: number;
  
  originX: number;
  originY: number;
  at: number;
}

export class ScreenController {
  private backends = new Map<ScreenBackendId, ScreenBackend>();
  
  private chain: Promise<unknown> = Promise.resolve();
  
  private halted = false;
  
  autoCapture = true;
  




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

  
  listBackends(): ScreenBackendId[] {
    return [...this.backends.keys()];
  }

  
  halt(): void {
    this.halted = true;
  }

  
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

  









  async listTargetsReport(id?: ScreenBackendId): Promise<{
    targets: DisplayInfo[];
    failures: Array<{ backend: ScreenBackendId; error: string }>;
  }> {
    const ids: ScreenBackendId[] = id ? [id] : this.listBackends();
    const targets: DisplayInfo[] = [];
    const failures: Array<{ backend: ScreenBackendId; error: string }> = [];
    for (const bid of ids) {
      try {
        targets.push(...(await this.backend(bid).listTargets()));
      } catch (e) {
        failures.push({ backend: bid, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { targets, failures };
  }

  
  async capture(id: ScreenBackendId, target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult> {
    try {
      const r = await this.backend(id).capture(target, opts);
      if (r.ok) { this.rememberBasis(id, target, r); }
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  
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

  











  async uiDump(id: ScreenBackendId, target?: string): Promise<UiDumpOutcome> {
    const b = this.backends.get(id);
    if (!b) { return { ok: false, elements: [], error: `图形控制后端 '${id}' 未注册` }; }
    if (!b.uiDump) { return { ok: false, elements: [], error: `后端 '${id}' 没有元素树能力（不支持元素层级导出）` }; }
    try {
      return { ok: true, elements: await b.uiDump(target) };
    } catch (e) {
      return { ok: false, elements: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  





  async listWindows(id: ScreenBackendId): Promise<Array<{ title: string; pid: number; x: number; y: number; width: number; height: number }>> {
    const b = this.backends.get(id);
    if (!b?.listWindows) { return []; }
    return await b.listWindows();
  }

  













  async focusWindow(id: ScreenBackendId, title: string): Promise<{ focused: boolean; detail: string; rect?: { x: number; y: number; width: number; height: number } }> {
    const b = this.backends.get(id);
    if (!b?.focusWindow) { return { focused: false, detail: `${id} 后端不支持窗口聚焦` }; }
    return await b.focusWindow(title);
  }

  



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

  
  async displayInfo(id: ScreenBackendId, target?: string): Promise<DisplayInfo> {
    return this.backend(id).displayInfo(target);
  }

  


  async perform(id: ScreenBackendId, action: ScreenAction, target?: string): Promise<ScreenActionResult> {
    
    const run = this.chain.then(() => this.performInner(id, action, target), () => this.performInner(id, action, target));
    
    this.chain = run.catch(() => undefined);
    return run;
  }

  






  onOperationFocus: ((e: OperationFocusEvent) => void) | null = null;

  private emitFocus(e: OperationFocusEvent): void {
    try { this.onOperationFocus?.(e); } catch {  }
  }

  



  private async awaitUserIdle(backend: ScreenBackend): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
    const started = Date.now();
    for (;;) {
      if (this.halted) {
        return { ok: false, reason: "图形控制已被紧急停止（用户中断）——请重新发起任务" };
      }
      const idleMs = await backend.userIdleMs!();
      const waitedMs = Date.now() - started;
      const d = decideUserYield({
        idleMs,
        waitedMs,
        activeWindowMs: USER_ACTIVE_WINDOW_MS,
        maxWaitMs: USER_YIELD_MAX_WAIT_MS,
        probeMs: USER_YIELD_PROBE_MS,
      });
      if (d.action === "proceed") {
        return {
          ok: true,
          note: d.note || (d.waitedMs > 0 ? `（已让位 ${Math.round(d.waitedMs)}ms 等用户停手）` : ""),
        };
      }
      if (d.action === "abort") {
        return { ok: false, reason: d.reason };
      }
      await new Promise((r) => setTimeout(r, d.waitMs));
    }
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

    
    
    
    if (!this.basis.get(`${id}|${target ?? ""}`)) {
      const loose = this.basis.get(`${id}|`);
      if (loose) { this.basis.set(`${id}|${target ?? ""}`, loose); }
    }

    
    let resolved = action;
    let locateNote = "";
    if (action.selector && (action.kind === "click" || action.kind === "tap" || action.kind === "double_click" || action.kind === "long_press")) {
      
      
      const dump = await this.uiDump(id, target);
      if (!dump.ok) {
        return {
          ok: false,
          error: `元素层级导出失败（不是 selector 的问题：后端没能给出元素树）：${dump.error ?? "未知原因"}。请改用 screen_capture 的网格刻度目测定位，或先修好后端。`,
        };
      }
      const el = matchElement(dump.elements, action.selector);
      if (!el) {
        return {
          ok: false,
          error: `元素定位失败（selector=${JSON.stringify(action.selector)}）——已导出 ${dump.elements.length} 个元素但没有匹配项；请先 screen_ui_dump 查看可选元素（必要时先下滑/翻页）`,
        };
      }
      resolved = { ...action, x: el.center.x, y: el.center.y, coordSpace: "device" };
      locateNote = `（按元素 #${el.index}${el.text ? `「${el.text}」` : el.id ? ` ${el.id}` : ""} 的中心）`;
    }

    
    const key = `${id}|${target ?? ""}`;
    const basis = this.basis.get(key);
    const space = resolved.coordSpace ?? (resolved.absolute === true ? "device" : "image");
    












    if (space !== "device" && !basis) {
      return {
        ok: false,
        error: "坐标基准缺失：本后端还没有截图记录，无法把「所见图像坐标」换算成屏幕坐标。请先调用 screen_capture（或 screen_ui_dump 定位元素）再执行动作；若坐标本就是物理像素，请显式传 coordSpace:\"device\"。",
      };
    }
    const imageW = basis?.imageWidth ?? info.width;
    const imageH = basis?.imageHeight ?? info.height;
    const regionW = basis?.deviceWidth ?? info.width;
    const regionH = basis?.deviceHeight ?? info.height;
    const ox = basis?.originX ?? 0;
    const oy = basis?.originY ?? 0;
    const scaled: ScreenAction = {
      ...resolved,
      x: coordToDeviceInRegion(space, resolved.x, imageW, regionW, ox),
      y: coordToDeviceInRegion(space, resolved.y, imageH, regionH, oy),
      x2: coordToDeviceInRegion(space, resolved.x2, imageW, regionW, ox),
      y2: coordToDeviceInRegion(space, resolved.y2, imageH, regionH, oy),
      
      absolute: true,
      coordSpace: "device",
      selector: undefined,
    };

    



    const injectOnce = async (): Promise<ScreenActionResult> => {
      
      
      const conflictsWithUser = USER_CONFLICT_ACTIONS.has(action.kind) && !!backend.userIdleMs;
      const focusRegion = operationRegionBox({
        targetRegion: target && basis ? { x: ox, y: oy, width: regionW, height: regionH } : null,
        point: { x: scaled.x, y: scaled.y },
        fallback: basis ? { x: ox, y: oy, width: regionW, height: regionH } : null,
      });
      let yieldNote = "";
      if (conflictsWithUser) {
        
        this.emitFocus({ phase: "begin", backend: id, action: action.kind, label: describeAction(scaled), region: focusRegion, waitingUser: true });
      }
      let r: ScreenActionResult;
      try {
        if (conflictsWithUser) {
          const gate = await this.awaitUserIdle(backend);
          if (!gate.ok) {
            return { ok: false, error: gate.reason };
          }
          yieldNote = gate.note;
        }
        r = await backend.perform(scaled, target, info);
        if (r.ok && yieldNote) { r.detail = `${r.detail ?? ""}${yieldNote}`; }
      } finally {
        if (conflictsWithUser) {
          this.emitFocus({ phase: "end", backend: id, action: action.kind, label: describeAction(scaled), region: focusRegion });
        }
      }
      
      if (r.ok && this.autoCapture && action.kind !== "wait") {
        const shot = await this.capture(id, target);
        if (shot.ok) { r.capture = shot; }
      }
      return r;
    };

    
    
    
    
    
    
    
    
    const kindVerifiable = VERIFY_ACTIONS.has(action.kind);
    const differReady = getImageDiffer() !== null;
    const wantVerify = kindVerifiable && this.autoCapture && differReady;
    let beforePng: string | undefined;
    if (wantVerify) {
      try {
        const b0 = await backend.capture(target, { marks: false });
        if (b0.ok) { beforePng = b0.pngBase64; }
      } catch { beforePng = undefined; }
    }

    let result: ScreenActionResult;
    try {
      result = await injectOnce();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    
    
    
    if (result.ok && kindVerifiable) {
      result = await this.verifyFeedback(result, beforePng, injectOnce);
    }

    if (result.ok && locateNote && result.detail) {
      result.detail = `${result.detail}${locateNote}`;
    }
    return result;
  }

  












  private async verifyFeedback(
    prev: ScreenActionResult,
    beforePng: string | undefined,
    injectOnce: () => Promise<ScreenActionResult>,
  ): Promise<ScreenActionResult> {
    if (!this.autoCapture) {
      return {
        ...prev,
        verify: { hit: true, ratio: null, attempts: 1, note: "已关闭动作后复截，本次不做命中校验" },
      };
    }
    let ratio = imageDiffRatio(beforePng, prev.capture?.pngBase64);
    if (ratio === null) {
      
      
      const why = getImageDiffer() === null
        ? "未装配画面差异度量，未做命中判定"
        : beforePng === undefined
          ? "动作前的参考图未取到，未做命中判定"
          : "两张截图不可比（尺寸不一致或解码失败），未做命中判定";
      const v: ActionVerify = { hit: true, ratio: null, attempts: 1, note: why };
      return { ...prev, verify: v };
    }
    if (ratio >= VERIFY_MIN_RATIO) {
      return { ...prev, verify: { hit: true, ratio, attempts: 1, note: "检测到画面可见变化" } };
    }
    
    const attemptsMax: number = VERIFY_MAX_ATTEMPTS;
    if (attemptsMax <= 1) {
      return { ...prev, verify: { hit: false, ratio, attempts: 1, note: "画面无可见变化（未开启自动重试）" } };
    }
    
    const again = await injectOnce();
    if (!again.ok) {
      return {
        ...again,
        verify: { hit: false, ratio, attempts: 2, note: "画面无可见变化；自动重试时动作本身失败" },
      };
    }
    const r2 = imageDiffRatio(beforePng, again.capture?.pngBase64);
    if (r2 !== null) { ratio = r2; }
    const hit = ratio >= VERIFY_MIN_RATIO;
    return {
      ...again,
      verify: {
        hit,
        ratio,
        attempts: 2,
        note: hit ? "首次未命中，自动重试后检测到画面可见变化" : "首次未命中，自动重试一次后画面仍无可见变化",
      },
    };
  }
}



function describeAction(a: ScreenAction): string {
  const names: Partial<Record<ScreenActionKind, string>> = {
    click: "点击", double_click: "双击", right_click: "右键点击", middle_click: "中键点击",
    long_press: "长按", tap: "点按", mouse_move: "移动指针", drag: "拖拽", scroll: "滚动",
    type: "输入文字", key: "按键", swipe: "滑动",
  };
  const verb = names[a.kind] ?? a.kind;
  if (a.kind === "type") { return `${verb}（${(a.text ?? "").length} 个字符）`; }
  if (a.kind === "key") { return `${verb} ${a.key ?? ""}`.trim(); }
  const hasPoint = typeof a.x === "number" && typeof a.y === "number";
  return hasPoint ? `${verb} (${Math.round(a.x!)}, ${Math.round(a.y!)})` : verb;
}


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
