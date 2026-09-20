/**
 * core-ts/src/screen/types.ts — slime 图形控制能力 · 类型契约层。
 *
 * 设计参照 Anthropic Claude Computer Use / Claude Code computerUse 的三层架构：
 *   ① Tool 接口（builtin.ts 注册 screen_* 工具）
 *   ② Executor（controller.ts：坐标缩放 + 互斥锁 + 动作分发）
 *   ③ Host Adapter（backends/*：平台无关的截屏 / 输入注入）
 *
 * 与 ADB 板块的关系：Android 只是**一个后端**，不是能力边界。
 * 桌面（Windows/macOS/Linux）与 Android 共用同一套动作语义与坐标模型。
 */

/** 后端标识 —— 新增平台只加一个 backend，不改工具契约 */
export type ScreenBackendId = "desktop" | "android";

/** 显示目标信息（决定坐标缩放基准） */
export interface DisplayInfo {
  backend: ScreenBackendId;
  /** 目标标识：桌面为 "primary"；Android 为设备 serial */
  target: string;
  width: number;
  height: number;
  /** 人类可读标签（如 "主显示器 2560×1440" / "Pixel 7 (1080×2400)"） */
  label: string;
  /** 可选：设备/系统缩放因子（DPI），仅信息展示用 */
  scale?: number;
  /**
   * A-1014：该目标坐标系的原点（虚拟桌面坐标，**可能为负**）。
   * 为什么必须在这里：PowerShell 宿主自 A-977 起就在 `size` 探针里返回了
   * `GetSystemMetrics(76/77)`（SM_XVIRTUALSCREEN/SM_YVIRTUALSCREEN），
   * 但 TS 侧 `displayInfo` 只取了 width/height、**把原点丢了** → controller 的
   * `basis.originX` 恒为 0。而整屏截图是 `CopyFromScreen($vx,$vy,...)`（图像 0 点 =
   * 虚拟坐标 (vx,vy)）、`SetCursorPos` 用的也是虚拟坐标 —— 于是**副屏在主屏左侧/上方
   * 时（vx/vy 为负），整屏截图后的点击会整体偏移 (vx,vy)**，且无任何提示。
   * 按窗口截图（captureWindow）当时就带 origin，所以只有"整屏"这一条路径是错的。
   */
  originX?: number;
  originY?: number;
}

/** 截图结果 */
export interface ScreenCaptureResult {
  ok: boolean;
  /** 原始 PNG（base64，不含 data: 前缀） */
  pngBase64?: string;
  /** 瘦身后的 data URL（缩放 + JPEG 压缩；无优化器时回退 PNG）—— 回灌模型用这个 */
  dataUrl?: string;
  /** 目标**物理**分辨率（坐标最终换算到它） */
  width?: number;
  height?: number;
  /**
   * A-975：**模型所见图像**的实际像素尺寸（dataUrl 的真实宽高）。
   * 视觉模型只会按"眼前这张图"的像素估坐标，而不是设备物理分辨率——两者在
   * 截图被缩放（桌面 2560→1600）时**不相等**。此前只用物理分辨率做基准 +
   * 只让模型给 0-1000 归一化值，是所有"点偏/点错"的结构性根因。
   */
  imageWidth?: number;
  imageHeight?: number;
  /**
   * A-978：本次截图覆盖区域在**目标坐标系里的原点**（默认 0,0 = 整屏/整虚拟桌面）。
   * 按窗口截图时 origin = 窗口左上角，width/height = 窗口尺寸；
   * 坐标换算必须再加上这个原点，否则点击会整体偏移（少加一个窗口偏移）。
   */
  originX?: number;
  originY?: number;
  /** 图像字节数（模型可见的证据性描述，配合反幻觉护栏） */
  bytes?: number;
  error?: string;
  /**
   * A-1014：**成功但有保留**的提示（ok=true 时可能有值）。
   * 首个用例：按窗口截图时没能把窗口抢到前台（`SetForegroundWindow` 被系统拒绝）——
   * 画面可能被其它窗口遮挡。此前这种情况要么静默、要么被当成硬失败，
   * 两种都不对：窗口其实可见时应当照常可用，但模型**必须知道**这张图可能不是目标窗口。
   * 工具层负责把它拼进回传给模型的正文。
   */
  warning?: string;
  /** A-975：本张截图叠加的标注（网格 / 元素编号框），供模型按刻度或编号定位 */
  annotate?: {
    grid: boolean;
    /** 已绘制的可点元素编号框数量 */
    marks: number;
    /** 图像→物理 的缩放比（imageWidth→width），模型据此刻度反算 */
    scaleX: number;
    scaleY: number;
  };
}

/**
 * A-975：坐标语义空间（对齐 Claude Computer Use / UI-TARS 的工程共识）。
 *  - "image"（默认）：**模型所见图像**的像素坐标（0..imageWidth / 0..imageHeight）。
 *     这是唯一与视觉模型训练范式一致的坐标系，也是默认值。
 *  - "normalized"：0-1000 归一化（历史兼容；模型易与像素混淆，不推荐）。
 *  - "device"：目标物理像素（绝对像素，需模型自己按物理分辨率换算，少用）。
 */
export type CoordSpace = "image" | "normalized" | "device";

/** 统一动作语义 —— 桌面与 Android 共用；不支持的动作由后端返回明确错误 */
export type ScreenActionKind =
  | "click"          // 左键单击 / 触摸点按
  | "double_click"   // 双击 / 双击手势
  | "right_click"    // 右键（Android 不支持）
  | "middle_click"   // 中键（Android 不支持）
  | "long_press"     // 长按（Android）；桌面为按住左键
  | "mouse_move"     // 仅移动指针（Android 不支持）
  | "drag"           // 拖拽（按下 → 移动 → 抬起）
  | "scroll"         // 滚轮（Android 映射为 swipe）
  | "type"           // 键入文本
  | "key"            // 按键 / 快捷键（如 "ctrl+c"、"Enter"、"KEYCODE_HOME"）
  | "tap"            // 显式触摸点按（Android 专用别名，桌面等价 click）
  | "swipe"          // 显式滑动（Android 专用，桌面等价 drag）
  | "wait";          // 等待毫秒（给 UI 反应时间）

/**
 * A-975：元素定位选择器——**比坐标可靠得多的点击方式**（业界标准做法）。
 * 优先按下面的顺序解析：index（来自 screen_ui_dump 的编号）→ id → text → desc。
 * 命中后取元素 bounds 中心作为点击坐标，天然规避"目测坐标漂移"。
 */
export interface ElementSelector {
  /** screen_ui_dump 列表里的编号（1 起）——最精确，推荐 */
  index?: number;
  /** resource-id（如 com.example:id/btn） */
  id?: string;
  /** 可见文本（精确或包含匹配） */
  text?: string;
  /** content-desc（无障碍描述，图标按钮常靠它定位） */
  desc?: string;
}

/** 单次动作请求 */
export interface ScreenAction {
  kind: ScreenActionKind;
  /** X（语义见 coordSpace；默认=模型所见图像的像素 x） */
  x?: number;
  /** Y（语义见 coordSpace；默认=模型所见图像的像素 y） */
  y?: number;
  /** 终点 X（drag / swipe / mouse_move 目标） */
  x2?: number;
  /** 终点 Y（drag / swipe / mouse_move 目标） */
  y2?: number;
  /** 文本（type） */
  text?: string;
  /** 按键名（key），如 "Enter" / "ctrl+c" / "KEYCODE_BACK" */
  key?: string;
  /** 滚动量：正数向上 / 负数向下（scroll） */
  delta?: number;
  /** 时长毫秒（long_press / swipe / drag / wait） */
  durationMs?: number;
  /** A-975：坐标语义空间（默认 "image"）。absolute=true 等价于 coordSpace="device"（历史兼容） */
  coordSpace?: CoordSpace;
  /** A-975：历史字段——true 时 x/y 按物理像素解释（等价 coordSpace="device"） */
  absolute?: boolean;
  /** A-975：元素定位（比坐标更稳）。提供时忽略 x/y，改点元素中心 */
  selector?: ElementSelector;
}

/** A-975：UI 层级里的一个可操作元素（screen_ui_dump 输出单元） */
export interface UiElement {
  /** 1 起的稳定编号（供 selector.index 使用） */
  index: number;
  /** 元素类型（如 android.widget.Button） */
  className?: string;
  /** 可见文本 */
  text?: string;
  /** resource-id */
  id?: string;
  /** content-desc（无障碍描述） */
  desc?: string;
  /** 设备物理像素包围盒 */
  bounds: { x1: number; y1: number; x2: number; y2: number };
  /** 包围盒中心（设备物理像素）——直接可用于 tap */
  center: { x: number; y: number };
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
}

/** 动作执行结果 */
export interface ScreenActionResult {
  ok: boolean;
  /** 动作的落地描述（含缩放后的真实坐标，供模型校准） */
  detail?: string;
  /** 执行后的自动复截（对齐 Claude Code「每个动作后回一张截图」） */
  capture?: ScreenCaptureResult;
  error?: string;
}

/** 后端能力声明 —— 控制器据此拒绝不支持的动作，而非静默失败 */
export interface ScreenBackend {
  readonly id: ScreenBackendId;
  /** 该后端支持的动作集合 */
  readonly actions: ReadonlySet<ScreenActionKind>;
  /** 列出可用目标（桌面一般 1 个；Android 可有多个设备） */
  listTargets(): Promise<DisplayInfo[]>;
  /** 取目标显示信息（缺省取默认目标） */
  displayInfo(target?: string): Promise<DisplayInfo>;
  /** 截屏（opts.marks=true 时叠加网格/元素编号标注） */
  capture(target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult>;
  /** 执行动作（坐标已在 controller 缩放为像素） */
  perform(action: ScreenAction, target?: string, info?: DisplayInfo): Promise<ScreenActionResult>;
  /**
   * A-975（可选能力）：导出当前界面的 UI 层级元素（Android 走 uiautomator dump）。
   * 返回可操作元素列表（含 bounds 中心），供「元素定位」点击——比目测坐标可靠得多。
   * 后端不支持时返回空数组（工具层据此降级为纯视觉）。
   */
  uiDump?(target?: string): Promise<UiElement[]>;
  /**
   * A-977（可选，桌面后端）：枚举当前可见窗口（标题 + 矩形）。
   * 让 Agent「先把目标窗口带到前台再操作」，显著降低"点错窗口"的概率。
   */
  listWindows?(): Promise<Array<{ title: string; pid: number; x: number; y: number; width: number; height: number }>>;
  /** A-977（可选，桌面后端）：按标题（包含匹配）聚焦/还原窗口，返回其矩形 */
  focusWindow?(title: string): Promise<{ focused: boolean; detail: string; rect?: { x: number; y: number; width: number; height: number } }>;
  /**
   * A-978（可选，桌面后端）：按窗口标题截取**该窗口区域**的画面（先聚焦再区域截取）。
   * 返回的 width/height = 窗口尺寸、originX/originY = 窗口左上角，坐标换算会带上这个原点。
   */
  captureWindow?(title: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult>;
}

/** 屏幕坐标归一化基准（历史 0-1000 坐标系；新代码默认用 image 像素空间） */
export const NORMALIZED_MAX = 1000;

/**
 * A-975：把「模型所见图像坐标」换算为目标物理像素。
 * 视觉模型按眼前图像估坐标 → 必须按 imageSize→deviceSize 的比例放大，
 * 而不是拿图像坐标当物理坐标用（这是"点偏"的结构性修复）。
 *
 * @deprecated A-1014：**不要在新代码里用**。它不接受区域原点，按窗口截图时会整体偏移。
 *   唯一正确的换算入口是 {@link coordToDeviceInRegion}（controller 也只调它）。
 *   保留仅因 `tests/core-ts/screen.spec.ts` 仍在测它；有测试的历史 API ≠ 该用的 API。
 */
export function imageToDevice(value: number | undefined, imageSize: number, deviceSize: number): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) { return undefined; }
  if (!imageSize || !deviceSize) { return Math.round(value); }
  return Math.round((value / imageSize) * deviceSize);
}

/**
 * 把归一化坐标换算为像素；absolute=true 时原样返回（历史兼容保留）
 *
 * @deprecated A-1014：**不要在新代码里用**。它与 {@link coordToDeviceInRegion} 是
 *   同一件事的两份实现（本项目「一个规则两处实现」出过两次事故），且不接受区域原点。
 *   新代码一律走 `coordToDeviceInRegion(space, value, imageSize, regionSize, origin)`。
 */
export function toPixel(value: number | undefined, size: number, absolute: boolean): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) { return undefined; }
  if (absolute) { return Math.round(value); }
  const clamped = Math.max(0, Math.min(NORMALIZED_MAX, value));
  return Math.round((clamped / NORMALIZED_MAX) * size);
}

/**
 * A-975：按 coordSpace 把任意坐标统一折算到**物理像素**。
 * @param space       坐标语义（image/normalized/device）
 * @param value       原始值
 * @param imageSize   模型所见图像在该轴上的尺寸
 * @param deviceSize  目标物理分辨率在该轴上的尺寸
 */
export function coordToDevice(
  space: CoordSpace,
  value: number | undefined,
  imageSize: number,
  deviceSize: number,
): number | undefined {
  return coordToDeviceInRegion(space, value, imageSize, deviceSize, 0);
}

/**
 * A-978：区域感知的坐标换算（按窗口截图时必须用这个）。
 * 截图只覆盖目标坐标系的某个子矩形时，物理坐标 = **区域原点 + 区域内的相对偏移**。
 * @param origin 该区域在目标坐标系里的原点（按窗口截图 = 窗口左上角）
 */
export function coordToDeviceInRegion(
  space: CoordSpace,
  value: number | undefined,
  imageSize: number,
  regionSize: number,
  origin: number,
): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) { return undefined; }
  if (space === "device") { return Math.round(value); }
  if (space === "normalized") {
    const clamped = Math.max(0, Math.min(NORMALIZED_MAX, value));
    return Math.round(origin + (clamped / NORMALIZED_MAX) * regionSize);
  }
  // image：模型所见图像像素 → 区域像素 → 目标坐标
  if (!imageSize || !regionSize) { return Math.round(origin + value); }
  return Math.round(origin + (value / imageSize) * regionSize);
}
