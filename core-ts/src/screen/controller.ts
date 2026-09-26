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
// A-1123：画面差异度量（命中校验的数据源）—— 与 setImageOptimizer 同款的注入点，见 optimize.ts
import { getImageDiffer, imageDiffRatio } from "./optimize.js";
// A-1044：用户让位仲裁（人优先）+ 操作区域几何 —— 判据唯一实现见 arbiter.ts
import {
  decideUserYield,
  operationRegionBox,
  USER_ACTIVE_WINDOW_MS,
  USER_YIELD_MAX_WAIT_MS,
  USER_YIELD_PROBE_MS,
  type Region,
} from "./arbiter.js";

/**
 * A-1044：一次图形动作的「可视化事件」（呼吸灯边框 + 悬浮提示的数据源）。
 * `phase:"begin"` 在输入注入**前**发出（让用户先看见"Agent 要动了"），`phase:"end"` 在动作结束后发出。
 */
export interface OperationFocusEvent {
  phase: "begin" | "end";
  backend: ScreenBackendId;
  action: ScreenActionKind;
  /** 人话标签（悬浮提示直接显示，如「点击 (812, 431)」） */
  label: string;
  /** 被操作区域（虚拟桌面坐标 / 设备坐标）；无可信区域时为 null（不画假框） */
  region: Region | null;
  /** 本次是否需要让位给用户（begin 时若为 true，界面应显示"正在等用户停手"） */
  waitingUser?: boolean;
}

/**
 * A-1044：**会注入输入**的动作集合。
 * 只有这些动作需要「用户让位」等待 —— 截图 / 枚举 / dump / wait 都不碰用户的指针与焦点，
 * 在用户操作时照常执行（让位是为了不抢，不是为了把自己整个停掉）。
 * `mouse_move` 也在内：它同样会搬走用户看得见的物理指针。
 */
const USER_CONFLICT_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([
  "click", "double_click", "right_click", "middle_click", "long_press",
  "mouse_move", "drag", "scroll", "type", "key", "tap", "swipe",
]);

/* ───────────────────── A-1123：命中校验（动作后自动复核 + 未命中自动重试一次） ─────────────────────
 *
 * 【要修的到底是什么】`detail` 只陈述「输入已注入」（"已在 (x,y) 左键单击"），**不陈述「效果已发生」**。
 * 点空 / 目标被遮挡 / 窗口没聚焦 / 元素还没渲染出来 —— 四种情形的回执与成功**逐字相同**，
 * 模型于是只能靠目测两张图来判断，而它**没有判据**（这就是"用起来总是糊涂"的另一半）。
 *
 * 【数据源】`imageDiffRatio`（optimize.ts 的注入点，GUI 用 nativeImage 实现）。
 *   比较不了时返回 `null` —— 那是**没有判据**，不是"没变化"：此时**不许判负、不许重试**，
 *   否则会把一次其实已经成功的点击再点一遍（对外是"双击了"，可能触发完全不同的行为）。
 */

/**
 * **期望产生可见反馈**的动作集合 —— 命中校验只对它们做。
 * `mouse_move`（只搬指针）与 `wait`（纯等待）画面本就不该变，纳入只会制造**假未命中**。
 *
 * ⚠️ **刻意不写成上面 `USER_CONFLICT_ACTIONS` 的派生**（`filter(k => k !== "mouse_move")`）：
 *   两处回答的是**两个不同问题**（"会碰用户的输入吗" / "画面该变吗"），派生会让"新增一类动作"
 *   悄无声息地同时改变另一边 —— 那正是本项目出过两次事故的「一个规则两处语义」。
 * ⚠️ 也**不许**把第一行写成与上行逐字相同：`mut-a1044` M6 是**按行锚定**的，
 *   行内容一撞，`check-mut-anchors` 就会报"不唯一 ⇒ 可能改错对象"（本轮真实踩到）。
 */
const VERIFY_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([
  "click", "double_click", "right_click",
  "middle_click", "long_press",
  "tap", "key", "type", "scroll", "drag", "swipe",
]);

/**
 * 判定「画面有可见变化」的最小像素差异率。
 * 留足噪声余量：时钟跳秒、文本光标闪烁、抗锯齿在 1440p 下各只占几百像素（<0.02%），
 * 这里取 0.2% —— **宁可漏报"未命中"，也不要把噪声读成命中、更不要把命中读成未命中**（后者会触发一次多余点击）。
 */
const VERIFY_MIN_RATIO = 0.002;

/** 未命中时的最大注入次数（2 = 自动重试一次；业界做法） */
const VERIFY_MAX_ATTEMPTS = 2;

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

  /**
   * 列出某后端（缺省全部）的目标 —— **并回报每个失败后端的原因**（唯一实现）。
   *
   * A-1123：旧实现把每后端的异常 `catch` 后**连原因一起吞掉**（只留一句"不影响其它后端枚举"）。
   * "不影响其它后端"是对的，但"原因也没了"是错的：全部后端都枚举失败时，
   * `screen_info` 只能报「无可用目标 / 当前没有任何图形控制后端可用」——
   * 模型据此以为**后端没装配**，去修一个并不存在的装配问题；真故障其实在宿主
   * （PowerShell 启动失败 / adb 掉线 / 设备未授权）。现在把失败按后端归集回传，
   * 由工具层逐条如实列出。判据与 A-1088 的 `listWindows` 完全一致：**故障不许与业务态同形**。
   */
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

  /**
   * A-975 / A-1123：导出某后端的 UI 元素层级 —— **三态**（唯一实现）。
   *
   *  · `ok:true` + 有元素 = 导出成功，界面有可操作元素；
   *  · `ok:true` + 空数组  = 导出**成功**，但界面确实没有可操作元素（全屏画布/游戏/页面未加载完）——**业务态**；
   *  · `ok:false`          = 后端未注册 / 该后端没有元素树能力 / **导出本身失败**（宿主机崩 / dump 超时）——**故障态**。
   *
   * 旧实现是 `catch { return [] }`：把后两者压成**同一个空数组**，于是 `screen_ui_dump` 只能回
   * 一句"未能导出元素层级（可能是 uiautomator 不可用、界面为全屏画布/游戏、或页面仍在加载）"
   * —— 把一个**确定的后端故障**说成三种可能，模型于是去反复重试或改代码修一个不存在的问题。
   * 这与 A-1088 对 `listWindows` / `focusWindow` 的修法同宗：**先把两态分开，再谈措辞**。
   */
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

  /** A-977：枚举可见窗口（仅桌面后端支持；不支持时返回空数组）
   *  A-1088：**不再把异常吞成空数组** —— 旧实现 `catch { return []; }` 让
   *  「枚举故障」与「本机真的没有窗口」在上层**完全同态**（工具只能回一句
   *  「未枚举到可见窗口」，模型据此去修一个并不存在的故障）。
   *  现在：不支持的后端仍返回空（语义是"这个后端没有窗口概念"）；
   *  真故障**原样上抛**，由 `screen_windows` 工具转成 `[错误] …`。 */
  async listWindows(id: ScreenBackendId): Promise<Array<{ title: string; pid: number; x: number; y: number; width: number; height: number }>> {
    const b = this.backends.get(id);
    if (!b?.listWindows) { return []; }
    return await b.listWindows();
  }

  /** A-977：按标题聚焦窗口并返回其矩形（仅桌面后端支持）。
   *
   *  A-1088 同判据：**「业务上没做到」与「调用本身失败」必须分两态**。
   *  旧实现 `catch (e) { return { focused: false, detail: … } }` 把两种完全不同的情形
   *  在上层压成**同一个形状**（都只有 `focused:false`，没有可区分的标记）：
   *    · 「未找到标题匹配的窗口」「没抢到前台」—— 后端**正常返回** `focused:false`，
   *      是业务态，有替代路径（窗口可见时区域截图照样能用）；
   *    · 「宿主崩溃 / 启动超时 / 从未启动」—— 后端**抛错**，是真故障，
   *      任何替代路径都不会成功（同一条死掉的宿主）。
   *  而 `screen_focus` 工具只能看 `focused` ⇒ 对**真故障**也回一句「[未获得前台] …」
   *  并附上「可直接 screen_capture 传 window 试试区域截图」的建议 ⇒ 模型把它当成
   *  **焦点限制**去绕（换标题、反复重试、试区域截图），**永远不会去报告那个已经死掉的宿主**。
   *  现在与 `listWindows` 完全同形：不支持的后端仍回业务态（语义是"该后端没有窗口概念"），
   *  真故障**原样上抛**，由 `screen_focus` 工具转成 `[错误] …`。 */
  async focusWindow(id: ScreenBackendId, title: string): Promise<{ focused: boolean; detail: string; rect?: { x: number; y: number; width: number; height: number } }> {
    const b = this.backends.get(id);
    if (!b?.focusWindow) { return { focused: false, detail: `${id} 后端不支持窗口聚焦` }; }
    return await b.focusWindow(title);
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

  /**
   * A-1044：**操作可视化的订阅点**（GUI 主进程据此画「呼吸灯边框」+ 悬浮提示）。
   *
   * 为什么放在 controller 而不是各后端：这里是所有图形动作的唯一咽喉
   * （串行化链 + 坐标换算 + 能力校验都在此），一处订阅就能覆盖桌面与安卓两条路径。
   * 回调是 fire-and-forget：界面画框失败绝不允许影响动作执行。
   */
  onOperationFocus: ((e: OperationFocusEvent) => void) | null = null;

  private emitFocus(e: OperationFocusEvent): void {
    try { this.onOperationFocus?.(e); } catch { /* 可视化失败不影响动作 */ }
  }

  /**
   * A-1044：等用户停手（人优先）。返回 `ok:false` = 等超时，**本次动作不执行**。
   * 语义与数值判据全在 `arbiter.ts`（唯一实现），这里只负责「问空闲 → 等 → 再问」。
   */
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

    // A-1014：基准兜底 —— 按窗口截图记的基准挂在 key `id|`（target 为空）上，而调用方
    // 可能带 target 来执行动作（两种 key 不一致）。此时**不能**再退回 info 的 1:1 口径
    // （那正是偏移的来源），而是直接复用最近一次带原点的基准 —— 它更可能是"模型看的那张图"。
    if (!this.basis.get(`${id}|${target ?? ""}`)) {
      const loose = this.basis.get(`${id}|`);
      if (loose) { this.basis.set(`${id}|${target ?? ""}`, loose); }
    }

    // A-975：元素定位优先——比坐标可靠得多（取 bounds 中心，天然规避目测漂移）
    let resolved = action;
    let locateNote = "";
    if (action.selector && (action.kind === "click" || action.kind === "tap" || action.kind === "double_click" || action.kind === "long_press")) {
      // A-1123：**导出故障**与**selector 没匹配**必须分两态（否则模型会去改 selector，
      // 而真正坏掉的是宿主）。这里先看三态的 ok，再看匹配结果。
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

    // 坐标换算：统一折算到物理像素（A-978：带上截图区域原点，按窗口截图才不会整体偏移）
    const key = `${id}|${target ?? ""}`;
    const basis = this.basis.get(key);
    const space = resolved.coordSpace ?? (resolved.absolute === true ? "device" : "image");
    /**
     * A-1014：**没有基准就是错误**，不再静默按 1:1 当物理像素用。
     *
     * 改前的写法是 `basis?.imageWidth ?? info.width` / `regionW = basis?.deviceWidth ?? info.width`
     * → 没有基准时比例恰好等于 1，模型给的 image 像素被直接当成物理像素。
     * 屏幕宽 > 1600（截图会被缩到 1600）时这是**系统性偏移**，而且因为比例"看起来正常"
     * （1.0）连日志都看不出异常：模型说"我点了 (800,450)"，实际点在 (800,450) 而它以为的
     * 那张图上 (800,450) 对应屏幕 (1280,720)。用户"用起来总是糊涂"有这一份。
     *
     * 为什么是错误而不是回退：`device` 空间本来就不需要基准，而 `image`/`normalized`
     * 离开截图就无从解释。与其猜一个比例，不如让模型先把截图拍了 —— 引导也是明确的
     * （工具描述本就写着"图形操作前必须先截图确认当前画面"）。
     */
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
      // 落地后一律按像素执行，后端无需再关心坐标系
      absolute: true,
      coordSpace: "device",
      selector: undefined,
    };

    /**
     * A-1123：**一次「注入 + 复截」** —— 抽成函数是因为未命中时要**原样重试一次**，
     * 两处各写一遍（让位仲裁 / 焦点事件 / 复截）必然漂移（本项目「一个规则两处实现」出过两次事故）。
     */
    const injectOnce = async (): Promise<ScreenActionResult> => {
      // A-1044：**用户让位仲裁**（人优先）。放在这里而不是更早，是为了不为一个
      // 注定会被拒的动作（缺基准/元素定位失败）白等几秒。
      const conflictsWithUser = USER_CONFLICT_ACTIONS.has(action.kind) && !!backend.userIdleMs;
      const focusRegion = operationRegionBox({
        targetRegion: target && basis ? { x: ox, y: oy, width: regionW, height: regionH } : null,
        point: { x: scaled.x, y: scaled.y },
        fallback: basis ? { x: ox, y: oy, width: regionW, height: regionH } : null,
      });
      let yieldNote = "";
      if (conflictsWithUser) {
        // `begin` 在注入**之前**发出：用户先看到"Agent 要动了"，才有机会把手挪开（人优先的可见化）
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
      // 动作后自动复截（wait 无副作用、halt 已停 → 不复截）—— 这张图同时是命中校验的「动作后」证据
      if (r.ok && this.autoCapture && action.kind !== "wait") {
        const shot = await this.capture(id, target);
        if (shot.ok) { r.capture = shot; }
      }
      return r;
    };

    // A-1123：命中校验的「动作前」参考图。
    // ⚠️ 直接调 `backend.capture`（**不经** `this.capture`）：后者会 `rememberBasis`，
    //    而这只是一张额外的比较用图，**不许**污染"模型看的那张图"的坐标基准 ——
    //    按窗口截图时基准带 originX/originY，被一张整屏参考图覆盖后，下一次动作会整体偏移。
    // ⚠️ `marks:false`：比较像素不需要标注，省一次标注绘制。
    // ⚠️⚠️ 只有**真的能比较**时才拍这张图：没有差异度量时它永远用不上，
    //    白拍一张整屏截图（每次点击多一次截图开销），并且让"动作后复截恰好一次"
    //    这个既有判据变成两次（A-1123 首轮就是这么把 `screen.spec.ts` 打红的）。
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

    // ── A-1123：命中校验（未命中 → 自动重试一次）───────────────────────────────
    // ⚠️ 条件用 `kindVerifiable` 而不是 `wantVerify`：关掉复截时**也要出声**
    //    （回执里说明"跳过命中校验"），否则"没校验"与"校验通过"又变成同一句话。
    if (result.ok && kindVerifiable) {
      result = await this.verifyFeedback(result, beforePng, injectOnce);
    }

    if (result.ok && locateNote && result.detail) {
      result.detail = `${result.detail}${locateNote}`;
    }
    return result;
  }

  /**
   * A-1123：**动作效果复核** —— 命中校验 + 未命中自动重试一次。
   *
   * 判据三分（关键：`ratio === null` **不是**"没变化"，而是**没有判据**）：
   *   · `null`     → `hit:true` 且**不重试**（宁可放过，也不要把一次其实成功的点击再点一遍）；
   *   · `>= 阈值`   → `hit:true`；
   *   · `< 阈值`    → `hit:false`，**原样再注入一次**后重判（业界做法）。
   *
   * @param prev       首次注入的结果（`capture` 即"动作后"证据）
   * @param beforePng  动作**前**的参考图（base64）；取不到时无法比较
   * @param injectOnce 再次注入同一动作 —— 与首次**共用同一段实现**（含让位仲裁与复截）
   * @returns 最终该回给模型的结果（重试过则以重试那次为基底，并带上 `verify`）
   */
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
      // 「没有判据」有三种成因，**必须分开说**（否则用户拿不到可操作的下一步）：
      //   未装配度量 → 换环境/开能力；参考图没取到 → 截图那条路坏了；不可比 → 尺寸不一致/解码失败。
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
    // `attemptsMax` 显式标注为 number：否则 TS 按字面量类型 2 判「与 1 无交集」而报 ts(2367)
    const attemptsMax: number = VERIFY_MAX_ATTEMPTS;
    if (attemptsMax <= 1) {
      return { ...prev, verify: { hit: false, ratio, attempts: 1, note: "画面无可见变化（未开启自动重试）" } };
    }
    // 未命中 → 原样重试一次
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

/** A-1044：把动作翻译成**人话**（悬浮提示直接展示；不出现内部坐标空间术语）。
 *  传入的是 `scaled`（已落地为物理像素），所以显示的坐标就是屏幕上的真实位置。 */
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
